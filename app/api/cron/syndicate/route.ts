import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runDue } from "@/lib/syndication/runner";
import { readOnly } from "@/lib/limits";
import { track } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Hourly on Vercel Cron: relay due sources. Also callable by admins to run now. */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const allowed = (env.CRON_SECRET && auth === `Bearer ${env.CRON_SECRET}`) || (env.ADMIN_KEY && auth === `Bearer ${env.ADMIN_KEY}`);
  if (!allowed) return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Cron or admin only." } }, { status: 401 });
  if (readOnly()) return NextResponse.json({ ok: true, skipped: "read_only" });
  const started = Date.now();
  track.counter("cron:syndicate");
  const result = await runDue(100_000);
  return NextResponse.json({ ok: true, ...result, ms: Date.now() - started });
}
