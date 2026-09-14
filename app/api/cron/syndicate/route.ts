import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runDue } from "@/lib/syndication/runner";
import { readOnly } from "@/lib/limits";
import { track } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Hourly ticks over the last 14 days: 2.2 s average per source, 42.6 s p95 per tick, 159.2 s at the
// worst. 120 would have cut that one off, so give it room; nothing waits on this route.
export const maxDuration = 300;

/** Hourly on Vercel Cron: relay due sources. Also callable by admins to run now. */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const allowed = (env.CRON_SECRET && auth === `Bearer ${env.CRON_SECRET}`) || (env.ADMIN_KEY && auth === `Bearer ${env.ADMIN_KEY}`);
  if (!allowed) return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Cron or admin only." } }, { status: 401 });
  if (readOnly()) return NextResponse.json({ ok: true, skipped: "read_only" });
  const started = Date.now();
  track.counter("cron:syndicate");
  await track.flush();
  const result = await runDue(100_000);
  // The run's own counters (synd:folded, synd:collapsed) land here rather than riding on `after()`:
  // the daily brief reads them out of daily_counters, and a tick that dropped them tells it nothing.
  await track.flush();
  return NextResponse.json({ ok: true, ...result, ms: Date.now() - started });
}
