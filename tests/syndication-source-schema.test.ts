import { test } from "node:test";
import assert from "node:assert/strict";
import { SourcePatch } from "../lib/syndication/source-schema.ts";
import { HORIZON_DAYS_CAP, MAX_PER_RUN_CAP } from "../lib/syndication/types.ts";

test("a patch at the relay caps is accepted", () => {
  const r = SourcePatch.safeParse({ max_per_run: MAX_PER_RUN_CAP, horizon_days: HORIZON_DAYS_CAP });
  assert.equal(r.success, true);
});

test("a patch over the relay caps is refused, not clamped", () => {
  const over = SourcePatch.safeParse({ max_per_run: 150 });
  assert.equal(over.success, false);
  assert.match(JSON.stringify(over.error?.issues), /max_per_run/);
  const far = SourcePatch.safeParse({ horizon_days: 90 });
  assert.equal(far.success, false);
  assert.match(JSON.stringify(far.error?.issues), /horizon_days/);
});

test("a patch may clear homepage and notes but not set a key the operator does not own", () => {
  assert.equal(SourcePatch.safeParse({ homepage: null, notes: null }).success, true);
  assert.equal(SourcePatch.safeParse({ enabled: false }).success, false);
  assert.equal(SourcePatch.safeParse({ id: "src_other" }).success, false);
  assert.equal(SourcePatch.safeParse({ last_status: "ok" }).success, false);
});
