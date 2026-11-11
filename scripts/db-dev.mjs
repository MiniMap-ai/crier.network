#!/usr/bin/env node
/**
 * A local development database with something in it: creates a Postgres 16 + pgvector database,
 * applies migrations/ with scripts/migrate.mjs, and loads a dev dataset into it.
 *
 *   --from snapshot|public|fixtures, or --file <saved.json>; default: snapshot if CRIER_SNAPSHOT_KEY is set, else public
 *   --db <url> (DEV_DATABASE_URL, else postgres://postgres:postgres@localhost:5432/crier_dev), --reset, --save <file>,
 *   --site <url> (CRIER_SNAPSHOT_URL, else https://crier.network), --include-expired (public), --allow-remote-host
 *
 * It never reads DATABASE_URL and refuses production (lib/dev-snapshot.ts). Private tables get synthetic
 * rows and every publisher a fresh dev key, written to .dev/keys.<database>.json. README: Running locally.
 */
import postgres from "postgres";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PG_ENV_VARS, PRODUCTION_REF_SHA256, SNAPSHOT_TABLES, databaseRefusal } from "../lib/dev-snapshot.ts";
import { datasetFromPublicPosts, planLoad, syntheticDataset } from "../lib/dev-dataset.ts";
import { normalizeSourceKey } from "../lib/source-key.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(24).toString("base64url");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const die = (msg) => { console.error(`db-dev: ${msg}`); process.exit(1); };

const dbUrl = option("db") || process.env.DEV_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/crier_dev";
const site = (option("site") || process.env.CRIER_SNAPSHOT_URL || "https://crier.network").replace(/\/$/, "");
const file = option("file");
const from = file ? "file" : option("from") || (process.env.CRIER_SNAPSHOT_KEY ? "snapshot" : "public");
if (!["snapshot", "public", "fixtures", "file"].includes(from)) die(`--from must be snapshot, public, fixtures or a --file; got ${from}`);

const refusal = databaseRefusal(dbUrl, { prodRefSha256: PRODUCTION_REF_SHA256, sha256, allowRemote: flag("allow-remote-host"), env: process.env });
if (refusal) die(`refusing to write to that database: ${refusal}.`);
// Nothing below, this process or migrate.mjs, may fill a part of the URL in from the shell.
for (const k of PG_ENV_VARS) delete process.env[k];

const target = new URL(dbUrl);
const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));
if (!dbName || dbName === "postgres") die("name a database of its own in the URL (e.g. /crier_dev), not the maintenance database");
const maintenance = new URL(dbUrl);
maintenance.pathname = "/postgres";

await prepareDatabase();
migrate();
const data = await fetchDataset();
if (option("save")) { await writeFile(option("save"), JSON.stringify(data)); console.log(`db-dev: saved the dataset to ${option("save")}`); }
await load(data);

