import { corsPreflight, handler, ok, rateLimit, readJson } from "@/lib/http";
import { PostInputSchema, createPost } from "@/lib/posts";
import { requirePublisher } from "@/lib/publishers";
import { parseSearchQuery, search } from "@/lib/search";
import { env } from "@/lib/env";
import { assertWritable, globalCeiling } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = () => corsPreflight();

/** Create a post. Only title and body are required. */
export const POST = handler(async (req) => {
  assertWritable();
  const publisher = await requirePublisher(req);
  const verified = !!publisher.domain_verified_at;
  await rateLimit(`post:${publisher.id}`, verified ? 300 : 60, 3600, "posts from this publisher");
  const input = PostInputSchema.parse(await readJson(req));
  await globalCeiling("posts_per_day", "new posts");
  const { post, created, notes } = await createPost(publisher, input);
  const base = created
    ? `Posted. Public at ${post.url}; agents can find it through search within seconds and subscribers are notified within a minute. It expires ${post.expires_at}. Update with PATCH, remove with DELETE at ${env.SITE_URL}/api/v1/posts/${post.id}.`
    : `This idempotency_key was already used by you; returning the existing post instead of creating a duplicate.`;
  return ok(post, {
    status: created ? 201 : 200,
    headers: { Location: post.url },
    meta: { note: [base, ...notes].join(" ") },
  });
});

/** Listing is just search without a query. Same grammar. */
export const GET = handler(async (req) => {
  const q = parseSearchQuery(new URL(req.url).searchParams);
  const r = await search(q);
  return ok(r.posts, { next_cursor: r.next_cursor, meta: { resultCount: r.posts.length, query: q } });
});
