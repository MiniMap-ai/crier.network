import { handler, ok } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { sql, withTimeout } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/admin/search-log?days=30&limit=500 — the raw search log, newest and busiest first.
 *
 * The public `demand` block in /api/v1/metrics withholds shapes below the BR-17 threshold; this is
 * the same table without that fold, for the daily brief to read when the Supabase connector is not
 * available. It is still de-identified: there is no seeker column in `search_log` to return.
 */
export const GET = handler(async (req) => {
  requireAdmin(req);
  const p = new URL(req.url).searchParams;
  const days = Math.min(365, Math.max(1, Number(p.get("days")) || 30));
  const limit = Math.min(5000, Math.max(1, Number(p.get("limit")) || 500));
  const rows = await withTimeout(sql()<{ day: string; q: string | null; kind: string | null; tags: string | null; near: string | null; radius_km: number | null; source: string; n: number; zero: number }[]>`
    select day::text as day, q, kind, tags, near, radius_km, source, n, zero
      from search_log where day >= current_date - ${days - 1}::int
     order by day desc, n desc limit ${limit}`, { label: "admin:search-log" });
  return ok(rows, { meta: { days, limit, rows: rows.length, note: "One row per day per query shape. No seeker, address or time of day is recorded (BR-17). Rows are purged after 365 days." } });
});
