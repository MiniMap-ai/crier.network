import { test } from "node:test";
import assert from "node:assert/strict";
import { EMBED_RETRY_BACKOFF_MS, classifyThrown, failureCounter, shouldRetryEmbed } from "../lib/embed-outcome.ts";
import type { EmbedFailure } from "../lib/embed-outcome.ts";

const abort: EmbedFailure = { cause: "abort", ms: 8000 };
const now = 1_000_000;
const roomy = { attempt: 1, now, deadline: now + 60_000, attemptMs: 8000 };

test("an attempt our timer cut off is an abort, whatever the error says", () => {
  const thrown = new DOMException("This operation was aborted", "AbortError");
  assert.deepEqual(classifyThrown(true, 5000, thrown), { cause: "abort", ms: 5000 });
  assert.deepEqual(classifyThrown(false, 5000, new TypeError("fetch failed")), { cause: "network", message: "fetch failed" });
});

test("aborts and every other failure are counted under separate keys", () => {
  assert.equal(failureCounter(abort), "error:embed_abort");
  assert.equal(failureCounter({ cause: "status", status: 502 }), "error:embed_error");
  assert.equal(failureCounter({ cause: "network", message: "ECONNRESET" }), "error:embed_error");
});

test("a transient failure is retried once when the deadline has room for it", () => {
  assert.ok(shouldRetryEmbed(abort, roomy));
  assert.ok(shouldRetryEmbed({ cause: "status", status: 502 }, roomy));
  assert.ok(shouldRetryEmbed({ cause: "status", status: 429 }, roomy));
  assert.ok(shouldRetryEmbed({ cause: "network", message: "fetch failed" }, roomy));
  assert.ok(!shouldRetryEmbed(abort, { ...roomy, attempt: 2 }), "never a second retry");
});

test("a caller without a deadline never retries", () => {
  assert.ok(!shouldRetryEmbed(abort, { attempt: 1, now, attemptMs: 5000 }));
});

test("a retry that would end after the deadline is not made", () => {
  const exact = now + EMBED_RETRY_BACKOFF_MS + 8000;
  assert.ok(shouldRetryEmbed(abort, { ...roomy, deadline: exact }));
  assert.ok(!shouldRetryEmbed(abort, { ...roomy, deadline: exact - 1 }));
  assert.ok(!shouldRetryEmbed(abort, { ...roomy, deadline: now - 1 }));
});

test("a request Cohere refused as invalid or unauthorized is not retried", () => {
  for (const status of [400, 401, 403, 404, 422]) assert.ok(!shouldRetryEmbed({ cause: "status", status }, roomy), String(status));
});
