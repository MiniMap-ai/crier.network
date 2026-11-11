import { test } from "node:test";
import assert from "node:assert/strict";
import { REACH_MIN_MS, REACH_POST_LIMIT, reachFrom, reachSentence, readReach } from "../lib/reach.ts";
import type { Reach, ReachReadDeps, ReachRow } from "../lib/reach.ts";

const B = "https://crier.network";

// postgres.js hands bigint columns and sum() back as strings; reply_count is an int4 and arrives as a number.
function row(id: string, over: Partial<ReachRow> = {}): ReachRow {
  return {
    id, title: `Post ${id}`, kind: "offer",
    created_at: new Date("2026-11-03T16:20:00Z"), expires_at: new Date("2026-12-03T16:20:00Z"),
    views: "14", retrievals: "32", reply_count: 0,
    total_posts: "1", total_views: "14", total_retrievals: "32", total_replies: "0",
    ...over,
  };
}

test("a post's counts come back as numbers with its page url and ISO dates", () => {
  const r = reachFrom([row("8Hq2mZk3")], B);
  assert.deepEqual(r.posts, [{
    id: "8Hq2mZk3", title: "Post 8Hq2mZk3", kind: "offer", url: `${B}/p/8Hq2mZk3`,
    created_at: "2026-11-03T16:20:00.000Z", expires_at: "2026-12-03T16:20:00.000Z",
    views: 14, retrievals: 32, reply_count: 0,
  }]);
  assert.deepEqual(r.totals, { posts: 1, views: 14, retrievals: 32, reply_count: 0 });
  assert.equal(typeof r.totals.views, "number");
});

test("totals come from the read's window sums, so they cover posts beyond the listed ones", () => {
  const totals = { total_posts: "25", total_views: "300", total_retrievals: "1000", total_replies: "7" };
  const rows = Array.from({ length: REACH_POST_LIMIT }, (_, i) => row(`p${String(i).padStart(7, "0")}`, totals));
  const r = reachFrom(rows, B);
  assert.equal(r.posts.length, REACH_POST_LIMIT);
  assert.deepEqual(r.totals, { posts: 25, views: 300, retrievals: 1000, reply_count: 7 });
});

test("no live posts is an empty list and zero totals, not an absent section", () => {
  assert.deepEqual(reachFrom([], B), { posts: [], totals: { posts: 0, views: 0, retrievals: 0, reply_count: 0 } });
});

test("a null sum reads as zero rather than NaN", () => {
  const r = reachFrom([row("8Hq2mZk3", { total_views: null as unknown as string })], B);
  assert.equal(r.totals.views, 0);
});

test("one live post is described in the singular", () => {
  assert.equal(reachSentence(reachFrom([row("8Hq2mZk3")], B)),
    "Your 1 live post has been returned in search results 32 times and viewed 14 times.");
});

test("replies are mentioned only when there are some, and counts of one are singular", () => {
  const r = reachFrom([row("8Hq2mZk3", { total_posts: "2", total_views: "1", total_retrievals: "1", total_replies: "1" }), row("9Hq2mZk3")], B);
  assert.equal(reachSentence(r), "Your 2 live posts have been returned in search results 1 time and viewed 1 time, with 1 reply.");
});

test("the sentence says when the list is shorter than the totals", () => {
  const rows = Array.from({ length: REACH_POST_LIMIT }, (_, i) => row(`p${String(i).padStart(7, "0")}`, { total_posts: "25" }));
  assert.match(reachSentence(reachFrom(rows, B)) ?? "", new RegExp(`^Your 25 live posts have .* The newest ${REACH_POST_LIMIT} are in reach\\.posts\\.$`));
});

test("a publisher with no live posts gets no line, so it is not prompted to post", () => {
  assert.equal(reachSentence(reachFrom([], B)), null);
});

class FakeDbTimeout extends Error {}

function deps(over: Partial<ReachReadDeps> = {}) {
  const seen = { counted: [] as string[], dbFailures: [] as unknown[], logged: [] as unknown[] };
  const d: ReachReadDeps = {
    capMs: 2500,
    isDbFailure: (e) => e instanceof FakeDbTimeout,
    noteDbFailure: (e) => { seen.dbFailures.push(e); },
    count: (key) => { seen.counted.push(key); },
    logError: (e) => { seen.logged.push(e); },
    ...over,
  };
  return { d, seen };
}

const someReach: Reach = reachFrom([row("8Hq2mZk3")], B);

test("reach is read with the budget that is left, capped at the side timeout", async () => {
  const waits: number[] = [];
  const { d, seen } = deps();
  assert.equal(await readReach(7000, async (ms) => { waits.push(ms); return someReach; }, d), someReach);
  assert.equal(await readReach(1200, async (ms) => { waits.push(ms); return someReach; }, d), someReach);
  assert.deepEqual(waits, [2500, 1200]);
  assert.deepEqual(seen, { counted: [], dbFailures: [], logged: [] });
});

test("too little budget left skips the read without starting it, and counts the skip", async () => {
  const { d, seen } = deps();
  let started = false;
  assert.equal(await readReach(REACH_MIN_MS - 1, async () => { started = true; return someReach; }, d), undefined);
  assert.equal(started, false);
  assert.deepEqual(seen.counted, ["inbox:reach_skipped"]);
});

test("exactly the minimum left runs the read", async () => {
  const { d, seen } = deps();
  assert.deepEqual(await readReach(REACH_MIN_MS, async () => someReach, d), someReach);
  assert.deepEqual(seen.counted, []);
});

test("a database failure drops reach and is noted as a dropped read, not as a fault", async () => {
  const { d, seen } = deps();
  const e = new FakeDbTimeout("timed out");
  assert.equal(await readReach(8000, async () => { throw e; }, d), undefined);
  assert.deepEqual(seen.dbFailures, [e]);
  assert.deepEqual(seen.counted, []);
  assert.deepEqual(seen.logged, []);
});

test("any other error drops reach rather than the items, and is logged and counted as a fault", async () => {
  const { d, seen } = deps();
  const e = new TypeError("created_at.toISOString is not a function");
  assert.equal(await readReach(8000, async () => { throw e; }, d), undefined);
  assert.deepEqual(seen.logged, [e]);
  assert.deepEqual(seen.counted, ["inbox:reach_failed"]);
  assert.deepEqual(seen.dbFailures, []);
});
