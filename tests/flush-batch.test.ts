import { test } from "node:test";
import assert from "node:assert/strict";
import { LOST_KEYS_SHOWN, describeBatch, isEmptyBatch, orderBatch, transactOnce, writeBatch } from "../lib/flush-batch.ts";
import type { ActorCount, TxSql } from "../lib/flush-batch.ts";
import type { ShapeCount } from "../lib/search-log.ts";

/**
 * Stands in for a postgres.js transaction: records each statement's text and parameters, in call
 * order, and how many were in flight at once. Can be told to fail on one.
 */
function recorder(opts: { failOn?: RegExp } = {}) {
  const statements: { sql: string; args: unknown[] }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const tx: TxSql = (strings, ...args) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push({ sql, args });
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    return new Promise((resolve, reject) => setImmediate(() => {
      inFlight--;
      if (opts.failOn?.test(sql)) reject(new Error("lock timeout"));
      else resolve([]);
    }));
  };
  return { tx, statements, get maxInFlight() { return maxInFlight; } };
}

const shape = (q: string | null, source: ShapeCount["source"] = "rest"): ShapeCount =>
  ({ q, kind: null, tags: null, near: null, radius_km: null, source, n: 1, zero: 0, embed_failed: 0 });

const counters: [string, number][] = [["route:GET /feed.xml", 3], ["search:total", 2], ["cron:tick", 1], ["page:human", 4]];
const actors: ActorCount[] = [{ role: "seeker", actor: "b", n: 1 }, { role: "mcp_client", actor: "z", n: 2 }, { role: "seeker", actor: "a", n: 1 }];
const stats: [string, number][] = [["searches", 2], ["retrievals", 9]];
const searches = [shape("tacos"), shape(null), shape("jobs", "feed")];

async function statementsFor(input: Parameters<typeof orderBatch>[0]) {
  const r = recorder();
  await writeBatch(r.tx, orderBatch(input));
  return r.statements;
}

test("a flush writes each daily table in one statement, with its rows sorted by key", async () => {
  const [c, a, ...rest] = await statementsFor({ counters, actors, stats, searches });
  assert.match(c.sql, /^insert into daily_counters/);
  assert.deepEqual(c.args[0], ["cron:tick", "page:human", "route:GET /feed.xml", "search:total"]);
  assert.deepEqual(c.args[1], [1, 4, 3, 2]);
  assert.match(a.sql, /^insert into daily_actors/);
  assert.deepEqual(a.args[0], ["mcp_client", "seeker", "seeker"]);
  assert.deepEqual(a.args[1], ["z", "a", "b"]);
  assert.deepEqual(rest.map((s) => s.sql.split("(")[0]), ["select bump_stat", "select bump_stat", "select bump_search", "select bump_search", "select bump_search"]);
  assert.deepEqual(rest.slice(0, 2).map((s) => s.args[0]), ["retrievals", "searches"]);
});

test("the same counts gathered in a different order produce the same statements", async () => {
  const forward = await statementsFor({ counters, actors, stats, searches });
  const reversed = await statementsFor({
    counters: [...counters].reverse(), actors: [...actors].reverse(), stats: [...stats].reverse(), searches: [...searches].reverse(),
  });
  assert.deepEqual(reversed, forward);
});

test("tables come in a fixed order, never interleaved, whatever was counted first", async () => {
  const tables = (await statementsFor({ counters, actors, stats, searches })).map((s) => /daily_counters|daily_actors|bump_stat|bump_search/.exec(s.sql)?.[0]);
  assert.deepEqual(tables, ["daily_counters", "daily_actors", "bump_stat", "bump_stat", "bump_search", "bump_search", "bump_search"]);
});

test("each statement waits for the one before it", async () => {
  const r = recorder();
  await writeBatch(r.tx, orderBatch({ counters, actors, stats, searches }));
  assert.equal(r.statements.length, 7);
  assert.equal(r.maxInFlight, 1);
});

test("a failed statement is the last one the transaction sends", async () => {
  const r = recorder({ failOn: /bump_stat/ });
  await assert.rejects(writeBatch(r.tx, orderBatch({ counters, actors, stats, searches })), /lock timeout/);
  assert.equal(r.statements.length, 3, "counters, actors, then the first bump_stat, and nothing queued behind it");
});

test("search shapes are ordered by their whole shape, so a null field sorts the same every time", async () => {
  const [a, b] = [await statementsFor({ counters: [], actors: [], stats: [], searches }), await statementsFor({ counters: [], actors: [], stats: [], searches: [searches[2], searches[0], searches[1]] })];
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
});

test("an empty batch issues nothing", async () => {
  const empty = orderBatch({ counters: [], actors: [], stats: [], searches: [] });
  assert.ok(isEmptyBatch(empty));
  const r = recorder();
  await writeBatch(r.tx, empty);
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

/* ---------------- one transaction, retried only before COMMIT ---------------- */

const connectionLost = () => Object.assign(new Error("write CONNECTION_DESTROYED"), { code: "CONNECTION_DESTROYED" });
const isConnectError = (e: unknown) => (e as { code?: string }).code === "CONNECTION_DESTROYED";
const quietly = async (fn: () => Promise<unknown>) => {
  const original = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = original; }
};

/** A begin() that runs the body against a recorder, then fails at COMMIT on the attempts listed. */
function fakeBegin(opts: { failCommitOn?: number[]; failBodyOn?: number[]; error?: () => Error } = {}) {
  let attempts = 0;
  const begin = async (body: (tx: TxSql) => Promise<void>) => {
    const n = ++attempts;
    const error = opts.error ?? connectionLost;
    await body(async () => { if (opts.failBodyOn?.includes(n)) throw error(); return []; });
    if (opts.failCommitOn?.includes(n)) throw error();
  };
  return { begin, get attempts() { return attempts; } };
}
const oneStatement = async (tx: TxSql) => { await tx`select 1`; };

test("a transaction that lost its connection before COMMIT runs once more", async () => {
  const b = fakeBegin({ failBodyOn: [1] });
  await quietly(() => transactOnce(b.begin, oneStatement, isConnectError, "t"));
  assert.equal(b.attempts, 2);
});

test("a transaction that lost its connection at COMMIT is not run again, since it may have applied", async () => {
  const b = fakeBegin({ failCommitOn: [1] });
  await assert.rejects(transactOnce(b.begin, oneStatement, isConnectError, "t"), /CONNECTION_DESTROYED/);
  assert.equal(b.attempts, 1);
});

test("a transaction that failed for any other reason is not run again", async () => {
  const b = fakeBegin({ failBodyOn: [1], error: () => new Error("lock timeout") });
  await assert.rejects(transactOnce(b.begin, oneStatement, isConnectError, "t"), /lock timeout/);
  assert.equal(b.attempts, 1);
});

test("a second lost connection is thrown, not retried again", async () => {
  const b = fakeBegin({ failBodyOn: [1, 2] });
  await assert.rejects(quietly(() => transactOnce(b.begin, oneStatement, isConnectError, "t")), /CONNECTION_DESTROYED/);
  assert.equal(b.attempts, 2);
});
