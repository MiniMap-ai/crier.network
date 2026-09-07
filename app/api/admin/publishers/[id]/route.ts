import { z } from "zod";
import { fail, handler, ok, readJson } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { sql } from "@/lib/db";
import { deletePublisher, getPublisher, publicPublisher } from "@/lib/publishers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Action = z.object({ action: z.enum(["suspend", "unsuspend", "delete"]), reason: z.string().max(500).optional() });

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req, ctx: Ctx) => {
  requireAdmin(req);
  const { id } = await ctx.params;
  const p = await getPublisher(id);
  if (!p) return fail(404, "not_found", "No such publisher.");
  const [stats] = await sql()<{ posts: number; hidden: number; reports: number; subs: number }[]>`
    select (select count(*)::int from posts where publisher_id = ${id} and deleted_at is null) as posts,
           (select count(*)::int from posts where publisher_id = ${id} and hidden_at is not null) as hidden,
           (select count(*)::int from reports r join posts p on p.id = r.post_id where p.publisher_id = ${id}) as reports,
           (select count(*)::int from subscriptions where publisher_id = ${id}) as subs`;
  return ok({ ...publicPublisher(p), status: p.status, suspended_reason: p.suspended_reason, last_seen_at: p.last_seen_at, terms_accepted_at: p.terms_accepted_at, ...stats });
});

/** Suspend hides every post at once and blocks the key; unsuspend restores both. Delete erases. */
export const POST = handler(async (req, ctx: Ctx) => {
  requireAdmin(req);
  const { id } = await ctx.params;
  const { action, reason } = Action.parse(await readJson(req));
  const p = await getPublisher(id);
  if (!p) return fail(404, "not_found", "No such publisher.");
  const s = sql();
  if (action === "suspend") {
    await s`update publishers set status = 'suspended', suspended_reason = ${reason ?? null} where id = ${id}`;
    await s`update posts set hidden_at = coalesce(hidden_at, now()), hidden_reason = coalesce(hidden_reason, 'publisher suspended') where publisher_id = ${id}`;
    await s`update subscriptions set active = false where publisher_id = ${id}`;
  }
  if (action === "unsuspend") {
    await s`update publishers set status = 'active', suspended_reason = null where id = ${id}`;
    await s`update posts set hidden_at = null, hidden_reason = null where publisher_id = ${id} and hidden_reason = 'publisher suspended'`;
  }
  if (action === "delete") await deletePublisher(id);
  return ok({ id, action, reason: reason ?? null });
});
