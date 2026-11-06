import { test } from "node:test";
import assert from "node:assert/strict";
import { DATE_TIME_HINT, isSearchDateTime } from "../lib/dates.ts";

const ACCEPTED = [
  "2026-09-12",
  "2026-09-12T21:00:00-05:00",
  "2026-09-12T21:00:00Z",
  "2026-09-12T21:00:00.123Z",
  "2026-09-12T21:00Z",
  "2026-09-12T21:00:00+0530",
  "2026-09-12 21:00:00+00:00",
  "2026-09-12t21:00:00z",
  "2028-02-29",
];

test("ISO 8601 dates and date-times are accepted", () => {
  for (const s of ACCEPTED) assert.ok(isSearchDateTime(s), s);
});

test("every accepted value becomes a Date that serializes with a four-digit year, so the query parameter cannot throw", () => {
  for (const s of ACCEPTED) assert.match(new Date(s).toISOString(), /^\d{4}-\d{2}-\d{2}T/, s);
});

test("an empty or unparseable string is rejected", () => {
  for (const s of ["", " ", "yesterday", "next friday", "Fri", "garbage", "2026-09-12T", "[object Object]"]) assert.ok(!isSearchDateTime(s), JSON.stringify(s));
});

test("a bare number is rejected rather than read as a year in 2001", () => {
  for (const s of ["0", "1", "12", "2026", "1726000000", "1726000000000", "-1"]) assert.ok(!isSearchDateTime(s), s);
});

test("formats Date.parse accepts but the grammar does not are rejected", () => {
  for (const s of ["Sep 12 2026", "2026/09/12", "12/09/2026", "Sat, 12 Sep 2026 21:00:00 GMT", "2026-09-12T21:00:00+05"]) assert.ok(!isSearchDateTime(s), s);
});

test("a date-time without an offset is rejected rather than read in the process zone", () => {
  for (const s of ["2026-09-12T21:00", "2026-09-12T21:00:00", "2026-09-12T21:00:00.123", "2026-09-12 21:00:00"]) assert.ok(!isSearchDateTime(s), s);
});

test("impossible calendar values are rejected instead of rolled over", () => {
  for (const s of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "2026-09-31", "2026-09-12T24:00:00Z", "2026-09-12T21:60:00Z", "2026-09-12T21:00:00+24:00"]) {
    assert.ok(!isSearchDateTime(s), s);
  }
});

test("years Postgres cannot store once normalized to UTC are rejected", () => {
  for (const s of ["0000-01-01", "0001-01-01T00:00:00+01:00", "9999-12-31T23:00:00-05:00", "+275760-09-13T00:00:00Z", "-000001-01-01T00:00:00Z"]) {
    assert.ok(!isSearchDateTime(s), s);
  }
});

test("the hint names the accepted format with examples", () => {
  assert.match(DATE_TIME_HINT, /ISO 8601/);
  for (const example of ["2026-09-12", "2026-09-12T21:00:00-05:00"]) assert.ok(DATE_TIME_HINT.includes(example), example);
});
