/**
 * What one call to Cohere's /embed came to, and whether to make it once more.
 *
 * lib/cohere.ts makes the call and counts the outcome; this module decides what the outcome was and
 * whether a second attempt fits. It has no imports so `node --test` can load it. The counters are
 * defined in docs/metrics.md, "Embedding failures".
 */

/**
 * Why an attempt produced no embedding. `abort` is the timer lib/cohere.ts sets on every request:
 * nothing else holds the request's AbortController, so an abort is always our own deadline.
 */
export type EmbedFailure =
  | { cause: "abort"; ms: number }
  | { cause: "status"; status: number }
  | { cause: "network"; message: string };

/** The call sites, as they appear in `embed:failed:<site>`. */
export type EmbedSite = "search" | "subscription" | "post_create" | "post_update" | "backfill";

/** What a failed attempt threw, given whether our timer had fired by then. */
export function classifyThrown(aborted: boolean, ms: number, e: unknown): EmbedFailure {
  if (aborted) return { cause: "abort", ms };
  return { cause: "network", message: e instanceof Error ? e.message : String(e) };
}

/** The `daily_counters` key one failed attempt is counted under. */
export function failureCounter(f: EmbedFailure): "error:embed_abort" | "error:embed_error" {
  return f.cause === "abort" ? "error:embed_abort" : "error:embed_error";
}

/** The pause before the one retry, in milliseconds. */
export const EMBED_RETRY_BACKOFF_MS = 500;

/**
 * Should a failed attempt be made once more? Only the first attempt is ever retried, and only when
 * the caller passed a deadline (epoch milliseconds) that the pause plus a full second attempt fits
 * before. A caller without one, such as a search inside a 10 s route, never retries. A 4xx other
 * than 429 is a request Cohere will refuse again, so it is not retried.
 */
export function shouldRetryEmbed(f: EmbedFailure, at: { attempt: number; now: number; deadline?: number; attemptMs: number }): boolean {
  if (at.attempt !== 1 || at.deadline === undefined) return false;
  if (f.cause === "status" && f.status !== 429 && f.status < 500) return false;
  return at.deadline - at.now >= EMBED_RETRY_BACKOFF_MS + at.attemptMs;
}
