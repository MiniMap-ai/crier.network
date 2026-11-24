#!/usr/bin/env node
/**
 * Holds the metrics flush to docs/metrics.md, "Lock order" and "When a counter is real", against a
 * real Postgres and the real postgres.js: what lib/flush-batch.ts sends lands from a pooled client
 * without a BEGIN, waits on a row lock no longer than metrics_flush allows, the error counters' own
 * statement lands on a client of its own, and a read that times out while pipelined leaves its
 * connection answering the right queries. The unit tests check the same code against a recorder.
 *
 *   SCRATCH_DATABASE_URL=postgres://... npm run check:flush
 *
 * Needs the schema already applied (CI runs it after scripts/migrate.mjs). It writes under keys of
 * its own and removes them when done, so it can run against any throwaway database.
 */
import postgres from "postgres";
import { orderBatch, saveCountersStatement, writeBatch } from "../lib/flush-batch.ts";
import { withTimeout } from "../lib/db-timeout.ts";

const url = process.env.SCRATCH_DATABASE_URL;
if (!url) {
  console.error("check-flush: SCRATCH_DATABASE_URL is required — a throwaway database with the schema applied");
  process.exit(1);
}

const sent = [];
// The shared client's settings from lib/db.ts that change what goes on the wire.
const sql = postgres(url, { prepare: false, max: 4, transform: { undefined: null }, onnotice: () => {}, debug: (_c, text) => sent.push(text) });
const probe = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

const problems = [];
const check = (ok, what) => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) problems.push(what); };
const settle = (p) => Promise.resolve(p).then((value) => ({ value }), (error) => ({ error }));
const batch = (counters, rest = {}) => orderBatch({ counters, actors: [], stats: [], searches: [], ...rest });
const counter = async (key) => (await probe`select n from daily_counters where day = current_date and key = ${key}`)[0]?.n;
const idleInTransaction = async () => (await probe`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`)[0].n;

/** Holds a row lock on today's `key` in daily_counters until the returned release() is called. */
async function holdCounter(key) {
  await probe`insert into daily_counters (day, key, n) values (current_date, ${key}, 0) on conflict do nothing`;
  const holder = await sql.reserve();
  await holder`begin`;
  await holder`select 1 from daily_counters where day = current_date and key = ${key} for update`;
  return async () => { await holder`rollback`; holder.release(); };
}

const KEYS = "chkflush:%";
const SAVED = "error:chkflush_saved";
const SEARCH_Q = "chkflush shape";
const [searchesBefore] = await probe`select coalesce((select searches from stats_daily where day = current_date), 0)::int as n`;

