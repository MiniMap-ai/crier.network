import { env } from "./env";
import { track } from "./metrics";
import { EMBED_RETRY_BACKOFF_MS, classifyThrown, failureCounter, shouldRetryEmbed } from "./embed-outcome";
import type { EmbedFailure, EmbedSite } from "./embed-outcome";

// Cohere embed-v4.0: asymmetric embeddings (documents vs queries), 1024 dims.
// Rerank-v3.5 for the second pass on text queries.
const EMBED_MODEL = process.env.COHERE_EMBED_MODEL || "embed-v4.0";
const RERANK_MODEL = process.env.COHERE_RERANK_MODEL || "rerank-v3.5";
export const EMBED_DIMS = 1024;

const DOCUMENT_TIMEOUT_MS = 8000;
const QUERY_TIMEOUT_MS = 5000;

/** `failure` is absent when no key is configured and nothing was sent. */
type Outcome<T> = { ok: true; value: T } | { ok: false; failure?: EmbedFailure };

async function call<T>(path: string, body: unknown, timeoutMs = DOCUMENT_TIMEOUT_MS): Promise<Outcome<T>> {
  if (!env.COHERE_API_KEY) return { ok: false };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.cohere.com/v2" + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.COHERE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error("cohere", path, res.status, (await res.text()).slice(0, 300));
      return { ok: false, failure: { cause: "status", status: res.status } };
    }
    return { ok: true, value: (await res.json()) as T };
  } catch (e) {
    console.error("cohere", path, (e as Error).message);
    return { ok: false, failure: classifyThrown(ctrl.signal.aborted, timeoutMs, e) };
  } finally {
    clearTimeout(t);
  }
}

type EmbedResponse = { embeddings: { float: number[][] } };

/**
 * Where an embedding is wanted, and until when. `deadline` is epoch milliseconds by which a retry
 * would have to finish; pass it only from a caller whose route has that time to spare. Without it
 * a failure is final.
 */
export type EmbedOpts = { site: EmbedSite; deadline?: number };

/**
 * One /embed request, made once more if shouldRetryEmbed allows it. Every failed attempt counts
 * under its cause; a call that ends with no vectors counts once more as `embed:failed:<site>`.
 * `failed` is false when no key is configured: nothing failed, there was nothing to call.
 */
async function embed(texts: string[], inputType: "search_document" | "search_query", timeoutMs: number, opts: EmbedOpts): Promise<{ vectors: number[][] | null; failed: boolean }> {
  const body = { model: EMBED_MODEL, texts, input_type: inputType, embedding_types: ["float"], output_dimension: EMBED_DIMS };
  for (let attempt = 1; ; attempt++) {
    const r = await call<EmbedResponse>("/embed", body, timeoutMs);
    if (r.ok) {
      if (attempt > 1) track.counter("embed:recovered");
      return { vectors: r.value.embeddings.float, failed: false };
    }
    if (!r.failure) return { vectors: null, failed: false };
    track.counter(failureCounter(r.failure));
    if (!shouldRetryEmbed(r.failure, { attempt, now: Date.now(), deadline: opts.deadline, attemptMs: timeoutMs })) {
      track.counter(`embed:failed:${opts.site}`);
      return { vectors: null, failed: true };
    }
    track.counter("embed:retried");
    await new Promise((resolve) => setTimeout(resolve, EMBED_RETRY_BACKOFF_MS));
  }
}

/** One vector per text, in order, or a null for each when Cohere is unavailable. A post stored with a null is filled later by backfillEmbeddings. */
export async function embedDocuments(texts: string[], opts: EmbedOpts): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const r = await embed(texts.map((t) => t.slice(0, 6000)), "search_document", DOCUMENT_TIMEOUT_MS, opts);
  return r.vectors ?? texts.map(() => null);
}

/** The query's vector, or null. `failed` says the null is Cohere failing rather than no key being configured. */
export async function embedQuery(text: string, opts: EmbedOpts): Promise<{ vec: number[] | null; failed: boolean }> {
  const r = await embed([text.slice(0, 2000)], "search_query", QUERY_TIMEOUT_MS, opts);
  return { vec: r.vectors?.[0] ?? null, failed: r.failed };
}

type RerankResponse = { results: { index: number; relevance_score: number }[] };

/** Returns indices into `docs` in ranked order with scores, or null if reranking is unavailable. */
export async function rerank(query: string, docs: string[], topN: number): Promise<{ index: number; score: number }[] | null> {
  if (docs.length === 0) return [];
  const r = await call<RerankResponse>("/rerank", {
    model: RERANK_MODEL,
    query: query.slice(0, 1000),
    documents: docs.map((d) => d.slice(0, 4000)),
    top_n: Math.min(topN, docs.length),
  }, 6000);
  if (!r.ok) return null;
  return r.value.results.map((x) => ({ index: x.index, score: x.relevance_score }));
}

/** The text we embed for a post: title, tags, place and body, in that order. */
export function postEmbeddingText(p: { title: string; body: string; tags: string[]; place_name?: string | null; kind: string }): string {
  const parts = [p.kind + ": " + p.title];
  if (p.tags.length) parts.push("tags: " + p.tags.join(", "));
  if (p.place_name) parts.push("where: " + p.place_name);
  parts.push(p.body);
  return parts.join("\n");
}
