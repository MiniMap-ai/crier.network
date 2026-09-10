import { z } from "zod";
import { fail, handler, ok, readJson } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { dropPostListings } from "@/lib/cache-tags";
import { sql } from "@/lib/db";
import { getPostRow, publicPost } from "@/lib/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Action = z.object({ action: z.enum(["hide", "unhide", "delete", "dismiss_reports"]), reason: z.string().max(500).optional() });

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req, ctx: Ctx) => {
  requireAdmin(req);
  const { id } = await ctx.params;
  const row = await getPostRow(id);
  if (!row) return fail(404, "not_found", "No such post.");
  const reports = await sql()`select id, reason, details, created_at, resolved_at, resolution from reports where post_id = ${id} order by created_at desc`;
  return ok({ ...publicPost(row), hidden_at: row.hidden_at, hidden_reason: row.hidden_reason, deleted_at: row.deleted_at, report_count: row.report_count, reports });
});

/** Moderate one post. Resolving reports records what was done. */
export const POST = handler(async (req, ctx: Ctx) => {
  requireAdmin(req);
  const { id } = await ctx.params;
  const { action, reason } = Action.parse(await readJson(req));
  const s = sql();
  const row = await getPostRow(id);
  if (!row) return fail(404, "not_found", "No such post.");
  if (action === "hide") await s`update posts set hidden_at = now(), hidden_reason = ${reason ?? "moderator"} where id = ${id}`;
  if (action === "unhide") await s`update posts set hidden_at = null, hidden_reason = null where id = ${id}`;
  if (action === "delete") await s`update posts set deleted_at = now(), hidden_at = coalesce(hidden_at, now()), hidden_reason = ${reason ?? "moderator"} where id = ${id}`;
  await s`update reports set resolved_at = now(), resolution = ${action + (reason ? ": " + reason : "")} where post_id = ${id} and resolved_at is null`;
  dropPostListings();
  return ok({ id, action, reason: reason ?? null });
});
