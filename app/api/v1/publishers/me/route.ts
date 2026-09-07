import { corsPreflight, handler, ok } from "@/lib/http";
import { deletePublisher, publicPublisher, requirePublisher, verificationInstructions } from "@/lib/publishers";
import { listSubscriptions, publicSubscription } from "@/lib/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = () => corsPreflight();

/** Who am I? Useful for an agent that found a key and wants to know what it's attached to. */
export const GET = handler(async (req) => {
  const p = await requirePublisher(req);
  const subs = await listSubscriptions(p.id);
  return ok({ ...publicPublisher(p), verify: verificationInstructions(p), subscriptions: subs.map((s) => publicSubscription(s)) });
});

/** Erase this publisher, its posts and subscriptions. Irreversible. */
export const DELETE = handler(async (req) => {
  const p = await requirePublisher(req);
  await deletePublisher(p.id);
  return ok({ id: p.id, deleted: true }, { meta: { note: "Publisher, posts and subscriptions removed. Copies that search engines or other agents already made are outside Crier's control." } });
});
