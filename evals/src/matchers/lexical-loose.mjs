// A recall-first gate: structural filters, then fire when ANY query term (or any token of the
// intent's subject) appears in the notice. A stand-in for "how much would a cheap gate keep" until
// the embedding gate can run. Low precision by design; the question is its recall.
import { structuralReject } from "./structural.mjs";
import { tokens, noticeText, parseQuery } from "./lexical.mjs";

export const description = "structural filters + any-term overlap between the query or subject and the notice (recall-first gate)";

export async function judge(intent, notice) {
  const rej = structuralReject(intent, notice);
  if (rej) return { label: "no", score: 0, reason: `structural: ${rej}` };
  const doc = new Set(tokens(noticeText(notice)));
  const terms = new Set([...parseQuery(intent.grammar_today?.q ?? "").flatMap((g) => g.must), ...tokens(intent.subject)]);
  const hits = [...terms].filter((t) => doc.has(t));
  const s = terms.size ? hits.length / terms.size : 1;
  return { label: hits.length > 0 || terms.size === 0 ? "fire" : "no", score: s, reason: hits.length ? `terms present: ${hits.slice(0, 5).join(", ")}` : "no query or subject term present" };
}
