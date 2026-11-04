#!/usr/bin/env node
/**
 * Holds the planner to the vector index for the related-posts query, against a table shaped like
 * production: many expired rows for every live one.
 *
 * On 2026-11-02, EXPLAIN on production showed the planner scanning every live row and computing
 * every distance for /p/[id]'s related posts rather than using the HNSW index: the index held every
 * row ever embedded, nine in ten of them expired, and the query's vector came from a join.
 * migrations/0013 and lib/posts.ts changed both. This is what keeps it that way. A regression here
 * is the 2.5 s tail of CRI-56 coming back, and no unit test can see it: it is a planner decision,
 * made against a real table.
 *
 *   SCRATCH_DATABASE_URL=postgres://... npm run check:live-index
 *
 * Needs the schema already applied (CI runs it after scripts/migrate.mjs). It writes rows under a
 * publisher of its own and removes them when done, so it can run against any throwaway database.
 * Five things are checked: the trigger and the sweeps keep `live` right and have their indexes; the
 * planner picks posts_embedding_live_idx for the shipped query; the query comes back inside the
 * bound; and the index is the size of the live rows, not of every row.
 */
import postgres from "postgres";
import { lastResult, relatedPostsStatement } from "../lib/live-sql.ts";

const url = process.env.SCRATCH_DATABASE_URL;
if (!url) {
  console.error("check-live-index: SCRATCH_DATABASE_URL is required — a throwaway database with the schema applied");
  process.exit(1);
}
const LIVE = Number(process.env.CHECK_LIVE_ROWS || 1600);        // about the live board today
const EXPIRED = Number(process.env.CHECK_EXPIRED_ROWS || 6400);  // the ratio that defeated the old plan, with margin
const BOUND_MS = Number(process.env.CHECK_BOUND_MS || 500);      // one fifth of the request-path side budget
const DIMS = 1024;
const PUB = "pub_checklive";

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

/** Unit vectors in a few loose clusters, so neighbours exist inside the 0.85 cosine bound like real posts do. */
const centres = Array.from({ length: 6 }, () => Array.from({ length: DIMS }, () => Math.random() * 2 - 1));
function vectorLiteral(i) {
  const c = centres[i % centres.length];
  const v = new Float64Array(DIMS);
  let n = 0;
  for (let d = 0; d < DIMS; d++) { v[d] = c[d] + (Math.random() * 2 - 1) * 0.6; n += v[d] * v[d]; }
  n = Math.sqrt(n);
  return "[" + Array.from(v, (x) => (x / n).toFixed(6)).join(",") + "]";
}

const problems = [];
const check = (ok, what) => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) problems.push(what); };

function findIndexNames(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (typeof node["Index Name"] === "string") out.add(node["Index Name"]);
  for (const k of ["Plan", "Plans"]) if (node[k]) (Array.isArray(node[k]) ? node[k] : [node[k]]).forEach((c) => findIndexNames(c, out));
  return out;
}

