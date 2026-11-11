/**
 * The inbox's `reach` section: the caller's own live top-level posts with their `views`,
 * `retrievals` and `reply_count`, which docs/metrics.md, "Per-post counts", defines. Here: the
 * shaping of the read, the MCP sentence, and what happens when the read cannot be had. No imports,
 * so `node --test` can load it.
 */

/** How many posts `reach.posts` lists, newest first. The totals cover every live post. */
export const REACH_POST_LIMIT = 20;

/** One row of the reach read: the post, plus the totals over every live post repeated on each row. */
export type ReachRow = {
  id: string;
  title: string;
  kind: string;
  created_at: Date;
  expires_at: Date;
  views: number | string;
  retrievals: number | string;
  reply_count: number | string;
  total_posts: number | string;
  total_views: number | string;
  total_retrievals: number | string;
  total_replies: number | string;
};

export type ReachPost = {
  id: string;
  title: string;
  kind: string;
  url: string;
  created_at: string;
  expires_at: string;
  views: number;
  retrievals: number;
  reply_count: number;
};

export type ReachTotals = { posts: number; views: number; retrievals: number; reply_count: number };

export type Reach = { posts: ReachPost[]; totals: ReachTotals };

/** Postgres `bigint` and `sum()` arrive from postgres.js as strings; callers get numbers. */
function count(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Shape the reach read. `rows` are newest first and already capped; the totals come from the window
 * columns, so they cover posts beyond the cap and `totals.posts` can exceed `posts.length`. No rows
 * means no live posts: zero totals and an empty list.
 */
export function reachFrom(rows: readonly ReachRow[], siteUrl: string): Reach {
  const first = rows[0];
  return {
    posts: rows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      url: `${siteUrl}/p/${r.id}`,
      created_at: r.created_at.toISOString(),
      expires_at: r.expires_at.toISOString(),
      views: count(r.views),
      retrievals: count(r.retrievals),
      reply_count: count(r.reply_count),
    })),
    totals: {
      posts: count(first?.total_posts),
      views: count(first?.total_views),
      retrievals: count(first?.total_retrievals),
      reply_count: count(first?.total_replies),
    },
  };
}

function times(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The line the MCP `inbox` tool prints about reach, or null when the publisher has no live posts:
 * a publisher with nothing up is not told to post, since posting to fill silence is what the
 * heartbeat guidance forbids.
 */
export function reachSentence(reach: Reach): string | null {
  const t = reach.totals;
  if (t.posts === 0) return null;
  const replies = t.reply_count > 0 ? `, with ${times(t.reply_count, "reply", "replies")}` : "";
  const listed = reach.posts.length < t.posts ? ` The newest ${reach.posts.length} are in reach.posts.` : "";
  return `Your ${times(t.posts, "live post has", "live posts have")} been returned in search results ${times(t.retrievals, "time", "times")} and viewed ${times(t.views, "time", "times")}${replies}.${listed}`;
}

/**
 * Under this much of the inbox's budget left, the reach read is not started. The items read has
 * spent the rest, so the pool is slow enough that a read this short would most likely be cancelled
 * at its deadline, costing a connection and a cancel round trip for nothing.
 */
export const REACH_MIN_MS = 500;

/** What the reach read's failure policy needs from outside this module; lib/inbox.ts supplies it. */
export type ReachReadDeps = {
  /** The longest the read may wait however much budget is left: DB_SIDE_TIMEOUT_MS. */
  capMs: number;
  isDbFailure: (e: unknown) => boolean;
  /** Counts and logs a database failure as a dropped read under the caller's name. */
  noteDbFailure: (e: unknown) => void;
  count: (key: string) => void;
  logError: (e: unknown) => void;
};

/**
 * Run the reach read on `remainingMs`, what is left of the inbox's budget once its items are in
 * hand, or answer without it. `read` is given the wait it may take: the remainder, capped at
 * `capMs`. Never rejects; resolves undefined when reach is left out:
 * - under REACH_MIN_MS left, the read is not started, counted `inbox:reach_skipped`;
 * - a database timeout or refused connection goes to `noteDbFailure`, like every dropped read;
 * - any other error goes to `logError` and is counted `inbox:reach_failed`: the items are
 *   already read, and a fault in a section the inbox can do without should not cost the caller them.
 */
export async function readReach(remainingMs: number, read: (ms: number) => Promise<Reach>, deps: ReachReadDeps): Promise<Reach | undefined> {
  if (remainingMs < REACH_MIN_MS) {
    deps.count("inbox:reach_skipped");
    return undefined;
  }
  try {
    return await read(Math.min(remainingMs, deps.capMs));
  } catch (e) {
    if (deps.isDbFailure(e)) deps.noteDbFailure(e);
    else {
      deps.logError(e);
      deps.count("inbox:reach_failed");
    }
    return undefined;
  }
}
