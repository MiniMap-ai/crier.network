/**
 * The identity of an upstream thing, derived from its URL.
 *
 * Two posts with the same `source_key` are the same thing said twice. Search collapses on it
 * (lib/search.ts), the syndication runner writes on it (lib/syndication/collapse.ts), and
 * `posts.source_key` stores it. It lives in a module of its own because it is pure — no database,
 * no `next/server` — so both of those can use it and a test can import it.
 */
export function normalizeSourceKey(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    url.hash = "";
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(k)) url.searchParams.delete(k);
    let s = url.toString().toLowerCase().replace(/^https?:\/\/(www\.)?/, "");
    s = s.replace(/\/+$/, "");
    return s.slice(0, 500);
  } catch { return null; }
}
