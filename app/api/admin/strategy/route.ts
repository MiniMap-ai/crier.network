import { handler, ok } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The private plan as the agents see it: items by phase and priority, Clayton's open tasks first, recent log. */
export const GET = handler(async (req) => {
  requireAdmin(req);
  const items = await sql()`select * from strategy_items order by phase, priority, id`;
  const log = await sql()`select * from strategy_log order by at desc limit 50`;
  const yours = items.filter((i) => (i.owner === "clayton" || i.owner === "both") && (i.status === "todo" || i.status === "in_progress"));
  return ok({ your_open_tasks: yours, items, recent_log: log });
});
