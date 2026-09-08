import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { classifyUserAgent, track } from "@/lib/metrics";
import { headers } from "next/headers";
import { PostList, fmtWhen } from "@/components/PostList";
import { env } from "@/lib/env";
import { POST_ID_RE } from "@/lib/ids";
import { bumpViews, getPostRow, indexable, jsonLd, publicPost, relatedPosts, repliesFor } from "@/lib/posts";

export const dynamic = "force-dynamic";

// generateMetadata and the page both need the row; React's cache dedupes it to one query per request.
const loadPost = cache((id: string) => getPostRow(id));

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  if (!POST_ID_RE.test(id)) return { title: "Not found" };
  const row = await loadPost(id);
  if (!row || row.deleted_at) return { title: "Not found", robots: { index: false } };
  const p = publicPost(row);
  const noindex = row.expires_at.getTime() < Date.now() || !!row.hidden_at || !indexable(row);
  return {
    title: p.title,
    description: p.body.slice(0, 160),
    alternates: { canonical: p.url },
    openGraph: { title: p.title, description: p.body.slice(0, 200), url: p.url, type: "article" },
    robots: noindex ? { index: false, follow: true } : undefined,
  };
}

export default async function PostPage({ params }: Props) {
  const { id } = await params;
  if (!POST_ID_RE.test(id)) notFound();
  const row = await loadPost(id);
  if (!row || row.deleted_at || row.hidden_at) notFound();
  const p = publicPost(row);
  const ua = (await headers()).get("user-agent");
  const crawler = classifyUserAgent(ua) === "crawler";
  track.pageView(ua, "post");
  // Crawlers are most of the page traffic and none of the readers: no view bump, and no related-posts
  // query for relay pages they are told not to index anyway.
  const [related, replies] = await Promise.all([
    crawler && row.syndicated ? Promise.resolve([]) : relatedPosts(id, 5),
    p.reply_count > 0 || p.kind === "thread" ? repliesFor(id, 50) : Promise.resolve({ posts: [], next_cursor: null }),
  ]);
  if (!crawler) bumpViews(id);
  const when = fmtWhen(p);
  const expired = row.expires_at.getTime() < Date.now();
  const B = env.SITE_URL;
  return (
    <article className="article">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd(p)).replace(/</g, "\\u003c") }} />
      {p.parent_id && (
        <p className="muted small">↩ Reply in thread <Link href={`/p/${p.parent_id}`}>{p.parent_id}</Link></p>
      )}
      <p style={{ margin: "18px 0 0" }}><span className="kind">{p.parent_id ? "reply" : p.kind}</span>{expired && <span className="muted small">expired</span>}</p>
      <h1 style={{ marginTop: 6 }}>{p.title}</h1>
      <p className="muted">
        {when && <>{when} · </>}
        {p.location?.name && <>{p.location.name} · </>}
        by <Link href={`/publishers/${p.publisher.id}`}>{p.publisher.name}</Link>
        {p.publisher.verified && <span className="verified"> ✓ verified {p.publisher.domain}</span>}
      </p>
      <div className="body">{p.body}</div>
      {p.link && <p><a href={p.link} rel="nofollow ugc noopener" target="_blank">{p.link} ↗</a></p>}
      {p.tags.length > 0 && <p>{p.tags.map((t) => <Link key={t} href={`/?q=${encodeURIComponent(t)}`} className="tag">{t}</Link>)}</p>}

      <dl className="meta">
        <dt>Posted</dt><dd>{p.created_at}{p.updated_at !== p.created_at && <> · updated {p.updated_at}</>}</dd>
        <dt>Expires</dt><dd>{p.expires_at}</dd>
        {p.location?.lat != null && <><dt>Coordinates</dt><dd>{p.location.lat}, {p.location.lng}</dd></>}
        {p.source_url && <><dt>Source</dt><dd><a href={p.source_url} rel="nofollow noopener">{p.source_url}</a>{p.syndicated && " (syndicated)"}</dd></>}
        <dt>Retrievals</dt><dd>{p.retrievals} <span className="small">(times returned in search)</span></dd>
        <dt>Id</dt><dd><code>{p.id}</code> · <a href={`/api/v1/posts/${p.id}`}>JSON</a></dd>
      </dl>

      {(p.kind === "thread" || replies.posts.length > 0) && (
        <>
          <h2>Replies ({p.reply_count})</h2>
          {replies.posts.length === 0 ? <p className="muted">No replies yet.</p> : (
            <div>
              {replies.posts.map((r) => (
                <div key={r.id} className="reply">
                  <div className="small muted"><Link href={`/publishers/${r.publisher.id}`}>{r.publisher.name}</Link>{r.publisher.verified && <span className="verified"> ✓</span>} · {r.created_at} · <Link href={`/p/${r.id}`}>{r.id}</Link></div>
                  <div style={{ fontWeight: 600 }}>{r.title}</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{r.body}</div>
                </div>
              ))}
            </div>
          )}
          <p className="muted small">To reply: <code>POST {B}/api/v1/posts</code> with <code>{`{"parent_id":"${p.id}", ...}`}</code>. To be told about replies: subscribe with <code>{`{"thread":"${p.id}"}`}</code>.</p>
        </>
      )}

      {related.length > 0 && (
        <>
          <h2>Related</h2>
          <PostList posts={related} />
        </>
      )}
    </article>
  );
}
