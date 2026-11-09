/**
 * The database writes nobody waits for, and the two rules that keep them.
 *
 * **Rule one: a side write must be registered with the platform, not merely bounded.** Under Fluid
 * compute an instance may be suspended once the response is out and nothing registered is pending.
 * An unawaited promise and its timeout freeze with it and thaw on some later, unrelated invocation,
 * where the timer immediately finds its deadline long past, cancels a query that may never have
 * been sent, and logs the failure against whatever route happens to be running. That is exactly
 * what `db read failed bumpViews … within 2500 ms` was: 68 of them in 24 hours, attributed to `/`,
 * `/api/v1/search` and `/api/v1/board`, none of which has ever called `bumpViews`. Work registered
 * with `after()` keeps the invocation alive until it finishes, which is what makes the bound mean
 * what it says.
 *
 * **Rule two: a counter is not a write.** Views and retrievals are `+1`s, so they accumulate in
 * this process and the metrics flush applies them in one statement, in a transaction of its own,
 * rather than each opening a connection of its own — the same trade lib/search-log.ts makes for
 * query shapes, and the reason a page view costs the database one write instead of four.
 *
 * Like lib/db-timeout.ts and lib/search-log.ts, this module has no imports at all, so the rules
 * above can be tested without a database, a bundler or a Next runtime. What it cannot know about
 * itself — how the platform keeps work alive, and how a wait is bounded — is handed in by
 * lib/db.ts, which is the one module that knows both.
 */

/** What this module needs from a postgres.js pending query. Plain promises are accepted too. */
type Pending<T> = PromiseLike<T> & { execute?: () => unknown; cancel?: () => unknown };

/**
 * How work is kept alive past the response: `after` from next/server in a request, and in a script,
 * a test or a cron's own flush, simply running it — there is no instance there waiting to suspend.
 */
export type Keepalive = (task: () => Promise<void>) => void;

/** How a wait is bounded: lib/db-timeout.ts's `withTimeout`, passed in so this module imports nothing. */
export type Bound = <T>(query: Pending<T>, opts: { ms: number; label: string }) => Promise<T>;

/**
 * Register a write nobody is waiting for: kept alive, bounded, counted and logged, in one place.
 *
 * The query is a thunk rather than a query so it is built inside the registered task. Nothing on
 * the request path should go back to a bare `void withTimeoutOr(...)`; that is the shape this
 * module replaced.
 */
export type SideWrite = (label: string, run: () => Pending<unknown>, opts?: { ms?: number }) => void;

/** The counter a lost side write lands on, so the loss rate is in `daily_counters` and not only in Vercel's logs. */
export const SIDE_WRITE_TIMEOUT_KEY = "error:side_write_timeout";

let lostSideWrites = 0;

/**
 * A side write was lost. Counted here rather than written here on purpose: writing a counter about
 * a failed write, from inside the failure, is how a flush ends up scheduling itself. The number
 * rides the next flush instead.
 */
export function noteSideWriteLost(n = 1): void {
  lostSideWrites += n;
}

/** Take the losses since the last flush, for that flush to record. */
export function drainSideWritesLost(): number {
  const n = lostSideWrites;
  lostSideWrites = 0;
  return n;
}

export function makeSideWrite(deps: { keepalive: Keepalive; bound: Bound; defaultMs: number }): SideWrite {
  return (label, run, opts = {}) => {
    const ms = opts.ms ?? deps.defaultMs;
    const queuedAt = Date.now();
    deps.keepalive(async () => {
      try {
        await deps.bound(run(), { ms, label });
      } catch (e) {
        noteSideWriteLost();
        // A warning, not an error: a lost side write costs a count or a staleness, and `error:` in
        // the runtime log should mean a request that suffered. The elapsed time is the diagnosis
        // rather than decoration — anything far above `ms` means the work was frozen with its
        // instance rather than slow, which is the failure this module exists to end.
        console.warn("side write failed", label, `${Date.now() - queuedAt} ms after it was queued;`, (e as Error).message);
      }
    });
  };
}

