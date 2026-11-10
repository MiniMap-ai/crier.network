import { test } from "node:test";
import assert from "node:assert/strict";
import { METRICS_MAX_AGE_S, METRICS_RETRY_AFTER_S, METRICS_REVALIDATE_S, boundedAge, snapshotAgeMs } from "../lib/metrics-freshness.ts";

const at = (ms: number) => ({ generated_at: new Date(ms).toISOString() });
const MAX = METRICS_MAX_AGE_S * 1000;
const RETRY = METRICS_RETRY_AFTER_S * 1000;
const NOW = 10 * MAX;
const opts = (now: () => number, extra = {}) => ({ maxAgeMs: MAX, retryAfterMs: RETRY, now, ...extra });

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

test("a snapshot stamped in the future counts as infinitely old and is recomputed", async () => {
  assert.equal(snapshotAgeMs(at(NOW + 1), NOW), Infinity);
  assert.equal(snapshotAgeMs(at(NOW), NOW), 0);
  const get = boundedAge(async () => at(NOW + 365 * 86_400_000), async () => at(NOW), opts(() => NOW));
  assert.deepEqual(await get(), at(NOW));
});

test("a cached snapshot within the bound is served without computing", async () => {
  let computed = 0;
  const get = boundedAge(async () => at(NOW - MAX), async () => { computed++; return at(NOW); }, opts(() => NOW));
  assert.deepEqual(await get(), at(NOW - MAX));
  assert.equal(computed, 0);
});

test("a cached snapshot older than the bound is replaced by a computed one", async () => {
  const get = boundedAge(async () => at(0), async () => at(NOW), opts(() => NOW));
  assert.deepEqual(await get(), at(NOW));
});

test("a stuck cache costs one computation per bound, shared by concurrent callers", async () => {
  let now = NOW;
  let computed = 0;
  const get = boundedAge(async () => at(0), async () => { computed++; return at(now); }, opts(() => now));
  await Promise.all([get(), get(), get()]);
  assert.equal(computed, 1);
  now += MAX;
  await get();
  assert.equal(computed, 1);
  now += 1;
  await get();
  assert.equal(computed, 2);
});

test("a failed computation serves the stale snapshot to every waiting caller and counts each", async () => {
  let failures = 0, staleServed = 0;
  const get = boundedAge(async () => at(0), async () => { throw new Error("db"); }, opts(() => NOW, {
    onComputeFailed: () => { failures++; },
    onStaleServed: () => { staleServed++; },
  }));
  assert.deepEqual(await Promise.all([get(), get()]), [at(0), at(0)]);
  assert.equal(failures, 1);
  assert.equal(staleServed, 2);
});

test("after a failure, stale is served without computing until the retry window passes", async () => {
  let now = NOW, attempts = 0, fail = true, staleServed = 0;
  const get = boundedAge(async () => at(0), async () => { attempts++; if (fail) throw new Error("db"); return at(now); }, opts(() => now, {
    onStaleServed: () => { staleServed++; },
  }));
  await get();
  now += RETRY - 1;
  assert.deepEqual(await get(), at(0));
  assert.equal(attempts, 1);
  assert.equal(staleServed, 2);
  fail = false;
  now += 1;
  assert.deepEqual(await get(), at(now));
  assert.equal(attempts, 2);
});

test("with no cached value at all, the failure reaches the caller", async () => {
  const get = boundedAge(async () => { throw new Error("cold cache, db down"); }, async () => at(NOW), opts(() => NOW));
  await assert.rejects(get(), /cold cache/);
});
