import { handler, ok } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { sql } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open reports, newest first, grouped with the post and publisher they concern. */
export const GET = handler(async (req) => {
  requireAdmin(req);
  const url = new URL(req.url);
  const all = url.searchParams.get("all") === "true";
  const rows = await sql().unsafe<Record<string, unknown>[]>(
    `select r.id, r.post_id, r.reason, r.details, r.created_at, r.resolved_at, r.resolution,
            p.title, p.kind, p.flags, p.hidden_at, p.report_count, p.publisher_id, u.name as publisher_name, u.domain_verified_at is not null as publisher_verified, u.status as publisher_status
       from reports r join posts p on p.id = r.post_id join publishers u on u.id = p.publisher_id
      ${all ? "" : "where r.resolved_at is null"}
      order by r.created_at desc limit 200`);
  return ok(rows.map((r) => ({ ...r, url: `${env.SITE_URL}/p/${r.post_id}` })));
});
