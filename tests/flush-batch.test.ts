import { test } from "node:test";
import assert from "node:assert/strict";
import { FLUSH_FAILED_KEY, LOST_KEYS_SHOWN, describeBatch, errorCountersOf, flushPayload, isEmptyBatch, orderBatch, saveCountersStatement, saveErrorCounters, writeBatch } from "../lib/flush-batch.ts";
import type { ActorCount, SqlTag } from "../lib/flush-batch.ts";
import type { ShapeCount } from "../lib/search-log.ts";

/** Stands in for a postgres.js client: records each statement's text and parameters, in call order. */
function recorder() {
  const statements: { sql: string; args: unknown[] }[] = [];
  const sql: SqlTag = (strings, ...args) => {
    statements.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), args });
    return Promise.resolve([]);
  };
  return { sql, statements };
}

const shape = (q: string | null, source: ShapeCount["source"] = "rest"): ShapeCount =>
  ({ q, kind: null, tags: null, near: null, radius_km: null, source, n: 1, zero: 0, embed_failed: 0 });

const counters: [string, number][] = [["route:GET /feed.xml", 3], ["search:total", 2], ["cron:tick", 1], ["page:human", 4]];
const actors: ActorCount[] = [{ role: "seeker", actor: "b", n: 1 }, { role: "mcp_client", actor: "z", n: 2 }, { role: "seeker", actor: "a", n: 1 }];
const stats: [string, number][] = [["searches", 2], ["retrievals", 9]];
const searches = [shape("tacos"), shape(null), shape("jobs", "feed")];

async function statementsFor(input: Parameters<typeof orderBatch>[0]) {
  const r = recorder();
  await writeBatch(r.sql, orderBatch(input));
  return r.statements;
}

test("a flush writes the whole daily batch in one statement, which opens no transaction", async () => {
  const statements = await statementsFor({ counters, actors, stats, searches });
  assert.equal(statements.length, 1);
  assert.equal(statements[0].sql, "select metrics_flush(?::jsonb)");
  assert.doesNotMatch(statements[0].sql, /\bbegin\b/i);
});

test("each list reaches metrics_flush sorted by key, which is the order it takes row locks in", async () => {
  const [{ args: [p] }] = await statementsFor({ counters, actors, stats, searches });
  const payload = p as ReturnType<typeof flushPayload>;
  assert.deepEqual(payload.counters, [{ key: "cron:tick", n: 1 }, { key: "page:human", n: 4 }, { key: "route:GET /feed.xml", n: 3 }, { key: "search:total", n: 2 }]);
  assert.deepEqual(payload.actors.map((a) => `${a.role}:${a.actor}`), ["mcp_client:z", "seeker:a", "seeker:b"]);
  assert.deepEqual(payload.stats, [{ col: "retrievals", n: 9 }, { col: "searches", n: 2 }]);
  assert.deepEqual(payload.searches.map((s) => s.q), ["jobs", "tacos", null]);
});

test("the same counts gathered in a different order produce the same statement", async () => {
  const forward = await statementsFor({ counters, actors, stats, searches });
  const reversed = await statementsFor({
    counters: [...counters].reverse(), actors: [...actors].reverse(), stats: [...stats].reverse(), searches: [...searches].reverse(),
  });
  assert.deepEqual(reversed, forward);
});

test("a search shape reaches metrics_flush with every field bump_search takes", () => {
  const full: ShapeCount = { q: "tacos", kind: "event", tags: "food", near: "40.5,-74.0", radius_km: 10, source: "mcp", n: 3, zero: 1, embed_failed: 1 };
  const [s] = flushPayload(orderBatch({ counters: [], actors: [], stats: [], searches: [full] })).searches;
  assert.deepEqual(s, { q: "tacos", kind: "event", tags: "food", near: "40.5,-74.0", radius_km: 10, source: "mcp", n: 3, zero: 1, embed_failed: 1 });
});

test("search shapes are ordered by their whole shape, so a null field sorts the same every time", async () => {
  const [a, b] = [await statementsFor({ counters: [], actors: [], stats: [], searches }), await statementsFor({ counters: [], actors: [], stats: [], searches: [searches[2], searches[0], searches[1]] })];
  assert.deepEqual(a, b);
});

test("an empty batch is recognised, so the flush sends nothing for it", () => {
  assert.ok(isEmptyBatch(orderBatch({ counters: [], actors: [], stats: [], searches: [] })));
  assert.ok(!isEmptyBatch(orderBatch({ counters: [["cron:tick", 1]], actors: [], stats: [], searches: [] })));
});

