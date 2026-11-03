import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCursor, encodeCursor, isDateField, isDeliveryCursor, isKeysetCursor, isOffsetCursor } from "../lib/cursor.ts";

const ID_RE = /^[A-Za-z0-9]{8}$/;

test("a cursor round-trips", () => {
  const c = decodeCursor(encodeCursor({ k: "2026-11-02T15:14:00.000Z", id: "Uo7yiauw" }));
  assert.ok(isKeysetCursor(c, ID_RE));
  assert.equal(c.id, "Uo7yiauw");
});

test("anything that is not an object decodes to null rather than to a value a query would trust", () => {
  assert.equal(decodeCursor(undefined), null);
  assert.equal(decodeCursor(""), null);
  assert.equal(decodeCursor("not base64url json at all"), null);
  assert.equal(decodeCursor(Buffer.from("42").toString("base64url")), null);
  assert.equal(decodeCursor(Buffer.from("[1,2]").toString("base64url")), null);
  assert.equal(decodeCursor(Buffer.from("null").toString("base64url")), null);
});

// The 2026-11-02 500 on /api/v1/search: a keyset cursor whose `k` was not a date reached
// `new Date(cur.k)`, and postgres.js threw RangeError serializing the Invalid Date it got.
test("a keyset cursor is only trusted when its order key parses and its id is a post id", () => {
  assert.ok(!isKeysetCursor(decodeCursor(encodeCursor({ k: "yesterday", id: "Uo7yiauw" })), ID_RE));
  assert.ok(!isKeysetCursor(decodeCursor(encodeCursor({ k: "2026-11-02T15:14:00Z", id: "../../x" })), ID_RE));
  assert.ok(!isKeysetCursor(decodeCursor(encodeCursor({ k: 1762096440000, id: "Uo7yiauw" })), ID_RE));
  assert.ok(!isKeysetCursor(decodeCursor(encodeCursor({ o: 20 })), ID_RE), "a cursor from the other branch of search");
  assert.ok(!isKeysetCursor(null, ID_RE));
});

test("an offset cursor is a non-negative integer, nothing else", () => {
  assert.ok(isOffsetCursor({ o: 0 }));
  assert.ok(isOffsetCursor({ o: 40 }));
  assert.ok(!isOffsetCursor({ o: -1 }));
  assert.ok(!isOffsetCursor({ o: 1.5 }));
  assert.ok(!isOffsetCursor({ o: "20" }));
  assert.ok(!isOffsetCursor({ o: Number.NaN }));
  assert.ok(!isOffsetCursor({ k: "2026-11-02T15:14:00Z", id: "Uo7yiauw" }));
});

test("a delivery cursor is a non-negative integer id", () => {
  assert.ok(isDeliveryCursor({ d: 0 }));
  assert.ok(isDeliveryCursor({ d: 1234 }));
  assert.ok(!isDeliveryCursor({ d: "1234" }), "a string reaches Postgres as text against a bigint");
  assert.ok(!isDeliveryCursor({ d: -1 }));
  assert.ok(!isDeliveryCursor({}));
});

test("a date field is a string Date.parse accepts", () => {
  assert.ok(isDateField("2026-11-02T15:14:00Z"));
  assert.ok(isDateField("2026-11-02"));
  assert.ok(!isDateField("2026-13-45"));
  assert.ok(!isDateField(""));
  assert.ok(!isDateField(1762096440000));
});
