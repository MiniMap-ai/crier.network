/**
 * Bounded database waits.
 *
 * postgres.js has no timeout of its own for the wait that matters. `connect_timeout` covers TCP and
 * authentication only; once the pooler has authenticated a client, a query waiting for a pooler
 * backend looks from here like a live connection that has not replied yet. And when all `max`
 * connections are busy, later queries are parked in an unbounded queue with no timer on it at all.
 * So a stalled pooler does not produce errors, it produces requests that wait forever — which under
 * Fluid compute, where one instance serves many concurrent requests, takes down every render routed
 * to that instance until the platform kills it.
 *
 * Everything on the request path goes through withTimeout. It lives in its own module, free of
 * imports, so it can be unit-tested without a database or a bundler. noteTimeout replaces the client
 * when reads have done nothing but time out for longer than one is allowed to wait;
 * retryIfConnectionLost reruns a read that lost its connection rather than its budget.
 *
 * A bound is not enough on its own for a write nobody awaits. `void withTimeoutOr(...)` on the
 * request path leaves the promise and this module's timer unregistered, so Fluid compute may
 * suspend the instance under them and the timer fires, cancels and logs inside a later, unrelated
 * invocation — the `bumpViews` group of 2026-09-10. Use `sideWrite` from lib/db.ts for those: it
 * registers the work with the platform, applies the same bound, and counts the loss. Nothing on
 * the request path should go back to a bare `void withTimeoutOr(...)`.
 */

function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Budget for a read on the request path, counted from the moment it is queued. */
export const DB_TIMEOUT_MS = int("CRIER_DB_TIMEOUT_MS", 8000);
/** Budget for a read the caller can do without: related posts, replies, board counts. */
export const DB_SIDE_TIMEOUT_MS = int("CRIER_DB_SIDE_TIMEOUT_MS", 2500);
/** Consecutive timeouts, with no read succeeding in between, before the pool is replaced. */
const RESET_AFTER_TIMEOUTS = int("CRIER_DB_RESET_AFTER_TIMEOUTS", 5);
/**
 * How long that run must have lasted, from its first timeout. A burst of concurrent requests lands
 * inside the budget they share and cannot reach this; a wedged pool does on the next request in.
 */
const RESET_AFTER_MS = int("CRIER_DB_RESET_AFTER_MS", DB_TIMEOUT_MS);
/**
 * Seconds a replaced client gets to finish in-flight work before its sockets are destroyed. Longer
 * than either budget, so a query someone is waiting on reaches its own deadline first. The flush's
 * wait in lib/metrics.ts has to stay under this too.
 */
const DRAIN_TIMEOUT_S = Math.ceil(Math.max(DB_TIMEOUT_MS, DB_SIDE_TIMEOUT_MS) / 1000) + 2;

/**
 * A read gave up before the database answered. Distinguishable on purpose: handlers turn it into a
 * 503 with Retry-After, pages degrade instead of hanging, and it is counted on its own
 * (`error:db_timeout`) rather than as an application error.
 */
export class DbTimeoutError extends Error {
  readonly code = "db_timeout";
  readonly ms: number;
  readonly label: string | undefined;
  constructor(ms: number, label?: string) {
    super(`The database did not answer within ${ms} ms${label ? ` (${label})` : ""}.`);
    this.name = "DbTimeoutError";
    this.ms = ms;
    this.label = label;
  }
}

/**
 * The codes a connection-level failure arrives with. SQLSTATE class 08 is how the Supabase pooler
 * reports a backend it could not open (`08006 Failed to connect to database: {:error, :timeout}`,
 * 2026-10-17); the rest are postgres.js's own and Node's, for a socket that never came up or went
 * away under a query. None of them is a timeout of ours: no query was ever waiting.
 */
const CONNECT_CODES = new Set(["CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"]);

/**
 * Did the database connection fail, rather than a query run long? Handlers answer 503 for it as they
 * do for a timeout, pages count it, and both record `error:db_connect`, so a pooler that refused a
 * connection is told apart from one that was slow. Before this, a refused connection on /p/[id] was
 * an unhandled render error that no counter saw (CRI-58).
 */
export function isDbConnectError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("08") || CONNECT_CODES.has(code));
}

/** What this module needs from a postgres.js pending query. Plain promises are accepted too. */
type Pending<T> = PromiseLike<T> & { execute?: () => unknown; cancel?: () => unknown };

/** The one method this module needs from the shared client, kept structural to avoid an import cycle. */
type PoolClient = { end: (opts: { timeout: number }) => unknown };

let consecutiveTimeouts = 0;
/** When the first timeout of the current run landed; undefined while reads are answering. */
let runStartedAt: number | undefined;

function noteHealthy() {
  consecutiveTimeouts = 0;
  runStartedAt = undefined;
}

