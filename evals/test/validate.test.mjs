import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/validate.mjs";

const dir = new URL("../data", import.meta.url).pathname;

test("the evaluation set is well-formed", () => {
  const v = validate(dir);
  assert.deepEqual(v.errors, [], v.errors.slice(0, 20).join("\n"));
  assert.ok(v.personas.length >= 10);
  assert.ok(v.intents.length >= 100);
  assert.ok(v.pairs.length >= 500);
});
