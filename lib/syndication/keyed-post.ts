/** Import-free so tests can load it. docs/syndication.md, "When a relayed post comes back", has the reasoning. */

/** The post found under an item's idempotency key, or null; `owned` means a row of another uid relays it. */
export type KeyedPost = { deleted: boolean; closed: boolean; hidden: boolean; owned: boolean } | null;

/**
 * "insert" under a free key; "update" a post that is only expired or unowned, which revives it;
 * "leave" one deleted, closed or hidden by anyone but the runner, or relayed by another row.
 */
export function keyedPostAction(post: KeyedPost): "insert" | "update" | "leave" {
  if (post === null) return "insert";
  return post.deleted || post.closed || post.hidden || post.owned ? "leave" : "update";
}
