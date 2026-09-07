import { z } from "zod";
import { fail, handler, ok, readJson } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { sql } from "@/lib/db";
import { runSource, syndicationPublisher } from "@/lib/syndication/runner";
import type { SourceRow } from "@/lib/syndication/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };
const Action = z.object({ action: z.enum(["enable", "disable", "run", "delete", "update"]), patch: z.record(z.string(), z.unknown()).optional() });

export const GET = handler(async (req, ctx: Ctx) => {
  requireAdmin(req);
  const { id } = await ctx.params;
  const [src] = await sql()<SourceRow[]>`select * from sources where id = ${id}`;
  if (!src) return fail(404, "not_found", "No such source.");
  const runs = await sql()`select * from source_runs where source_id = ${id} order by id desc limit 20`;
  const [{ n }] = await sql()<{ n: number }[]>`select count(*)::int as n from source_items where source_id = ${id}`;
  return ok({ ...src, relayed_items: n, runs });
});

/** enable | disable | run (now) | delete (retires every relayed post) | update {patch} */
export const POST = handler(async (req, ctx: Ctx) => {
  requireAdmin(req);
  const { id } = await ctx.params;
  const { action, patch } = Action.parse(await readJson(req));
  const s = sql();
  const [src] = await s<SourceRow[]>`select * from sources where id = ${id}`;
  if (!src) return fail(404, "not_found", "No such source.");
  if (action === "enable") await s`update sources set enabled = true where id = ${id}`;
  if (action === "disable") await s`update sources set enabled = false where id = ${id}`;
  if (action === "update" && patch) {
    const allowed = ["name", "config", "homepage", "license", "default_kind", "tags", "run_every_minutes", "max_per_run", "horizon_days", "notes"] as const;
    for (const k of allowed) if (k in patch) {
      const v = patch[k];
      if (k === "config") await s`update sources set config = ${s.json(v as never)} where id = ${id}`;
      else if (k === "tags") await s`update sources set tags = ${(v as string[]).map(String)} where id = ${id}`;
      else await s.unsafe(`update sources set ${k} = $1 where id = $2`, [v as never, id]);
    }
  }
  if (action === "run") {
    const pub = await syndicationPublisher();
    if (!pub) return fail(500, "no_publisher", "The Crier Syndication publisher does not exist.");
    const [fresh] = await s<SourceRow[]>`select * from sources where id = ${id}`;
    const result = await runSource(fresh, pub, Date.now() + 50_000);
    return ok({ id, action, result });
  }
  if (action === "delete") {
    const pub = await syndicationPublisher();
    const items = await s<{ post_id: string | null }[]>`select post_id from source_items where source_id = ${id}`;
    let retired = 0;
    for (const it of items) if (it.post_id && pub) { await s`update posts set deleted_at = now(), updated_at = now() where id = ${it.post_id} and deleted_at is null and publisher_id = ${pub.id}`; retired++; }
    await s`delete from sources where id = ${id}`;
    return ok({ id, action, retired });
  }
  return ok({ id, action });
});
