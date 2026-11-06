import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { noteDroppedRead, notePageFailure, track } from "@/lib/metrics";
import { headers } from "next/headers";
import { PostList } from "@/components/PostList";
import { getPublisher, publicPublisher } from "@/lib/publishers";
import { cachedPublisherPosts } from "@/lib/cache";
import { DB_SIDE_TIMEOUT_MS, budget, retryIfConnectionLost } from "@/lib/db";
import type { PublicPost } from "@/lib/posts";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

type Props = { params: Promise<{ id: string }> };

// One primary-key lookup, shared by generateMetadata and the body. Its budget is the small one: the
// listing below needs the rest of what the route is allowed. A connection that goes away under it
// gets one more try on that budget's remainder, as the post page's load does.
// If it still fails the page is a 500, and it is counted on the shared promise for the reason given
// in app/p/[id]/page.tsx: either awaiter may be the one that sees the rejection.
const loadPublisher = cache((id: string) => {
  const at = budget(DB_SIDE_TIMEOUT_MS);
  return retryIfConnectionLost(() => getPublisher(id, at)).catch((e: unknown) => { notePageFailure("publishers/[id]", e); throw e; });
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const p = await loadPublisher(id);
  return { title: p ? `${p.name} on Crier` : "Not found" };
}

export default async function PublisherPage({ params }: Props) {
  const { id } = await params;
  const row = await loadPublisher(id);
  if (!row) notFound();
  const p = publicPublisher(row);
  track.pageView((await headers()).get("user-agent"), "publisher");
  // The listing is cached and, failing that, droppable: the publisher is the page, the posts are a list.
  const posts = await cachedPublisherPosts(p.id).catch((e: unknown) => { noteDroppedRead("publishers/[id]:posts", e); return [] as PublicPost[]; });
  return (
    <>
      <h1>{p.name}{p.verified && <span className="verified" style={{ fontSize: 14, marginLeft: 10 }}>✓ verified {p.domain}</span>}</h1>
      {p.description && <p className="lede">{p.description}</p>}
      <dl className="meta">
        {p.url && <><dt>Website</dt><dd><a href={p.url} rel="nofollow noopener">{p.url}</a></dd></>}
        <dt>First seen</dt><dd>{p.first_seen}</dd>
        <dt>Posts</dt><dd>{p.post_count}</dd>
        <dt>Id</dt><dd><code>{p.id}</code> · <a href={`/api/v1/publishers/${p.id}`}>JSON</a> · <a href={`/feed.xml?publisher=${p.id}`}>RSS</a></dd>
      </dl>
      <h2>Active posts</h2>
      <PostList posts={posts} empty="No active posts." />
    </>
  );
}
