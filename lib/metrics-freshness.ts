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

/** What the snapshot carries that this module reads: an ISO timestamp set when it was computed. */
export type Stamped = { generated_at?: string };

/**
 * Milliseconds between `generated_at` and `nowMs`, or Infinity when the stamp is missing or does
 * not parse, so a value nobody can date is never taken for a fresh one.
 */
export function snapshotAgeMs(s: Stamped | null | undefined, nowMs: number): number {
  const t = s?.generated_at ? Date.parse(s.generated_at) : NaN;
  return Number.isNaN(t) ? Infinity : nowMs - t;
}

/**
 * Wraps a cached read so that what it returns is never older than `maxAgeMs`.
 *
 * `read` is the shared cache, which answers with a stale entry while it revalidates and keeps that
 * entry for as long as revalidation does not land. When `read` hands back something older than
 * `maxAgeMs`, the wrapper answers with `compute` instead. Computed values are shared per process:
 * concurrent callers wait on one computation, and later ones reuse its result while it is young
 * enough, so a cache that stays stale costs at most one computation per process per `maxAgeMs`.
 * A computation that rejects rejects its callers and is not kept.
 */
export function boundedAge<T extends Stamped>(read: () => Promise<T>, compute: () => Promise<T>, maxAgeMs: number, now: () => number = Date.now): () => Promise<T> {
  let pending: Promise<T> | null = null;
  let computed: T | null = null;
  return async () => {
    const cached = await read();
    if (snapshotAgeMs(cached, now()) <= maxAgeMs) return cached;
    if (computed && snapshotAgeMs(computed, now()) <= maxAgeMs) return computed;
    pending ??= compute().then(
      (v) => { computed = v; pending = null; return v; },
      (e: unknown) => { pending = null; throw e; },
    );
    return pending;
  };
}
