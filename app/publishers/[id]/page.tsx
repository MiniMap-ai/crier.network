import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PostList } from "@/components/PostList";
import { getPublisher, publicPublisher } from "@/lib/publishers";
import { search } from "@/lib/search";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const p = await getPublisher(id);
  return { title: p ? `${p.name} on Crier` : "Not found" };
}

export default async function PublisherPage({ params }: Props) {
  const { id } = await params;
  const row = await getPublisher(id);
  if (!row) notFound();
  const p = publicPublisher(row);
  const r = await search({ publisher: p.id, limit: 50, include_replies: "true" }, { track: false });
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
      <PostList posts={r.posts} empty="No active posts." />
    </>
  );
}
