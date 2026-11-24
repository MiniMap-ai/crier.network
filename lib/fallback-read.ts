/**
 * A second attempt, on a connection of its own, for the one read a page cannot render without.
 *
 * Many of the shared client's failures are local to it: a query parked behind a wedged or desynced
 * pooled socket, or caught in a pool being replaced. A second client shares none of its sockets, so
 * a read sent there is not parked behind the same thing. lib/page-read.ts wires this to the real clients.
 *
 * No imports, so tests can load it.
 */

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  try {
    return run().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  } catch (error) {
    return Promise.resolve({ ok: false as const, error });
  }
}

const never = new Promise<never>(() => {});
const answered = <T>(s: Promise<Settled<T>>) => s.then((o) => (o.ok ? o : never));

export type HedgeOpts = {
  /** Start the fallback if the primary has not answered within this many ms. */
  afterMs: number;
  /** Milliseconds left of the budget both attempts share. */
  left: () => number;
  /** The least of that budget worth starting the fallback with. */
  minMs: number;
  /** The fallback is starting: the primary was `slow`, or `failed` with `error`. */
  onRetry?: (why: "slow" | "failed", error?: unknown) => void;
  /** The fallback's answer is the one being returned. */
  onRecovered?: () => void;
};

/**
 * Run `primary`; if it has not answered after `afterMs`, or fails sooner, run `fallback` too while
 * at least `minMs` of the budget is left. The first answer wins. If both fail, the primary's error is
 * thrown. The loser is left to finish on its own bound, and its rejection is absorbed here.
 *
 * Both attempts must be bounded by the same budget `left` reports: this function adds no deadline of
 * its own, so it waits as long as the slower of the two.
 */
export async function hedgedRead<T>(primary: () => Promise<T>, fallback: () => Promise<T>, opts: HedgeOpts): Promise<T> {
  const first = settle(primary);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<"slow">((resolve) => { timer = setTimeout(() => resolve("slow"), opts.afterMs); });
  const early = await Promise.race([first, slow]);
  clearTimeout(timer);
  if (early !== "slow" && early.ok) return early.value;
  if (opts.left() < opts.minMs) {
    const o = await first;
    if (o.ok) return o.value;
    throw o.error;
  }

  opts.onRetry?.(early === "slow" ? "slow" : "failed", early === "slow" ? undefined : early.error);
  const second = settle(fallback);
  const winner = await Promise.race([
    answered(first).then((o) => ({ recovered: false, o })),
    answered(second).then((o) => ({ recovered: true, o })),
    Promise.all([first, second]).then(([a, b]) => (a.ok || !b.ok ? { recovered: false, o: a } : { recovered: true, o: b })),
  ]);
  if (!winner.o.ok) throw winner.o.error;
  if (winner.recovered) opts.onRecovered?.();
  return winner.o.value;
}

/** What this module needs from a postgres.js client. */
type Endable = { end: (opts: { timeout: number }) => unknown };

export type DisposableClient<C> = {
  /** The current client, created on first use and after each retirement. */
  get(): C;
  /** Drain `client` and forget it, unless it has already been replaced. */
  retire(client: C): void;
};

/**
 * A client that is thrown away after a failure, so the next caller gets new sockets rather than the
 * ones that just failed. `retire` takes the client the failed read used, so several reads failing on
 * one client retire it once and never the replacement. A retired client drains for `drainS` seconds,
 * which must outlast any bounded wait still running on it.
 */
export function disposableClient<C extends Endable>(create: () => C, drainS: number): DisposableClient<C> {
  let current: C | undefined;
  return {
    get: () => (current ??= create()),
    retire(client) {
      if (client !== current) return;
      current = undefined;
      try { void Promise.resolve(client.end({ timeout: drainS })).catch(() => {}); } catch { /* best effort */ }
    },
  };
}
