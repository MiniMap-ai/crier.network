import { corsPreflight, fail, handler, ok, readJson } from "@/lib/http";
import { PostPatchSchema, bumpViews, deletePost, getPostRow, publicPost, relatedPosts, repliesFor, updatePost } from "@/lib/posts";
import { requirePublisher } from "@/lib/publishers";
import { POST_ID_RE } from "@/lib/ids";
import { assertWritable } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = () => corsPreflight();

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, ctx: Ctx) => {
  const { id: raw } = await ctx.params;
  const id = raw.replace(/\.json$/, "");
  if (!POST_ID_RE.test(id)) return fail(404, "not_found", "No such post.", { hint: "Post ids are 8 characters, e.g. /api/v1/posts/8Hq2mZk3." });
  const row = await getPostRow(id);
  if (!row || row.deleted_at) return fail(404, "not_found", "No such post.", { hint: "It may have been removed by its publisher." });
  if (row.hidden_at) return fail(404, "hidden", "This post is hidden pending review.", { hint: "It was reported by several parties or removed by a moderator. If you published it and believe this is wrong, email abuse@crier.network." });
  const post = publicPost(row);
  post.related = await relatedPosts(id, 5);
  if (post.reply_count > 0 || post.kind === "thread") post.replies = (await repliesFor(id, 20)).posts;
  bumpViews(id);
  const expired = row.expires_at.getTime() < Date.now();
  return ok(post, { meta: expired ? { note: `This post expired ${post.expires_at}. It is kept for reference but no longer appears in search.` } : undefined });
});

export const PATCH = handler(async (req, ctx: Ctx) => {
  assertWritable();
  const { id } = await ctx.params;
  const publisher = await requirePublisher(req);
  const patch = PostPatchSchema.parse(await readJson(req));
  const post = await updatePost(publisher, id, patch);
  return ok(post, { meta: { note: "Updated. Subscribers are not re-notified for edits." } });
});

export const DELETE = handler(async (req, ctx: Ctx) => {
  assertWritable();
  const { id } = await ctx.params;
  const publisher = await requirePublisher(req);
  await deletePost(publisher, id);
  return ok({ id, deleted: true });
});
