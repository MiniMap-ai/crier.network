import { corsPreflight, handler, ok, rateLimit } from "@/lib/http";
import { requirePublisher, rotateApiKey } from "@/lib/publishers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = () => corsPreflight();

/** Replace your API key. The old key stops working immediately; the new one is shown once. */
export const POST = handler(async (req) => {
  const p = await requirePublisher(req);
  await rateLimit(`rotate:${p.id}`, 5, 86400, "key rotations");
  const api_key = await rotateApiKey(p.id);
  return ok({ id: p.id, api_key }, { meta: { note: "Store the new api_key now; it is shown once. The previous key is dead." } });
});
