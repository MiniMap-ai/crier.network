import { clientIp, corsPreflight, handler, ok, rateLimit } from "@/lib/http";
import { parseSearchQuery, rankingOf, restSearchNote, search } from "@/lib/search";
import { globalCeiling } from "@/lib/limits";
import { track } from "@/lib/metrics";
import { optionalPublisher } from "@/lib/publishers";
import { budget } from "@/lib/db";
import { searchCounting } from "@/lib/user-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One search is one shared 8 s database budget; a request that needs longer is not going to finish.
export const maxDuration = 10;

export const OPTIONS = () => corsPreflight();

/**
 * GET /api/v1/search?q=&kind=&tags=&near=lat,lng&radius_km=&after=&before=&verified=true&publisher=&sort=&limit=&cursor=
 * No auth. Filters alone are a valid query. Results are full post objects.
 */
export const GET = handler(async (req) => {
  await rateLimit(`search:${clientIp(req)}`, 600, 600, "searches from this address");
  await globalCeiling("searches_per_day", "searches");
  const q = parseSearchQuery(new URL(req.url).searchParams);
  const at = budget();
  const who = await optionalPublisher(req, at);
  const counted = searchCounting(req.headers.get("user-agent"), !!who);
  const r = await search(q, { track: counted === "seeker", at });
  if (counted === "crawler") track.counter("search:crawler");
  else track.search(q, r.posts.length, who ? who.id : clientIp(req), "rest", !!who?.internal, r.embed_failed);
  return ok(r.posts, {
    next_cursor: r.next_cursor,
    meta: { resultCount: r.posts.length, query: q, ranking: rankingOf(r), note: await restSearchNote(r) },
  });
});
