// Measure a real, running Crier through its public HTTP API. Nothing is imported from Crier.
//
//   CRIER_URL=http://localhost:3000 CRON_SECRET=... node src/crier.mjs [--data dir] [--out predictions/crier.jsonl]
//
// Sequence: register publishers, save every encodable intent as a subscription (grammar_today),
// then post every notice, then call the cron until it has matched everything, then read each
// subscription's pending deliveries. A pair fires when the notice's post id is among that
// subscription's deliveries. Intents whose encoding needs a `thread` id are skipped (notices carry
// no parent), and their pairs are left unpredicted (scored as "no", reported as missing).
//
// Needs a fresh database each run: subscriptions only see posts created after them. Set
// CRIER_DATABASE_URL to let the script clear rate-limit windows between batches (local only) and
// mark the posting publisher verified so 461 posts fit in an hour.
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadData } from "./data.mjs";

const args = process.argv.slice(2);
const dataDir = args.includes("--data") ? args[args.indexOf("--data") + 1] : undefined;
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : new URL("../predictions/crier.jsonl", import.meta.url).pathname;
const BASE = (process.env.CRIER_URL || "http://localhost:3000").replace(/\/$/, "");
const CRON = process.env.CRON_SECRET || "";
const DB = process.env.CRIER_DATABASE_URL || "";

async function api(method, path, body, key) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? ""} ${JSON.stringify(json?.error?.issues ?? "")}`), { status: res.status, json });
  return json;
}
function sql(q) { if (!DB) return; execFileSync("psql", [DB, "-qtc", q], { stdio: ["ignore", "ignore", "inherit"] }); }
const resetLimits = () => sql("delete from rate_limits");

const data = loadData(dataDir);
const t = { start: Date.now() };

// 1. Publishers.
resetLimits();
// One subscriber per persona: Crier caps active subscriptions at 50 per publisher.
const subs = new Map();
for (const p of data.personas) { resetLimits(); subs.set(p.id, (await api("POST", "/api/v1/publishers", { name: `Evals subscriber ${p.id}`, description: "standing-intent evaluation harness", accept_terms: true, client: "crier-evals" })).data); }
resetLimits();
const pub = (await api("POST", "/api/v1/publishers", { name: "Evals publisher", description: "standing-intent evaluation harness", accept_terms: true, client: "crier-evals" })).data;
sql(`update publishers set domain_verified_at = now() where id = '${pub.id}'`);

// 2. Subscriptions, one per encodable intent.
const subByIntent = new Map(); const skipped = [];
let n = 0;
for (const it of data.intents) {
  const g = it.grammar_today;
  if (!g || g.thread) { skipped.push(it.id); continue; }
  const query = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, typeof v === "number" ? v : String(v)]));
  if (++n % 25 === 0) resetLimits();
  try {
    const r = await api("POST", "/api/v1/subscriptions", { query, label: it.id }, subs.get(it.persona).api_key);
    subByIntent.set(it.id, r.data.id);
  } catch (e) { skipped.push(it.id); console.error(`subscribe ${it.id}: ${e.message}`); }
}
t.subscribed = Date.now();
console.log(`subscriptions: ${subByIntent.size} saved, ${skipped.length} skipped (${skipped.join(", ")})`);

// 3. Posts, one per notice.
const postByNotice = new Map();
n = 0;
for (const nt of data.notices) {
  if (++n % 250 === 0) resetLimits();
  const body = {
    kind: nt.kind, title: nt.title.slice(0, 200), body: nt.body.slice(0, 8000), tags: nt.tags.slice(0, 20),
    ...(nt.place_name || nt.lat !== null ? { location: { ...(nt.place_name ? { name: nt.place_name } : {}), ...(nt.lat !== null ? { lat: nt.lat, lng: nt.lng } : {}) } } : {}),
    ...(nt.starts_at ? { starts_at: nt.starts_at } : {}), ...(nt.ends_at ? { ends_at: nt.ends_at } : {}),
    ...(nt.publisher === "relay" ? { syndicated: true, source_url: `https://relay.example.org/${nt.id}` } : {}),
    idempotency_key: nt.id,
  };
  try { postByNotice.set(nt.id, (await api("POST", "/api/v1/posts", body, pub.api_key)).data.id); }
  catch (e) { console.error(`post ${nt.id}: ${e.message}`); }
}
t.posted = Date.now();
console.log(`posts: ${postByNotice.size} of ${data.notices.length} created`);

// 4. Match. The cron scans up to 500 new posts per tick.
let ticks = 0, scanned = 0, matched = 0, cronMs = 0;
for (;;) {
  const t0 = Date.now();
  const r = await api("GET", "/api/cron/deliver", undefined, CRON);
  cronMs += Date.now() - t0; ticks++;
  scanned += r.matched.scanned; matched += r.matched.matched;
  console.log(`  tick ${ticks}: scanned ${r.matched.scanned}, matched ${r.matched.matched}, ${r.ms} ms`);
  if (r.matched.scanned < 500 || ticks > 20) break;   // one tick drains up to 500 posts; the matcher re-scans its last post each tick
}
t.matched = Date.now();
console.log(`cron: ${ticks} ticks, ${scanned} posts scanned, ${matched} deliveries, ${cronMs} ms total (${(cronMs / Math.max(1, scanned)).toFixed(1)} ms per post against ${subByIntent.size} subscriptions)`);

// 5. Read deliveries.
const firedByIntent = new Map();
for (const [intentId, subId] of subByIntent) {
  const ids = new Set(); let cursor;
  for (;;) {
    const r = await api("GET", `/api/v1/subscriptions/${subId}/pending?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, subs.get(data.intentById.get(intentId).persona).api_key);
    for (const p of r.data) ids.add(p.id);
    if (!r.next_cursor) break; cursor = r.next_cursor;
  }
  firedByIntent.set(intentId, ids);
}

// 6. Predictions over the labelled pairs.
const lines = []; let fired = 0, missing = 0;
for (const pair of data.pairs) {
  const set = firedByIntent.get(pair.intent); const postId = postByNotice.get(pair.notice);
  if (!set || !postId) { missing++; continue; }
  const fire = set.has(postId); if (fire) fired++;
  lines.push(JSON.stringify({ intent: pair.intent, notice: pair.notice, label: fire ? "fire" : "no", reason: fire ? "delivered by Crier" : "not delivered by Crier" }));
}
mkdirSync(new URL("../predictions", import.meta.url).pathname, { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
writeFileSync(new URL("../cache/crier-run.json", import.meta.url).pathname, JSON.stringify({ base: BASE, at: new Date().toISOString(), timing: t, ticks, scanned, matched, cronMs, subscribers: [...subs.values()].map((s) => s.id), publisher: pub.id, subByIntent: [...subByIntent], postByNotice: [...postByNotice], skipped }, null, 2));
console.log(`${lines.length} predictions (${fired} fire), ${missing} pairs unpredicted\nwrote ${out}`);
