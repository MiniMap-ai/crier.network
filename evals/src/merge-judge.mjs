// Merge blind judge batches (cache/judge/out-*.jsonl) into predictions/<name>.jsonl.
// Usage: node src/merge-judge.mjs [name]   (default: judge)
// Borderline judgments are kept in the file; the scorer treats anything but "fire" as "no".
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const dir = new URL("../cache/judge/", import.meta.url).pathname;
const name = process.argv[2] ?? "judge";
const rows = [];
for (const f of readdirSync(dir).filter((f) => /^out-\d+\.jsonl$/.test(f)).sort()) {
  for (const line of readFileSync(dir + f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { console.error(`${f}: bad line: ${line.slice(0, 80)}`); continue; }
    if (!r.intent || !r.notice || !["fire", "no", "borderline"].includes(r.label)) { console.error(`${f}: bad row: ${line.slice(0, 80)}`); continue; }
    rows.push(JSON.stringify({ intent: r.intent, notice: r.notice, label: r.label, reason: r.reason ?? "" }));
  }
}
const out = new URL(`../predictions/${name}.jsonl`, import.meta.url).pathname;
writeFileSync(out, rows.join("\n") + "\n");
const counts = {}; for (const r of rows) { const l = JSON.parse(r).label; counts[l] = (counts[l] ?? 0) + 1; }
console.log(`${rows.length} judgments -> ${out}`, counts);