/* ---------------- batched per-post counters ---------------- */

/**
 * How many distinct posts one process counts for between flushes. Views come one id at a time and
 * retrievals a page at a time, and a flush follows every request that buffers anything, so this is
 * far above what traffic reaches; it exists because the ids come from callers, and an unbounded map
 * fed by callers is the one that grows if a flush ever stops draining it. Past the cap, ids already
 * being counted keep counting and new ones are dropped — the same trade the counters and the search
 * log make under duress.
 */
export const MAX_PENDING_POSTS = 2000;

const pendingViews = new Map<string, number>();
const pendingRetrievals = new Map<string, number>();

function bump(m: Map<string, number>, id: string, n: number): void {
  const cur = m.get(id);
  if (cur !== undefined) { m.set(id, cur + n); return; }
  if (m.size >= MAX_PENDING_POSTS) { noteSideWriteLost(); return; }
  m.set(id, n);
}

/** One human view of a post. Crawlers are excluded by the caller, which is the one that knows. */
export function noteView(id: string, n = 1): void {
  bump(pendingViews, id, n);
}

/** A page of search results was handed out: one retrieval each. */
export function noteRetrievals(ids: readonly string[], n = 1): void {
  for (const id of ids) bump(pendingRetrievals, id, n);
}

export type PendingCounts = { views: [string, number][]; retrievals: [string, number][] };

/** Take what has accumulated, for the flush to apply. Empties the buffers, like drainSearches(). */
export function drainCounts(): PendingCounts {
  const counts: PendingCounts = { views: [...pendingViews.entries()], retrievals: [...pendingRetrievals.entries()] };
  pendingViews.clear();
  pendingRetrievals.clear();
  return counts;
}

export function hasPendingCounts(counts: PendingCounts): boolean {
  return counts.views.length > 0 || counts.retrievals.length > 0;
}

/**
 * What this module needs from a postgres.js transaction: the tagged template. Structural, so the
 * flush's per-post half can be tested with a recorder instead of a database.
 */
// `unknown` rather than a promise: postgres.js overloads its tagged template with a helper form,
// and pinning the return here would pick the wrong overload. What comes back is awaited and
// discarded, so nothing is lost by not naming it.
export type Tx = (strings: TemplateStringsArray, ...args: unknown[]) => unknown;

/**
 * Apply the batched views and retrievals in one statement, so the caller's transaction holds at
 * most one statement timeout of work. Throws on failure; the caller owns the transaction and counts
 * and logs the loss. Never in the transaction that writes the daily counters: an update of `posts`
 * can run to its statement timeout, and every counter row locked before it would wait with it
 * (docs/metrics.md, "Lock order").
 *
 * `for update skip locked` keeps the rule that a counter never waits on a row lock: a page view
 * must not queue behind a syndication update. A row skipped because it is locked loses that one
 * batch's bump.
 */
export async function applyCounts(tx: Tx, counts: PendingCounts): Promise<void> {
  if (!hasPendingCounts(counts)) return;
  const byId = new Map<string, { views: number; retrievals: number }>();
  for (const [id, n] of counts.views) byId.set(id, { views: n, retrievals: 0 });
  for (const [id, n] of counts.retrievals) {
    const cur = byId.get(id);
    if (cur) cur.retrievals += n; else byId.set(id, { views: 0, retrievals: n });
  }
  const ids = [...byId.keys()].sort();
  await tx`update posts p set views = p.views + c.v, retrievals = p.retrievals + c.r
             from unnest(${ids}::text[], ${ids.map((id) => byId.get(id)!.views)}::bigint[], ${ids.map((id) => byId.get(id)!.retrievals)}::bigint[]) as c(id, v, r)
            where p.id = c.id
              and p.id in (select id from posts where id = any(${ids}::text[]) for update skip locked)`;
}
