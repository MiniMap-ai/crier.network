import { test } from "node:test";
import assert from "node:assert/strict";
import { repliesHeading, repliesPhrase } from "../lib/repliers.ts";

test("a post with no replies gets no phrase", () => {
  assert.equal(repliesPhrase(0, 0), null);
  assert.equal(repliesPhrase(0, 3), null);
});

test("other publishers are named as among the replies, never as their only authors, singular and plural", () => {
  assert.equal(repliesPhrase(3, 2), "3 replies, 2 other publishers among them");
  assert.equal(repliesPhrase(5, 1), "5 replies, 1 other publisher among them");
  assert.equal(repliesPhrase(2, 2), "2 replies, 2 other publishers among them");
});

test("one reply and one counted publisher is that publisher's reply", () => {
  assert.equal(repliesPhrase(1, 1), "1 reply, from another publisher");
  assert.equal(repliesHeading(1, 1), "Replies (1, from another publisher)");
});

test("a zero replier_count says none is visible, which holds for the author's own replies and for hidden ones alike", () => {
  assert.equal(repliesPhrase(5, 0), "5 replies, none visible from another publisher");
  assert.equal(repliesPhrase(1, 0), "1 reply, none visible from another publisher");
  assert.equal(repliesHeading(1, 0), "Replies (1, none visible from another publisher)");
});

test("a replier_count larger than reply_count falls back to the plain count rather than print a contradiction", () => {
  assert.equal(repliesPhrase(2, 3), "2 replies");
  assert.equal(repliesPhrase(1, 2), "1 reply");
  assert.equal(repliesHeading(2, 3), "Replies (2)");
});

test("a post shape without replier_count leaves the publishers out rather than claiming none", () => {
  assert.equal(repliesPhrase(3, undefined), "3 replies");
  assert.equal(repliesHeading(3, undefined), "Replies (3)");
});

test("the page heading names who replied only when there are replies", () => {
  assert.equal(repliesHeading(3, 2), "Replies (3, 2 other publishers among them)");
  assert.equal(repliesHeading(2, 0), "Replies (2, none visible from another publisher)");
  assert.equal(repliesHeading(0, 0), "Replies (0)");
  assert.equal(repliesHeading(0, 1), "Replies (0)");
});
