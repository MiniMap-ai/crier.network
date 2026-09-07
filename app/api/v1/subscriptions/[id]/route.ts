import { corsPreflight, fail, handler, ok } from "@/lib/http";
import { requirePublisher } from "@/lib/publishers";
import { deleteSubscription, getSubscription, publicSubscription } from "@/lib/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = () => corsPreflight();

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const publisher = await requirePublisher(req);
  const s = await getSubscription(id);
  if (!s || s.publisher_id !== publisher.id) return fail(404, "not_found", "No such subscription for this publisher.");
  return ok(publicSubscription(s));
});

export const DELETE = handler(async (req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const publisher = await requirePublisher(req);
  await deleteSubscription(publisher, id);
  return ok({ id, deleted: true });
});