try {
  await sql`delete from posts where publisher_id = ${PUB}`;
  await sql`delete from publishers where id = ${PUB}`;
  await sql`insert into publishers (id, name, verify_token, api_key_hash, api_key_prefix, internal)
            values (${PUB}, 'check-live-index', 'check', ${"check:" + PUB}, 'check', true)`;

  console.log(`seeding ${LIVE} live and ${EXPIRED} expired posts with ${DIMS}-dim embeddings`);
  const started = Date.now();
  const BATCH = 200;
  let n = 0;
  for (const [count, live] of [[EXPIRED, false], [LIVE, true]]) {
    for (let off = 0; off < count; off += BATCH) {
      const size = Math.min(BATCH, count - off);
      const ids = [], vecs = [];
      for (let k = 0; k < size; k++) { ids.push(`chk${String(n).padStart(5, "0")}`); vecs.push(vectorLiteral(n)); n++; }
      await sql.unsafe(
        `insert into posts (id, publisher_id, kind, title, body, expires_at, embedding)
           select i, $2, 'announcement', 'check-live-index ' || i, 'seeded by scripts/check-live-index.mjs', $3::timestamptz, e::vector
             from unnest($1::text[], $4::text[]) as t(i, e)`,
        [ids, PUB, live ? new Date(Date.now() + 30 * 86400e3).toISOString() : new Date(Date.now() - 86400e3).toISOString(), vecs]);
    }
  }
  console.log(`  seeded in ${Date.now() - started} ms`);
  await sql`analyze posts`;

  console.log("the trigger and the sweep");
  const [flags] = await sql`select count(*) filter (where live)::int as live, count(*) filter (where not live)::int as dead from posts where publisher_id = ${PUB}`;
  check(flags.live === LIVE && flags.dead === EXPIRED, `insert trigger: ${flags.live} live, ${flags.dead} not (expected ${LIVE} / ${EXPIRED})`);
  const probe = "chk_probe";
  await sql`insert into posts (id, publisher_id, kind, title, body, expires_at) values (${probe}, ${PUB}, 'announcement', 'probe', 'probe', now() + interval '1 hour')`;
  await sql`update posts set expires_at = now() - interval '1 second' where id = ${probe}`;
  const [afterExpire] = await sql`select live from posts where id = ${probe}`;
  check(afterExpire.live === false, "update trigger: moving expires_at into the past clears live");
  await sql`update posts set expires_at = now() + interval '1 hour' where id = ${probe}`;
  await sql`update posts set hidden_at = now() where id = ${probe}`;
  const [afterHide] = await sql`select live from posts where id = ${probe}`;
  check(afterHide.live === false, "update trigger: hiding clears live");
  await sql`update posts set hidden_at = null where id = ${probe}`;
  const [afterUnhide] = await sql`select live from posts where id = ${probe}`;
  check(afterUnhide.live === true, "update trigger: unhiding restores live while the post is in date");
  // The clock, which the trigger cannot see: a row that was in date when written and has since passed.
  await sql`update posts set live = true, expires_at = now() + interval '1 second' where id = ${probe}`;
  await new Promise((r) => setTimeout(r, 1200));
  const swept = await sql`update posts set live = false where live and expires_at <= now() returning id`;
  check(swept.some((r) => r.id === probe), "the minute sweep (lib/posts.ts sweepExpired) takes a row whose time has come");
  const sweepPlan = await sql.unsafe(`explain (format json) update posts set live = false where live and expires_at <= now()`);
  check(findIndexNames(sweepPlan[0]["QUERY PLAN"][0]).has("posts_live_expires_idx"), "the sweep uses posts_live_expires_idx rather than walking the expired rows");
  // The embedding sweep (lib/posts.ts backfillEmbeddings) runs every minute too. It lost its index
  // when its predicate moved to `live` (CRI-69): a partial index whose predicate still said
  // `deleted_at is null` cannot serve a query that says `live`, and the planner read and sorted every
  // live row to return none. The index of migrations/0015 says `live`; this holds the plan to it.
  const embedPlan = (await sql.unsafe(`explain (format json) select id from posts where embedding is null and live order by created_at asc limit 5`))[0]["QUERY PLAN"][0];
  const embedNodes = JSON.stringify(embedPlan);
  check(findIndexNames(embedPlan).has("posts_embedding_pending_idx") && !embedNodes.includes('"Node Type":"Sort"'),
    `the embedding sweep walks posts_embedding_pending_idx in created_at order (indexes in the plan: ${[...findIndexNames(embedPlan)].join(", ") || "none"}${embedNodes.includes('"Node Type":"Sort"') ? ", with a Sort" : ""})`);

  console.log("the related-posts query, as lib/posts.ts runs it");
  const [{ id: liveId, embedding }] = await sql`select id, embedding::text as embedding from posts where publisher_id = ${PUB} and live order by id limit 1`;
  // The statement as lib/posts.ts sends it — one simple-protocol query, SET LOCAL and all — with
  // EXPLAIN on the query half, inside the same implicit transaction the SET applies to.
  const stmt = relatedPostsStatement("p.id", embedding, liveId, 5);
  const explain = lastResult(await sql.unsafe(`${stmt.prelude} explain (analyze, buffers, format json) ${stmt.query}`).simple());
  const top = explain[0]["QUERY PLAN"][0];
  const names = findIndexNames(top);
  const ms = top["Execution Time"];
  const pages = (top.Plan["Shared Hit Blocks"] ?? 0) + (top.Plan["Shared Read Blocks"] ?? 0);
  check(names.has("posts_embedding_live_idx"), `the planner uses posts_embedding_live_idx (indexes in the plan: ${[...names].join(", ") || "none"})`);
  const [{ stale }] = await sql`select count(*)::int as stale from pg_indexes where tablename = 'posts' and indexname = 'posts_embedding_idx'`;
  check(stale === 0, "the full index posts_embedding_idx is gone from the catalog");
  check(ms < BOUND_MS, `execution ${ms.toFixed(1)} ms, bound ${BOUND_MS} ms, ${pages} buffer pages`);
  // The brute force the planner would otherwise pick, for the record: the same query with sorting allowed.
  const [without] = await sql.unsafe(`explain (analyze, buffers, format json) ${stmt.query}`);
  const w = without["QUERY PLAN"][0];
  console.log(`  for comparison, with sorting allowed: ${w["Execution Time"].toFixed(1)} ms, ${(w.Plan["Shared Hit Blocks"] ?? 0) + (w.Plan["Shared Read Blocks"] ?? 0)} buffer pages, via ${[...findIndexNames(w)].join(", ") || "a sequential scan"}`);
  const rows = lastResult(await sql.unsafe(stmt.text).simple());
  check(rows.length === 5 && rows.every((r) => r.id !== liveId), `returns ${rows.length} neighbours, none of them the post itself`);
  // One HNSW element takes about a page at this dimensionality (13 MB for 1,600 rows here). The
  // bound allows two pages per live row; an index that also holds the expired rows, four for every
  // live one, is five times the size and fails it. That is what production got on 2026-11-03, when
  // 0013 built the index in the transaction that backfilled `live` and the build indexed the old
  // row versions the backfill had replaced (the account is in migrations/0014). Here the rows are
  // seeded after the migrations, so this only bites when the check runs against a database that
  // had rows when they were applied — which is the case worth catching.
  const [{ bytes }] = await sql`select pg_relation_size('posts_embedding_live_idx'::regclass) as bytes`;
  const indexBytes = Number(bytes);
  const boundBytes = LIVE * 2 * 8192;
  check(indexBytes <= boundBytes, `posts_embedding_live_idx is ${(indexBytes / 1048576).toFixed(1)} MB for ${LIVE} live rows (bound ${(boundBytes / 1048576).toFixed(0)} MB, two pages a row)`);
} catch (e) {
  problems.push(e.message);
  console.error("check-live-index:", e);
} finally {
  try {
    await sql`delete from posts where publisher_id = ${PUB}`;
    await sql`delete from publishers where id = ${PUB}`;
  } catch (e) { console.error("cleanup", e.message); }
  await sql.end();
}

if (problems.length) {
  console.error(`\ncheck-live-index: ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log("\ncheck-live-index: the live vector index serves the related-posts query");