async function prepareDatabase() {
  const admin = connect(maintenance);
  try {
    const [{ v }] = await admin`select current_setting('server_version_num')::int as v`;
    if (v < 160000) die(`Postgres ${Math.floor(v / 10000)} found; production runs 16. Try: docker run -d --name crier-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg16`);
    const [exists] = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (exists && flag("reset")) {
      await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${dbName} and pid <> pg_backend_pid()`;
      await admin.unsafe(`drop database ${quoteIdent(dbName)}`);
    }
    if (!exists || flag("reset")) await admin.unsafe(`create database ${quoteIdent(dbName)}`);
  } catch (e) {
    die(`cannot prepare ${dbName} through ${maintenance.host}: ${e.message}. Start one with: docker run -d --name crier-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg16`);
  } finally { await admin.end(); }
  const db = connect(target);
  try {
    await db.unsafe("create extension if not exists vector; create extension if not exists pg_trgm; create extension if not exists unaccent; create extension if not exists pgcrypto");
  } catch (e) {
    die(`cannot create the extensions (${e.message}). The pgvector/pgvector:pg16 image has all four.`);
  } finally { await db.end(); }
}

function migrate() {
  const run = spawnSync(process.execPath, [path.join(root, "scripts/migrate.mjs")], {
    cwd: root, stdio: "inherit", env: { ...process.env, DATABASE_URL: dbUrl, MIGRATION_DATABASE_URL: dbUrl },
  });
  if (run.status !== 0) die("migrations failed; see above");
}

async function fetchDataset() {
  if (from === "fixtures") return syntheticDataset();
  if (from === "file") return JSON.parse(await readFile(file, "utf8"));
  if (from === "public") return datasetFromPublicPosts(await publicPages());
  return snapshot();
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "crier-db-dev", ...headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) die(`${new URL(url).pathname} answered ${res.status}: ${body?.error?.message ?? "no JSON body"}`);
  return body;
}

async function snapshot() {
  const key = process.env.CRIER_SNAPSHOT_KEY;
  if (!key) die("--from snapshot needs CRIER_SNAPSHOT_KEY; --from public or --from fixtures need nothing");
  const auth = { Authorization: `Bearer ${key}` };
  const manifest = await getJson(`${site}/api/dev/snapshot`, auth);
  console.log("db-dev: snapshot of", manifest.data.tables.map((t) => `${t.rows} ${t.name}`).join(", "));
  const allowed = new Map(SNAPSHOT_TABLES.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
  const data = { publishers: [], sources: [], posts: [] };
  let cursor = manifest.next_cursor;
  while (cursor) {
    const page = await getJson(`${site}/api/dev/snapshot?cursor=${encodeURIComponent(cursor)}`, auth);
    const cols = allowed.get(page.data.table);
    if (!cols) die(`the snapshot sent a table this script does not load: ${page.data.table}`);
    // Keep only what this checkout's allowlist names, whatever the server sent.
    for (const r of page.data.rows) data[page.data.table].push(Object.fromEntries(Object.entries(r).filter(([k]) => cols.has(k))));
    cursor = page.next_cursor;
  }
  return data;
}

async function publicPages() {
  const pages = [];
  const q = `limit=100&include_replies=true${flag("include-expired") ? "&include_expired=true" : ""}`;
  let cursor = null;
  do {
    const body = await getJson(`${site}/api/v1/posts?${q}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    pages.push(body.data);
    cursor = body.next_cursor;
  } while (cursor);
  return pages;
}

async function load(data) {
  const plan = planLoad(data, { sha256, token, normalizeSourceKey });
  const db = connect(target);
  try {
    const [{ n }] = await db`select count(*)::int as n from posts`;
    if (n > 0) die(`${dbName} already has ${n} posts; pass --reset to start over`);
    await db.begin(async (tx) => {
      // Load as stored: the triggers would recount replies, extend thread expiry and bump post counts.
      await tx`set local session_replication_role = replica`;
      await insert(tx, "publishers", plan.publishers);
      await insert(tx, "sources", plan.sources, ["config"]);
      await insert(tx, "posts", plan.posts, ["metadata"]);
      await insert(tx, "source_items", plan.source_items);
      await insert(tx, "subscriptions", plan.subscriptions, ["query"]);
      await insert(tx, "reports", plan.reports);
      await insert(tx, "search_log", plan.search_log);
      await insert(tx, "unmet_queries", plan.unmet_queries);
      await tx`update posts set live = (deleted_at is null and hidden_at is null and closed_at is null and expires_at > now())`;
      await tx`update posts p set report_count = r.n from (select post_id, count(*)::int as n from reports group by post_id) r where r.post_id = p.id`;
    });
  } finally { await db.end(); }
  const keysFile = path.join(root, `.dev/keys.${dbName}.json`);
  await mkdir(path.dirname(keysFile), { recursive: true });
  await writeFile(keysFile, JSON.stringify(plan.keys, null, 2) + "\n", { mode: 0o600 });
  console.log(`db-dev: loaded ${plan.publishers.length} publishers, ${plan.sources.length} sources, ${plan.posts.length} posts into ${dbName}` +
    (plan.orphaned_replies ? ` (${plan.orphaned_replies} replies whose thread is not public loaded as top-level posts)` : ""));
  console.log(`db-dev: dev keys for every publisher are in ${path.relative(process.cwd(), keysFile)}; no post has an embedding (semantic search and related posts are empty until the cron backfills live posts with COHERE_API_KEY set).`);
  console.log(`db-dev: put DATABASE_URL=${dbUrl} in .env.local and run npm run dev`);
}

async function insert(tx, table, rows, jsonColumns = []) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => {
      const o = { ...r };
      for (const c of jsonColumns) if (c in o) o[c] = tx.json(o[c]);
      return o;
    });
    await tx`insert into ${tx(table)} ${tx(chunk)}`;
  }
}

/** A client for exactly the URL's host, port, user and database. */
function connect(url) {
  return postgres(url.toString(), {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username) || "postgres",
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    max: 1,
    onnotice: () => {},
  });
}

function quoteIdent(s) {
  return `"${s.replace(/"/g, '""')}"`;
}