try {
  console.log("one statement per batch, from a pooled client");
  await writeBatch(sql, batch([["chkflush:error:5xx", 1]]));
  check(String(await counter("chkflush:error:5xx")) === "1", "a batch holding exactly one counter key lands (CRI-97)");

  sent.length = 0;
  const full = batch([["chkflush:a", 2], ["chkflush:b", 1]], {
    actors: [{ role: "seeker", actor: "chkflush-actor", n: 1 }],
    stats: [["searches", 3]],
    searches: [{ q: SEARCH_Q, kind: null, tags: null, near: null, radius_km: 5, source: "rest", n: 2, zero: 1, embed_failed: 0 }],
  });
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => settle(writeBatch(sql, full))));
  check(outcomes.every((o) => !o.error), `eight concurrent flushes on a max: 4 client all land${outcomes.find((o) => o.error) ? `: ${outcomes.find((o) => o.error).error.message}` : ""}`);
  check(String(await counter("chkflush:a")) === "16" && String(await counter("chkflush:b")) === "8", "every counter is added once per flush");
  const [actor] = await probe`select n from daily_actors where day = current_date and role = 'seeker' and actor = 'chkflush-actor'`;
  check(actor?.n === 8, `daily_actors adds up (${actor?.n})`);
  const [searches] = await probe`select searches::int as n from stats_daily where day = current_date`;
  check(searches.n - searchesBefore.n === 24, `stats_daily adds up (${searches.n - searchesBefore.n})`);
  const [shape] = await probe`select n, zero, radius_km from search_log where day = current_date and q = ${SEARCH_Q}`;
  check(shape?.n === 16 && shape?.zero === 8 && shape?.radius_km === 5, "search_log adds up, every field in its column");
  check(!sent.some((text) => /^\s*begin\b/i.test(text)), "the flush sends no BEGIN (CRI-106)");
  check(await idleInTransaction() === 0, "and leaves no session idle in transaction (CRI-76)");

  console.log("bounded waits");
  const release = await holdCounter("chkflush:locked");
  const started = Date.now();
  const locked = await settle(writeBatch(sql, batch([["chkflush:locked", 1]])));
  const waited = Date.now() - started;
  await release();
  check(locked.error?.code === "55P03" && waited < 3000, `a flush that meets a locked counter row gives up at metrics_flush's lock_timeout (${locked.error?.code ?? "no error"}, ${waited} ms)`);

  const rescue = postgres(url, { prepare: false, max: 1, fetch_types: false, onnotice: () => {} });
  await rescue.unsafe(saveCountersStatement([[SAVED, 2]], 1000)).simple();
  check(String(await counter(SAVED)) === "2", "the error counters' statement lands on a one-connection client that fetched no types");
  const releaseSaved = await holdCounter(SAVED);
  const savedAt = Date.now();
  const blocked = await settle(rescue.unsafe(saveCountersStatement([[SAVED, 1]], 300)).simple());
  const savedWaited = Date.now() - savedAt;
  await releaseSaved();
  check(blocked.error?.code === "55P03" && savedWaited < 1500, `its SET LOCAL bounds its own lock wait (${blocked.error?.code ?? "no error"}, ${savedWaited} ms)`);
  await rescue.end();

  console.log("a read that times out while pipelined");
  // Two connections, both occupied: one by a statement without parameters, which postgres.js
  // pipelines behind, the other by one with parameters, which it does not.
  const pair = postgres(url, { prepare: false, max: 2, transform: { undefined: null }, onnotice: () => {} });
  await Promise.all([pair`select 1`, pair`select ${1}::int`]);
  const busy = pair`select pg_sleep(0.4), 'busy' as busy`.execute();
  const held = pair`select pg_sleep(${0.6})::text as held`.execute();
  await new Promise((r) => setTimeout(r, 30));
  const stalled = pair`select 'stalled' as stalled`;
  const timedOut = settle(withTimeout(stalled, { ms: 100, label: "check-flush:pipelined" }));
  const next = settle(pair`select ${"next"}::text as next`.execute());
  await new Promise((r) => setTimeout(r, 10));
  check(Boolean(stalled.state) && !stalled.active, "precondition: the read is written behind another query, not yet answered");
  check((await timedOut).error?.code === "db_timeout", "the read times out for its caller");
  const answer = await next;
  check(answer.value?.[0]?.next === "next", `the query after it gets its own answer (${JSON.stringify(answer.value ?? answer.error?.message)})`);
  const after = await settle(writeBatch(pair, batch([["chkflush:after", 1]])));
  check(!after.error && String(await counter("chkflush:after")) === "1", `a flush on the same client then lands (${after.error?.message ?? "ok"})`);
  await Promise.all([settle(busy), settle(held)]);
  check(await idleInTransaction() === 0, "and nothing is left idle in transaction");
  await pair.end({ timeout: 1 });
} finally {
  await probe`delete from daily_counters where day = current_date and (key like ${KEYS} or key = ${SAVED})`;
  await probe`delete from daily_actors where day = current_date and actor = 'chkflush-actor'`;
  await probe`delete from search_log where day = current_date and q = ${SEARCH_Q}`;
  await probe`update stats_daily set searches = ${searchesBefore.n} where day = current_date`;
  await sql.end({ timeout: 1 });
  await probe.end();
}

if (problems.length) {
  console.error(`\ncheck-flush: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log("check-flush: the metrics flush lands, opens no transaction, and bounds its waits");
