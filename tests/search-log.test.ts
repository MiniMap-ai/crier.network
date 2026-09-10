import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetSearchLog, drainSearches, foldDemand, meetsThreshold, normalizeQuery, recordSearch,
  roundNear, searchShape, shapeKey,
} from "../lib/search-log.ts";
import type { DemandRow } from "../lib/search-log.ts";

/**
 * lib/metrics.ts cannot be imported here — it pulls in `next/server`, which is not resolvable
 * outside the bundler — so the rules it delegates live in lib/search-log.ts and are tested here.
 * What metrics.ts keeps is the wiring: `track.search` calls recordSearch once, and the flush runs
 * one `bump_search(...)` per entry drainSearches returns.
 */

const drained = () => drainSearches().map(({ q, kind, tags, near, radius_km, source, n, zero }) => ({ q, kind, tags, near, radius_km, source, n, zero }));

test("case and whitespace collapse to one shape", () => {
  __resetSearchLog();
  recordSearch({ q: "Live Music" }, "rest", { zero: false });
  recordSearch({ q: "live music" }, "rest", { zero: false });
  recordSearch({ q: "  LIVE   music  " }, "rest", { zero: false });
  const rows = drained();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].q, "live music");
  assert.equal(rows[0].n, 3);
});

test("the same text from two sources is two rows", () => {
  __resetSearchLog();
  recordSearch({ q: "live music" }, "rest", { zero: false });
  recordSearch({ q: "live music" }, "feed", { zero: false });
  const rows = drained().sort((a, b) => a.source.localeCompare(b.source));
  assert.deepEqual(rows.map((r) => r.source), ["feed", "rest"]);
  assert.deepEqual(rows.map((r) => r.n), [1, 1]);
});

test("personal data is replaced with a placeholder before it is stored", () => {
  __resetSearchLog();
  recordSearch({ q: "contact Ada@Example.COM about the loft" }, "rest", { zero: false });
  recordSearch({ q: "call 512-555-0134 or 512 555 0134" }, "rest", { zero: false });
  recordSearch({ q: "ssn 078-05-1120" }, "rest", { zero: false });
  const qs = drained().map((r) => r.q);
  assert.ok(qs.includes("contact [email] about the loft"));
  assert.ok(qs.includes("call [phone] or [phone]"));
  assert.ok(qs.includes("ssn [id]"));
  for (const q of qs) assert.ok(!/@|\d{3}[-\s]\d{4}/.test(q ?? ""), `left personal data in ${q}`);
});

test("a query longer than the cap is truncated", () => {
  __resetSearchLog();
  recordSearch({ q: "x".repeat(500) }, "rest", { zero: false });
  assert.equal(drained()[0].q?.length, 200);
});

test("an internal seeker is not logged at all", () => {
  __resetSearchLog();
  assert.equal(recordSearch({ q: "seed check" }, "rest", { zero: false, internal: true }), "skipped");
  assert.equal(recordSearch({ q: "seed check" }, "mcp", { zero: true, internal: true }), "skipped");
  assert.deepEqual(drained(), []);
  assert.equal(recordSearch({ q: "seed check" }, "rest", { zero: false, internal: false }), "recorded");
  assert.equal(drained().length, 1);
});

test("a bare listing is a shape, stored with null fields", () => {
  __resetSearchLog();
  recordSearch({}, "rest", { zero: false });
  recordSearch({ limit: 20, sort: "newest" } as never, "rest", { zero: false });
  const rows = drained();
  assert.equal(rows.length, 1, "paging and sorting are not part of the shape");
  assert.deepEqual(rows[0], { q: null, kind: null, tags: null, near: null, radius_km: null, source: "rest", n: 2, zero: 0 });
});

test("filters are part of the shape; places round to ~50 km cells", () => {
  __resetSearchLog();
  recordSearch({ q: "tacos", kind: "offer", tags: "Food,Cheap", near: "30.2672,-97.7431", radius_km: 25 }, "rest", { zero: false });
  recordSearch({ q: "tacos", kind: "offer", tags: "Food,Cheap", near: "30.31,-97.61", radius_km: 25 }, "rest", { zero: false });
  recordSearch({ q: "tacos", kind: "event", tags: "Food,Cheap", near: "30.2672,-97.7431", radius_km: 25 }, "rest", { zero: false });
  const rows = drained();
  assert.equal(rows.length, 2, "two nearby points share a cell; a different kind does not");
  const offers = rows.find((r) => r.kind === "offer")!;
  assert.equal(offers.n, 2);
  assert.equal(offers.near, "30.5,-97.5");
  assert.equal(offers.tags, "food,cheap");
});

test("one entry per shape, with n and zero counted right", () => {
  __resetSearchLog();
  for (const zero of [false, true, false]) recordSearch({ q: "night market" }, "rest", { zero });
  recordSearch({ q: "night market", kind: "event" }, "rest", { zero: true });
  recordSearch({ q: "night market", kind: "event" }, "rest", { zero: true });
  // One drained entry is one bump_search statement in the flush.
  const rows = drained().sort((a, b) => (a.kind ?? "").localeCompare(b.kind ?? ""));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.kind, r.n, r.zero]), [[null, 3, 1], ["event", 2, 2]]);
});

test("draining empties the buffer, so a flush cannot write a shape twice", () => {
  __resetSearchLog();
  recordSearch({ q: "once" }, "rest", { zero: false });
  assert.equal(drainSearches().length, 1);
  assert.deepEqual(drainSearches(), []);
});

