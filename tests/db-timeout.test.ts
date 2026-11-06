import { test } from "node:test";
import assert from "node:assert/strict";
import type { DbTimeoutError as DbTimeout } from "../lib/db-timeout.ts";

// The wrapper reads its budgets once, at import. Set them first so the cases run in milliseconds.
process.env.CRIER_DB_TIMEOUT_MS = "60";
process.env.CRIER_DB_RESET_AFTER_TIMEOUTS = "3";
// Three timeouts back to back take 120 ms; three that land together take a few. The floor sits
// between, so the two shapes the guard has to tell apart are both reachable here.
process.env.CRIER_DB_RESET_AFTER_MS = "100";

const { DB_SIDE_TIMEOUT_MS, DB_TIMEOUT_MS, DbTimeoutError, __resetDbHealth, retryIfConnectionLost, withTimeout, withTimeoutOr } = await import("../lib/db-timeout.ts");

type FakeQuery<T> = PromiseLike<T> & {
  execute: () => void;
  cancel: () => unknown;
  executed: number;
  cancelled: number;
};

/** Stands in for a postgres.js pending query: a thenable with execute() and cancel(). */
function fakeQuery<T>(opts: { value?: T; delayMs?: number; cancel?: "ok" | "throws" | "rejects" } = {}): FakeQuery<T> {
  const inner = new Promise<T>((resolve) => {
    if (opts.delayMs !== undefined) setTimeout(() => resolve(opts.value as T), opts.delayMs);
    // No delay given: never settles, which is the case this whole module exists for.
  });
  const q: FakeQuery<T> = {
    executed: 0,
    cancelled: 0,
    execute() { q.executed++; },
    cancel() {
      q.cancelled++;
      if (opts.cancel === "throws") throw new Error("cancel blew up");
      if (opts.cancel === "rejects") return Promise.reject(new Error("cancel connection refused"));
      return Promise.resolve();
    },
    then: (onFulfilled, onRejected) => inner.then(onFulfilled, onRejected),
  };
  return q;
}

test("a query that never resolves rejects with DbTimeoutError and is cancelled", async () => {
  __resetDbHealth();
  const q = fakeQuery<string>();
  const started = Date.now();
  const err = await withTimeout(q, { label: "never" }).then(() => null, (e: unknown) => e);
  const elapsed = Date.now() - started;

  assert.ok(err instanceof DbTimeoutError, `expected DbTimeoutError, got ${String(err)}`);
  assert.equal((err as DbTimeout).ms, DB_TIMEOUT_MS);
  assert.equal((err as DbTimeout).code, "db_timeout");
  assert.match((err as DbTimeout).message, /never/);
  assert.equal(q.cancelled, 1, "the pending query must be cancelled so its pool slot comes back");
  // A timer may fire a millisecond before Date.now() agrees it is due; the budget is not short by it.
  assert.ok(elapsed >= DB_TIMEOUT_MS - 1, `rejected after ${elapsed} ms, before the budget`);
  assert.ok(elapsed < DB_TIMEOUT_MS + 2000, `rejected after ${elapsed} ms, far past the budget`);
});

test("the clock starts when the query is queued, not on the first await", () => {
  __resetDbHealth();
  const q = fakeQuery<string>();
  const pending = withTimeout(q, { label: "enqueue" });
  // execute() has already run: a query still waiting for a connection is on the same budget as one
  // that has been sent, which is the wait postgres.js does not time out on its own.
  assert.equal(q.executed, 1);
  return pending.then(() => assert.fail("should not resolve"), (e: unknown) => assert.ok(e instanceof DbTimeoutError));
});

test("a query that answers in time passes its value through untouched", async () => {
  __resetDbHealth();
  const q = fakeQuery<{ n: number }>({ value: { n: 7 }, delayMs: 1 });
  assert.deepEqual(await withTimeout(q, { label: "fast" }), { n: 7 });
  assert.equal(q.cancelled, 0);
});

test("a cancel that throws or rejects does not mask the timeout", async () => {
  for (const mode of ["throws", "rejects"] as const) {
    __resetDbHealth();
    const q = fakeQuery<string>({ cancel: mode });
    const err = await withTimeout(q).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof DbTimeoutError, `cancel ${mode}: expected DbTimeoutError`);
    assert.equal(q.cancelled, 1);
  }
});

