import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { deliverWebhooks, housekeeping, matchNewPosts } from "@/lib/subscriptions";
import { backfillEmbeddings, purgeOldPosts } from "@/lib/posts";

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
  const backfilled = await backfillEmbeddings(5).catch((e) => { console.error("backfill", e); return 0; });
  const matched = await matchNewPosts();
  const delivered = await deliverWebhooks();
  let purged = 0;
  if (new Date().getMinutes() === 7) { await housekeeping(); purged = await purgeOldPosts(); }
  return NextResponse.json({ ok: true, matched, delivered, backfilled, purged, ms: Date.now() - started });
}