test("a lost flush is described by its counter keys, so the routes it carried are in the log", () => {
  const line = describeBatch(orderBatch({ counters, actors, stats, searches }));
  assert.match(line, /route:GET \/feed\.xml=3/);
  assert.match(line, /cron:tick=1/);
  assert.match(line, /3 actors/);
  assert.match(line, /retrievals=9, searches=2/);
  assert.match(line, /3 search shapes/);
});

test("a loss line names at most LOST_KEYS_SHOWN keys and counts the rest", () => {
  const many: [string, number][] = Array.from({ length: LOST_KEYS_SHOWN + 5 }, (_, i) => [`k${String(i).padStart(3, "0")}`, 1]);
  const line = describeBatch(orderBatch({ counters: many, actors: [], stats: [], searches: [] }));
  assert.match(line, /and 5 more/);
  assert.doesNotMatch(line, new RegExp(`k${String(LOST_KEYS_SHOWN).padStart(3, "0")}=`));
});

/* ---------------- what a failed daily batch keeps ---------------- */

const withErrors = orderBatch({
  counters: [...counters, ["error:5xx", 1], ["error:side_write_timeout", 2], ["error:db_timeout", 3]],
  actors, stats, searches,
});

test("a failed batch keeps its error counters and one more for the failure, sorted, and nothing else", () => {
  assert.deepEqual(errorCountersOf(withErrors), [
    ["error:5xx", 1], ["error:db_timeout", 3], [FLUSH_FAILED_KEY, 1], ["error:side_write_timeout", 2],
  ]);
});

test("a failure carried from an earlier flush adds to this one's", () => {
  const carried = orderBatch({ counters: [[FLUSH_FAILED_KEY, 2], ["error:5xx", 1]], actors: [], stats: [], searches: [] });
  assert.deepEqual(errorCountersOf(carried), [["error:5xx", 1], [FLUSH_FAILED_KEY, 3]]);
});

test("a batch with no error counters still records that it failed", () => {
  assert.deepEqual(errorCountersOf(orderBatch({ counters, actors: [], stats: [], searches: [] })), [[FLUSH_FAILED_KEY, 1]]);
});

test("an error key that could not be written as a literal is left to the loss line", () => {
  const odd = orderBatch({ counters: [["error:5xx'; drop table posts; --", 1], ["error:5xx", 1]], actors: [], stats: [], searches: [] });
  assert.deepEqual(errorCountersOf(odd), [["error:5xx", 1], [FLUSH_FAILED_KEY, 1]]);
});

test("the saved counters go in one statement with no parameters and a bounded lock wait", () => {
  const statement = saveCountersStatement([["error:5xx", 1], [FLUSH_FAILED_KEY, 1]], 1000);
  assert.equal(statement,
    "set local lock_timeout = '1000ms'; insert into daily_counters (day, key, n) values (current_date, 'error:5xx', 1), " +
    "(current_date, 'error:metrics_flush_failed', 1) on conflict (day, key) do update set n = daily_counters.n + excluded.n");
});

test("a key or count that would not be a plain literal is refused rather than written", () => {
  assert.throws(() => saveCountersStatement([["error:it's", 1]], 1000), /cannot save/);
  assert.throws(() => saveCountersStatement([["route:GET /", 1]], 1000), /cannot save/);
  assert.throws(() => saveCountersStatement([["error:5xx", 1.5]], 1000), /cannot save/);
  assert.throws(() => saveCountersStatement([["error:5xx", 0]], 1000), /cannot save/);
});

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [warn, error] = [console.warn, console.error];
  console.warn = console.error = () => {};
  try { return await fn(); } finally { [console.warn, console.error] = [warn, error]; }
};

test("saved error counters are written once and nothing is carried", async () => {
  const sent: string[] = [];
  const unsaved = await quietly(() => saveErrorCounters(withErrors, async (s) => { sent.push(s); }, 1000));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /'error:5xx', 1\).*'error:metrics_flush_failed', 1\)/);
  assert.deepEqual(unsaved, []);
});

test("error counters that could not be saved are handed back to carry, without a second attempt", async () => {
  let attempts = 0;
  const unsaved = await quietly(() => saveErrorCounters(withErrors, async () => { attempts++; throw new Error("The database did not answer within 1500 ms"); }, 1000));
  assert.equal(attempts, 1);
  assert.deepEqual(unsaved, errorCountersOf(withErrors));
});
