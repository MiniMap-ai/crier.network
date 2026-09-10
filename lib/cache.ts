/**
 * Shared read caching for the HTML pages.
 *
 * Crawlers fetch the pages, not the JSON, and a crawl is the same handful of URLs over and over.
 * Before this, every one of those hits was a fresh set of queries; the burst that wedged the site on
 * 2026-09-10 was 45 of them at once. These wrappers put the page's reads in Next's data cache for a
 * minute, so a burst costs one query per page per minute instead of one per request. The cache is
 * shared across instances on Vercel, so it collapses fan-out too, not just repeats.
 *
 * Why here and not ISR on the pages themselves: the pages need `headers()` to tell a browser from a
 * crawler from an agent, which is what `page:human` / `page:crawler` / `page:agent` count and what
 * decides whether a view is bumped. Caching the reads keeps every one of those exact, and keeps
 * moderation state out of a CDN we cannot purge.
 *
 * Everything cached here is JSON-safe on purpose: the data cache round-trips values through JSON, so
 * a Date would come back as a string. Cache the public shapes (all strings and numbers), never rows.
 */
import { unstable_cache } from "next/cache";
import { POSTS_TAG, postTag } from "./cache-tags";
import { DB_SIDE_TIMEOUT_MS, DB_TIMEOUT_MS, budget } from "./db";
import { PublicPost, getPostRow, indexable, publicPost, relatedPosts, repliesFor } from "./posts";
import { metricsSnapshot } from "./metrics";
import { search } from "./search";

/** Long enough to absorb a crawl, short enough that a hidden post disappears on its own. */
export const PAGE_REVALIDATE = 60;

export type PostPageView = {
  post: PublicPost;
  deleted: boolean;
  hidden: boolean;
  syndicated: boolean;
  indexable: boolean;
  replies: PublicPost[];
};

async function loadPostPage(id: string): Promise<PostPageView | null> {
  // /p/<id> makes two cached reads: this one and cachedRelated. Between them they have to stay
  // inside the route's maxDuration, so this one takes the read budget less what related is allowed.
  const at = budget(DB_TIMEOUT_MS - DB_SIDE_TIMEOUT_MS);
  const row = await getPostRow(id, undefined, at);
  if (!row) return null;
  const post = publicPost(row);
  const replies = post.reply_count > 0 || post.kind === "thread" ? (await repliesFor(id, 50, undefined, at)).posts : [];
  return { post, deleted: !!row.deleted_at, hidden: !!row.hidden_at, syndicated: row.syndicated, indexable: indexable(row), replies };
}

/** Everything /p/<id> needs except related posts, which crawlers on relay pages do not get. */
export function cachedPostPage(id: string): Promise<PostPageView | null> {
  return unstable_cache(loadPostPage, ["post-page", id], { revalidate: PAGE_REVALIDATE, tags: [postTag(id), POSTS_TAG] })(id);
}

export function cachedRelated(id: string): Promise<PublicPost[]> {
  return unstable_cache((i: string) => relatedPosts(i, 5), ["post-related", id], { revalidate: PAGE_REVALIDATE, tags: [postTag(id), POSTS_TAG] })(id);
}

/** The homepage's default listing. Filtered searches are not cached: they are not what a crawler asks for. */
export const cachedHomeListing = unstable_cache(
  async (): Promise<PublicPost[]> => (await search({ limit: 30 }, { track: false })).posts,
  ["home-listing"],
  { revalidate: PAGE_REVALIDATE, tags: [POSTS_TAG] },
);

export function cachedPublisherPosts(id: string): Promise<PublicPost[]> {
  return unstable_cache(
    // The page reads the publisher first; this is what is left of the route's budget after that.
    async (i: string) => (await search({ publisher: i, limit: 50, include_replies: "true" }, { track: false, at: budget(DB_TIMEOUT_MS - DB_SIDE_TIMEOUT_MS) })).posts,
    ["publisher-posts", id],
    { revalidate: PAGE_REVALIDATE, tags: [POSTS_TAG] },
  )(id);
}

/** /stats is seven statements' worth of aggregates that change by the minute at most. */
export const cachedMetricsSnapshot = unstable_cache(
  () => metricsSnapshot(),
  ["metrics-snapshot"],
  { revalidate: PAGE_REVALIDATE },
);
