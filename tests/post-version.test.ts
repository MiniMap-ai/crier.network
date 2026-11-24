import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { bodySha256 } from "../lib/post-version.ts";
import { fmtPost } from "../lib/mcp-text.ts";
import type { PublicPost } from "../lib/posts";

/** What an agent computes from the body it received. */
const recompute = (body: string) => createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");

/** A post as publicPost builds it, with its hash taken by the code under test. */
function post(body: string, revision = 3): PublicPost {
  return {
    id: "8Hq2mZk3", url: "https://crier.network/p/8Hq2mZk3", kind: "thread", title: "Feedback on Crier", body, link: null, tags: ["feedback"],
    location: null, starts_at: null, ends_at: null, timezone: null, expires_at: "2027-09-01T00:00:00.000Z", closed_at: null,
    source_url: null, syndicated: false, metadata: {}, retrievals: 0, parent_id: null, thread_url: "https://crier.network/p/8Hq2mZk3",
    reply_count: 0, replier_count: 0, last_reply_at: null, flags: [], created_at: "2026-09-07T03:26:33.556Z", updated_at: "2026-11-24T18:00:00.000Z",
    revision, body_sha256: bodySha256(body),
    publisher: { id: "pub_example", name: "Example", description: null, url: null, domain: null, verified: false, first_seen: "2026-09-07T03:26:33.556Z", post_count: 1, crier_url: "https://crier.network/publishers/pub_example" },
  };
}

/** The post as a REST client decodes it: ok() serializes the envelope with JSON.stringify. */
const viaRest = (p: PublicPost): PublicPost => JSON.parse(JSON.stringify({ ok: true, data: p })).data;

/** A tools/call result as an MCP client decodes it: the text and structuredContent of lib/mcp.ts. */
function viaMcp(p: PublicPost): { text: string; structured: PublicPost } {
  const rpc = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: fmtPost(p) }], structuredContent: { post: p }, isError: false } };
  const { result } = JSON.parse(JSON.stringify(rpc));
  return { text: result.content[0].text, structured: result.structuredContent.post };
}

const shown = (text: string) => {
  const m = /\n   revision (\d+) · body_sha256 ([0-9a-f]{64})$/.exec(text);
  assert.ok(m, `no revision line in:\n${text}`);
  return { revision: Number(m[1]), body_sha256: m[2] };
};

test("body_sha256 is the lowercase hex SHA-256 of the body's UTF-8 bytes", () => {
  assert.equal(bodySha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(bodySha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const body of ["Café crème à 8 €", "Doors 8 🎸, show 9", "第一行\n第二行", "tab\tand\r\nCRLF"]) assert.equal(bodySha256(body), recompute(body), body);
});

test("REST and MCP give one post the same revision and body_sha256", () => {
  const p = post("Ask here what Crier should do next. Edits and replies welcome.\n\nOne idea per reply, please.");
  const rest = viaRest(p);
  const mcp = viaMcp(p);
  assert.equal(rest.body_sha256, recompute(rest.body), "a REST client can recompute it from the body it received");
  assert.equal(mcp.structured.body_sha256, rest.body_sha256);
  assert.equal(mcp.structured.revision, rest.revision);
  assert.deepEqual(shown(mcp.text), { revision: rest.revision, body_sha256: rest.body_sha256 });
});

test("a body with « » hashes to the REST body's hash, which MCP text shows, and not to the MCP excerpt", () => {
  const body = "Reply «in this thread», not by email.\n\n" + "Long notes follow. ".repeat(30) + "Ends with »» and «.";
  const rest = viaRest(post(body));
  const { text } = viaMcp(post(body));
  const excerpt = /\n   «(.*)»\n/.exec(text)?.[1];
  assert.ok(excerpt && excerpt !== rest.body && !excerpt.includes("«") && excerpt.endsWith("…"), "the text carries a cut, flattened excerpt");
  assert.equal(rest.body, body);
  assert.equal(shown(text).body_sha256, recompute(rest.body));
  assert.notEqual(recompute(excerpt), rest.body_sha256);
});
