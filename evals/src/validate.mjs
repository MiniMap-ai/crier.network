// Validate and summarise the standing-intent evaluation set (see README.md).
// Usage: node src/validate.mjs [dir]   (default: data)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const ENUMS = {
  group: ["entity-does-thing", "marketplace-want", "topic-stream", "rare-world-event", "conversation-follow", "recurring-local", "other"],
  strictness: ["strict", "loose", "irrelevant"],
  publisher: ["relay", "venue-agent", "seller-agent", "buyer-agent", "researcher-agent", "personal-agent", "org-agent", "civic-agent", "employer-agent", "news-feed"],
  expected_volume: ["none", "rare", "occasional", "steady", "flood"],
  lifetime: ["one-shot", "weeks", "years", "forever"],
  source: ["clayton", "mine"],
  kind: ["event", "offer", "request", "announcement", "thread"],
  style: ["terse", "chatty", "structured", "abstract", "one-liner"],
  sloppy: ["no-coords", "place-in-body", "wrong-kind", "no-tags", "time-in-prose", "alias-only", "typo"],
  label: ["fire", "no", "borderline"],
  grammar: ["q", "kind", "tags", "near", "radius_km", "after", "before", "verified", "publisher", "thread", "include_syndicated", "include_replies"],
};
const QUALIFIERS = ["place", "time", "price", "source", "trust", "exclude"];
const STRICT_PARTS = ["subject", "event", "place", "time", "price", "source"];

export function readJsonl(path) {
  if (!existsSync(path)) return { rows: [], errors: [`${path}: missing`] };
  const rows = [], errors = [];
  readFileSync(path, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line)); } catch (e) { errors.push(`${path}:${i + 1}: ${e.message}`); }
  });
  return { rows, errors };
}

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isNumOrNull = (v) => v === null || (typeof v === "number" && Number.isFinite(v));
const isIso = (v) => v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v)));

export function validate(dir) {
  const errors = [];
  const personas = readJsonl(join(dir, "personas.jsonl"));
  const intents = readJsonl(join(dir, "intents.jsonl"));
  const notices = readJsonl(join(dir, "notices.jsonl"));
  const pairs = readJsonl(join(dir, "pairs.jsonl"));
  errors.push(...personas.errors, ...intents.errors, ...notices.errors, ...pairs.errors);

  const personaIds = new Set();
  for (const p of personas.rows) {
    if (!isStr(p.id) || !/^[a-z][a-z0-9-]*$/.test(p.id)) errors.push(`persona id invalid: ${JSON.stringify(p.id)}`);
    if (personaIds.has(p.id)) errors.push(`duplicate persona id ${p.id}`);
    personaIds.add(p.id);
    for (const k of ["name", "city", "sketch"]) if (!isStr(p[k])) errors.push(`persona ${p.id}: ${k} missing`);
    if (typeof p.age !== "number") errors.push(`persona ${p.id}: age must be a number`);
  }

  const intentIds = new Set();
  for (const it of intents.rows) {
    const id = it.id;
    if (!isStr(id)) { errors.push(`intent without id: ${JSON.stringify(it).slice(0, 80)}`); continue; }
    if (intentIds.has(id)) errors.push(`duplicate intent id ${id}`);
    intentIds.add(id);
    if (!personaIds.has(it.persona)) errors.push(`intent ${id}: unknown persona ${it.persona}`);
    else if (!id.startsWith(it.persona + "-i")) errors.push(`intent ${id}: id must start with ${it.persona}-i`);
    for (const k of ["utterance", "domain", "subject", "event", "grammar_gap"]) if (!isStr(it[k])) errors.push(`intent ${id}: ${k} missing`);
    for (const [k, allowed] of [["group", ENUMS.group], ["expected_volume", ENUMS.expected_volume], ["lifetime", ENUMS.lifetime], ["source", ENUMS.source]]) {
      if (!allowed.includes(it[k])) errors.push(`intent ${id}: ${k} must be one of ${allowed.join("|")}, got ${JSON.stringify(it[k])}`);
    }
    if (!it.qualifiers || typeof it.qualifiers !== "object") errors.push(`intent ${id}: qualifiers missing`);
    else for (const q of QUALIFIERS) if (!(q in it.qualifiers) || !(it.qualifiers[q] === null || isStr(it.qualifiers[q]))) errors.push(`intent ${id}: qualifiers.${q} must be a string or null`);
    if (!it.strictness || typeof it.strictness !== "object") errors.push(`intent ${id}: strictness missing`);
    else for (const s of STRICT_PARTS) if (!ENUMS.strictness.includes(it.strictness[s])) errors.push(`intent ${id}: strictness.${s} must be strict|loose|irrelevant`);
    if (!Array.isArray(it.likely_publisher) || it.likely_publisher.length === 0) errors.push(`intent ${id}: likely_publisher must be a non-empty list`);
    else for (const p of it.likely_publisher) if (![...ENUMS.publisher, "nobody-yet"].includes(p)) errors.push(`intent ${id}: likely_publisher ${p} not allowed`);
    if (it.grammar_today !== null) {
      if (!it.grammar_today || typeof it.grammar_today !== "object") errors.push(`intent ${id}: grammar_today must be an object or null`);
      else for (const k of Object.keys(it.grammar_today)) if (!ENUMS.grammar.includes(k)) errors.push(`intent ${id}: grammar_today.${k} is not in the grammar`);
    }
  }

  const noticeIds = new Set();
  for (const n of notices.rows) {
    const id = n.id;
    if (!isStr(id)) { errors.push(`notice without id: ${JSON.stringify(n).slice(0, 80)}`); continue; }
    if (noticeIds.has(id)) errors.push(`duplicate notice id ${id}`);
    noticeIds.add(id);
    const persona = id.split("-n")[0];
    if (!personaIds.has(persona)) errors.push(`notice ${id}: id must start with a persona id followed by -n`);
    if (!ENUMS.kind.includes(n.kind)) errors.push(`notice ${id}: kind invalid`);
    if (!isStr(n.title) || !isStr(n.body)) errors.push(`notice ${id}: title and body required`);
    if (!(n.place_name === null || isStr(n.place_name))) errors.push(`notice ${id}: place_name must be a string or null`);
    if (!isNumOrNull(n.lat) || !isNumOrNull(n.lng) || (n.lat === null) !== (n.lng === null)) errors.push(`notice ${id}: lat and lng must both be numbers or both null`);
    if (!isIso(n.starts_at) || !isIso(n.ends_at)) errors.push(`notice ${id}: starts_at/ends_at must be ISO 8601 or null`);
    if (!Array.isArray(n.tags) || n.tags.some((t) => !isStr(t))) errors.push(`notice ${id}: tags must be a list of strings`);
    if (!ENUMS.publisher.includes(n.publisher)) errors.push(`notice ${id}: publisher invalid`);
    if (!ENUMS.style.includes(n.style)) errors.push(`notice ${id}: style invalid`);
    if (!Array.isArray(n.sloppy) || n.sloppy.some((s) => !ENUMS.sloppy.includes(s))) errors.push(`notice ${id}: sloppy must be a list from ${ENUMS.sloppy.join("|")}`);
    if (!Array.isArray(n.exercises) || n.exercises.length === 0) errors.push(`notice ${id}: exercises must list at least one intent id`);
  }
  for (const n of notices.rows) if (Array.isArray(n.exercises)) for (const e of n.exercises) if (!intentIds.has(e)) errors.push(`notice ${n.id}: exercises unknown intent ${e}`);

  const seen = new Set();
  const perIntent = new Map([...intentIds].map((id) => [id, { fire: 0, no: 0, borderline: 0, hardNo: 0 }]));
  for (const p of pairs.rows) {
    const key = `${p.intent}|${p.notice}`;
    if (seen.has(key)) errors.push(`duplicate pair ${key}`);
    seen.add(key);
    if (!intentIds.has(p.intent)) { errors.push(`pair ${key}: unknown intent`); continue; }
    if (!noticeIds.has(p.notice)) { errors.push(`pair ${key}: unknown notice`); continue; }
    if (!ENUMS.label.includes(p.label)) errors.push(`pair ${key}: label invalid`);
    if (typeof p.hard !== "boolean") errors.push(`pair ${key}: hard must be boolean`);
    if (!isStr(p.reason)) errors.push(`pair ${key}: reason required`);
    const c = perIntent.get(p.intent);
    if (c && ENUMS.label.includes(p.label)) { c[p.label]++; if (p.label === "no" && p.hard) c.hardNo++; }
  }
  for (const [id, c] of perIntent) {
    if (c.fire < 2) errors.push(`intent ${id}: needs at least 2 fire pairs, has ${c.fire}`);
    if (c.no < 3) errors.push(`intent ${id}: needs at least 3 no pairs, has ${c.no}`);
    if (c.hardNo < 2) errors.push(`intent ${id}: needs at least 2 hard no pairs, has ${c.hardNo}`);
  }

  return { errors, personas: personas.rows, intents: intents.rows, notices: notices.rows, pairs: pairs.rows };
}

