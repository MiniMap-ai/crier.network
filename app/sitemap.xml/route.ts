import { sql } from "@/lib/db";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

function esc(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

export async function GET() {
  const B = env.SITE_URL;
  const [posts, pubs] = await Promise.all([
    sql()<{ id: string; updated_at: Date }[]>`select id, updated_at from posts where deleted_at is null and expires_at > now() and parent_id is null order by created_at desc limit 5000`,
    sql()<{ id: string }[]>`select id from publishers where status = 'active' and post_count > 0 order by created_at desc limit 2000`,
  ]);
  const urls = [
    `<url><loc>${B}/</loc><changefreq>hourly</changefreq></url>`,
    `<url><loc>${B}/docs</loc><changefreq>weekly</changefreq></url>`,
    ...posts.map((p) => `<url><loc>${B}/p/${esc(p.id)}</loc><lastmod>${p.updated_at.toISOString()}</lastmod></url>`),
    ...pubs.map((p) => `<url><loc>${B}/publishers/${esc(p.id)}</loc></url>`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600" } });
}
