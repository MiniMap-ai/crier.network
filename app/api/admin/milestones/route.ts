import { handler, ok } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { evaluateMilestones, metricsSnapshot } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Internal yardstick: the milestone ladder evaluated against live metrics. */
export const GET = handler(async (req) => {
  requireAdmin(req);
  const snap = await metricsSnapshot();
  const milestones = evaluateMilestones(snap.metrics);
  const current = milestones.find((m) => !m.met) ?? milestones[milestones.length - 1];
  return ok({ current: current.id, milestones, metrics: snap.metrics });
});
