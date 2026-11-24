/**
 * The daily-table half of the metrics flush: what one flush writes to `daily_counters`,
 * `daily_actors`, `stats_daily` and `search_log`, the order it writes it in, and what is saved
 * when that write fails.
 *
 * The batch is one statement, `metrics_flush(jsonb)` (migrations/0024_metrics_flush.sql), so the
 * flush opens no transaction a lost client could leave open. Flushes from different instances touch
 * the same rows, so rows are sorted by key and tables come in a fixed order: two flushes can only
 * queue behind each other, never wait in a cycle. docs/metrics.md, "Lock order".
 *
 * Imports types only, which `node --test` strips, so a test can check the statements against a
 * recorder.
 */
import type { ShapeCount } from "./search-log.ts";

export type ActorCount = { role: string; actor: string; n: number };

/** One flush's daily-table writes, every list in lock order. Build it with orderBatch. */
export type CounterBatch = {
  counters: [string, number][];
  actors: ActorCount[];
  stats: [string, number][];
  searches: ShapeCount[];
};

/** A postgres.js tagged template. `unknown` for the reason lib/side-writes.ts gives for Tx. */
export type SqlTag = (strings: TemplateStringsArray, ...args: unknown[]) => unknown;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The same tuple search_log_shape_idx enforces, so equal shapes sort together. */
const searchKey = (s: ShapeCount) => JSON.stringify([s.q, s.kind, s.tags, s.near, s.radius_km, s.source]);

/**
 * Sort what accumulated into lock order. The result depends only on the contents, never on the order
 * things were counted in. Callers fold duplicates first (the in-process maps do); this does not.
 */
export function orderBatch(input: {
  counters: Iterable<[string, number]>;
  actors: Iterable<ActorCount>;
  stats: Iterable<[string, number]>;
  searches: Iterable<ShapeCount>;
}): CounterBatch {
  return {
    counters: [...input.counters].sort((a, b) => byText(a[0], b[0])),
    actors: [...input.actors].sort((a, b) => byText(a.role, b.role) || byText(a.actor, b.actor)),
    stats: [...input.stats].sort((a, b) => byText(a[0], b[0])),
    searches: [...input.searches].map((s) => [searchKey(s), s] as const).sort((a, b) => byText(a[0], b[0])).map(([, s]) => s),
  };
}

export function isEmptyBatch(b: CounterBatch): boolean {
  return !b.counters.length && !b.actors.length && !b.stats.length && !b.searches.length;
}

/** The argument `metrics_flush` reads: each list as the batch holds it, so the function keeps its order. */
export function flushPayload(b: CounterBatch) {
  return {
    counters: b.counters.map(([key, n]) => ({ key, n })),
    actors: b.actors.map(({ role, actor, n }) => ({ role, actor, n })),
    stats: b.stats.map(([col, n]) => ({ col, n })),
    searches: b.searches.map((s) => ({ q: s.q, kind: s.kind, tags: s.tags, near: s.near, radius_km: s.radius_km, source: s.source, n: s.n, zero: s.zero, embed_failed: s.embed_failed })),
  };
}

/**
 * The whole batch as one statement, returned unsent so the caller's withTimeout can queue it and
 * cancel it. It is its own transaction: it applies all of the batch or none of it.
 */
export function writeBatch(sql: SqlTag, b: CounterBatch): unknown {
  return sql`select metrics_flush(${flushPayload(b)}::jsonb)`;
}

/** Lands beside a failed batch's error counters: one per daily batch that did not write. */
export const FLUSH_FAILED_KEY = "error:metrics_flush_failed";

/** The only keys saveCountersStatement writes, because it writes them as SQL literals. */
const SAVABLE_KEY = /^error:[a-z0-9_.:-]{1,100}$/;

/**
 * What a daily batch that failed must not take with it: its `error:` counters, plus one
 * FLUSH_FAILED_KEY, in lock order. Other counters, actors, stats and shapes are left to the loss line.
 */
export function errorCountersOf(b: CounterBatch): [string, number][] {
  const kept = new Map(b.counters.filter(([k, n]) => SAVABLE_KEY.test(k) && Number.isSafeInteger(n) && n > 0));
  kept.set(FLUSH_FAILED_KEY, (kept.get(FLUSH_FAILED_KEY) ?? 0) + 1);
  return [...kept].sort((a, b) => byText(a[0], b[0]));
}

/**
 * One simple-protocol query adding `counters` to today's `daily_counters` rows. It binds no
 * parameters and opens no transaction block, so neither the binding nor the BEGIN that failed a flush
 * can fail it. Its SET LOCAL holds in the implicit transaction of a multi-statement query. Throws on
 * a key or count it cannot write as a literal; errorCountersOf yields only ones it can.
 */
export function saveCountersStatement(counters: [string, number][], lockTimeoutMs: number): string {
  const rows = counters.map(([k, n]) => {
    if (!SAVABLE_KEY.test(k) || !Number.isSafeInteger(n) || n <= 0) throw new Error(`cannot save counter ${JSON.stringify(k)}=${n} as a literal`);
    return `(current_date, '${k}', ${n})`;
  });
  return `set local lock_timeout = '${Math.max(1, Math.round(lockTimeoutMs))}ms'; ` +
    `insert into daily_counters (day, key, n) values ${rows.join(", ")} on conflict (day, key) do update set n = daily_counters.n + excluded.n`;
}

/**
 * After a daily batch failed: write its error counters once through `write`, which must reach the
 * database by a client other than the one that failed. Never retried here, since the request may be
 * dying. Returns what is still unwritten, for the caller to carry to its next flush: nothing, or all
 * of them.
 */
export async function saveErrorCounters(b: CounterBatch, write: (statement: string) => Promise<unknown>, lockTimeoutMs: number): Promise<[string, number][]> {
  const counters = errorCountersOf(b);
  const shown = counters.map(([k, n]) => `${k}=${n}`).join(", ");
  try {
    await write(saveCountersStatement(counters, lockTimeoutMs));
    console.warn("metrics flush saved its error counters", shown);
    return [];
  } catch (e) {
    console.error("metrics flush could not save its error counters; carrying them to the next flush", (e as { code?: string }).code ?? "", (e as Error).message, shown);
    return counters;
  }
}

/** How many counter keys a loss line names before it summarizes the rest. */
export const LOST_KEYS_SHOWN = 40;

/**
 * One line saying what a failed flush took with it: counter keys and counts up to LOST_KEYS_SHOWN
 * and how many more there were, the stats columns, and how many actors and search shapes. `route:`
 * keys name the requests whose counts were lost.
 */
export function describeBatch(b: CounterBatch): string {
  const shown = b.counters.slice(0, LOST_KEYS_SHOWN).map(([k, n]) => `${k}=${n}`).join(", ");
  const more = b.counters.length > LOST_KEYS_SHOWN ? ` and ${b.counters.length - LOST_KEYS_SHOWN} more` : "";
  return `counters [${shown}${more}]; ${b.actors.length} actors, ${b.stats.map(([c, n]) => `${c}=${n}`).join(", ") || "no stats"}, ${b.searches.length} search shapes`;
}
