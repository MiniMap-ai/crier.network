import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { deliverWebhooks, housekeeping, matchNewPosts } from "@/lib/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Runs every minute on Vercel Cron. Match new posts to subscriptions, push webhooks, tidy up. */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (env.CRON_SECRET && auth !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Cron only." } }, { status: 401 });
  }
  const started = Date.now();
  const matched = await matchNewPosts();
  const delivered = await deliverWebhooks();
  if (new Date().getMinutes() === 7) await housekeeping();
  return NextResponse.json({ ok: true, matched, delivered, ms: Date.now() - started });
}
