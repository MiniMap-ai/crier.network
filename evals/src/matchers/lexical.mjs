// Today's keyword branch: an approximation of Postgres websearch_to_tsquery('english') over the
// post's title, body, tags and place name, plus the structural filters. No embeddings.
// This is a lower bound on today's matcher, which also fires on embedding distance <= 0.65.
import { structuralReject } from "./structural.mjs";

export const description = "structural filters + keyword AND-match on title/body/tags/place (approximates websearch_to_tsquery)";

const STOP = new Set("a an and are as at be by for from has he in is it its of on or that the to was were will with this these those i you your we our they their not no do does did have had but if then than so very can could would should may might just".split(" "));

export function stem(w) {
  // A deliberately small stemmer: enough to make plural and -ing/-ed forms meet, like Postgres's english config does.
  if (w.length <= 3) return w;
  for (const [suf, rep] of [["ies", "y"], ["sses", "ss"], ["ness", ""], ["ing", ""], ["ed", ""], ["es", ""], ["s", ""]]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length) + rep;
  }
  return w;
}

export function tokens(text) {
  return String(text).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).map(stem);
}

/** Parse a websearch-style query into OR-groups of {must:[], mustNot:[]}. */
export function parseQuery(q) {
  const groups = [];
  for (const part of String(q).split(/\s+or\s+/i)) {
    const must = [], mustNot = [];
    for (const m of part.matchAll(/(-)?"([^"]+)"|(-)?(\S+)/g)) {
      const neg = m[1] || m[3]; const text = m[2] ?? m[4];
      for (const t of tokens(text)) (neg ? mustNot : must).push(t);
    }
    groups.push({ must, mustNot });
  }
  return groups;
}

export function noticeText(n) {
  return [n.title, n.body, n.tags.join(" "), n.place_name ?? ""].join("\n");
}

export function lexicalScore(q, notice) {
  const doc = new Set(tokens(noticeText(notice)));
  let best = 0;
  for (const g of parseQuery(q)) {
    if (g.mustNot.some((t) => doc.has(t))) continue;
    if (g.must.length === 0) continue;
    const hit = g.must.filter((t) => doc.has(t)).length;
    best = Math.max(best, hit === g.must.length ? 1 : hit / g.must.length);
  }
  return best;
}

export async function judge(intent, notice) {
  const rej = structuralReject(intent, notice);
  if (rej) return { label: "no", score: 0, reason: `structural: ${rej}` };
  const q = intent.grammar_today?.q;
  if (!q) return { label: "fire", score: 1, reason: "no q: filters alone match" };
  const s = lexicalScore(q, notice);
  return { label: s >= 1 ? "fire" : "no", score: s, reason: s >= 1 ? "every query term present" : `${Math.round(s * 100)}% of query terms present` };
}
