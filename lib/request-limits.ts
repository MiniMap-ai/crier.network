/**
 * Per-request and per-address limits, and the input handling of the reads they guard, whose
 * decisions are pure, so unit tests can load them.
 * Rationale for the numbers: docs/scenarios.md, scenario 14.
 */

export type RateRule = { limit: number; windowSeconds: number };

/** Post reads (REST GET /api/v1/posts/:id and MCP get_post) per address, shared by both surfaces. */
export const POST_READS: RateRule = { limit: 600, windowSeconds: 600 };

/**
 * Whether a hit is refused, given what `rate_limit_hit` returned: the rule's limit minus the hits
 * counted in the current window, this one included. Zero is the last hit allowed.
 */
export function overLimit(remaining: number): boolean {
  return remaining < 0;
}

/**
 * The counter suffix for a rate-limit key: its scope, the text before the first colon
 * (`read:<address>` is `read`). Keys are built in code, so the scope is one of a fixed few.
 */
export function limitScope(key: string): string {
  const i = key.indexOf(":");
  return i < 0 ? key : key.slice(0, i);
}

/** Scopes keyed by the caller's network address alone, whether or not it sends a key. */
const ADDRESS_SCOPES = new Set(["read", "search", "feed", "register", "report"]);
/** Scopes keyed by the publisher the key belongs to (`verifyhook` by that publisher's subscription). */
const PUBLISHER_SCOPES = new Set(["post", "inbox", "sub", "rotate", "verify", "verifyhook"]);

export type LimitRefusal = { scope: string; message: string; hint: string; retryAfter: number };

/**
 * What a 429 from `rateLimit` says. `retryAfter` is the window length in seconds: the window is
 * fixed and resets `windowSeconds` after its first hit (rate_limit_hit, migrations/0001_init.sql),
 * so waiting that long always clears it. The hint says who shares the allowance, by scope.
 */
export function limitRefusal(key: string, limit: number, windowSeconds: number, what: string): LimitRefusal {
  const scope = limitScope(key);
  const who = ADDRESS_SCOPES.has(scope)
    ? " This limit is per network address and shared with everyone behind it; sending a key does not change it."
    : PUBLISHER_SCOPES.has(scope)
      ? ` This limit is per publisher.${scope === "post" ? " Verified publishers get more." : ""}`
      : "";
  return {
    scope,
    message: `Too many ${what}: limit is ${limit} per ${humanWindow(windowSeconds)}.`,
    hint: `Back off for the delay given (Retry-After on the REST API, retry_after in an MCP error), then retry with exponential backoff.${who} See /llms.txt.`,
    retryAfter: windowSeconds,
  };
}

function humanWindow(s: number): string {
  if (s % 86400 === 0) return s / 86400 === 1 ? "day" : `${s / 86400} days`;
  if (s % 3600 === 0) return s / 3600 === 1 ? "hour" : `${s / 3600} hours`;
  if (s % 60 === 0) return s / 60 === 1 ? "minute" : `${s / 60} minutes`;
  return `${s} seconds`;
}

/** Most JSON-RPC messages one POST /mcp may carry, notifications included. */
export const MCP_MAX_BATCH = 5;

export type BatchCheck =
  | { ok: true; msgs: unknown[] }
  | { ok: false; reason: "too_large" | "invalid"; message: string; data?: unknown };

/**
 * Splits a parsed POST /mcp body into its messages, refusing an empty batch, a batch longer than
 * MCP_MAX_BATCH, and any entry that is not a JSON-RPC 2.0 request or notification. A refusal maps
 * to JSON-RPC -32600 with HTTP 400; the size is checked before any entry is looked at.
 */
export function checkBatch(body: unknown): BatchCheck {
  const msgs = Array.isArray(body) ? body : [body];
  if (msgs.length > MCP_MAX_BATCH) {
    return {
      ok: false,
      reason: "too_large",
      message: `Batch too large: at most ${MCP_MAX_BATCH} messages per request. Send the rest as separate requests.`,
      data: { max_batch: MCP_MAX_BATCH, received: msgs.length },
    };
  }
  const valid = (m: unknown) => {
    const o = m as { jsonrpc?: unknown; method?: unknown } | null;
    return !!o && typeof o === "object" && o.jsonrpc === "2.0" && typeof o.method === "string";
  };
  if (msgs.length === 0 || !msgs.every(valid)) return { ok: false, reason: "invalid", message: "Invalid Request" };
  return { ok: true, msgs };
}

/**
 * How many entries of one batch run at once. MCP_MAX_BATCH entries make three rounds of at most
 * DB_TIMEOUT_MS (8 s by default), inside /mcp's 30 s maxDuration (docs/scenarios.md, scenario 14).
 */
export const MCP_BATCH_CONCURRENCY = 2;

/**
 * `fn` over `items` with at most `concurrency` calls in flight, results in the order of `items`.
 * Rejects with the first rejection, so an `fn` whose every result is wanted must not reject.
 */
export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return out;
}

/**
 * The post id in what a caller passed as one: a bare id, `<id>.json`, or a pasted post URL such as
 * `https://crier.network/p/<id>?utm_source=x#top`. Not validated: the caller tests POST_ID_RE.
 */
export function postIdFromInput(raw: string): string {
  return raw.trim().replace(/[?#].*$/s, "").replace(/^.*\/p\//, "").split("/")[0].replace(/\.json$/, "");
}