/**
 * A read timed out. RESET_AFTER_TIMEOUTS in a row spanning RESET_AFTER_MS, and the client is
 * replaced: postgres.js never retires a connection whose query never answers, so a pool whose
 * sockets are alive but silent would otherwise fail for the rest of the instance's life. The count
 * alone is not evidence of that — five concurrent reads on a cold instance can hit their deadlines
 * in the same second while their connections are still coming up, which is how CRI-70 was served —
 * so the run has to outlive a full read budget as well, which no single burst can.
 *
 * The old client is drained, not destroyed: `end({ timeout: 0 })` failed every query still on it
 * with CONNECTION_DESTROYED, the page's primary read and the metrics flush included.
 */
function noteTimeout() {
  const now = Date.now();
  runStartedAt ??= now;
  if (++consecutiveTimeouts < RESET_AFTER_TIMEOUTS) return;
  if (now - runStartedAt < RESET_AFTER_MS) return;
  const age = now - runStartedAt;
  noteHealthy();
  const holder = globalThis as { __crier_sql?: PoolClient };
  const stale = holder.__crier_sql;
  holder.__crier_sql = undefined;
  if (!stale) return;
  console.error(`db: ${RESET_AFTER_TIMEOUTS} consecutive read timeouts over ${age} ms; replacing the connection pool, draining the old one`);
  try { void Promise.resolve(stale.end({ timeout: DRAIN_TIMEOUT_S })).catch(() => {}); } catch { /* best effort */ }
}

/**
 * Bound a database wait. Rejects with DbTimeoutError if the query has not answered in time, and
 * cancels it so its connection is not held for the rest of the request.
 *
 * The clock starts when the query is queued rather than when it gets a connection: a request that
 * never gets a connection has to fail on the same budget as one that does. `execute()` enqueues the
 * query here instead of leaving it until the first `await`.
 */
export function withTimeout<T>(query: Pending<T>, opts: { ms?: number; label?: string } = {}): Promise<T> {
  const ms = opts.ms ?? DB_TIMEOUT_MS;
  try { query.execute?.(); } catch { /* not a postgres.js query; race it as it is */ }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // For a query still in the queue, cancel() removes it and rejects it. For one already sent, it
      // opens a side connection and asks Postgres to cancel. Either way the slot comes back instead
      // of staying busy behind a wait nobody is reading any more.
      try { void Promise.resolve(query.cancel?.()).catch(() => {}); } catch { /* best effort */ }
      reject(new DbTimeoutError(ms, opts.label));
    }, ms);
  });
  return Promise.race([query, expiry]).then(
    (value) => { clearTimeout(timer); noteHealthy(); return value as T; },
    (e: unknown) => { clearTimeout(timer); if (e instanceof DbTimeoutError) noteTimeout(); throw e; },
  );
}

/** Same budget as withTimeout, for a read whose absence the caller can render around. */
export function withTimeoutOr<T, F>(query: Pending<T>, fallback: F, opts: { ms?: number; label?: string } = {}): Promise<T | F> {
  return withTimeout(query, opts).catch((e: unknown) => {
    console.error("db read failed", opts.label ?? "", (e as Error).message);
    return fallback;
  });
}

/**
 * One shared deadline for every read a single request makes. Without it a page that issues four
 * reads has a four-times budget and can still outlive the route's maxDuration; with it, the whole
 * render is bounded by the same number the route is.
 */
export type Budget = (label: string) => { ms: number; label: string };

/**
 * A read started after the budget is spent is meant to fail immediately — the request has already
 * had its allowance, and this is what keeps a route's total database time under its maxDuration
 * however many statements it runs. The floor only exists so the timer is not degenerate; on a
 * healthy database nothing reaches it, because reaching it means seconds of reads have gone before.
 */
const MIN_BUDGET_MS = 100;

export function budget(totalMs: number = DB_TIMEOUT_MS): Budget {
  const until = Date.now() + totalMs;
  return (label: string) => ({ ms: Math.max(MIN_BUDGET_MS, until - Date.now()), label });
}

/**
 * Run a read once more if it died with its connection rather than its budget: a class-08 or
 * postgres.js connection code means the socket went away, and the next `sql()` hands out a live
 * one. A timeout is not retried; the budget is spent. Reads only — a write lost during COMMIT may
 * have applied, so the metrics flush does its own retry and stops at COMMIT (lib/metrics.ts).
 */
export async function retryIfConnectionLost<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    if (!isDbConnectError(e)) throw e;
    console.warn("db read lost its connection; trying once more", (e as { code?: string }).code ?? "", (e as Error).message);
    return await attempt();
  }
}

/** Test seam: forget how many reads have timed out in a row. */
export function __resetDbHealth() {
  noteHealthy();
}
