import { z } from "zod";

/**
 * What a post body may say, on create and on edit, and how an edit lands on the stored post. Its
 * only import is zod, so tests load it without a database or Next.
 */

export const KINDS = ["event", "offer", "request", "announcement", "thread"] as const;
export type Kind = (typeof KINDS)[number];

export const LocationSchema = z.object({
  name: z.string().trim().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
}).refine((l) => (l.lat === undefined) === (l.lng === undefined), { message: "lat and lng must be given together" });

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO 8601 date-time, e.g. 2026-09-12T21:00:00-05:00" });

// No defaults here: zod's .partial() keeps a default, so a PATCH schema built from a defaulted field
// would fill in a value the caller never sent and overwrite the stored one.
const PostFields = z.object({
  kind: z.enum(KINDS),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  url: z.url().max(1000).optional(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20),
  location: LocationSchema.optional(),
  starts_at: isoDate.optional(),
  ends_at: isoDate.optional(),
  timezone: z.string().max(64).optional(),
  expires_at: isoDate.optional(),
  source_url: z.url().max(1000).optional(),
  syndicated: z.boolean().optional(),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).refine((m) => JSON.stringify(m).length <= 4096, { message: "metadata must serialize to 4 KB or less" }).optional(),
  parent_id: z.string().trim().min(1).max(60).optional(),
});

/** A create body. Only title and body are required; kind defaults to announcement and tags to none. */
export const PostInputSchema = PostFields.extend({
  kind: PostFields.shape.kind.default("announcement"),
  tags: PostFields.shape.tags.default([]),
});
export type PostInput = z.infer<typeof PostInputSchema>;

/** A PATCH body: any post field but idempotency_key and parent_id, each optional and never defaulted. */
export const PostPatchSchema = PostFields.partial().omit({ idempotency_key: true, parent_id: true });
export type PostEdit = z.infer<typeof PostPatchSchema>;

/** The text embedded for a post: kind and title, tags, place and body, in that order. */
export function postEmbeddingText(p: { title: string; body: string; tags: string[]; place_name?: string | null; kind: string }): string {
  const parts = [p.kind + ": " + p.title];
  if (p.tags.length) parts.push("tags: " + p.tags.join(", "));
  if (p.place_name) parts.push("where: " + p.place_name);
  parts.push(p.body);
  return parts.join("\n");
}

/** The stored fields an edit can change, as a posts row holds them. */
export type EditableFields = {
  kind: Kind; title: string; body: string; url: string | null; tags: string[];
  place_name: string | null; lat: number | null; lng: number | null;
  starts_at: Date | null; ends_at: Date | null; timezone: string | null;
  source_url: string | null; syndicated: boolean; metadata: Record<string, unknown>;
};

/**
 * Apply an edit to a stored post. A field the patch omits keeps its stored value; `tags: []` clears
 * the tags, and `location` replaces place and coordinates together. The caller strips hidden
 * Unicode from the patch's title and body first, so `textChanged` compares the text as it would be
 * stored. `textChanged` is true only when the embedded text differs, so an edit to dates, link or
 * metadata keeps the post's embedding.
 */
export function mergeEdit(existing: EditableFields, patch: PostEdit): { merged: EditableFields; textChanged: boolean } {
  const merged: EditableFields = {
    kind: patch.kind ?? existing.kind,
    title: patch.title ?? existing.title,
    body: patch.body ?? existing.body,
    url: patch.url !== undefined ? patch.url : existing.url,
    tags: patch.tags ? [...new Set(patch.tags)] : existing.tags,
    place_name: patch.location ? patch.location.name ?? null : existing.place_name,
    lat: patch.location ? patch.location.lat ?? null : existing.lat,
    lng: patch.location ? patch.location.lng ?? null : existing.lng,
    starts_at: patch.starts_at !== undefined ? new Date(patch.starts_at) : existing.starts_at,
    ends_at: patch.ends_at !== undefined ? new Date(patch.ends_at) : existing.ends_at,
    timezone: patch.timezone !== undefined ? patch.timezone : existing.timezone,
    source_url: patch.source_url !== undefined ? patch.source_url : existing.source_url,
    syndicated: patch.syndicated ?? existing.syndicated,
    metadata: patch.metadata ?? existing.metadata,
  };
  return { merged, textChanged: postEmbeddingText(merged) !== postEmbeddingText(existing) };
}
