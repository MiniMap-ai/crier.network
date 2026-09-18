// The embedding branch of today's matcher: Cohere embed-v4.0, cosine distance, fire at or below
// a threshold (0.65 in production). Needs COHERE_API_KEY. Embeddings are cached on disk so a
// run costs the API once per text. Plus the structural filters.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { structuralReject } from "./structural.mjs";
import { noticeText } from "./lexical.mjs";

export const description = "structural filters + Cohere embed-v4 cosine distance <= threshold (default 0.65, env EVAL_SEMANTIC_DISTANCE)";
const CACHE = new URL("../../cache/embeddings.json", import.meta.url).pathname;
const THRESHOLD = Number(process.env.EVAL_SEMANTIC_DISTANCE || 0.65);

function loadCache() { return existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {}; }
function key(kind, text) { return kind + ":" + createHash("sha256").update(text).digest("hex").slice(0, 24); }

async function embedBatch(texts, inputType, apiKey) {
  const res = await fetch("https://api.cohere.com/v2/embed", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "embed-v4.0", input_type: inputType, embedding_types: ["float"], texts }),
  });
  if (!res.ok) throw new Error(`cohere ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).embeddings.float;
}

export async function embedAll(items, inputType, apiKey, cache) {
  const todo = items.filter(({ text, kind }) => !cache[key(kind, text)]);
  for (let i = 0; i < todo.length; i += 96) {
    const batch = todo.slice(i, i + 96);
    const vecs = await embedBatch(batch.map((b) => b.text), inputType, apiKey);
    batch.forEach((b, j) => { cache[key(b.kind, b.text)] = vecs[j]; });
    mkdirSync(new URL("../../cache", import.meta.url).pathname, { recursive: true });
    writeFileSync(CACHE, JSON.stringify(cache));
  }
  return (text, kind) => cache[key(kind, text)];
}

export function cosineDistance(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function intentQueryText(intent) { return intent.grammar_today?.q ?? intent.utterance; }

export async function prepare(data) {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error("semantic matcher needs COHERE_API_KEY (embeddings are cached in cache/ once fetched)");
  const cache = loadCache();
  const get = await embedAll([
    ...data.intents.map((i) => ({ kind: "q", text: intentQueryText(i) })),
    ...data.notices.map((n) => ({ kind: "d", text: noticeText(n) })),
  ].filter((x, i, arr) => arr.findIndex((y) => y.kind === x.kind && y.text === x.text) === i), "search_query", apiKey, cache);
  // Documents are embedded with the document input type; re-run for those.
  await embedAll(data.notices.map((n) => ({ kind: "d", text: noticeText(n) })), "search_document", apiKey, cache);
  return { get, threshold: THRESHOLD };
}

export async function judge(intent, notice, ctx) {
  const rej = structuralReject(intent, notice);
  if (rej) return { label: "no", score: 0, reason: `structural: ${rej}` };
  const d = cosineDistance(ctx.get(intentQueryText(intent), "q"), ctx.get(noticeText(notice), "d"));
  return { label: d <= ctx.threshold ? "fire" : "no", score: 1 - d, reason: `cosine distance ${d.toFixed(3)} vs ${ctx.threshold}` };
}
