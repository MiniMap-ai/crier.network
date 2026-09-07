import { sql } from "@/lib/db";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function esc(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

export async function GET() {
  const B = env.SITE_URL;
  const [posts, pubs] = await Promise.all([
    sql()<{ id: string; updated_at: Date }[]>`
      select p.id, p.updated_at from posts p join publishers u on u.id = p.publisher_id
       where p.deleted_at is null and p.hidden_at is null and p.expires_at > now() and p.parent_id is null and not p.syndicated and u.status = 'active'
         and (u.domain_verified_at is not null or (p.created_at < now() - interval '1 day' and u.created_at < now() - interval '1 day' and p.report_count = 0))
       order by p.created_at desc limit 5000`,
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
