/**
 * How old the metrics snapshot may be when /api/v1/metrics and /stats serve it. docs/metrics.md
 * ("How fresh the numbers are") is the contract these numbers implement.
 *
 * No imports, so it can be tested without a database or a bundler.
 */

/** Seconds a client or CDN may reuse a /api/v1/metrics response: the `max-age` it sends. */
export const METRICS_MAX_AGE_S = 300;

/**
 * Seconds the data cache keeps a snapshot before revalidating it in the background. No greater
 * than METRICS_MAX_AGE_S; tests/metrics-freshness.test.ts holds the two together.
 */
export const METRICS_REVALIDATE_S = 60;

/** Seconds after a failed computation during which a stale snapshot is served without retrying. */
export const METRICS_RETRY_AFTER_S = 30;

/** What the snapshot carries that this module reads: an ISO timestamp set when it was computed. */
export type Stamped = { generated_at?: string };

/**
 * Milliseconds between `generated_at` and `nowMs`, or Infinity when the stamp is missing, does
 * not parse, or is later than `nowMs`, so a value nobody can date is never taken for a fresh one.
 */
export function snapshotAgeMs(s: Stamped | null | undefined, nowMs: number): number {
  const t = s?.generated_at ? Date.parse(s.generated_at) : NaN;
  return Number.isNaN(t) || t > nowMs ? Infinity : nowMs - t;
}

export type BoundedAgeOptions = {
  maxAgeMs: number;
  /** After a failed computation, how long stale values are served before computing again. */
  retryAfterMs: number;
  /** Called once per failed computation, before any caller is handed the stale value. */
  onComputeFailed?: (e: unknown) => void;
  /** Called each time a caller is handed a value older than `maxAgeMs` because computing failed. */
  onStaleServed?: () => void;
  now?: () => number;
};

/**
 * Wraps a cached read so that what it returns is no older than `maxAgeMs` while computing works.
 *
 * `read` is the shared cache, which answers with a stale entry while it revalidates and keeps that
 * entry for as long as revalidation does not land. When `read` hands back something older than
 * `maxAgeMs`, the wrapper answers with `compute` instead. Computed values are shared per process:
 * concurrent callers wait on one computation, and later ones reuse its result while it is young
 * enough, so a cache that stays stale costs at most one computation per process per `maxAgeMs`.
 *
 * When a computation rejects, its callers get the youngest stale value they have, and for
 * `retryAfterMs` later callers get theirs without a new computation. Only `read` itself throwing,
 * which means there is no cached value at all, reaches the caller as an error.
 */
export function boundedAge<T extends Stamped>(read: () => Promise<T>, compute: () => Promise<T>, opts: BoundedAgeOptions): () => Promise<T> {
  const now = opts.now ?? Date.now;
  let pending: Promise<T> | null = null;
  let computed: T | null = null;
  let failedAt = -Infinity;
  const serveStale = (stale: T) => { opts.onStaleServed?.(); return stale; };
  return async () => {
    const cached = await read();
    if (snapshotAgeMs(cached, now()) <= opts.maxAgeMs) return cached;
    if (computed && snapshotAgeMs(computed, now()) <= opts.maxAgeMs) return computed;
    const stale = computed && snapshotAgeMs(computed, now()) < snapshotAgeMs(cached, now()) ? computed : cached;
    if (!pending && now() - failedAt < opts.retryAfterMs) return serveStale(stale);
    pending ??= compute().then(
      (v) => { computed = v; pending = null; return v; },
      (e: unknown) => { pending = null; failedAt = now(); opts.onComputeFailed?.(e); throw e; },
    );
    return pending.catch(() => serveStale(stale));
  };
}