test("withTimeoutOr falls back instead of throwing", async () => {
  __resetDbHealth();
  assert.deepEqual(await withTimeoutOr(fakeQuery<string[]>(), [], { label: "side" }), []);
  assert.deepEqual(await withTimeoutOr(fakeQuery<string[]>({ value: ["a"], delayMs: 1 }), [], { label: "side" }), ["a"]);
});

// ---------- the pool guard ----------

/** Stands in for the shared postgres.js client: records how it was asked to end. */
function fakeClient() {
  const ended: { timeout: number }[] = [];
  const client = { ended, end: (opts: { timeout: number }) => { ended.push(opts); return Promise.resolve(); } };
  (globalThis as { __crier_sql?: unknown }).__crier_sql = client;
  return client;
}
const currentClient = () => (globalThis as { __crier_sql?: unknown }).__crier_sql;
const forgetClient = () => { __resetDbHealth(); (globalThis as { __crier_sql?: unknown }).__crier_sql = undefined; };

test("a run of timeouts that outlives a read budget replaces the pool; a success in between does not", async () => {
  __resetDbHealth();
  const client = fakeClient();

  // Two timeouts, then a healthy read: the run is broken, so nothing is replaced.
  await withTimeoutOr(fakeQuery<string>(), null);
  await withTimeoutOr(fakeQuery<string>(), null);
  await withTimeout(fakeQuery<string>({ value: "ok", delayMs: 1 }));
  assert.equal(client.ended.length, 0, "a successful read must clear the run of timeouts");
  assert.equal(currentClient(), client);

  // Three in a row with nothing succeeding, the last landing two budgets after the first: a wedge,
  // so the client is replaced.
  await withTimeoutOr(fakeQuery<string>(), null);
  await withTimeoutOr(fakeQuery<string>(), null);
  await withTimeoutOr(fakeQuery<string>(), null);
  assert.equal(client.ended.length, 1, "the wedged client must be ended");
  assert.equal(currentClient(), undefined, "the next caller must build a fresh pool");

  forgetClient();
});

test("the replaced client is drained, not destroyed", async () => {
  __resetDbHealth();
  const client = fakeClient();
  await withTimeoutOr(fakeQuery<string>(), null);
  await withTimeoutOr(fakeQuery<string>(), null);
  await withTimeoutOr(fakeQuery<string>(), null);
  assert.equal(client.ended.length, 1);
  // `end({ timeout })` lets in-flight work finish for that many seconds; `timeout: 0` destroys the
  // sockets now, which is what served the 500s. Every wait is bounded by one of the two budgets, so
  // a drain at least as long as the larger one never reaches a query anyone is waiting on.
  const longestWait = Math.max(DB_TIMEOUT_MS, DB_SIDE_TIMEOUT_MS) / 1000;
  assert.ok(client.ended[0].timeout >= longestWait, `drain of ${client.ended[0].timeout} s is shorter than the longest bounded wait, ${longestWait} s`);
  assert.ok(client.ended[0].timeout > 0, "a timeout of 0 is a destroy, which is what served the 500s");
  forgetClient();
});

test("a burst of timeouts inside one read budget does not replace the pool", async () => {
  __resetDbHealth();
  const client = fakeClient();
  // Five concurrent reads on a cold instance reach their deadlines within the same few milliseconds
  // with the connections still coming up: five in a row, and no evidence the pool is wedged.
  await Promise.all([
    withTimeoutOr(fakeQuery<string>(), null, { ms: 20, label: "relatedPosts" }),
    withTimeoutOr(fakeQuery<string>(), null, { ms: 20, label: "relatedPosts" }),
    withTimeoutOr(fakeQuery<string>(), null, { ms: 20, label: "relatedPosts:embedding" }),
    withTimeoutOr(fakeQuery<string>(), null, { ms: 40, label: "getPostRow" }),
    withTimeoutOr(fakeQuery<string>(), null, { ms: 40, label: "getPostRow" }),
  ]);
  assert.equal(client.ended.length, 0, "a burst inside one budget must not replace the pool");
  assert.equal(currentClient(), client);
  // The run is still open: one more timeout past the floor is enough.
  await new Promise((r) => setTimeout(r, 100));
  await withTimeoutOr(fakeQuery<string>(), null, { ms: 5 });
  assert.equal(client.ended.length, 1, "a run that outlives the budget is a wedge whatever started it");
  forgetClient();
});

