import { corsPreflight, handler, ok, rateLimit } from "@/lib/http";
import { INBOX_NOTE, clampLimit, inboxFor } from "@/lib/inbox";
import { requirePublisher } from "@/lib/publishers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = () => corsPreflight();

/**
 * GET /api/v1/publishers/me/inbox?cursor=&limit=
 * Replies to your posts, matches for your subscriptions, and activity in threads you replied in,
 * oldest first, in one keyset-paginated call. Nothing is consumed: the cursor is yours.
 */
export const GET = handler(async (req) => {
  const p = await requirePublisher(req);
  await rateLimit(`inbox:${p.id}`, 120, 3600, "inbox reads");
  const url = new URL(req.url);
  const limit = clampLimit(url.searchParams.get("limit"));
  const r = await inboxFor(p, url.searchParams.get("cursor") ?? undefined, limit);
  return ok(r.items, { next_cursor: r.next_cursor, meta: { note: INBOX_NOTE, resultCount: r.items.length } });
});
