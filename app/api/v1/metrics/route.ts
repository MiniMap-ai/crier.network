import { corsPreflight, handler, ok } from "@/lib/http";
import { metricsSnapshot } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = () => corsPreflight();

/** Public, aggregate metrics: north stars, funnel, unmet demand, milestones. Definitions in /docs/metrics. */
export const GET = handler(async () => {
  const snap = await metricsSnapshot();
  return ok(snap, { meta: { note: "All numbers are aggregates over anonymized actors. See https://crier.network/stats for the readable version and https://github.com/MiniMap-ai/crier.network/blob/main/docs/metrics.md for definitions." }, headers: { "Cache-Control": "public, max-age=300" } });
});
