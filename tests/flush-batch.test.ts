import { test } from "node:test";
import assert from "node:assert/strict";
import { LOST_KEYS_SHOWN, batchStatements, describeBatch, isEmptyBatch, orderBatch } from "../lib/flush-batch.ts";
import type { ActorCount, SearchCount, TxSql } from "../lib/flush-batch.ts";

/** Stands in for a postgres.js transaction: records each statement's text and parameters, in call order. */
function recorder() {
  const statements: { sql: string; args: unknown[] }[] = [];
  const tx: TxSql = (strings, ...args) => {
    statements.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), args });
    return Promise.resolve([]);
  };
  return { tx, statements };
}

const shape = (q: string | null, source = "rest"): SearchCount =>
  ({ q, kind: null, tags: null, near: null, radius_km: null, source, n: 1, zero: 0, embed_failed: 0 });

const counters: [string, number][] = [["route:GET /feed.xml", 3], ["search:total", 2], ["cron:tick", 1], ["page:human", 4]];
const actors: ActorCount[] = [{ role: "seeker", actor: "b", n: 1 }, { role: "mcp_client", actor: "z", n: 2 }, { role: "seeker", actor: "a", n: 1 }];
const stats: [string, number][] = [["searches", 2], ["retrievals", 9]];
const searches = [shape("tacos"), shape(null), shape("jobs", "feed")];

function statementsFor(input: Parameters<typeof orderBatch>[0]) {
  const r = recorder();
  batchStatements(r.tx, orderBatch(input));
  return r.statements;
}

test("a flush writes each daily table in one statement, with its rows sorted by key", () => {
  const [c, a, ...rest] = statementsFor({ counters, actors, stats, searches });
  assert.match(c.sql, /^insert into daily_counters/);
  assert.deepEqual(c.args[0], ["cron:tick", "page:human", "route:GET /feed.xml", "search:total"]);
  assert.deepEqual(c.args[1], [1, 4, 3, 2]);
  assert.match(a.sql, /^insert into daily_actors/);
  assert.deepEqual(a.args[0], ["mcp_client", "seeker", "seeker"]);
  assert.deepEqual(a.args[1], ["z", "a", "b"]);
  assert.deepEqual(rest.map((s) => s.sql.split("(")[0]), ["select bump_stat", "select bump_stat", "select bump_search", "select bump_search", "select bump_search"]);
  assert.deepEqual(rest.slice(0, 2).map((s) => s.args[0]), ["retrievals", "searches"]);
});

test("the same counts gathered in a different order produce the same statements", () => {
  const forward = statementsFor({ counters, actors, stats, searches });
  const reversed = statementsFor({
    counters: [...counters].reverse(), actors: [...actors].reverse(), stats: [...stats].reverse(), searches: [...searches].reverse(),
  });
  assert.deepEqual(reversed, forward);
});

test("tables come in a fixed order whatever was counted first", () => {
  const tables = statementsFor({ counters, actors, stats, searches }).map((s) => /daily_counters|daily_actors|bump_stat|bump_search/.exec(s.sql)?.[0]);
  assert.deepEqual([...new Set(tables)], ["daily_counters", "daily_actors", "bump_stat", "bump_search"]);
});

test("search shapes are ordered by their whole shape, so a null field sorts the same every time", () => {
  const [a, b] = [statementsFor({ counters: [], actors: [], stats: [], searches }), statementsFor({ counters: [], actors: [], stats: [], searches: [searches[2], searches[0], searches[1]] })];
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
});

test("an empty batch issues nothing", () => {
  const empty = orderBatch({ counters: [], actors: [], stats: [], searches: [] });
  assert.ok(isEmptyBatch(empty));
  const r = recorder();
  assert.deepEqual(batchStatements(r.tx, empty), []);
  assert.equal(r.statements.length, 0);
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
