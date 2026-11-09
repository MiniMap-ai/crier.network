/**
 * The daily-table half of the metrics flush: what one flush writes to `daily_counters`,
 * `daily_actors`, `stats_daily` and `search_log`, and the order it writes it in.
 *
 * Flushes from different instances touch the same rows and hold their locks until COMMIT, so rows
 * are sorted by key and tables come in a fixed order: two flushes can only queue behind each other,
 * never wait in a cycle. Nothing slow shares the transaction; docs/metrics.md, "Lock order".
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

/** The tagged template of a postgres.js transaction. `unknown` for the reason lib/side-writes.ts gives for Tx. */
export type TxSql = (strings: TemplateStringsArray, ...args: unknown[]) => unknown;

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

/**
 * Write the batch one statement at a time, in lock order. Each waits for the one before, so a
 * failure is the last statement the transaction sends and ROLLBACK follows it at once, rather than
 * behind statements already queued for an aborted transaction. One statement per table, except
 * `bump_stat` and `bump_search`, which take one column or shape per call.
 */
export async function writeBatch(tx: TxSql, b: CounterBatch): Promise<void> {
  if (b.counters.length) {
    await tx`insert into daily_counters (day, key, n)
             select current_date, k, n from unnest(${b.counters.map((c) => c[0])}::text[], ${b.counters.map((c) => c[1])}::bigint[]) as t(k, n)
             on conflict (day, key) do update set n = daily_counters.n + excluded.n`;
  }
  if (b.actors.length) {
    await tx`insert into daily_actors (day, role, actor, n)
             select current_date, r, a, n from unnest(${b.actors.map((a) => a.role)}::text[], ${b.actors.map((a) => a.actor)}::text[], ${b.actors.map((a) => a.n)}::integer[]) as t(r, a, n)
             on conflict (day, role, actor) do update set n = daily_actors.n + excluded.n`;
  }
  for (const [col, n] of b.stats) await tx`select bump_stat(${col}, ${n})`;
  for (const g of b.searches) await tx`select bump_search(${g.q}, ${g.kind}, ${g.tags}, ${g.near}, ${g.radius_km}, ${g.source}, ${g.n}, ${g.zero}, ${g.embed_failed})`;
}

/** Opens a transaction, runs `body` in it and commits: sql().begin under the flush's limits and bound. */
export type Begin = (body: (tx: TxSql) => Promise<void>) => Promise<unknown>;

/**
 * Run `work` in one transaction, and once more on a fresh connection if the first lost its
 * connection before COMMIT was next: that attempt applied nothing. One lost during COMMIT may have
 * applied, and every write here adds, so that error is thrown rather than risked twice.
 */
export async function transactOnce(begin: Begin, work: (tx: TxSql) => Promise<void>, isConnectError: (e: unknown) => boolean, label: string): Promise<void> {
  let committing = false;
  const attempt = () => begin(async (tx) => {
    await work(tx);
    committing = true;
  });
  try {
    await attempt();
  } catch (e) {
    if (!isConnectError(e) || committing) throw e;
    console.warn("metrics flush lost its connection before COMMIT; trying once more", label, (e as { code?: string }).code ?? "", (e as Error).message);
    await attempt();
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
