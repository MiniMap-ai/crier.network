import { test } from "node:test";
import assert from "node:assert/strict";
import { METRICS_MAX_AGE_S, METRICS_REVALIDATE_S, boundedAge, snapshotAgeMs } from "../lib/metrics-freshness.ts";

const at = (ms: number) => ({ generated_at: new Date(ms).toISOString() });
const MAX = METRICS_MAX_AGE_S * 1000;
const NOW = 10 * MAX;

test("the data cache revalidates no later than the max-age the route promises", () => {
  assert.ok(METRICS_REVALIDATE_S > 0);
  assert.ok(METRICS_REVALIDATE_S <= METRICS_MAX_AGE_S, `revalidate ${METRICS_REVALIDATE_S}s exceeds max-age ${METRICS_MAX_AGE_S}s`);
});

test("a snapshot without a parseable generated_at counts as infinitely old", () => {
  assert.equal(snapshotAgeMs({}, 1000), Infinity);
  assert.equal(snapshotAgeMs({ generated_at: "yesterday" }, 1000), Infinity);
  assert.equal(snapshotAgeMs(undefined, 1000), Infinity);
  assert.equal(snapshotAgeMs(at(400), 1000), 600);
});

test("a cached snapshot within the bound is served without computing", async () => {
  let computed = 0;
  const get = boundedAge(async () => at(NOW - MAX), async () => { computed++; return at(NOW); }, MAX, () => NOW);
  assert.deepEqual(await get(), at(NOW - MAX));
  assert.equal(computed, 0);
});

test("a cached snapshot older than the bound is replaced by a computed one", async () => {
  const get = boundedAge(async () => at(0), async () => at(NOW), MAX, () => NOW);
  assert.deepEqual(await get(), at(NOW));
});

test("a stuck cache costs one computation per bound, shared by concurrent callers", async () => {
  let now = NOW;
  let computed = 0;
  const get = boundedAge(async () => at(0), async () => { computed++; return at(now); }, MAX, () => now);
  await Promise.all([get(), get(), get()]);
  assert.equal(computed, 1);
  now += MAX;
  await get();
  assert.equal(computed, 1);
  now += 1;
  await get();
  assert.equal(computed, 2);
});

test("a failed computation reaches its callers and is retried by the next one", async () => {
  let fail = true;
  const get = boundedAge(async () => at(0), async () => { if (fail) throw new Error("db"); return at(NOW); }, MAX, () => NOW);
  await assert.rejects(get(), /db/);
  fail = false;
  assert.deepEqual(await get(), at(NOW));
});
