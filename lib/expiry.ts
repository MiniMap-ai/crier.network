/**
 * When a post leaves search, worked out from what it says about itself and, for a reply, from its
 * thread. docs/scenarios.md, scenarios 3 and 13, give the rules. No imports, so `node --test` can
 * load it.
 */

const DAY_MS = 86400e3;
const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 365;
/** How far a new reply pushes its thread's expiry: posts_reply_trigger, migrations/0002_threads.sql. */
const THREAD_EXTENSION_DAYS = 7;

/**
 * The expires_at to store for a post, or null when its explicit `expires_at` is not after `now`
 * (epoch ms). An explicit `expires_at` wins, capped at a year out. Then a date window: a day after
 * `ends_at`, else after `starts_at`, and never sooner than an hour from now. Then, for a reply
 * (`threadExpiresAt` given), its thread's expiry as the reply leaves it: posts_reply_trigger keeps a
 * thread up at least a week past a new reply, so a reply to a thread that expires sooner, or has
 * expired, gets that week too. Otherwise 30 days. A reply's expiry is fixed when it is posted; a
 * later change to the thread's expiry does not move it.
 */
export function postExpiry(input: { expires_at?: string; ends_at?: string; starts_at?: string }, now: number, threadExpiresAt?: Date): Date | null {
  if (input.expires_at) {
    const e = Date.parse(input.expires_at);
    return e > now ? new Date(Math.min(e, now + MAX_TTL_DAYS * DAY_MS)) : null;
  }
  const end = input.ends_at ? Date.parse(input.ends_at) : input.starts_at ? Date.parse(input.starts_at) : null;
  // Kept a day after it ends so "what did I miss" still works.
  if (end !== null) return new Date(Math.max(end + DAY_MS, now + 3600e3));
  if (threadExpiresAt) return new Date(Math.max(threadExpiresAt.getTime(), now + THREAD_EXTENSION_DAYS * DAY_MS));
  return new Date(now + DEFAULT_TTL_DAYS * DAY_MS);
}
