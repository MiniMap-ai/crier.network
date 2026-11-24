import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { guardUnhandledRejections } from "../lib/process-guard.ts";

test("an unhandled rejection is logged with its stack and counted", () => {
  const proc = new EventEmitter();
  const lines: unknown[][] = [];
  const counted: unknown[] = [];
  assert.equal(guardUnhandledRejections(proc, (e) => counted.push(e), (...args) => lines.push(args)), true);
  const e = Object.assign(new TypeError("Cannot read properties of undefined (reading 'length')"), { code: "X1" });
  proc.emit("unhandledRejection", e);
  assert.deepEqual(counted, [e]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], "unhandled rejection");
  assert.match(String(lines[0][1]), /TypeError: Cannot read properties of undefined/);
  assert.match(String(lines[0][1]), /at /, "the stack is what names the library that threw");
  assert.match(String(lines[0][1]), /\(code X1\)/);
});

test("the guard runs before a listener that was there first, so a listener that exits cannot pre-empt it", () => {
  const proc = new EventEmitter();
  const order: string[] = [];
  proc.on("unhandledRejection", () => order.push("platform"));
  guardUnhandledRejections(proc, () => order.push("guard"), () => {});
  proc.emit("unhandledRejection", new Error("x"));
  assert.deepEqual(order, ["guard", "platform"]);
});

test("a guard whose log or counter throws does not throw out of the listener", () => {
  const proc = new EventEmitter();
  let counted = 0;
  guardUnhandledRejections(proc, () => { counted++; throw new Error("counter broke"); }, () => { throw new Error("log broke"); });
  assert.doesNotThrow(() => proc.emit("unhandledRejection", new Error("x")));
  assert.equal(counted, 1, "a failing log must not stop the count");
});

test("a reason that is not an Error, or cannot be printed, is still logged and counted", () => {
  const proc = new EventEmitter();
  const lines: unknown[][] = [];
  let counted = 0;
  guardUnhandledRejections(proc, () => { counted++; }, (...args) => lines.push(args));
  proc.emit("unhandledRejection", "a bare string");
  proc.emit("unhandledRejection", { toString() { throw new Error("no"); } });
  assert.equal(counted, 2);
  assert.equal(lines[0][1], "a bare string");
  assert.equal(typeof lines[1][1], "string");
});

test("installing twice adds one listener", () => {
  const proc = new EventEmitter();
  assert.equal(guardUnhandledRejections(proc, () => {}, () => {}), true);
  assert.equal(guardUnhandledRejections(proc, () => {}, () => {}), false);
  assert.equal(proc.listenerCount("unhandledRejection"), 1);
});
