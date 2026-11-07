/**
 * The daily-table half of the metrics flush: what one flush writes to `daily_counters`,
 * `daily_actors`, `stats_daily` and `search_log`, and the order it writes it in.
 *
 * Two flushes from different instances often touch the same rows (`route:GET /feed.xml`,
 * `search:total`, today's `stats_daily` row), and each holds the row locks it took until COMMIT.
 * So the rows are sorted by key and the tables always come in the same order: two flushes can then
 * only queue behind each other, never wait in a cycle. And nothing slow shares the transaction — the
 * per-post counters run in a transaction of their own (lib/metrics.ts) — so the wait is one
 * flush's remaining upserts. docs/metrics.md, "Lock order", has the argument.
 *
 * No imports, like lib/side-writes.ts, so a test can check the statements against a recorder.
 */

export type ActorCount = { role: string; actor: string; n: number };

/** The fields of a search_log shape the flush writes, as lib/search-log.ts's ShapeCount carries them. */
export type SearchCount = {
  q: string | null; kind: string | null; tags: string | null; near: string | null; radius_km: number | null;
  source: string; n: number; zero: number; embed_failed: number;
};

/** One flush's daily-table writes, every list in lock order. Build it with orderBatch. */
export type CounterBatch = {
  counters: [string, number][];
  actors: ActorCount[];
  stats: [string, number][];
  searches: SearchCount[];
};

/** The tagged template of a postgres.js transaction. `unknown` for the reason lib/side-writes.ts gives for Tx. */
export type TxSql = (strings: TemplateStringsArray, ...args: unknown[]) => unknown;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The same tuple search_log_shape_idx enforces, so equal shapes sort together. */
const searchKey = (s: SearchCount) => JSON.stringify([s.q, s.kind, s.tags, s.near, s.radius_km, s.source]);

/**
 * Sort what accumulated into lock order. The result depends only on the contents, never on the order
 * things were counted in. Callers fold duplicates first (the in-process maps do); this does not.
 */
export function orderBatch(input: {
  counters: Iterable<[string, number]>;
  actors: Iterable<ActorCount>;
  stats: Iterable<[string, number]>;
  searches: Iterable<SearchCount>;
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
 * The batch's statements, in lock order, started in that order. Await them together: postgres.js
 * pipelines queries on a connection, so the whole batch goes out in one flight and no row lock waits
 * on a round trip to this process. One statement per table, except `bump_stat` and `bump_search`,
 * which are one per distinct column or shape because the functions take one at a time.
 */
export function batchStatements(tx: TxSql, b: CounterBatch): unknown[] {
  const out: unknown[] = [];
  if (b.counters.length) {
    out.push(tx`insert into daily_counters (day, key, n)
               select current_date, k, n from unnest(${b.counters.map((c) => c[0])}::text[], ${b.counters.map((c) => c[1])}::bigint[]) as t(k, n)
               on conflict (day, key) do update set n = daily_counters.n + excluded.n`);
  }
  if (b.actors.length) {
    out.push(tx`insert into daily_actors (day, role, actor, n)
               select current_date, r, a, n from unnest(${b.actors.map((a) => a.role)}::text[], ${b.actors.map((a) => a.actor)}::text[], ${b.actors.map((a) => a.n)}::integer[]) as t(r, a, n)
               on conflict (day, role, actor) do update set n = daily_actors.n + excluded.n`);
  }
  for (const [col, n] of b.stats) out.push(tx`select bump_stat(${col}, ${n})`);
  for (const g of b.searches) out.push(tx`select bump_search(${g.q}, ${g.kind}, ${g.tags}, ${g.near}, ${g.radius_km}, ${g.source}, ${g.n}, ${g.zero}, ${g.embed_failed})`);
  return out;
}

/** How many counter keys a loss line names before it summarizes the rest. */
export const LOST_KEYS_SHOWN = 40;

/**
 * One line saying what a failed flush took with it: every counter key and count up to
 * LOST_KEYS_SHOWN, then totals. `route:` keys name the requests whose counts were lost.
 */
export function describeBatch(b: CounterBatch): string {
  const shown = b.counters.slice(0, LOST_KEYS_SHOWN).map(([k, n]) => `${k}=${n}`).join(", ");
  const more = b.counters.length > LOST_KEYS_SHOWN ? ` and ${b.counters.length - LOST_KEYS_SHOWN} more` : "";
  return `counters [${shown}${more}]; ${b.actors.length} actors, ${b.stats.map(([c, n]) => `${c}=${n}`).join(", ") || "no stats"}, ${b.searches.length} search shapes`;
}
