import { handler, ok } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { sql } from "@/lib/db";
import { CEILINGS, readOnly } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Operational snapshot: counts, ceilings used today, delivery health. */
export const GET = handler(async (req) => {
  requireAdmin(req);
  const s = sql();
  const [counts] = await s<Record<string, number>[]>`
    select (select count(*)::int from posts where deleted_at is null and expires_at > now()) as active_posts,
           (select count(*)::int from posts where hidden_at is not null and deleted_at is null) as hidden_posts,
           (select count(*)::int from posts where embedding is null and deleted_at is null) as unembedded_posts,
           (select count(*)::int from posts where 'possible_instruction' = any(flags) and deleted_at is null) as flagged_instruction,
           (select count(*)::int from publishers where status = 'active') as publishers,
           (select count(*)::int from publishers where status = 'suspended') as suspended_publishers,
           (select count(*)::int from reports where resolved_at is null) as open_reports,
           (select count(*)::int from subscriptions where active) as active_subscriptions,
           (select count(*)::int from subscriptions where webhook_url is not null and webhook_verified_at is null) as unverified_webhooks,
           (select count(*)::int from deliveries where status = 'pending') as pending_deliveries,
           (select count(*)::int from deliveries where status = 'failed') as failed_deliveries`;
  const used = await s<{ key: string; count: number; window_start: Date }[]>`select key, count, window_start from rate_limits where key like 'global:%'`;
  const days = await s`select * from stats_daily order by day desc limit 14`;
  return ok({
    read_only: readOnly(),
    counts,
    ceilings: Object.fromEntries(Object.entries(CEILINGS).map(([k, limit]) => {
      const u = used.find((r) => r.key === "global:" + k);
      const fresh = u && Date.now() - new Date(u.window_start).getTime() < 86400e3;
      return [k, { limit, used_today: fresh ? u!.count : 0 }];
    })),
    last_14_days: days,
  });
});
