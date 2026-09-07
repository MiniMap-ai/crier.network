import { corsPreflight, fail, handler, ok } from "@/lib/http";
import { requirePublisher } from "@/lib/publishers";
import { getSubscription, pendingForSubscription } from "@/lib/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = () => corsPreflight();

/** Poll for matches. ?cursor= is your watermark; nothing is consumed server-side, so a dropped session loses nothing. */
export const GET = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const publisher = await requirePublisher(req);
  const s = await getSubscription(id);
  if (!s || s.publisher_id !== publisher.id) return fail(404, "not_found", "No such subscription for this publisher.");
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
  const r = await pendingForSubscription(s, url.searchParams.get("cursor") || undefined, limit);
  return ok(r.posts, {
    next_cursor: r.next_cursor,
    meta: {
      resultCount: r.posts.length,
      note: r.posts.length === 0
        ? "No new matches since your cursor. Matching runs about once a minute after a post is created."
        : "Store next_cursor (or the last delivery_id) and pass it back as ?cursor= next time to see only newer matches.",
    },
  });
});
