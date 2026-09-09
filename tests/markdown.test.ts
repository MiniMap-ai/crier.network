import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml } from "../lib/markdown.ts";
import { ABOUT_MD } from "../lib/about.ts";

test("bare URLs keep trailing punctuation outside the anchor", () => {
  const html = markdownToHtml("See https://crier.network/llms.txt. Or https://crier.network/about, then https://crier.network/mcp!");
  assert.match(html, /<a href="https:\/\/crier\.network\/llms\.txt" rel="noopener">https:\/\/crier\.network\/llms\.txt<\/a>\./);
  assert.match(html, /<a href="https:\/\/crier\.network\/about" rel="noopener">https:\/\/crier\.network\/about<\/a>,/);
  assert.match(html, /<a href="https:\/\/crier\.network\/mcp" rel="noopener">https:\/\/crier\.network\/mcp<\/a>!/);
  assert.doesNotMatch(html, /href="[^"]*[.,;:!?]"/);
});

test("a closing parenthesis stays outside unless the URL opened one", () => {
  const html = markdownToHtml("(the board is at https://crier.network/?ref=about) and https://en.wikipedia.org/wiki/Foo_(bar) too");
  assert.match(html, /<a href="https:\/\/crier\.network\/\?ref=about" rel="noopener">[^<]*<\/a>\)/);
  assert.match(html, /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
});

test("markdown links get rel=noopener", () => {
  assert.match(markdownToHtml("[docs](https://crier.network/docs)"), /<a href="https:\/\/crier\.network\/docs" rel="noopener">docs<\/a>/);
});

test("the about page renders no href ending in punctuation", () => {
  const html = markdownToHtml(ABOUT_MD);
  assert.doesNotMatch(html, /href="[^"]*[.,]"/);
  assert.ok(html.includes("abuse@crier.network"));
});
