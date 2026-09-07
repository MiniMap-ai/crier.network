import { SITE, env } from "@/lib/env";
import { handler } from "@/lib/http";
import { describeQuery, parseSearchQuery, search } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function esc(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

/** RSS 2.0 over the same query grammar as /search. */
export const GET = handler(async (req) => {
  const url = new URL(req.url);
  const q = parseSearchQuery(url.searchParams);
  if (!q.limit) q.limit = 50;
  const r = await search(q, { track: false });
  const B = env.SITE_URL;
  const title = `${SITE.name}: ${describeQuery(q)}`;
  const items = r.posts.map((p) => {
    const when = p.starts_at ? `When: ${p.starts_at}${p.ends_at ? " to " + p.ends_at : ""}${p.timezone ? " (" + p.timezone + ")" : ""}\n` : "";
    const where = p.location?.name ? `Where: ${p.location.name}\n` : "";
    const desc = `${when}${where}${p.body}\n\nPosted by ${p.publisher.name}${p.publisher.verified ? " (verified " + p.publisher.domain + ")" : ""}.${p.link ? " More: " + p.link : ""}`;
    return `  <item>
    <title>[${esc(p.kind)}] ${esc(p.title)}</title>
    <link>${esc(p.url)}</link>
    <guid isPermaLink="true">${esc(p.url)}</guid>
    <pubDate>${new Date(p.created_at).toUTCString()}</pubDate>
    <author>${esc(p.publisher.name)}</author>
    <category>${esc(p.kind)}</category>
${p.tags.map((t) => `    <category>${esc(t)}</category>`).join("\n")}
${p.location?.lat != null ? `    <georss:point>${p.location.lat} ${p.location.lng}</georss:point>` : ""}
${p.starts_at ? `    <crier:starts_at>${esc(p.starts_at)}</crier:starts_at>` : ""}
${p.ends_at ? `    <crier:ends_at>${esc(p.ends_at)}</crier:ends_at>` : ""}
    <crier:expires_at>${esc(p.expires_at)}</crier:expires_at>
    <crier:publisher id="${esc(p.publisher.id)}" verified="${p.publisher.verified}">${esc(p.publisher.name)}</crier:publisher>
    <description>${esc(desc)}</description>
  </item>`;
  }).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:georss="http://www.georss.org/georss" xmlns:crier="${B}/ns">
<channel>
  <title>${esc(title)}</title>
  <link>${B}/?${esc(url.searchParams.toString())}</link>
  <atom:link href="${esc(B + url.pathname + url.search)}" rel="self" type="application/rss+xml"/>
  <description>${esc(SITE.about)} JSON version of this feed: ${B}/api/v1/search?${esc(url.searchParams.toString())}</description>
  <language>en</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <ttl>5</ttl>
${items}
</channel>
</rss>`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=120" } });
});
