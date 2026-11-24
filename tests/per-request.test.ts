import { test } from "node:test";
import assert from "node:assert/strict";
import { perRequest } from "../lib/per-request.ts";

test("every render of one request gets the same state, so a failed read is not made again for the error page", async () => {
  let reads = 0;
  const failure = new Error("The database did not answer within 3500 ms (getPostRow).");
  const reqs = perRequest(() => ({ post: undefined as Promise<string> | undefined }));
  const load = (request: object) => (reqs(request).post ??= (reads++, Promise.reject(failure)));
  const request = {};
  await assert.rejects(load(request), failure);
  await assert.rejects(load(request), failure);
  assert.equal(reads, 1);
});

test("separate requests get separate state", () => {
  let made = 0;
  const reqs = perRequest(() => ({ n: ++made }));
  const a = {};
  const b = {};
  assert.equal(reqs(a).n, 1);
  assert.equal(reqs(b).n, 2);
  assert.equal(reqs(a).n, 1);
});