test("the buffer is bounded, and a dropped shape says so", () => {
  __resetSearchLog();
  for (let i = 0; i < 500; i++) assert.equal(recordSearch({ q: `q${i}` }, "rest", { zero: false }), "recorded");
  assert.equal(recordSearch({ q: "one too many" }, "rest", { zero: false }), "dropped");
  assert.equal(recordSearch({ q: "q0" }, "rest", { zero: false }), "recorded", "a shape already held keeps counting");
  assert.equal(drainSearches().length, 500);
});

test("the shape key holds no seeker and no clock", () => {
  const k = shapeKey(searchShape({ q: "anything", near: "30.2,-97.7" }, "mcp"));
  assert.equal(k, JSON.stringify(["anything", null, null, "30.0,-97.5", null, "mcp"]));
});

test("normalizeQuery and roundNear are the ones unmet_queries stores", () => {
  assert.equal(normalizeQuery(undefined), null);
  assert.equal(normalizeQuery("  Two   Words "), "two words");
  assert.equal(roundNear(undefined), null);
  assert.equal(roundNear("not a point"), null);
  assert.equal(roundNear("-0.1,0.9"), "0.0,1.0");
});

/* ---------------- the public aggregate ---------------- */

const row = (day: string, q: string | null, n: number, extra: Partial<DemandRow> = {}): DemandRow =>
  ({ day, q, kind: null, near: null, tags: null, n, zero: 0, ...extra });

test("the threshold names a shape at three searches or two days, and folds the rest", () => {
  assert.ok(meetsThreshold(3, 1));
  assert.ok(meetsThreshold(1, 2));
  assert.ok(!meetsThreshold(2, 1));

  const d = foldDemand([
    row("2026-09-10", "asked three times", 3),
    row("2026-09-10", "asked on two days", 1),
    row("2026-09-09", "asked on two days", 1),
    row("2026-09-10", "asked once", 1),
    row("2026-09-10", "asked twice in a day", 2, { zero: 1 }),
  ]);
  assert.deepEqual(d.shapes.map((s) => s.q), ["asked three times", "asked on two days"]);
  assert.equal(d.shapes[1].days, 2);
  assert.deepEqual(d.other, { shapes: 2, n: 3, zero: 1 }, "withheld shapes still count towards the totals");
  assert.equal(d.searches, 8);
  assert.equal(d.zero, 1);
});

test("a shape is named by q, kind and place together", () => {
  const d = foldDemand([
    row("2026-09-10", "tacos", 3, { kind: "offer" }),
    row("2026-09-10", "tacos", 3, { kind: "event" }),
    row("2026-09-10", "tacos", 4, { kind: "offer", near: "30.5,-97.5" }),
  ]);
  assert.equal(d.shapes.length, 3);
  assert.equal(d.shapes[0].n, 4, "the busiest shape leads");
});

test("days counts calendar days, not rows: one shape split by tags is still one day", () => {
  // The log splits a shape further by tags, radius and source, so one afternoon can be several rows.
  const d = foldDemand([
    row("2026-09-10", "tacos", 1, { tags: "food" }),
    row("2026-09-10", "tacos", 1, { tags: "cheap" }),
  ]);
  assert.deepEqual(d.shapes, [], "two rows on one day are two searches, which is below the threshold");
  assert.deepEqual(d.other, { shapes: 1, n: 2, zero: 0 });

  const spread = foldDemand([
    row("2026-09-10", "tacos", 1, { tags: "food" }),
    row("2026-09-09", "tacos", 1, { tags: "cheap" }),
  ]);
  assert.equal(spread.shapes.length, 1);
  assert.equal(spread.shapes[0].days, 2);
});

test("the poller peak is a day's traffic, not a row's", () => {
  const d = foldDemand([
    row("2026-09-10", "poll", 30, { source: "rest" } as never),
    row("2026-09-10", "poll", 30, { tags: "a" }),
  ]);
  assert.equal(d.shapes[0].days, 1);
  assert.equal(d.shapes[0].poller, true, "60 searches in one day is a schedule however the rows split");
});

test("poller marks a shape that ran more than fifty times in one day", () => {
  const busy = foldDemand([row("2026-09-10", "poll", 51)]).shapes[0];
  assert.equal(busy.poller, true);
  const steady = foldDemand([row("2026-09-10", "poll", 50), row("2026-09-09", "poll", 50)]).shapes[0];
  assert.equal(steady.poller, false, "a hundred searches over two days is use, not a schedule");
  assert.equal(steady.days, 2);
});

test("kinds, places and tags carry their zero share", () => {
  const d = foldDemand([
    row("2026-09-10", "a", 4, { kind: "event", near: "30.5,-97.5", tags: "music, Free", zero: 1 }),
    row("2026-09-09", "b", 4, { kind: "event", near: "30.5,-97.5", tags: "music", zero: 3 }),
  ]);
  assert.deepEqual(d.kinds, [{ key: "event", n: 8, zero: 4, zero_share: 0.5 }]);
  assert.deepEqual(d.places, [{ key: "30.5,-97.5", n: 8, zero: 4, zero_share: 0.5 }]);
  assert.deepEqual(d.tags.map((t) => [t.key, t.n]), [["music", 8], ["Free", 4]]);
});

test("an empty log folds to an empty but valid block", () => {
  assert.deepEqual(foldDemand([]), { searches: 0, zero: 0, shapes: [], other: { shapes: 0, n: 0, zero: 0 }, kinds: [], places: [], tags: [] });
});
