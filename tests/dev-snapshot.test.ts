import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  NEVER_SERVED_COLUMNS, NEVER_SERVED_TABLES, SNAPSHOT_ENVELOPE_BYTES, SNAPSHOT_TABLES,
  asSnapshotCursor, countStatement, cutPage, databaseRefusal, firstCursor, pageStatement, snapshotAccess,
} from "../lib/dev-snapshot.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const eq = (a: string, b: string) => a === b;

// The allowlist the owner approved. Changing what the snapshot serves means changing this test in
// the same PR, with the reason the column is already public.
const APPROVED: Record<string, string[]> = {
  publishers: ["id", "name", "description", "url", "domain", "verified", "post_count", "created_at"],
  sources: ["id", "name", "adapter", "license"],
  posts: [
    "id", "publisher_id", "kind", "title", "body", "url", "tags", "place_name", "lat", "lng",
    "starts_at", "ends_at", "timezone", "expires_at", "closed_at", "source_url", "syndicated", "metadata",
    "retrievals", "parent_id", "reply_count", "last_reply_at", "flags", "created_at", "updated_at",
  ],
};

test("the snapshot serves exactly the approved tables and columns, in load order", () => {
  assert.deepEqual(SNAPSHOT_TABLES.map((t) => t.name), Object.keys(APPROVED));
  for (const t of SNAPSHOT_TABLES) assert.deepEqual(t.columns.map((c) => c.name), APPROVED[t.name], t.name);
});

test("the never-served tables are the ones the ticket names, and none of them is served", () => {
  assert.deepEqual([...NEVER_SERVED_TABLES].sort(), [
    "cron_state", "daily_actors", "deliveries", "rate_limits", "reports", "schema_migrations",
    "search_log", "strategy_items", "strategy_log", "subscriptions", "unmet_queries",
  ]);
  for (const t of SNAPSHOT_TABLES) assert.ok(!NEVER_SERVED_TABLES.includes(t.name), t.name);
});

test("no served column reads a secret, a key, an embedding or moderation state, under any name", () => {
  for (const t of SNAPSHOT_TABLES) {
    for (const c of t.columns) {
      assert.ok(!NEVER_SERVED_COLUMNS.includes(c.name), `${t.name}.${c.name}`);
      for (const banned of NEVER_SERVED_COLUMNS) {
        assert.ok(!new RegExp(`\\b${banned}\\b`).test(c.expr), `${t.name}.${c.name} reads ${banned}`);
      }
    }
  }
  for (const banned of ["api_key_hash", "verify_token", "secret", "webhook_challenge", "embedding"]) {
    assert.ok(NEVER_SERVED_COLUMNS.includes(banned), banned);
  }
});

test("only rows the public API shows are served: no hidden, deleted or suspended content", () => {
  const posts = SNAPSHOT_TABLES.find((t) => t.name === "posts")!;
  assert.match(posts.where, /t\.deleted_at is null/);
  assert.match(posts.where, /t\.hidden_at is null/);
  assert.match(posts.where, /u\.status = 'active'/);
  assert.match(SNAPSHOT_TABLES.find((t) => t.name === "publishers")!.where, /t\.status = 'active'/);
  assert.match(SNAPSHOT_TABLES.find((t) => t.name === "sources")!.where, /p\.hidden_at is null/);
});

test("a publisher is served only with a visible post, and a source only through a relayed post", () => {
  assert.match(SNAPSHOT_TABLES.find((t) => t.name === "publishers")!.where, /from posts p where p\.publisher_id = t\.id and p\.deleted_at is null and p\.hidden_at is null/);
  const sources = SNAPSHOT_TABLES.find((t) => t.name === "sources")!.where;
  assert.match(sources, /p\.syndicated and exists \(select 1 from publishers r where r\.id = p\.publisher_id and r\.internal\)/);
});

test("a page reads one table in key order after the cursor's key, and a count covers every table", () => {
  const s = pageStatement(SNAPSHOT_TABLES[0]);
  assert.match(s, /^select t\.id, .*\(t\.domain_verified_at is not null\) as verified, .* from publishers t where \(.*\) and t\.id > \$1 order by t\.id limit \$2$/);
  assert.equal(countStatement().match(/count\(\*\)/g)?.length, SNAPSHOT_TABLES.length);
});

