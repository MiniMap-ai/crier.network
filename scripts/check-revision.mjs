#!/usr/bin/env node
/**
 * Holds posts.revision (migrations/0027_post_revision.sql) to its definition in docs/scenarios.md,
 * scenario 20: an edit that changes a post's content raises it by one, and nothing else moves it.
 * It runs the statement the app runs, writeEdit in lib/post-version.ts, on edits merged by the app's
 * mergeEdit, so it checks the code that ships rather than a copy of it.
 *
 *   SCRATCH_DATABASE_URL=postgres://... npm run check:revision
 *
 * Needs the schema already applied (CI runs it after scripts/migrate.mjs). It writes rows under a
 * publisher of its own and removes them when done, so it can run against any throwaway database.
 */
import postgres from "postgres";
import { mergeEdit } from "../lib/post-schema.ts";
import { writeEdit } from "../lib/post-version.ts";
import { applyCounts } from "../lib/side-writes.ts";

const url = process.env.SCRATCH_DATABASE_URL;
if (!url) {
  console.error("check-revision: SCRATCH_DATABASE_URL is required — a throwaway database with the schema applied");
  process.exit(1);
}

const PUB = "pub_chkrev_a";
const POST = "chkrev_p";
const sql = postgres(url, { prepare: false, max: 3, onnotice: () => {} });

const problems = [];
const check = (ok, what) => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) problems.push(what); };

const stored = async (db = sql) => (await db`select * from posts where id = ${POST}`)[0];

/** Merges `patch` into the stored post as updatePost does and writes it with writeEdit. */
async function edit(patch, { expires_at = null, wholeWindow = false, flags, embedding, db = sql } = {}) {
  const row = await stored(db);
  const { merged } = mergeEdit(row, patch, { wholeWindow });
  await writeEdit(db, POST, { ...merged, expires_at, source_key: null, flags: flags ?? row.flags, embedding });
}

async function expect(n, what) {
  const { revision } = await stored();
  check(revision === n, `${what}: revision ${revision} (expected ${n})`);
}

async function cleanup() {
  await sql`delete from posts where publisher_id = ${PUB}`;
  await sql`delete from publishers where id = ${PUB}`;
}

try {
  await cleanup();
  await sql`insert into publishers (id, name, verify_token, api_key_hash, api_key_prefix, internal)
            values (${PUB}, 'check-revision', 'check', ${"check:" + PUB}, 'check', true)`;
  // The window to the millisecond, as only the app writes it; expires_at to the microsecond, as the
  // reply trigger does, which an edit that leaves the expiry alone must not count as a change.
  const day = 86400e3;
  await sql`insert into posts (id, publisher_id, kind, title, body, tags, lat, lng, starts_at, ends_at, expires_at, metadata)
            values (${POST}, ${PUB}, 'thread', 'check-revision thread', 'seeded by scripts/check-revision.mjs', ${["a", "b"]},
                    39.7392, -104.9903, ${new Date(Date.now() + 2 * day)}, ${new Date(Date.now() + 2.1 * day)}, now() + interval '3 days',
                    ${sql.json({ ref: "a1", nested: { x: 1, y: [1, 2] } })})`;
  await expect(1, "a new post");

  console.log("edits that change nothing");
  await edit({});
  await expect(1, "writing back every stored value");
  const row = await stored();
  await edit({ title: row.title, body: row.body, tags: row.tags, kind: row.kind, location: { lat: row.lat, lng: row.lng } });
  await expect(1, "resending the stored title, body, tags, kind and coordinates");
  await edit({ metadata: { nested: { y: [1, 2], x: 1 }, ref: "a1" } });
  await expect(1, "resending the stored metadata with its keys in another order");
  await edit({ starts_at: row.starts_at.toISOString(), ends_at: row.ends_at.toISOString() }, { wholeWindow: true });
  await expect(1, "a relay update whose whole window is the stored one");
  await edit({}, { flags: ["possible_instruction"], embedding: null });
  await expect(1, "new flags and a cleared embedding");

  console.log("edits that change content");
  await edit({ title: "check-revision thread, edited" });
  await expect(2, "a new title");
  await edit({ title: "check-revision thread, edited" });
  await expect(2, "the same title again, as a retried PATCH sends it");
  await edit({ tags: ["b", "a"] });
  await expect(3, "the same tags in another order");
  await edit({}, { expires_at: new Date(Date.now() + 5 * 86400e3) });
  await expect(4, "a new expires_at");
  await edit({ metadata: { ref: "a2" } });
  await expect(5, "new metadata");
  await edit({}, { wholeWindow: true });
  await expect(6, "a relay update that drops the window");

  console.log("writes that are not edits");
  await sql`insert into posts (id, publisher_id, kind, title, body, expires_at, parent_id)
            values ('chkrev_r', ${PUB}, 'announcement', 'check-revision reply', 'seeded by scripts/check-revision.mjs', now() + interval '1 day', ${POST})`;
  const expiry = async () => (await sql`select expires_at, expires_at::text as exact from posts where id = ${POST}`)[0];
  const extended = await expiry();
  check(extended.expires_at.getTime() > Date.now() + 6 * day, "a reply extended the thread's expiry by a week (migrations/0002)");
  await edit({});
  await expect(6, "an edit that changes nothing after the extension");
  const kept = await expiry();
  check(kept.exact === extended.exact, `and that edit left the extended expiry to the microsecond (${kept.exact})`);
  await sql.begin((tx) => applyCounts(tx, { views: [[POST, 3]], retrievals: [[POST, 5]] }));
  await sql`update posts set closed_at = now(), updated_at = now() where id = ${POST}`;
  await sql`update posts set hidden_at = now() where id = ${POST}`;
  await sql`update posts set hidden_at = null where id = ${POST}`;
  await expect(6, "the metrics flush, closing, hiding and unhiding");

  console.log("two edits to the same text at once");
  const s1 = await sql.reserve(), s2 = await sql.reserve();
  try {
    await s1`begin`; await s2`begin`;
    await edit({ body: "raced" }, { db: s1 });
    const pending = edit({ body: "raced" }, { db: s2 }).then(() => "done");
    const raced = await Promise.race([pending, new Promise((r) => setTimeout(() => r("waiting"), 300))]);
    check(raced === "waiting", "the second edit waits for the first one's row lock");
    await s1`commit`;
    await pending;
    await s2`commit`;
  } finally {
    s1.release(); s2.release();
  }
  await expect(7, "only the first of them counts: the second compares against what the first wrote");
} catch (e) {
  problems.push(e.message);
  console.error("check-revision:", e);
} finally {
  try { await cleanup(); } catch (e) { console.error("cleanup", e.message); }
  await sql.end();
}

if (problems.length) {
  console.error(`\ncheck-revision: ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log("\ncheck-revision: revision counts content changes and nothing else, as docs/scenarios.md defines it");