test("CRI-70: five soft deadlines beside a primary read that answers leave the primary read alone", async () => {
  __resetDbHealth();
  const client = fakeClient();
  // Five relatedPosts reads on the side budget give up together while a page's getPostRow is still
  // waiting and would have answered. The guard used to destroy the pool on the fifth, and it with it.
  const primary = withTimeout(fakeQuery<{ id: string }>({ value: { id: "n4a2ed3N" }, delayMs: 40 }), { ms: 55, label: "getPostRow" });
  const soft = await Promise.all(Array.from({ length: 5 }, () => withTimeout(fakeQuery<string>(), { ms: 15, label: "relatedPosts" }).then(() => null, (e: unknown) => e)));
  assert.ok(soft.every((e) => e instanceof DbTimeoutError), "each decorative read rejects with its own timeout, which the page counts and renders around");
  assert.deepEqual(await primary, { id: "n4a2ed3N" }, "the primary read must answer, not fail with CONNECTION_DESTROYED");
  assert.equal(client.ended.length, 0);
  assert.equal(currentClient(), client);
  forgetClient();
});

// ---------- one more try when the connection, not the budget, is what failed ----------

const lostConnection = (code: string) => Object.assign(new Error(`write ${code} aws-0-us-east-1.pooler.supabase.com:6543`), { code });

test("a read that lost its connection is tried once more, and the second answer is the answer", async () => {
  let attempts = 0;
  const value = await retryIfConnectionLost(async () => {
    attempts++;
    if (attempts === 1) throw lostConnection("CONNECTION_DESTROYED");
    return "row";
  });
  assert.equal(value, "row");
  assert.equal(attempts, 2);
});

test("a read that answers is not tried again, and one that times out is not either", async () => {
  let attempts = 0;
  assert.equal(await retryIfConnectionLost(async () => { attempts++; return "row"; }), "row");
  assert.equal(attempts, 1);

  attempts = 0;
  const err = await retryIfConnectionLost(async () => { attempts++; throw new DbTimeoutError(5500, "getPostRow"); }).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof DbTimeoutError, "a timeout has spent the budget; there is nothing to retry with");
  assert.equal(attempts, 1);
});

test("a second lost connection is the caller's to handle; only one more try is ever made", async () => {
  let attempts = 0;
  const err = await retryIfConnectionLost(async () => { attempts++; throw lostConnection(attempts === 1 ? "CONNECTION_DESTROYED" : "08006"); }).then(() => null, (e: unknown) => e);
  assert.equal((err as { code?: string }).code, "08006");
  assert.equal(attempts, 2);
});

test("an application error is not a lost connection and is not retried", async () => {
  let attempts = 0;
  const err = await retryIfConnectionLost(async () => { attempts++; throw Object.assign(new Error("invalid input syntax"), { code: "22P02" }); }).then(() => null, (e: unknown) => e);
  assert.equal((err as { code?: string }).code, "22P02");
  assert.equal(attempts, 1);
});

// ---------- connection failures, as distinct from timeouts ----------

test("a connection-level failure is recognised by its code, whoever raised it", async () => {
  const { isDbConnectError } = await import("../lib/db-timeout.ts");
  // How Supavisor reported "Failed to connect to database: {:error, :timeout}" on 2026-10-17.
  assert.ok(isDbConnectError(Object.assign(new Error("Failed to connect to database: {:error, :timeout}"), { code: "08006", severity_local: "FATAL" })));
  assert.ok(isDbConnectError(Object.assign(new Error("connection_exception"), { code: "08000" })));
  // postgres.js's own, for a socket that never came up or went away under a query.
  assert.ok(isDbConnectError(Object.assign(new Error("CONNECT_TIMEOUT"), { code: "CONNECT_TIMEOUT" })));
  assert.ok(isDbConnectError(Object.assign(new Error("CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" })));
  // Node's.
  assert.ok(isDbConnectError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })));
});

test("a timeout, a query error and a plain error are not connection failures", async () => {
  const { isDbConnectError, DbTimeoutError } = await import("../lib/db-timeout.ts");
  assert.ok(!isDbConnectError(new DbTimeoutError(2500, "relatedPosts")));
  assert.ok(!isDbConnectError(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" })));
  assert.ok(!isDbConnectError(Object.assign(new Error("invalid input syntax"), { code: "22P02" })));
  assert.ok(!isDbConnectError(new Error("anything")));
  assert.ok(!isDbConnectError(null));
  assert.ok(!isDbConnectError({ code: 8006 }));
});
