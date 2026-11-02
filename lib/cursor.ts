/**
 * Pagination cursors. Opaque to callers, but callers send them back, so a cursor that comes in is
 * caller input: one from a different query, a truncated one, one somebody typed. Decoded, it has
 * whatever shape it has — and `new Date(junk)` is an Invalid Date that postgres.js cannot serialize,
 * which on 2026-11-02 was a 500 on /api/v1/search. The guards below are what a query checks before
 * it trusts a field; a cursor that fails one is answered 400 `invalid_cursor` by the caller.
 *
 * No imports, so it can be tested without a database or a bundler.
 */

export function encodeCursor(o: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

/** The cursor's object, or null for anything that is not one: absent, undecodable, or not an object. */
export function decodeCursor<T = Record<string, unknown>>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
  } catch { return null; }
}

/** A date-time a query will hand to Postgres as a Date: it has to parse, or serializing it throws. */
export function isDateField(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

/** A keyset cursor over (order key, post id), as lib/search.ts writes it. */
export function isKeysetCursor(c: unknown, idRe: RegExp): c is { k: string; id: string } {
  const o = c as { k?: unknown; id?: unknown } | null;
  return !!o && isDateField(o.k) && typeof o.id === "string" && idRe.test(o.id);
}

/** A delivery id to resume after, as lib/subscriptions.ts writes it. */
export function isDeliveryCursor(c: unknown): c is { d: number } {
  const o = c as { d?: unknown } | null;
  return !!o && typeof o.d === "number" && Number.isInteger(o.d) && o.d >= 0;
}

/** An offset into the hybrid candidate pool, as lib/search.ts writes it. */
export function isOffsetCursor(c: unknown): c is { o: number } {
  const o = c as { o?: unknown } | null;
  return !!o && typeof o.o === "number" && Number.isInteger(o.o) && o.o >= 0;
}
