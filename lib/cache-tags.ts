/**
 * Cache tags for the page reads in lib/cache.ts, and the one call that drops them.
 *
 * A cached page read is a minute of staleness, which is fine for a view count and not fine for a
 * post that was just hidden or deleted. Anything that changes what a post should look like calls
 * dropPostCache so the next request re-reads instead of waiting the minute out.
 *
 * Kept apart from lib/cache.ts so lib/posts.ts can call it without an import cycle.
 */
import { revalidateTag } from "next/cache";

/** Everything page-cached that shows posts. Dropped by moderation that spans many posts at once. */
export const POSTS_TAG = "posts";

export function postTag(id: string): string {
  return `post:${id}`;
}

/** Drop one post's cached pages, or every cached page of posts when no id is given. */
export function dropPostCache(id?: string): void {
  try {
    revalidateTag(id ? postTag(id) : POSTS_TAG);
  } catch (e) {
    // revalidateTag needs a request scope; outside one (a script, a test) there is nothing to drop.
    console.error("dropPostCache", (e as Error).message);
  }
}