const rows = (n: number, bytes = 10) => Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}`, pad: "x".repeat(bytes) }));

test("a batch shorter than the batch size ends its table and the next page starts the next table", () => {
  const p = cutPage(firstCursor(), rows(3), { batchRows: 10 });
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.next, { t: SNAPSHOT_TABLES[1].name, k: "" });
});

test("a full batch continues the same table after its last key", () => {
  const p = cutPage(firstCursor(), rows(10), { batchRows: 10 });
  assert.deepEqual(p.next, { t: "publishers", k: "r0009" });
});

test("the last table's last page has no next cursor", () => {
  assert.equal(cutPage({ t: "posts", k: "abc" }, rows(2), { batchRows: 10 }).next, null);
});

test("a page is cut at the byte budget and resumes at the first row it left out", () => {
  const p = cutPage({ t: "posts", k: "" }, rows(10), { batchRows: 100, maxBytes: SNAPSHOT_ENVELOPE_BYTES + 250, size: () => 100 });
  assert.equal(p.rows.length, 2);
  assert.ok(p.bytes <= 250);
  assert.deepEqual(p.next, { t: "posts", k: "r0001" });
});

test("a single row over the budget still goes out alone, so paging always advances", () => {
  const p = cutPage({ t: "posts", k: "" }, rows(3), { batchRows: 100, maxBytes: SNAPSHOT_ENVELOPE_BYTES + 10, size: () => 1000 });
  assert.equal(p.rows.length, 1);
  assert.deepEqual(p.next, { t: "posts", k: "r0000" });
});

test("the default page budget keeps a page of maximal posts under Vercel's 4.5 MB body limit", () => {
  const big = Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, body: "é".repeat(8000), metadata: { m: "y".repeat(4000) } }));
  const p = cutPage({ t: "posts", k: "" }, big);
  const envelope = JSON.stringify({ ok: true, data: { table: "posts", columns: APPROVED.posts, rows: p.rows }, next_cursor: "x".repeat(60), meta: { content_notice: "n".repeat(400) } });
  assert.ok(Buffer.byteLength(envelope) <= 3_000_000, String(Buffer.byteLength(envelope)));
  assert.ok(p.next && p.next.t === "posts");
});

test("only cursors naming a served table and a string key are accepted", () => {
  assert.deepEqual(asSnapshotCursor({ t: "posts", k: "abc" }), { t: "posts", k: "abc" });
  assert.equal(asSnapshotCursor({ t: "subscriptions", k: "" }), null);
  assert.equal(asSnapshotCursor({ t: "posts", k: 5 }), null);
  assert.equal(asSnapshotCursor({ t: "posts", k: "x".repeat(201) }), null);
  assert.equal(asSnapshotCursor(null), null);
});

test("without CRIER_SNAPSHOT_KEY_SHA256 the endpoint is disabled, whatever is sent", () => {
  assert.equal(snapshotAccess(undefined, "anything", sha256, eq), "disabled");
  assert.equal(snapshotAccess("", "anything", sha256, eq), "disabled");
  assert.equal(snapshotAccess("   ", "anything", sha256, eq), "disabled");
});

test("a set but malformed digest, such as a whole shasum line, is misconfigured and still refuses", () => {
  assert.equal(snapshotAccess("not-a-digest", "anything", sha256, eq), "misconfigured");
  assert.equal(snapshotAccess(`${sha256("the-key")}  -`, "the-key", sha256, eq), "misconfigured");
});

test("the key is checked by its SHA-256, and a missing or wrong key is denied", () => {
  const digest = sha256("the-key");
  assert.equal(snapshotAccess(digest, "the-key", sha256, eq), "granted");
  assert.equal(snapshotAccess(digest.toUpperCase(), "the-key", sha256, eq), "granted");
  assert.equal(snapshotAccess(digest, "another-key", sha256, eq), "denied");
  assert.equal(snapshotAccess(digest, digest, sha256, eq), "denied", "the digest itself is not the key");
  assert.equal(snapshotAccess(digest, null, sha256, eq), "denied");
});

const FAKE_REF = "abcdefghijklmnopqrst";
const guard = { prodRefSha256: [sha256(FAKE_REF)], sha256 };

test("db-dev refuses any URL carrying the production ref, wherever it appears", () => {
  for (const url of [
    `postgres://postgres.${FAKE_REF}:pw@localhost:5432/crier_dev`,
    `postgres://postgres:pw@db.${FAKE_REF}.example.net:5432/postgres`,
    `postgresql://localhost/crier_dev?options=${FAKE_REF.toUpperCase()}`,
    `postgres://localhost/crier_dev?application_name=x${FAKE_REF}y`,
  ]) assert.match(databaseRefusal(url, { ...guard, allowRemote: true }) ?? "", /production project ref/, url);
});

test("db-dev refuses Supabase hosts even with --allow-remote-host, and other remote hosts without it", () => {
  assert.match(databaseRefusal("postgres://u:p@aws-0-us-east-1.pooler.supabase.com:5432/x", { ...guard, allowRemote: true }) ?? "", /Supabase/);
  assert.match(databaseRefusal("postgres://u:p@db.other.supabase.co:5432/x", { ...guard, allowRemote: true }) ?? "", /Supabase/);
  assert.match(databaseRefusal("postgres://u:p@db.example.net/x", guard) ?? "", /not a local host/);
  assert.equal(databaseRefusal("postgres://u:p@db.example.net/x", { ...guard, allowRemote: true }), null);
  assert.match(databaseRefusal("mysql://localhost/x", guard) ?? "", /postgres/);
});

test("db-dev refuses a URL with no host, which a client would fill from PGHOST", () => {
  assert.notEqual(databaseRefusal("postgres://postgres@/crier_dev", guard), null);
  for (const url of ["postgres:///crier_dev", "postgresql:///crier_dev?host=/var/run/postgresql"]) {
    assert.match(databaseRefusal(url, { ...guard, allowRemote: true }) ?? "", /names no host/, url);
  }
});

test("db-dev refuses when the shell's PG variables point at production, even for a local URL", () => {
  const local = "postgres://postgres@localhost:5432/crier_dev";
  assert.match(databaseRefusal(local, { ...guard, env: { PGUSER: `postgres.${FAKE_REF}` } }) ?? "", /PGUSER carries the production project ref/);
  assert.match(databaseRefusal(local, { ...guard, env: { PGHOST: `db.${FAKE_REF}.example.net` } }) ?? "", /production project ref/);
  assert.match(databaseRefusal(local, { ...guard, env: { PGHOSTADDR: "aws-0-us-east-1.pooler.supabase.com" } }) ?? "", /PGHOST or PGHOSTADDR is a Supabase host/);
  assert.equal(databaseRefusal(local, { ...guard, env: { PGHOST: "localhost", PGUSER: "me", PGPASSWORD: FAKE_REF } }), null, "the password is never inspected");
});

test("db-dev accepts a local database", () => {
  assert.equal(databaseRefusal("postgres://postgres:postgres@localhost:5432/crier_dev", guard), null);
  assert.equal(databaseRefusal("postgres://postgres@127.0.0.1:55432/crier_dev", guard), null);
});
