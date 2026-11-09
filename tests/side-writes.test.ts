import { test } from "node:test";
import assert from "node:assert/strict";

// Same trick as tests/db-timeout.test.ts: the wrapper reads its budgets once, at import. Set this
// first so the case that waits out a side write's budget runs in milliseconds.
process.env.CRIER_DB_SIDE_TIMEOUT_MS = "60";

const { DB_SIDE_TIMEOUT_MS, withTimeout } = await import("../lib/db-timeout.ts");
const {
  MAX_PENDING_POSTS,
  applyCounts, drainCounts, drainSideWritesLost, makeSideWrite, noteRetrievals, noteView,
} = await import("../lib/side-writes.ts");
type Tx = Parameters<typeof applyCounts>[0];

/**
 * The two things lib/side-writes.ts has handed to it, wired as lib/db.ts wires them — except for
 * the keepalive, which each case supplies so it can see what was registered and when. The bound is
 * the real one: a side write's whole point is that the bound is honoured, so mocking it would test
 * nothing.
 */
const sideWriteWith = (keepalive: (task: () => Promise<void>) => void) =>
  makeSideWrite({ keepalive, bound: withTimeout, defaultMs: DB_SIDE_TIMEOUT_MS });

/**
 * `flush()` itself cannot be imported here — lib/metrics.ts pulls in `next/server`, which is not
 * resolvable outside the bundler (the same reason tests/metrics-view.test.ts keeps its subject in a
 * module of its own). So the flush's counter half lives in lib/side-writes.ts, and what is checked
 * here is the statements it issues against a recorder: what the flush delegates is what the flush
 * does. The rest of flush() — the transaction, the budget, the drain order — is the part a unit
 * test could only restate.
 */

/** Stands in for a postgres.js transaction: records the statements, and can be told to fail on one. */
function fakeTx(opts: { failOn?: RegExp } = {}) {
  const statements: { sql: string; args: unknown[] }[] = [];
  const tx: Tx = (strings, ...args) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push({ sql, args });
    if (opts.failOn?.test(sql)) return Promise.reject(new Error("canceling statement due to statement timeout"));
    return Promise.resolve([]);
  };
  return { tx, statements };
}

/** Run something that may warn, and hand back both what it returned and what it said. */
async function capturingWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

/** The buffers are module state; empty them so a case starts from nothing whatever ran before it. */
function reset() {
  drainCounts();
  drainSideWritesLost();
}

/* ---------------- the buffers ---------------- */

test("views accumulate per id rather than one write per view", () => {
  reset();
  noteView("aaaaaaaa");
  noteView("bbbbbbbb");
  noteView("aaaaaaaa");
  noteView("aaaaaaaa");
  const counts = drainCounts();
  assert.deepEqual(counts.views.sort(), [["aaaaaaaa", 3], ["bbbbbbbb", 1]]);
  assert.deepEqual(counts.retrievals, [], "a view is not a retrieval");
});

test("draining empties the buffer, so the next flush does not count the same views again", () => {
  reset();
  noteView("aaaaaaaa");
  assert.deepEqual(drainCounts().views, [["aaaaaaaa", 1]]);
  assert.deepEqual(drainCounts().views, [], "the second drain has nothing left to take");
});

test("a page of results is one retrieval each, and repeated ids add up", () => {
  reset();
  noteRetrievals(["aaaaaaaa", "bbbbbbbb"]);
  noteRetrievals(["bbbbbbbb", "cccccccc"]);
  const counts = drainCounts();
  assert.deepEqual(counts.retrievals.sort(), [["aaaaaaaa", 1], ["bbbbbbbb", 2], ["cccccccc", 1]]);
});

test("past the cap, new ids are dropped and counted; ids already held keep counting", () => {
  reset();
  noteView("first");
  for (let i = 0; i < MAX_PENDING_POSTS - 1; i++) noteView(`id${i}`);   // fills it exactly
  noteView("first");            // already held: still counted
  noteView("one-too-many");     // new, and there is no room
  const counts = drainCounts();
  assert.equal(counts.views.length, MAX_PENDING_POSTS, "the buffer is bounded by the cap");
  assert.deepEqual(counts.views.find((v) => v[0] === "first"), ["first", 2]);
  assert.equal(counts.views.find((v) => v[0] === "one-too-many"), undefined);
  assert.equal(drainSideWritesLost(), 1, "and the dropped bump is counted as a lost side write");
});

/* ---------------- what the flush issues ---------------- */