function count(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = typeof key === "function" ? key(r) : r[key]; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function report(dir) {
  const v = validate(dir);
  const lines = [];
  lines.push(`personas ${v.personas.length} · intents ${v.intents.length} · notices ${v.notices.length} · pairs ${v.pairs.length}`);
  lines.push("", "intents by group:");
  for (const [k, n] of count(v.intents, "group")) lines.push(`  ${String(n).padStart(4)}  ${k}`);
  lines.push("", "intents by persona:");
  for (const [k, n] of count(v.intents, "persona")) lines.push(`  ${String(n).padStart(4)}  ${k}`);
  lines.push("", "pairs by label:");
  for (const [k, n] of count(v.pairs, "label")) lines.push(`  ${String(n).padStart(4)}  ${k}`);
  lines.push(`  ${String(v.pairs.filter((p) => p.hard).length).padStart(4)}  hard`);
  const encodable = v.intents.filter((i) => i.grammar_today !== null).length;
  lines.push("", `intents the current grammar can express at all: ${encodable} of ${v.intents.length}`);
  const lossy = v.intents.filter((i) => i.grammar_today !== null && !/^(none|nothing|no loss)\b/i.test(i.grammar_gap)).length;
  lines.push(`  of those, encoded with a stated loss: ${lossy}`);
  lines.push("", "notices by publisher:");
  for (const [k, n] of count(v.notices, "publisher")) lines.push(`  ${String(n).padStart(4)}  ${k}`);
  lines.push("", "sloppiness:");
  for (const [k, n] of count(v.notices.flatMap((n) => n.sloppy), (x) => x)) lines.push(`  ${String(n).padStart(4)}  ${k}`);
  return { text: lines.join("\n"), errors: v.errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? new URL("../data", import.meta.url).pathname;
  const r = report(dir);
  console.log(r.text);
  if (r.errors.length) {
    console.error(`\n${r.errors.length} problem(s):`);
    for (const e of r.errors.slice(0, 200)) console.error("  " + e);
    process.exit(1);
  }
  console.log("\nvalid");
}
