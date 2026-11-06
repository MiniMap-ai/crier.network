import { test } from "node:test";
import assert from "node:assert/strict";
import { MCP_MAX_BATCH, POST_READS, checkBatch, limitScope, overLimit } from "../lib/request-limits.ts";

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
