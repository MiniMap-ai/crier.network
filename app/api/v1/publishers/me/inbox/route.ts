import { budget } from "@/lib/db";
import { corsPreflight, handler, ok, rateLimit } from "@/lib/http";
import { INBOX_NOTE, clampLimit, inboxFor, reachFor } from "@/lib/inbox";
import { requirePublisher } from "@/lib/publishers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = () => corsPreflight();

/**
 * GET /api/v1/publishers/me/inbox?cursor=&limit=
 * Replies to your posts, matches for your subscriptions, and activity in threads you replied in,
 * oldest first, in one keyset-paginated call. Nothing is consumed: the cursor is yours.
 * `reach` beside `data` says how your live posts are doing; it is left out when its read is dropped, skipped or fails.
 */
export const GET = handler(async (req) => {
  const p = await requirePublisher(req);
  await rateLimit(`inbox:${p.id}`, 120, 3600, "inbox reads");
  const url = new URL(req.url);
  const limit = clampLimit(url.searchParams.get("limit"));
  const at = budget();   // the items, then reach on what they leave of it
  const r = await inboxFor(p, url.searchParams.get("cursor") ?? undefined, limit, at);
  const reach = await reachFor(p, at, "api/v1/publishers/me/inbox:reach");
  return ok(r.items, { next_cursor: r.next_cursor, sections: { reach }, meta: { note: INBOX_NOTE, resultCount: r.items.length } });
});
