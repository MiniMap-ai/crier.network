import { createHash } from "node:crypto";
import type { EditableFields } from "./post-schema.ts";

/**
 * How a reader tells one version of a post from another: the `revision` an edit raises and the
 * `body_sha256` every response carries. docs/scenarios.md, scenario 20, defines both. Its one runtime
 * import is node:crypto, so tests and scripts/check-revision.mjs load it without a database or Next.
 */

/**
 * Lowercase hex SHA-256 of the UTF-8 bytes of `body`, which must be the full stored body exactly as
 * REST returns it. MCP text shows an excerpt of the body; the hash is never taken over that.
 */
export function bodySha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** A postgres.js tagged template, passed in by the caller. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

/** A post's content as an edit leaves it, and what the edit stores beside it. */
export type EditWrite = EditableFields & {
  /** null keeps the stored expiry. */
  expires_at: Date | null;
  source_key: string | null;
  flags: string[];
  /** A pgvector literal; null clears the embedding and undefined keeps it. */
  embedding: string | null | undefined;
};

/**
 * The statement that writes an edit to post `id`, and the only place `revision` is raised: by one
 * when any content column (the EditableFields and expires_at) ends up different from the stored
 * value, by none when the edit writes back what is there. The comparison runs against the row the
 * UPDATE locks, so of two edits racing to the same text only the first counts. Flags, embedding,
 * source_key and updated_at are written but are not content.
 */
export function writeEdit(sql: SqlTag, id: string, e: EditWrite): unknown {
  return sql`
    update posts p set
      revision = p.revision + ((
          p.kind, p.title, p.body, p.url, p.tags, p.place_name, p.lat, p.lng,
          p.starts_at, p.ends_at, p.timezone, p.expires_at, p.source_url, p.syndicated, p.metadata
        ) is distinct from (
          n.kind, n.title, n.body, n.url, n.tags, n.place_name, n.lat, n.lng,
          n.starts_at, n.ends_at, n.timezone, coalesce(n.expires_at, p.expires_at), n.source_url, n.syndicated, n.metadata
        ))::int,
      kind = n.kind, title = n.title, body = n.body, url = n.url, tags = n.tags,
      place_name = n.place_name, lat = n.lat, lng = n.lng,
      starts_at = n.starts_at, ends_at = n.ends_at, timezone = n.timezone,
      expires_at = coalesce(n.expires_at, p.expires_at), source_url = n.source_url, source_key = ${e.source_key},
      syndicated = n.syndicated, metadata = n.metadata,
      embedding = case when ${e.embedding === undefined}::boolean then p.embedding else ${e.embedding ?? null}::vector end,
      flags = ${e.flags}::text[],
      updated_at = now()
    from (select ${e.kind}::text as kind, ${e.title}::text as title, ${e.body}::text as body, ${e.url}::text as url,
                 ${e.tags}::text[] as tags, ${e.place_name}::text as place_name, ${e.lat}::float8 as lat, ${e.lng}::float8 as lng,
                 ${e.starts_at}::timestamptz as starts_at, ${e.ends_at}::timestamptz as ends_at, ${e.timezone}::text as timezone,
                 ${e.expires_at}::timestamptz as expires_at, ${e.source_url}::text as source_url,
                 ${e.syndicated}::boolean as syndicated, ${e.metadata}::jsonb as metadata) n
    where p.id = ${id}`;
}
