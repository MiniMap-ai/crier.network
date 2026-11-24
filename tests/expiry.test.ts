import { test } from "node:test";
import assert from "node:assert/strict";
import { postExpiry } from "../lib/expiry.ts";

const now = Date.parse("2026-11-24T19:00:00Z");
const DAY = 86400e3;
const at = (days: number) => new Date(now + days * DAY);
const iso = (days: number) => at(days).toISOString();

test("a top-level post that sets no dates expires in 30 days", () => {
  assert.deepEqual(postExpiry({}, now), at(30));
});

test("a reply that sets no dates expires with its long-lived thread", () => {
  const thread = new Date("2027-09-01T00:00:00Z");
  assert.deepEqual(postExpiry({}, now, thread), thread);
});

test("a reply to a thread expiring within a week, or already expired, gets the week the reply adds to the thread", () => {
  assert.deepEqual(postExpiry({}, now, at(2)), at(7));
  assert.deepEqual(postExpiry({}, now, at(-10)), at(7));
});

test("a reply's explicit expires_at or date window wins over its thread's expiry", () => {
  const thread = at(280);
  assert.deepEqual(postExpiry({ expires_at: iso(3) }, now, thread), at(3));
  assert.deepEqual(postExpiry({ starts_at: iso(4), ends_at: iso(5) }, now, thread), at(6));
  assert.deepEqual(postExpiry({ starts_at: iso(4) }, now, thread), at(5));
});

test("an explicit expires_at is capped at a year out, and one not after now is refused", () => {
  assert.deepEqual(postExpiry({ expires_at: iso(500) }, now), at(365));
  assert.equal(postExpiry({ expires_at: iso(0) }, now), null);
  assert.equal(postExpiry({ expires_at: iso(-1) }, now, at(100)), null);
});

test("a window keeps a post a day past its end, and at least an hour from now", () => {
  assert.deepEqual(postExpiry({ ends_at: iso(2) }, now), at(3));
  assert.deepEqual(postExpiry({ starts_at: iso(-3), ends_at: iso(-2) }, now), new Date(now + 3600e3));
});
