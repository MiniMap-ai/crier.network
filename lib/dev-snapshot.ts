/**
 * The dev dataset: what GET /api/dev/snapshot may serve, how it pages, and the guards scripts/db-dev.mjs
 * puts around loading it. Each served column is one the public v1 API already shows for that entity,
 * so the snapshot is a bulk copy of the public board, not a window into anything private.
 * docs/scenarios.md, scenario 15, has the reasoning.
 *
 * No imports, so it can be tested without a database or a bundler; hashing is injected.
 */

/** One served column: its name in the snapshot, and the SQL that reads it from the table aliased `t`. */
export type SnapshotColumn = { name: string; expr: string };

export type SnapshotTable = {
  name: string;
  /** The text primary key the pages walk in order. */
  key: string;
  columns: SnapshotColumn[];
  /** Which rows the public API shows. */
  where: string;
};

const same = (...names: string[]): SnapshotColumn[] => names.map((name) => ({ name, expr: `t.${name}` }));

const VISIBLE_POST = (p: string) =>
  `${p}.deleted_at is null and ${p}.hidden_at is null and exists (select 1 from publishers u where u.id = ${p}.publisher_id and u.status = 'active')`;

/** In load order: a table's foreign keys point only at tables before it. */
export const SNAPSHOT_TABLES: readonly SnapshotTable[] = [
  {
    name: "publishers",
    key: "id",
    // publicPublisher: verified is the only thing it says about domain_verified_at.
    columns: [...same("id", "name", "description", "url", "domain"), { name: "verified", expr: "(t.domain_verified_at is not null)" }, ...same("post_count", "created_at")],
    where: "t.status = 'active'",
  },
  {
    name: "sources",
    key: "id",
    // What a relayed post's metadata says about its source: source_id, source_name, license (cut
    // to 200 characters, as the runner writes it), and the adapter as metadata.source.
    columns: [...same("id", "name", "adapter"), { name: "license", expr: "left(t.license, 200)" }],
    where: `exists (select 1 from posts p where p.metadata->>'source_id' = t.id and ${VISIBLE_POST("p")})`,
  },
  {
    name: "posts",
    key: "id",
    // publicPost. Expired posts stay: /p/<id> and include_expired search still serve them.
    columns: same(
      "id", "publisher_id", "kind", "title", "body", "url", "tags", "place_name", "lat", "lng",
      "starts_at", "ends_at", "timezone", "expires_at", "source_url", "syndicated", "metadata",
      "retrievals", "parent_id", "reply_count", "last_reply_at", "flags", "created_at", "updated_at",
    ),
    where: VISIBLE_POST("t"),
  },
];

/**
 * Tables the snapshot never serves, whatever the allowlist above grows to. Private by construction
 * (keys, secrets, moderation, address-derived rows, operator state) or meaningless off production.
 */
export const NEVER_SERVED_TABLES: readonly string[] = [
  "strategy_items", "strategy_log", "rate_limits", "daily_actors", "unmet_queries", "search_log",
  "reports", "subscriptions", "deliveries", "cron_state", "schema_migrations",
];

/** Columns no served table may carry, under any name. embedding is held back until the owner says otherwise. */
export const NEVER_SERVED_COLUMNS: readonly string[] = [
  "api_key_hash", "api_key_prefix", "verify_token", "secret", "webhook_challenge", "embedding",
  "query_embedding", "idempotency_key", "user_agent", "client", "internal", "views",
  "hidden_at", "hidden_reason", "report_count", "suspended_reason", "deleted_at", "reporter_hash",
];

/** Vercel refuses a response body over 4.5 MB; a page stays under this, envelope included. */
export const SNAPSHOT_PAGE_BYTES = 3_000_000;
/** Bytes held back from the page budget for the envelope around the rows. */
export const SNAPSHOT_ENVELOPE_BYTES = 16_000;
/** Rows read per page. A post is at most about 13 kB of JSON, so a full batch can overrun the page and is cut. */
export const SNAPSHOT_BATCH_ROWS = 400;

export type SnapshotCursor = { t: string; k: string };

/** A cursor the caller sent back, if it names a served table and a key; null for anything else. */
export function asSnapshotCursor(c: unknown): SnapshotCursor | null {
  const o = c as { t?: unknown; k?: unknown } | null;
  if (!o || typeof o.t !== "string" || typeof o.k !== "string" || o.k.length > 200) return null;
  return SNAPSHOT_TABLES.some((t) => t.name === o.t) ? { t: o.t, k: o.k } : null;
}

export function firstCursor(): SnapshotCursor {
  return { t: SNAPSHOT_TABLES[0].name, k: "" };
}

