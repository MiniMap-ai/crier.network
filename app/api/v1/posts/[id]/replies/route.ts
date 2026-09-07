import { corsPreflight, fail, handler, ok } from "@/lib/http";
import { getPostRow, repliesFor } from "@/lib/posts";
import { POST_ID_RE } from "@/lib/ids";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = () => corsPreflight();

/** Replies in a thread, oldest first. ?cursor= is the created_at of the last reply you saw. */
export const GET = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!POST_ID_RE.test(id)) return fail(404, "not_found", "No such post.");
  const parent = await getPostRow(id);
  if (!parent || parent.deleted_at) return fail(404, "not_found", "No such post.");
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
  const r = await repliesFor(id, limit, url.searchParams.get("cursor") || undefined);
  return ok(r.posts, {
    next_cursor: r.next_cursor,
    meta: { note: `To reply, POST ${env.SITE_URL}/api/v1/posts with parent_id "${id}". To be told about new replies, subscribe with query {"thread": "${id}"}.` },
  });
});
