#!/usr/bin/env node
/**
 * Holds the replier_count triggers of migrations/0022_replier_count.sql to their definition in
 * docs/metrics.md, "Per-post counts": what they count, when they fire, and when they leave the
 * parent row unlocked. check:migrations only proves the file applies twice.
 *
 *   SCRATCH_DATABASE_URL=postgres://... npm run check:repliers
 *
 * Needs the schema already applied (CI runs it after scripts/migrate.mjs). It writes rows under
 * publishers of its own and removes them when done, so it can run against any throwaway database.
 */
import postgres from "postgres";
import { applyCounts } from "../lib/side-writes.ts";

const url = process.env.SCRATCH_DATABASE_URL;
if (!url) {
  console.error("check-repliers: SCRATCH_DATABASE_URL is required — a throwaway database with the schema applied");
  process.exit(1);
}

const PUBS = ["pub_chkrep_a", "pub_chkrep_b", "pub_chkrep_c", "pub_chkrep_d"];
const [A, B, C, D] = PUBS;
const PARENT = "chkrep_p";

const sql = postgres(url, { prepare: false, max: 4, onnotice: () => {} });

const problems = [];
const check = (ok, what) => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) problems.push(what); };

let seq = 0;
async function reply(publisher, { hidden = false, db = sql } = {}) {
  const id = `chkrep_${seq++}`;
  await db`insert into posts (id, publisher_id, kind, title, body, expires_at, parent_id, hidden_at)
           values (${id}, ${publisher}, 'announcement', 'check-repliers reply', 'seeded by scripts/check-repliers.mjs',
                   now() + interval '1 day', ${PARENT}, ${hidden ? new Date() : null})`;
  return id;
}
async function repliers(id = PARENT) {
  const [row] = await sql`select replier_count from posts where id = ${id}`;
  return row?.replier_count;
}
async function expect(n, what) {
  const got = await repliers();
  check(got === n, `${what}: replier_count ${got} (expected ${n})`);
}

/** Runs `q` on its own connection with a one-second lock_timeout; true if it finished, false if it waited out. */
async function withinLockTimeout(q) {
  const c = await sql.reserve();
  try {
    await c`begin`;
    await c`set local lock_timeout = '1s'`;
    await q(c);
    await c`commit`;
    return true;
  } catch (e) {
    await c`rollback`.catch(() => {});
    if (e.code === "55P03") return false;
    throw e;
  } finally {
    c.release();
  }
}

async function cleanup() {
  await sql`delete from posts where publisher_id in ${sql(PUBS)}`;
  await sql`delete from publishers where id in ${sql(PUBS)}`;
}

try {
  await cleanup();
  for (const p of PUBS) {
    await sql`insert into publishers (id, name, verify_token, api_key_hash, api_key_prefix, internal)
              values (${p}, 'check-repliers', 'check', ${"check:" + p}, 'check', true)`;
  }
  await sql`insert into posts (id, publisher_id, kind, title, body, expires_at)
            values (${PARENT}, ${A}, 'thread', 'check-repliers thread', 'seeded by scripts/check-repliers.mjs', now() + interval '1 day')`;

  console.log("what the triggers count");
  await reply(A);
  await reply(A);
  await expect(0, "two replies by the post's own publisher");
  await reply(B);
  await reply(B);
  await expect(1, "another publisher replying twice");
  const c1 = await reply(C);
  await expect(2, "a second other publisher");
  await sql`update posts set hidden_at = now() where id = ${c1}`;
  await expect(1, "hiding that publisher's only reply");
  await sql`update posts set hidden_at = null where id = ${c1}`;
  await expect(2, "unhiding it");
  await sql`update posts set deleted_at = now() where id = ${c1}`;
  await expect(1, "soft-deleting it");
  await sql`update posts set deleted_at = null where id = ${c1}`;
  await expect(2, "restoring it");
  await sql`delete from posts where id = ${c1}`;
  await expect(1, "hard-deleting it while it counted");
  await reply(D, { hidden: true });
  await expect(1, "a reply inserted already hidden");

  console.log("what the triggers leave alone");
  const b1 = (await sql`select id from posts where parent_id = ${PARENT} and publisher_id = ${B} limit 1`)[0].id;
  await sql`update posts set replier_count = 99 where id = ${PARENT}`;
  await sql`update posts set replier_count = 7 where id = ${b1}`;
  await sql.begin((tx) => applyCounts(tx, { views: [[PARENT, 1], [b1, 1]], retrievals: [[PARENT, 2], [b1, 2]] }));
  const [bumped] = await sql`select views::int as views from posts where id = ${PARENT}`;
  check(bumped.views === 1, `the metrics flush applied its bump (views ${bumped.views})`);
  await expect(99, "a views/retrievals flush on the parent and a reply leaves the parent's planted value");
  check(await repliers(b1) === 7, "and leaves the reply's planted value");
  await sql`update posts set replier_count = 0 where id = ${b1}`;
  await sql`update posts set replier_count = 1 where id = ${PARENT}`;

  console.log("when the parent is locked");
  const a1 = (await sql`select id from posts where parent_id = ${PARENT} and publisher_id = ${A} limit 1`)[0].id;
  const holder = await sql.reserve();
  try {
    await holder`begin`;
    await holder`select 1 from posts where id = ${PARENT} for no key update`;
    check(await withinLockTimeout((c) => c`update posts set hidden_at = now() where id = ${a1}`),
      "hiding the post's own publisher's reply does not wait for the parent row");
    check(!(await withinLockTimeout((c) => c`update posts set hidden_at = now() where id = ${b1}`)),
      "hiding another publisher's reply waits for the parent row, since it recounts");
    await holder`commit`;
  } finally {
    await holder`rollback`.catch(() => {});
    holder.release();
  }
  await sql`update posts set hidden_at = null where id = ${a1}`;
  await expect(1, "after both, the count is unchanged");

  console.log("two replies from different publishers at once, each taking the parent first");
  for (const [first, second] of [[C, D], [D, C]]) {
    await sql`delete from posts where parent_id = ${PARENT} and publisher_id in (${C}, ${D})`;
    const s1 = await sql.reserve(), s2 = await sql.reserve();
    try {
      await s1`begin`; await s2`begin`;
      await reply(first, { db: s1 });
      const pending = reply(second, { db: s2 }).then(() => "done");
      const raced = await Promise.race([pending, new Promise((r) => setTimeout(() => r("waiting"), 300))]);
      check(raced === "waiting", "the second reply's recount waits for the first transaction's lock on the parent");
      await s1`commit`;
      await pending;
      await s2`commit`;
    } finally {
      s1.release(); s2.release();
    }
    await expect(3, `B and both concurrent repliers count, ${first === C ? "C" : "D"} first`);
  }

  console.log("deleting the parent");
  await sql`delete from posts where id = ${PARENT}`;
  const [{ left }] = await sql`select count(*)::int as left from posts where parent_id = ${PARENT}`;
  check(left === 0, "hard-deleting a parent with replies succeeds and takes its replies");
} catch (e) {
  problems.push(e.message);
  console.error("check-repliers:", e);
} finally {
  try { await cleanup(); } catch (e) { console.error("cleanup", e.message); }
  await sql.end();
}

if (problems.length) {
  console.error(`\ncheck-repliers: ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log("\ncheck-repliers: replier_count is counted and kept as docs/metrics.md defines it");
