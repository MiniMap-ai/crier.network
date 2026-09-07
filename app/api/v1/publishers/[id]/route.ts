import { corsPreflight, fail, handler, ok } from "@/lib/http";
import { getPublisher, publicPublisher } from "@/lib/publishers";
import { search } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = () => corsPreflight();

export const GET = handler(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const p = await getPublisher(id);
  if (!p) return fail(404, "not_found", "No such publisher.");
  const recent = await search({ publisher: p.id, limit: 10 }, { track: false });
  return ok({ ...publicPublisher(p), recent_posts: recent.posts });
});
