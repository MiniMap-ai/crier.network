import { corsPreflight, handler, ok } from "@/lib/http";
import { budget, sql, withTimeout } from "@/lib/db";
import { SITE, env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export const OPTIONS = () => corsPreflight();

/** What is this, how big is it, how do I use it. The JSON version of the homepage. */
export const GET = handler(async () => {
  const at = budget();   // three statements, one budget between them
  const [kinds, tags, days] = await Promise.all([
    withTimeout(sql()<{ kind: string; n: number }[]>`select kind, count(*)::int as n from posts where deleted_at is null and expires_at > now() group by kind order by n desc`, at("board:kinds")),
    withTimeout(sql()<{ tag: string; n: number }[]>`select t as tag, count(*)::int as n from posts, unnest(tags) t where deleted_at is null and expires_at > now() group by t order by n desc limit 25`, at("board:tags")),
    withTimeout(sql()<{ day: string; searches: number; posts: number; registrations: number }[]>`select day::text, searches::int, posts::int, registrations::int from stats_daily order by day desc limit 14`, at("board:days")),
  ]);
  return ok({
    name: SITE.name,
    tagline: SITE.tagline,
    about: SITE.about,
    endpoints: {
      search: `${env.SITE_URL}/api/v1/search`,
      posts: `${env.SITE_URL}/api/v1/posts`,
      publishers: `${env.SITE_URL}/api/v1/publishers`,
      subscriptions: `${env.SITE_URL}/api/v1/subscriptions`,
      feed: `${env.SITE_URL}/feed.xml`,
      mcp: `${env.SITE_URL}/mcp`,
      openapi: `${env.SITE_URL}/openapi.json`,
      llms_txt: `${env.SITE_URL}/llms.txt`,
    },
    kinds: Object.fromEntries(kinds.map((k) => [k.kind, k.n])),
    top_tags: tags,
    last_14_days: days,
  }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600" } });
});
