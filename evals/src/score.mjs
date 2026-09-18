// Score a predictions file against the labelled pairs.
// Usage: node src/score.mjs predictions/<matcher>.jsonl [--data dir] [--json]
//
// A prediction row is { intent, notice, label: "fire" | "no", score?, reason? }. Pairs with no
// prediction count as "no" (the matcher did not fire) and are reported as missing.
//
// Gold "borderline" is scored two ways: strict treats it as "no"; lenient drops it. Both are
// reported. Precision, recall and F1 are for the "fire" class, which is what a subscriber sees.
import { writeFileSync } from "node:fs";
import { loadData, readJsonl } from "./data.mjs";

const QUALIFIERS = ["place", "time", "price", "source", "trust", "exclude"];

function prf(tp, fp, fn) {
  const p = tp + fp ? tp / (tp + fp) : 0;
  const r = tp + fn ? tp / (tp + fn) : 0;
  const f = p + r ? (2 * p * r) / (p + r) : 0;
  return { tp, fp, fn, precision: p, recall: r, f1: f };
}

function tally(rows) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const { gold, pred } of rows) {
    if (gold === "fire" && pred === "fire") tp++;
    else if (gold === "no" && pred === "fire") fp++;
    else if (gold === "fire" && pred === "no") fn++;
    else tn++;
  }
  return { ...prf(tp, fp, fn), tn, n: rows.length };
}

export function score(predictions, data) {
  const predByKey = new Map(predictions.map((p) => [`${p.intent}|${p.notice}`, p]));
  let missing = 0;
  const rows = data.pairs.map((pair) => {
    const p = predByKey.get(`${pair.intent}|${pair.notice}`);
    if (!p) missing++;
    const pred = p?.label === "fire" ? "fire" : "no";
    return { pair, intent: data.intentById.get(pair.intent), notice: data.noticeById.get(pair.notice), goldRaw: pair.label, pred, score: p?.score ?? null };
  });
  const strict = rows.map((r) => ({ ...r, gold: r.goldRaw === "fire" ? "fire" : "no" }));
  const lenient = rows.filter((r) => r.goldRaw !== "borderline").map((r) => ({ ...r, gold: r.goldRaw }));

  const by = (rowsIn, keyFn) => {
    const groups = new Map();
    for (const r of rowsIn) for (const k of [].concat(keyFn(r))) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, rs]) => ({ key: k, ...tally(rs) }));
  };

  return {
    n_pairs: data.pairs.length, n_predictions: predictions.length, missing,
    strict: { overall: tally(strict), hard_only: tally(strict.filter((r) => r.pair.hard)) },
    lenient: { overall: tally(lenient), hard_only: tally(lenient.filter((r) => r.pair.hard)) },
    by_group: by(strict, (r) => r.intent.group),
    by_qualifier: by(strict, (r) => QUALIFIERS.filter((q) => r.intent.qualifiers[q])),
    by_persona: by(strict, (r) => r.intent.persona),
    by_sloppiness: by(strict, (r) => r.notice.sloppy.length ? r.notice.sloppy : ["clean"]),
    false_negatives: strict.filter((r) => r.gold === "fire" && r.pred === "no").map((r) => ({ intent: r.pair.intent, notice: r.pair.notice, hard: r.pair.hard, reason: r.pair.reason })),
    false_positives: strict.filter((r) => r.gold === "no" && r.pred === "fire").map((r) => ({ intent: r.pair.intent, notice: r.pair.notice, hard: r.pair.hard, reason: r.pair.reason })),
  };
}

const pct = (x) => (100 * x).toFixed(1).padStart(5);
const line = (label, t) => `| ${label.padEnd(22)} | ${String(t.n).padStart(4)} | ${pct(t.precision)} | ${pct(t.recall)} | ${pct(t.f1)} |`;
const header = (title) => [`\n**${title}**\n`, "| slice                  |    n |  prec |   rec |    f1 |", "|------------------------|-----:|------:|------:|------:|"];

export function formatScore(s, name) {
  const out = [`# ${name}`, "", `${s.n_pairs} labelled pairs, ${s.n_predictions} predictions, ${s.missing} pairs with no prediction (scored as no).`];
  out.push(...header("Overall (fire class)"));
  out.push(line("strict, all", s.strict.overall), line("strict, hard only", s.strict.hard_only), line("lenient, all", s.lenient.overall), line("lenient, hard only", s.lenient.hard_only));
  for (const [title, key] of [["By intent group (strict)", "by_group"], ["By qualifier present (strict)", "by_qualifier"], ["By notice sloppiness (strict)", "by_sloppiness"], ["By persona (strict)", "by_persona"]]) {
    out.push(...header(title));
    for (const t of s[key]) out.push(line(t.key, t));
  }
  out.push("", `False negatives: ${s.false_negatives.length} (${s.false_negatives.filter((x) => x.hard).length} hard). False positives: ${s.false_positives.length} (${s.false_positives.filter((x) => x.hard).length} hard).`);
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) { console.error("usage: node src/score.mjs predictions/<matcher>.jsonl [--data dir] [--json out.json]"); process.exit(2); }
  const dataDir = args.includes("--data") ? args[args.indexOf("--data") + 1] : undefined;
  const data = loadData(dataDir);
  const s = score(readJsonl(file), data);
  const name = file.replace(/^.*\//, "").replace(/\.jsonl$/, "");
  console.log(formatScore(s, name));
  if (args.includes("--json")) { const out = args[args.indexOf("--json") + 1]; writeFileSync(out, JSON.stringify(s, null, 2)); console.log(`\nwrote ${out}`); }
}
