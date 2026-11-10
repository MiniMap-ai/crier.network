import { NextResponse } from "next/server";
import { budget, sql, withTimeout } from "@/lib/db";
import { CONTENT_NOTICE, HttpError, bearer, clientIp, decodeCursor, encodeCursor, handler, rateLimit } from "@/lib/http";
import { safeEqual, sha256 } from "@/lib/ids";
import {
  NEVER_SERVED_TABLES, SNAPSHOT_BATCH_ROWS, SNAPSHOT_PAGE_BYTES, SNAPSHOT_TABLES,
  asSnapshotCursor, countStatement, cutPage, firstCursor, pageStatement, snapshotAccess,
} from "@/lib/dev-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Per address. A full copy is a handful of pages, so this leaves room for many reloads an hour. */
const SNAPSHOT_PAGES_PER_HOUR = 120;

const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...HEADERS, ...headers } });
}

/** handler() answers an HttpError through fail(), which reads board counts and sets no Cache-Control. */
function refusal(e: HttpError) {
  const retry = e.status === 429 ? { "Retry-After": String(e.retryAfter ?? 60) } : undefined;
  return reply(e.status, { ok: false, error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } }, retry);
}

/**
 * The dev dataset (docs/scenarios.md, scenario 15). Without a cursor, the manifest: tables, columns
 * and row counts, and the cursor of the first page. With one, a page of one table's rows.
 */
export async function GET(req: Request): Promise<Response> {
  // Including handler()'s own 500s, whose fail() sets no Cache-Control.
  const res = await guarded(req, undefined);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

const guarded = handler(async (req) => {
  try {
    return await snapshot(req);
  } catch (e) {
    if (e instanceof HttpError) return refusal(e);
    throw e;
  }
});

let warnedMisconfigured = false;

async function snapshot(req: Request): Promise<Response> {
  const access = snapshotAccess(process.env.CRIER_SNAPSHOT_KEY_SHA256, bearer(req), sha256, safeEqual);
  if (access === "misconfigured" && !warnedMisconfigured) {
    warnedMisconfigured = true;
    console.warn("CRIER_SNAPSHOT_KEY_SHA256 is set but is not 64 hex characters, so /api/dev/snapshot is disabled. Set it to the digest alone.");
  }
  if (access === "disabled" || access === "misconfigured") return reply(404, { ok: false, error: { code: "not_found", message: "Not found." } });
  const at = budget();
  await rateLimit(`snapshot:${clientIp(req)}`, SNAPSHOT_PAGES_PER_HOUR, 3600, "snapshot pages from this address", at("dev/snapshot:rateLimit"));
  if (access === "denied") return reply(401, { ok: false, error: { code: "unauthorized", message: "This endpoint needs the snapshot key as a bearer token." } });

  const raw = new URL(req.url).searchParams.get("cursor");
  if (!raw) {
    const [counts] = await withTimeout(sql().unsafe<Record<string, number>[]>(countStatement()), at("dev/snapshot:counts"));
    return reply(200, {
      ok: true,
      data: {
        version: 1,
        generated_at: new Date().toISOString(),
        page_bytes: SNAPSHOT_PAGE_BYTES,
        tables: SNAPSHOT_TABLES.map((t) => ({ name: t.name, key: t.key, columns: t.columns.map((c) => c.name), rows: counts?.[t.name] ?? 0 })),
        never_served: NEVER_SERVED_TABLES,
        embeddings: false,
      },
      next_cursor: encodeCursor(firstCursor()),
      meta: { content_notice: CONTENT_NOTICE },
    });
  }

  const cursor = asSnapshotCursor(decodeCursor(raw));
  if (!cursor) throw new HttpError(400, "invalid_cursor", "That cursor did not come from this endpoint.", "Start again from the manifest: GET without a cursor.");
  const table = SNAPSHOT_TABLES.find((t) => t.name === cursor.t)!;
  const fetched = await withTimeout(sql().unsafe<Record<string, unknown>[]>(pageStatement(table), [cursor.k, SNAPSHOT_BATCH_ROWS]), at(`dev/snapshot:${table.name}`));
  const page = cutPage(cursor, fetched);
  return reply(200, {
    ok: true,
    data: { table: table.name, columns: table.columns.map((c) => c.name), rows: page.rows },
    next_cursor: page.next ? encodeCursor(page.next) : null,
    meta: { content_notice: CONTENT_NOTICE },
  });
}