/** The read for one page: rows of `table` after key `$1`, in key order, at most `$2` of them. */
export function pageStatement(table: SnapshotTable): string {
  const cols = table.columns.map((c) => (c.expr === `t.${c.name}` ? c.expr : `${c.expr} as ${c.name}`)).join(", ");
  return `select ${cols} from ${table.name} t where (${table.where}) and t.${table.key} > $1 order by t.${table.key} limit $2`;
}

/** One statement counting the rows each served table would page through, as columns named after the tables. */
export function countStatement(): string {
  return "select " + SNAPSHOT_TABLES.map((t) => `(select count(*)::int from ${t.name} t where ${t.where}) as ${t.name}`).join(", ");
}

export type Page<R> = { rows: R[]; bytes: number; next: SnapshotCursor | null };

/**
 * Cut a fetched batch to the page budget and say where the next page starts. `fetched` is the batch
 * as read with limit `batchRows`; a batch shorter than that means the table is done. A single row
 * over the budget still goes out alone, so paging always advances.
 */
export function cutPage<R extends Record<string, unknown>>(
  cursor: SnapshotCursor, fetched: R[], opts: { batchRows?: number; maxBytes?: number; size?: (r: R) => number } = {},
): Page<R> {
  const batchRows = opts.batchRows ?? SNAPSHOT_BATCH_ROWS;
  const max = (opts.maxBytes ?? SNAPSHOT_PAGE_BYTES) - SNAPSHOT_ENVELOPE_BYTES;
  const size = opts.size ?? ((r: R) => Buffer.byteLength(JSON.stringify(r)) + 1);
  const table = SNAPSHOT_TABLES.find((t) => t.name === cursor.t)!;
  const rows: R[] = [];
  let bytes = 0;
  for (const r of fetched) {
    const n = size(r);
    if (rows.length > 0 && bytes + n > max) break;
    rows.push(r);
    bytes += n;
  }
  if (rows.length < fetched.length || fetched.length === batchRows) {
    return { rows, bytes, next: { t: cursor.t, k: String(rows[rows.length - 1][table.key]) } };
  }
  const i = SNAPSHOT_TABLES.indexOf(table);
  return { rows, bytes, next: i + 1 < SNAPSHOT_TABLES.length ? { t: SNAPSHOT_TABLES[i + 1].name, k: "" } : null };
}

export type Access = "disabled" | "denied" | "granted";

/**
 * Whether a request may read the snapshot. `expectedSha256` is CRIER_SNAPSHOT_KEY_SHA256: unset or
 * not a hex SHA-256 is "disabled", which the route answers 404 so the endpoint does not exist.
 * `equal` must be constant-time.
 */
export function snapshotAccess(
  expectedSha256: string | undefined, presented: string | null,
  sha256: (s: string) => string, equal: (a: string, b: string) => boolean,
): Access {
  const want = (expectedSha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) return "disabled";
  if (!presented) return "denied";
  return equal(sha256(presented).toLowerCase(), want) ? "granted" : "denied";
}

/** An empty host is the client default, localhost. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

/**
 * Why scripts/db-dev.mjs must not write to this database URL, or null when it may. It writes, drops
 * and recreates, so it refuses production by its project ref wherever the ref appears (user name,
 * host, query), any Supabase host, and any other remote host unless `allowRemote`. The ref is
 * matched by hash so the repository does not carry it: every run of 20 lowercase letters is hashed.
 */
export function databaseRefusal(
  url: string, opts: { prodRefSha256: readonly string[]; sha256: (s: string) => string; allowRemote?: boolean },
): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "not a postgres:// URL"; }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return "not a postgres:// URL";
  const text = decodeURIComponent(url).toLowerCase();
  for (const run of text.match(/[a-z]{20,}/g) ?? []) {
    for (let i = 0; i + 20 <= run.length; i++) {
      if (opts.prodRefSha256.includes(opts.sha256(run.slice(i, i + 20)))) return "it carries the production project ref";
    }
  }
  const host = parsed.hostname.toLowerCase();
  if (/(^|\.)supabase\.(co|com)$/.test(host)) return "it is a Supabase host";
  if (!LOCAL_HOSTS.has(host) && !opts.allowRemote) return `${host} is not a local host (pass --allow-remote-host for a scratch database elsewhere)`;
  return null;
}

/** SHA-256 of the production Supabase project ref. */
export const PRODUCTION_REF_SHA256 = ["e2b038339fac67002462d61e4e00b98493f9a88ca3f6e3ec52b7d70b64a9dd3e"];
