import { clientIp, corsPreflight, fail, handler, ok, rateLimit, readJson } from "@/lib/http";
import { PostPatchSchema, deletePost, getPostRow, publicPost, relatedPosts, repliesFor, updatePost } from "@/lib/posts";
import { budget, isDbFailure } from "@/lib/db";
import { noteDbTimeout, track } from "@/lib/metrics";
import { requirePublisher } from "@/lib/publishers";
import { POST_ID_RE } from "@/lib/ids";
import { assertWritable } from "@/lib/limits";
import { POST_READS } from "@/lib/request-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export const OPTIONS = () => corsPreflight();

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req, ctx: Ctx) => {
  const { id: raw } = await ctx.params;
  const id = raw.replace(/\.json$/, "");
  if (!POST_ID_RE.test(id)) return fail(404, "not_found", "No such post.", { hint: "Post ids are 8 characters, e.g. /api/v1/posts/8Hq2mZk3." });
  const at = budget();   // the limiter, the post, its related posts and its replies share one budget
  await rateLimit(`read:${clientIp(req)}`, POST_READS.limit, POST_READS.windowSeconds, "post reads from this address", at("api/v1/posts/[id]:rateLimit"));
  const row = await getPostRow(id, undefined, at);
  if (!row || row.deleted_at) return fail(404, "not_found", "No such post.", { hint: "It may have been removed by its publisher." });
  if (row.hidden_at) return fail(404, "hidden", "This post is hidden pending review.", { hint: "It was reported by several parties or removed by a moderator. If you published it and believe this is wrong, email abuse@crier.network." });
  const post = publicPost(row);
  // Replies before related: a related timeout spends what is left of the budget, not what replies need.
  if (post.reply_count > 0 || post.kind === "thread") post.replies = (await repliesFor(id, 20, undefined, at)).posts;
  // Related posts are decoration: a database failure on them costs the caller the related block, not
  // the post, and is counted as a dropped read (docs/metrics.md). The post and replies reads above
  // stay uncaught: without them there is no post to answer with, so the handler answers 503 (CRI-47).
  post.related = await relatedPosts(id, 5, at).catch((e: unknown) => {
    if (!isDbFailure(e)) throw e;   // a bug in the read stays a 500 with a ref, not an empty list
    noteDbTimeout("api/v1/posts/[id]:related", e);
    return [];
  });
  track.view(id);
  const expired = row.expires_at.getTime() < Date.now();
  return ok(post, {
    meta: expired ? { note: `This post expired ${post.expires_at}. It is kept for reference but no longer appears in search.` } : undefined,
    // A post object changes rarely; let the edge absorb repeated fetches of the same id.
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600" },
  });
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
