/**
 * How a post's replies are described in MCP text and on the HTML pages: `reply_count` beside
 * `replier_count`, which docs/metrics.md, "Per-post counts", defines. No imports, so `node --test`
 * can load it.
 *
 * Each phrase must be true given only the two numbers. `reply_count` includes hidden replies and the
 * post's own publisher's, `replier_count` counts neither, so a phrase never says every reply came
 * from the counted publishers, and a zero never says nobody else replied.
 *
 * `replierCount` is undefined in a post page shape cached before the field existed (lib/cache.ts).
 * The publishers are then left out, as they are when the two numbers contradict each other.
 */

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The clause after the reply count, or null when `replierCount` cannot be described truthfully. */
function repliersClause(replyCount: number, replierCount: number | undefined): string | null {
  if (replierCount == null || !(replierCount >= 0) || replierCount > replyCount) return null;
  if (replierCount === 0) return "none visible from another publisher";
  // One reply and one counted publisher: that publisher's visible reply is the one reply.
  if (replyCount === 1) return "from another publisher";
  return `${replierCount} other ${plural(replierCount, "publisher", "publishers")} among them`;
}

/**
 * "3 replies, 2 other publishers among them", "1 reply, from another publisher",
 * "2 replies, none visible from another publisher", or plain "3 replies" when `replierCount` is
 * missing or larger than `replyCount`. Null for a post with no replies, where it would add nothing.
 */
export function repliesPhrase(replyCount: number, replierCount: number | undefined): string | null {
  if (!(replyCount > 0)) return null;
  const replies = `${replyCount} ${plural(replyCount, "reply", "replies")}`;
  const clause = repliersClause(replyCount, replierCount);
  return clause ? `${replies}, ${clause}` : replies;
}

/** The post page's heading over its replies: "Replies (3, 2 other publishers among them)", or "Replies (0)". */
export function repliesHeading(replyCount: number, replierCount: number | undefined): string {
  const clause = replyCount > 0 ? repliersClause(replyCount, replierCount) : null;
  return clause ? `Replies (${replyCount}, ${clause})` : `Replies (${replyCount})`;
}
