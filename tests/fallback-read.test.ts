import { test } from "node:test";
import assert from "node:assert/strict";
import { disposableClient, hedgedRead } from "../lib/fallback-read.ts";
import type { HedgeOpts } from "../lib/fallback-read.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const answerAfter = <T>(ms: number, value: T) => () => wait(ms).then(() => value);
const failAfter = (ms: number, error: unknown) => () => wait(ms).then(() => { throw error; });
const silent = () => new Promise<never>(() => {});

/** Hedge options with a short hedge and a generous budget, recording what the read reported. */
function opts(over: Partial<HedgeOpts> = {}) {
  const seen: { retried: ("slow" | "failed")[]; retryErrors: unknown[]; recovered: number } = { retried: [], retryErrors: [], recovered: 0 };
  const o: HedgeOpts = {
    afterMs: 30,
    left: () => 1000,
    minMs: 100,
    onRetry: (why, e) => { seen.retried.push(why); seen.retryErrors.push(e); },
    onRecovered: () => { seen.recovered++; },
    ...over,
  };
  return { o, seen };
}

/** Fails the test if a promise rejection goes unhandled while `run` is in flight. */
async function noUnhandledRejections(run: () => Promise<void>) {
  const unhandled: unknown[] = [];
  const onRejection = (e: unknown) => { unhandled.push(e); };
  process.on("unhandledRejection", onRejection);
  try {
    await run();
    await wait(80);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(unhandled, [], "a losing attempt's rejection escaped to the process");
}

test("a primary read that answers before the hedge is the answer, and no second read is made", async () => {
  const { o, seen } = opts();
  let fallbackCalls = 0;
  const v = await hedgedRead(answerAfter(5, "primary"), async () => { fallbackCalls++; return "fallback"; }, o);
  assert.equal(v, "primary");
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(seen.retried, []);
});

test("a primary read that goes quiet is retried, and the retry's answer is the page's", async () => {
  const { o, seen } = opts();
  const started = Date.now();
  const v = await hedgedRead(silent, answerAfter(5, "fallback"), o);
  assert.equal(v, "fallback");
  assert.deepEqual(seen.retried, ["slow"]);
  assert.equal(seen.recovered, 1);
  assert.ok(Date.now() - started < 200, "the retry must not wait for the primary's own deadline");
});

test("CRI-98: a client library throwing inside the primary read starts the retry at once, without waiting for the hedge", async () => {
  const { o, seen } = opts({ afterMs: 500 });
  const desync = new TypeError("Cannot read properties of undefined (reading 'length')");
  const started = Date.now();
  const v = await hedgedRead(failAfter(2, desync), answerAfter(5, "fallback"), o);
  assert.equal(v, "fallback");
  assert.deepEqual(seen.retried, ["failed"]);
  assert.equal(seen.retryErrors[0], desync);
  assert.ok(Date.now() - started < 200, "a failure must not wait out the hedge");
});

test("a primary read that answers after the retry started, but first, is the answer", async () => {
  const { o, seen } = opts();
  const v = await hedgedRead(answerAfter(50, "primary"), answerAfter(200, "fallback"), o);
  assert.equal(v, "primary");
  assert.deepEqual(seen.retried, ["slow"]);
  assert.equal(seen.recovered, 0);
});

test("when both attempts fail, the primary's error is thrown, and the retry's does not escape", async () => {
  await noUnhandledRejections(async () => {
    const { o } = opts();
    const primary = new Error("primary: db_timeout");
    await assert.rejects(hedgedRead(failAfter(60, primary), failAfter(5, new Error("retry: refused")), o), (e) => e === primary);
  });
});

test("a primary read that fails after the retry answered leaves no unhandled rejection behind", async () => {
  await noUnhandledRejections(async () => {
    const { o } = opts();
    assert.equal(await hedgedRead(failAfter(60, new Error("late")), answerAfter(5, "fallback"), o), "fallback");
  });
});

test("no retry is started with less budget left than a retry needs", async () => {
  const { o, seen } = opts({ left: () => 50, minMs: 100 });
  let fallbackCalls = 0;
  const err = new Error("primary failed");
  await assert.rejects(hedgedRead(failAfter(2, err), async () => { fallbackCalls++; return "fallback"; }, o), (e) => e === err);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(seen.retried, []);
});

test("a retry that throws before returning a promise counts as a failed retry", async () => {
  const { o } = opts();
  const v = await hedgedRead(answerAfter(60, "primary"), () => { throw new Error("no client"); }, o);
  assert.equal(v, "primary");
});

type FakeClient = { name: string; ended: { timeout: number }[]; end: (opts: { timeout: number }) => unknown };
const fake = (name: string, end?: () => unknown): FakeClient => {
  const c: FakeClient = { name, ended: [], end: (opts) => { c.ended.push(opts); return end?.(); } };
  return c;
};

test("the fallback client is reused until a failure retires it, then rebuilt, and the retired one is drained", () => {
  let built = 0;
  const holder = disposableClient(() => fake(`client ${++built}`), 12);
  const a = holder.get();
  assert.equal(holder.get(), a);
  holder.retire(a);
  assert.deepEqual(a.ended, [{ timeout: 12 }], "a retired client is drained, not destroyed");
  const b = holder.get();
  assert.notEqual(b, a);
  assert.equal(built, 2);
});

test("a second failure on a client already retired does not retire its replacement", () => {
  const holder = disposableClient(() => fake("client"), 12);
  const a = holder.get();
  holder.retire(a);
  const b = holder.get();
  holder.retire(a);
  assert.equal(holder.get(), b);
  assert.deepEqual(b.ended, []);
  assert.equal(a.ended.length, 1);
});

test("an end that throws or rejects does not stop the client from being replaced", () => {
  let n = 0;
  const holder = disposableClient(() => fake(`client ${++n}`, n === 1 ? () => { throw new Error("boom"); } : () => Promise.reject(new Error("refused"))), 12);
  const a = holder.get();
  holder.retire(a);
  const b = holder.get();
  holder.retire(b);
  assert.notEqual(holder.get(), b);
});
