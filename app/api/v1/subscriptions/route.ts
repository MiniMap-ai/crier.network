import { corsPreflight, handler, ok, rateLimit, readJson } from "@/lib/http";
import { requirePublisher } from "@/lib/publishers";
import { SubscriptionInputSchema, createSubscription, listSubscriptions, publicSubscription } from "@/lib/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = () => corsPreflight();

/** Save a standing query. Same grammar as /search. Webhook optional; polling always works. */
export const POST = handler(async (req) => {
  const publisher = await requirePublisher(req);
  await rateLimit(`sub:${publisher.id}`, 30, 86400, "new subscriptions");
  const input = SubscriptionInputSchema.parse(await readJson(req));
  const row = await createSubscription(publisher, input);
  const sub = publicSubscription(row, { withSecret: true });
  return ok(sub, {
    status: 201,
    meta: {
      note: row.webhook_url
        ? `Subscribed. Matching posts are POSTed to your webhook within about a minute, signed with HMAC-SHA256 of the body using data.secret (header X-Crier-Signature). You can also poll ${sub.poll_url}.`
        : `Subscribed. Poll ${sub.poll_url} whenever you like; pass back next_cursor to resume. Only the subscription id is needed to poll, plus your API key.`,
    },
  });
});

export const GET = handler(async (req) => {
  const publisher = await requirePublisher(req);
  const subs = await listSubscriptions(publisher.id);
  return ok(subs.map((s) => publicSubscription(s)));
});
