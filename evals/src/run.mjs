// Run a matcher over every labelled pair and write its predictions.
// Usage: node src/run.mjs <matcher> [--data dir] [--out predictions/<matcher>.jsonl]
//
// A matcher is a module in src/matchers/<name>.mjs exporting:
//   export const description: string
//   export async function prepare(data): Promise<ctx>        (optional; embeddings, indexes, keys)
//   export async function judge(intent, notice, ctx): Promise<{ label: "fire"|"no", score?: number, reason?: string }>
// Matchers judge only labelled pairs here, so scoring is exact; the same interface can later run
// the full cross product for volume and latency measurements.
import { writeFileSync, mkdirSync } from "node:fs";
import { loadData } from "./data.mjs";

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
if (!name) { console.error("usage: node src/run.mjs <matcher> [--data dir] [--out file]"); process.exit(2); }
const dataDir = args.includes("--data") ? args[args.indexOf("--data") + 1] : undefined;
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : new URL(`../predictions/${name}.jsonl`, import.meta.url).pathname;

const data = loadData(dataDir);
const m = await import(`./matchers/${name}.mjs`);
const ctx = m.prepare ? await m.prepare(data) : {};
const t0 = performance.now();
const lines = [];
let fired = 0;
for (const pair of data.pairs) {
  const r = await m.judge(data.intentById.get(pair.intent), data.noticeById.get(pair.notice), ctx);
  if (r.label === "fire") fired++;
  lines.push(JSON.stringify({ intent: pair.intent, notice: pair.notice, label: r.label, ...(r.score !== undefined ? { score: r.score } : {}), ...(r.reason ? { reason: r.reason } : {}) }));
}
const ms = performance.now() - t0;
mkdirSync(new URL("../predictions", import.meta.url).pathname, { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
console.log(`${name}: ${m.description ?? ""}\n${lines.length} predictions, ${fired} fire, ${ms.toFixed(0)} ms (${(ms / lines.length).toFixed(2)} ms per pair)\nwrote ${out}`);
