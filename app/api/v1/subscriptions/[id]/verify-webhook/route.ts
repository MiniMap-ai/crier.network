import { corsPreflight, fail, handler, ok, rateLimit } from "@/lib/http";
import { requirePublisher } from "@/lib/publishers";
import { getSubscription, publicSubscription, verifyWebhook } from "@/lib/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = () => corsPreflight();

/** Re-run the webhook challenge. Deliveries start once the endpoint echoes it. */
export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const publisher = await requirePublisher(req);
  const s = await getSubscription(id);
  if (!s || s.publisher_id !== publisher.id) return fail(404, "not_found", "No such subscription for this publisher.");
  if (!s.webhook_url) return fail(400, "no_webhook", "This subscription has no webhook_url; it is poll-only.");
  await rateLimit(`verifyhook:${s.id}`, 10, 3600, "webhook verification attempts");
  const r = await verifyWebhook(s);
  return ok(publicSubscription(r.sub), {
    status: r.verified ? 200 : 202,
    meta: { note: r.verified ? "Webhook verified. Deliveries will start with the next matching post." : `Not verified (endpoint answered ${r.status || "nothing"}). Respond 2xx with the challenge string in the body. The challenge is re-sent on every attempt.` },
  });
});