test("the flush applies views and retrievals in one statement, one row per post", async () => {
  reset();
  noteView("bbbbbbbb");
  noteView("aaaaaaaa");
  noteView("aaaaaaaa");
  noteRetrievals(["cccccccc", "aaaaaaaa"]);
  const t = fakeTx();

  await applyCounts(t.tx, drainCounts());
  assert.equal(t.statements.length, 1, "one statement, not one per post or per column");

  const [update] = t.statements;
  assert.match(update.sql, /update posts p set views = p\.views \+ c\.v, retrievals = p\.retrievals \+ c\.r/);
  assert.match(update.sql, /for update skip locked/, "a view bump still never waits on a row lock");
  assert.deepEqual(update.args[0], ["aaaaaaaa", "bbbbbbbb", "cccccccc"], "ids go in as one array, sorted");
  assert.deepEqual(update.args[1], [2, 1, 0], "views alongside, in the same order");
  assert.deepEqual(update.args[2], [1, 0, 1], "and retrievals");
  assert.deepEqual(update.args[3], ["aaaaaaaa", "bbbbbbbb", "cccccccc"], "the lock subquery takes the same ids");
  assert.equal(drainSideWritesLost(), 0, "nothing was lost");
});

test("nothing pending issues nothing at all", async () => {
  reset();
  const t = fakeTx();
  await applyCounts(t.tx, drainCounts());
  assert.deepEqual(t.statements, [], "an idle instance does not write nothing");
});

test("a failed per-post statement is thrown to the flush, which counts and logs the loss once", async () => {
  reset();
  noteView("aaaaaaaa");
  const t = fakeTx({ failOn: /update posts/ });
  await assert.rejects(applyCounts(t.tx, drainCounts()), /statement timeout/);
  assert.equal(drainSideWritesLost(), 0, "not counted here as well");
  assert.equal(t.statements.length, 1, "exactly one attempt, not a retry that could double-count");
});

/* ---------------- the sideWrite helper ---------------- */

test("a side write is registered with the platform, not simply fired", async () => {
  reset();
  const registered: (() => Promise<void>)[] = [];
  const sideWrite = sideWriteWith((task) => { registered.push(task); });
  let ran = 0;

  sideWrite("subscription:polled", () => { ran++; return Promise.resolve([]); });
  assert.equal(registered.length, 1, "the work went to `after`, not to a bare void promise");
  assert.equal(ran, 0, "and the query is not even built yet: the registration decides when");

  await registered[0]();
  assert.equal(ran, 1);
  assert.equal(drainSideWritesLost(), 0);
});

test("a side write that never answers is bounded, cancelled, counted and warned about", async () => {
  reset();
  const registered: (() => Promise<void>)[] = [];
  const sideWrite = sideWriteWith((task) => { registered.push(task); });
  let cancelled = 0;

  sideWrite("deliveries:polled", () => Object.assign(
    // Never settles, which is the shape lib/db-timeout.ts exists for: a pooler that authenticated
    // the client and then went quiet looks exactly like this.
    new Promise<unknown>(() => {}),
    { execute: () => {}, cancel: () => { cancelled++; } },
  ));

  const started = Date.now();
  const { warnings } = await capturingWarnings(() => registered[0]());
  const elapsed = Date.now() - started;

  assert.equal(cancelled, 1, "the query is cancelled so its pool slot comes back");
  // A timer may fire a millisecond before Date.now() agrees it is due; the budget is not short by it.
  assert.ok(elapsed >= DB_SIDE_TIMEOUT_MS - 1, `gave up after ${elapsed} ms, before the ${DB_SIDE_TIMEOUT_MS} ms budget`);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /side write failed deliveries:polled/);
  assert.match(warnings[0], /\d+ ms after it was queued/, "elapsed time is what tells a frozen timer from a slow query");
  assert.equal(drainSideWritesLost(), 1, "and the loss is counted, not only logged");
});

test("a side write is warned about, never thrown, so nothing upstream fails because of one", async () => {
  reset();
  const registered: (() => Promise<void>)[] = [];
  const sideWrite = sideWriteWith((task) => { registered.push(task); });
  sideWrite("unmet_queries", () => Promise.reject(new Error("relation does not exist")));

  const { warnings } = await capturingWarnings(async () => {
    await assert.doesNotReject(registered[0]());
  });
  assert.match(warnings[0], /side write failed unmet_queries .*relation does not exist/);
  assert.equal(drainSideWritesLost(), 1);
});

test("a side write that succeeds counts nothing and says nothing", async () => {
  reset();
  const registered: (() => Promise<void>)[] = [];
  const sideWrite = sideWriteWith((task) => { registered.push(task); });
  sideWrite("subscription:polled", () => Promise.resolve([]));

  const { warnings } = await capturingWarnings(() => registered[0]());
  assert.deepEqual(warnings, [], "the healthy path is silent");
  assert.equal(drainSideWritesLost(), 0);
});
