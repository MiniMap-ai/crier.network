import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { classifyUserAgent, noteDbTimeout, track } from "@/lib/metrics";
import { headers } from "next/headers";
import { PostList, fmtWhen } from "@/components/PostList";
import { env } from "@/lib/env";
import { POST_ID_RE } from "@/lib/ids";
import { cachedPostPage, cachedRelated } from "@/lib/cache";
import { jsonLd } from "@/lib/posts";

export const dynamic = "force-dynamic";
// A post page is one cached read and a view bump. If it cannot do that in ten seconds it is wedged,
// and the answer is to fail and let the caller retry, not to sit there until the platform kills it.
export const maxDuration = 10;

// generateMetadata and the page both need the post; React's cache dedupes it to one load per
// request, and lib/cache keeps that load off the database for a minute at a time.
const loadPost = cache((id: string) => cachedPostPage(id));

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  if (!POST_ID_RE.test(id)) return { title: "Not found" };
  // Not caught: a timeout here is the same failure the body reports, and a 500 titled "Not found"
  // would be a worse answer than an error page.
  const view = await loadPost(id);
  if (!view || view.deleted) return { title: "Not found", robots: { index: false } };
  const p = view.post;
  const noindex = Date.parse(p.expires_at) < Date.now() || view.hidden || !view.indexable;
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
  // The one read this page cannot render around. If it times out, say so with an error rather than
  // an empty article: app/error.tsx needs no database of its own.
  const view = await loadPost(id).catch((e: unknown) => { noteDbTimeout("p/[id]", e); throw e; });
  if (!view || view.deleted || view.hidden) notFound();
  const p = view.post;
  const ua = (await headers()).get("user-agent");
  const crawler = classifyUserAgent(ua) === "crawler";
  track.pageView(ua, "post");
  // Crawlers are most of the page traffic and none of the readers: no view bump, and no related-posts
  // read for relay pages they are told not to index anyway. Related posts are a nicety, so a slow one
  // is dropped rather than allowed to take the page down with it.
  const related = crawler && view.syndicated ? [] : await cachedRelated(id).catch((e: unknown) => { noteDbTimeout("p/[id]:related", e); return []; });
  const replies = { posts: view.replies };
  if (!crawler) track.view(id);
  const when = fmtWhen(p);
  const expired = Date.parse(p.expires_at) < Date.now();
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
