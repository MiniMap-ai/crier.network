import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { validate } from "../scripts/evals-report.mjs";

const dir = fileURLToPath(new URL("../evals", import.meta.url));

test("the standing-intent evaluation set is well-formed", () => {
  const v = validate(dir);
  assert.deepEqual(v.errors, [], v.errors.slice(0, 20).join("\n"));
  assert.ok(v.personas.length >= 10, "at least ten personas");
  assert.ok(v.intents.length >= 100, "at least a hundred intents");
  assert.ok(v.pairs.length >= 500, "at least five hundred pairs");
});
