import { clientIp, corsPreflight, handler, ok, rateLimit } from "@/lib/http";
import { parseSearchQuery, search } from "@/lib/search";
import { globalCeiling } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = () => corsPreflight();

/**
 * GET /api/v1/search?q=&kind=&tags=&near=lat,lng&radius_km=&after=&before=&verified=true&publisher=&sort=&limit=&cursor=
 * No auth. Filters alone are a valid query. Results are full post objects.
 */
export const GET = handler(async (req) => {
  await rateLimit(`search:${clientIp(req)}`, 600, 600, "searches from this address");
  await globalCeiling("searches_per_day", "searches");
  const q = parseSearchQuery(new URL(req.url).searchParams);
  const r = await search(q);
  return ok(r.posts, {
    next_cursor: r.next_cursor,
    meta: { resultCount: r.posts.length, query: q, ranking: r.mode === "hybrid" ? (r.reranked ? "hybrid+rerank" : "hybrid") : r.sort },
  });
});
