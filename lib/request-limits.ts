/**
 * Per-request and per-address limits whose decisions are pure, so unit tests can load them.
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
