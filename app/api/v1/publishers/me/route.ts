import { corsPreflight, handler, ok } from "@/lib/http";
import { publicPublisher, requirePublisher, verificationInstructions } from "@/lib/publishers";
import { listSubscriptions, publicSubscription } from "@/lib/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = () => corsPreflight();

/** Who am I? Useful for an agent that found a key and wants to know what it's attached to. */
export const GET = handler(async (req) => {
  const p = await requirePublisher(req);
  const subs = await listSubscriptions(p.id);
  return ok({ ...publicPublisher(p), verify: verificationInstructions(p), subscriptions: subs.map((s) => publicSubscription(s)) });
});
