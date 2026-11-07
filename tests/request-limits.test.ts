import { test } from "node:test";
import assert from "node:assert/strict";
import { MCP_BATCH_CONCURRENCY, MCP_MAX_BATCH, POST_READS, checkBatch, limitRefusal, limitScope, mapConcurrent, overLimit, postIdFromInput } from "../lib/request-limits.ts";

const call = (id: number, name = "get_post") => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { id: "8Hq2mZk3" } } });
const batchOf = (n: number) => Array.from({ length: n }, (_, i) => call(i + 1));

// rate_limit_hit returns limit minus the hits in the window, the current one included.
const remainingAfter = (hits: number) => POST_READS.limit - hits;

test("the last hit in a window is allowed and the one after it is refused", () => {
  assert.equal(overLimit(remainingAfter(POST_READS.limit)), false);
  assert.equal(overLimit(remainingAfter(POST_READS.limit + 1)), true);
});

test("an agent reading every result on six full search pages in one window is never refused", () => {
  const searchPage = 100;
  for (let hit = 1; hit <= 6 * searchPage; hit++) assert.equal(overLimit(remainingAfter(hit)), false, `hit ${hit}`);
});

test("post reads share search's allowance of 600 per 10 minutes", () => {
  assert.deepEqual(POST_READS, { limit: 600, windowSeconds: 600 });
});

test("a limit's counter scope is its key's prefix", () => {
  assert.equal(limitScope("read:0123456789abcdef01234567"), "read");
  assert.equal(limitScope("search:abc"), "search");
  assert.equal(limitScope("noscope"), "noscope");
});

test("a single message passes as a batch of one", () => {
  const r = checkBatch(call(1));
  assert.ok(r.ok);
  assert.equal(r.msgs.length, 1);
});

test("a batch at the cap passes", () => {
  const r = checkBatch(batchOf(MCP_MAX_BATCH));
  assert.ok(r.ok);
  assert.equal(r.msgs.length, MCP_MAX_BATCH);
});

test("a batch one over the cap is refused as too large, with the cap in data", () => {
  const r = checkBatch(batchOf(MCP_MAX_BATCH + 1));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === "too_large");
  assert.deepEqual(!r.ok && r.data, { max_batch: MCP_MAX_BATCH, received: MCP_MAX_BATCH + 1 });
  assert.match(!r.ok ? r.message : "", /at most 5 messages/);
});

test("an oversized batch is refused for its size even when its entries are malformed", () => {
  const r = checkBatch(Array.from({ length: 5000 }, () => null));
  assert.ok(!r.ok && r.reason === "too_large");
});

test("an empty batch is an invalid request", () => {
  const r = checkBatch([]);
  assert.ok(!r.ok && r.reason === "invalid");
});

test("a batch with one entry that is not JSON-RPC 2.0 is an invalid request", () => {
  for (const bad of [null, 7, "x", [], { jsonrpc: "1.0", method: "ping" }, { jsonrpc: "2.0" }, { jsonrpc: "2.0", method: 3 }]) {
    const r = checkBatch([call(1), bad]);
    assert.ok(!r.ok && r.reason === "invalid", JSON.stringify(bad));
  }
});

test("a notification without an id is a valid message", () => {
  assert.ok(checkBatch([{ jsonrpc: "2.0", method: "notifications/initialized" }, call(1)]).ok);
});

test("a refusal's retry_after is the window length, which always clears a fixed window", () => {
  const r = limitRefusal("read:abc", POST_READS.limit, POST_READS.windowSeconds, "post reads from this address");
  assert.equal(r.retryAfter, 600);
  assert.equal(limitRefusal("post:pub_x", 60, 3600, "posts from this publisher").retryAfter, 3600);
  assert.equal(r.message, "Too many post reads from this address: limit is 600 per 10 minutes.");
});

test("an address-keyed limit's hint says it is shared per address and never offers a key", () => {
  for (const scope of ["read", "search", "feed", "register", "report"]) {
    const { hint } = limitRefusal(`${scope}:abc`, 10, 600, "things");
    assert.match(hint, /per network address and shared with everyone behind it/, scope);
    assert.doesNotMatch(hint, /your own allowance/, scope);
  }
});

test("a publisher-keyed limit's hint says it is per publisher, and only posts mention verification", () => {
  for (const scope of ["post", "inbox", "sub", "rotate", "verify", "verifyhook"]) {
    const { hint } = limitRefusal(`${scope}:pub_x`, 10, 3600, "things");
    assert.match(hint, /per publisher/, scope);
    assert.doesNotMatch(hint, /network address/, scope);
    assert.equal(/Verified publishers get more/.test(hint), scope === "post", scope);
  }
});

test("a refusal hint names both places the delay is given", () => {
  assert.match(limitRefusal("read:abc", 10, 600, "things").hint, /Retry-After.*retry_after/);
});

test("mapConcurrent keeps input order however the calls finish", async () => {
  const delays = [30, 5, 20, 1, 10];
  const out = await mapConcurrent(delays, 2, (ms, i) => new Promise<string>((r) => setTimeout(() => r(`#${i}`), ms)));
  assert.deepEqual(out, ["#0", "#1", "#2", "#3", "#4"]);
});

test("a full batch never has more than two entries in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  await mapConcurrent(Array.from({ length: MCP_MAX_BATCH }, (_, i) => i), MCP_BATCH_CONCURRENCY, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5 + (i % 3) * 5));
    inFlight--;
  });
  assert.equal(MCP_BATCH_CONCURRENCY, 2);
  assert.equal(peak, 2);
});

test("mapConcurrent on an empty list resolves to an empty list", async () => {
  assert.deepEqual(await mapConcurrent([], 2, async () => 1), []);
});

test("a pasted post URL yields its id with any query, fragment or trailing path dropped", () => {
  for (const raw of [
    "8Hq2mZk3",
    " 8Hq2mZk3 ",
    "8Hq2mZk3.json",
    "https://crier.network/p/8Hq2mZk3",
    "https://crier.network/p/8Hq2mZk3?utm_source=chat&ref=https://x.example/p/zzz",
    "https://crier.network/p/8Hq2mZk3#replies",
    "crier.network/p/8Hq2mZk3/",
    "https://crier.network/p/8Hq2mZk3/related?x=1",
    "https://crier.network/p/8Hq2mZk3.json?x=1",
  ]) assert.equal(postIdFromInput(raw), "8Hq2mZk3", raw);
});
