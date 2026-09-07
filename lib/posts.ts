import { z } from "zod";
import { sql, toVectorLiteral } from "./db";
import { env } from "./env";
import { HttpError } from "./http";
import { newPostId } from "./ids";
import { embedDocuments, postEmbeddingText } from "./cohere";
import { PublicPublisher, PublisherRow, publicPublisher } from "./publishers";

export const KINDS = ["event", "offer", "request", "announcement", "thread"] as const;
export type Kind = (typeof KINDS)[number];

export const LocationSchema = z.object({
  name: z.string().trim().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
}).refine((l) => (l.lat === undefined) === (l.lng === undefined), { message: "lat and lng must be given together" });

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO 8601 date-time, e.g. 2026-09-12T21:00:00-05:00" });

export const PostInputSchema = z.object({
  kind: z.enum(KINDS).default("announcement"),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  url: z.url().max(1000).optional(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).default([]),
  location: LocationSchema.optional(),
  starts_at: isoDate.optional(),
  ends_at: isoDate.optional(),
  timezone: z.string().max(64).optional(),
  expires_at: isoDate.optional(),
  source_url: z.url().max(1000).optional(),
  syndicated: z.boolean().optional(),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  parent_id: z.string().trim().min(1).max(60).optional(),
});
export type PostInput = z.infer<typeof PostInputSchema>;

export const PostPatchSchema = PostInputSchema.partial().omit({ idempotency_key: true, parent_id: true });

export type PostRow = {
  id: string;
  publisher_id: string;
  kind: Kind;
  title: string;
  body: string;
  url: string | null;
  tags: string[];
  place_name: string | null;
  lat: number | null;
  lng: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  timezone: string | null;
  expires_at: Date;
  source_url: string | null;
  source_key: string | null;
  syndicated: boolean;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  retrievals: number | string;
  views: number | string;
  parent_id: string | null;
  reply_count: number;
  last_reply_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  // joined
  distance_km?: number | null;
  score?: number | null;
  pub_name?: string; pub_url?: string | null; pub_domain?: string | null; pub_description?: string | null;
  pub_verified_at?: Date | null; pub_created_at?: Date; pub_post_count?: number;
};

export type PublicPost = {
  id: string;
  url: string;              // canonical Crier URL
  kind: Kind;
  title: string;
  body: string;
  link: string | null;      // the outbound url the publisher gave
  tags: string[];
  location: { name: string | null; lat: number | null; lng: number | null } | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  expires_at: string;
  source_url: string | null;
  syndicated: boolean;
  metadata: Record<string, unknown>;
  retrievals: number;
  parent_id: string | null;
  thread_url: string | null;    // where to read/reply if this is part of a thread
  reply_count: number;
  last_reply_at: string | null;
  created_at: string;
  updated_at: string;
  distance_km?: number;
  relevance?: number;       // reranker score for the query, 0..1, on text searches only
  publisher: PublicPublisher;
  related?: PublicPost[];
  replies?: PublicPost[];
};

export function publicPost(r: PostRow, opts: { withDistance?: boolean } = {}): PublicPost {
  const p: PublicPost = {
    id: r.id,
    url: `${env.SITE_URL}/p/${r.id}`,
    kind: r.kind,
    title: r.title,
    body: r.body,
    link: r.url,
    tags: r.tags ?? [],
    location: r.place_name || r.lat != null ? { name: r.place_name, lat: r.lat, lng: r.lng } : null,
    starts_at: r.starts_at ? r.starts_at.toISOString() : null,
    ends_at: r.ends_at ? r.ends_at.toISOString() : null,
    timezone: r.timezone,
    expires_at: r.expires_at.toISOString(),
    source_url: r.source_url,
    syndicated: r.syndicated,
    metadata: r.metadata ?? {},
    retrievals: Number(r.retrievals ?? 0),
    parent_id: r.parent_id ?? null,
    thread_url: r.parent_id ? `${env.SITE_URL}/p/${r.parent_id}` : r.reply_count > 0 || r.kind === "thread" ? `${env.SITE_URL}/p/${r.id}` : null,
    reply_count: r.reply_count ?? 0,
    last_reply_at: r.last_reply_at ? r.last_reply_at.toISOString() : null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    publisher: {
      id: r.publisher_id,
      name: r.pub_name ?? "",
      description: r.pub_description ?? null,
      url: r.pub_url ?? null,
      domain: r.pub_domain ?? null,
      verified: !!r.pub_verified_at,
      first_seen: r.pub_created_at ? r.pub_created_at.toISOString() : r.created_at.toISOString(),
      post_count: r.pub_post_count ?? 0,
      crier_url: `${env.SITE_URL}/publishers/${r.publisher_id}`,
    },
  };
  if (opts.withDistance && r.distance_km != null) p.distance_km = Math.round(r.distance_km * 10) / 10;
  return p;
}

/** Columns for a post joined with its publisher. Use inside a query that aliases posts as p and publishers as u. */
export const POST_COLUMNS = `
  p.*, u.name as pub_name, u.url as pub_url, u.domain as pub_domain, u.description as pub_description,
  u.domain_verified_at as pub_verified_at, u.created_at as pub_created_at, u.post_count as pub_post_count`;

export function normalizeSourceKey(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    url.hash = "";
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(k)) url.searchParams.delete(k);
    let s = url.toString().toLowerCase().replace(/^https?:\/\/(www\.)?/, "");
    s = s.replace(/\/+$/, "");
    return s.slice(0, 500);
  } catch { return null; }
}

const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 365;

function computeExpiry(input: { expires_at?: string; ends_at?: string; starts_at?: string }): Date {
  const now = Date.now();
  if (input.expires_at) {
    const e = new Date(input.expires_at);
    if (e.getTime() <= now) throw new HttpError(400, "invalid_expiry", "expires_at is in the past.");
    return new Date(Math.min(e.getTime(), now + MAX_TTL_DAYS * 86400e3));
  }
  const end = input.ends_at ? new Date(input.ends_at) : input.starts_at ? new Date(input.starts_at) : null;
  if (end) {
    // Keep events around a day after they end so "what did I miss" still works.
    return new Date(Math.max(end.getTime() + 86400e3, now + 3600e3));
  }
  return new Date(now + DEFAULT_TTL_DAYS * 86400e3);
}

function validateWindow(input: { starts_at?: string; ends_at?: string }) {
  if (input.starts_at && input.ends_at && Date.parse(input.ends_at) < Date.parse(input.starts_at)) {
    throw new HttpError(400, "invalid_window", "ends_at is before starts_at.");
  }
}

export async function createPost(publisher: PublisherRow, input: PostInput): Promise<{ post: PublicPost; created: boolean }> {
  validateWindow(input);
  if (input.idempotency_key) {
    const existing = await getPostRow(null, { publisherId: publisher.id, idempotencyKey: input.idempotency_key });
    if (existing) return { post: publicPost(existing), created: false };
  }
  let parentId: string | null = null;
  if (input.parent_id) {
    const pid = input.parent_id.replace(/^.*\/p\//, "").replace(/\.json$/, "");
    const parent = await getPostRow(pid);
    if (!parent || parent.deleted_at) throw new HttpError(404, "parent_not_found", `No post ${pid} to reply to.`);
    if (parent.parent_id) throw new HttpError(400, "nested_reply", "Replies are one level deep; reply to the thread itself.", `Use parent_id ${parent.parent_id}.`);
    parentId = parent.id;
  }
  const id = newPostId();
  const expires_at = computeExpiry(input);
  const tags = [...new Set(input.tags)];
  const [vec] = await embedDocuments([postEmbeddingText({ ...input, tags, place_name: input.location?.name ?? null })]);
  const [row] = await sql()<PostRow[]>`
    insert into posts (id, publisher_id, kind, title, body, url, tags, place_name, lat, lng, starts_at, ends_at, timezone,
                       expires_at, source_url, source_key, syndicated, idempotency_key, metadata, embedding, parent_id)
    values (${id}, ${publisher.id}, ${input.kind}, ${input.title}, ${input.body}, ${input.url ?? null}, ${tags},
            ${input.location?.name ?? null}, ${input.location?.lat ?? null}, ${input.location?.lng ?? null},
            ${input.starts_at ? new Date(input.starts_at) : null}, ${input.ends_at ? new Date(input.ends_at) : null}, ${input.timezone ?? null},
            ${expires_at}, ${input.source_url ?? null}, ${normalizeSourceKey(input.source_url)}, ${input.syndicated ?? false},
            ${input.idempotency_key ?? null}, ${sql().json((input.metadata ?? {}) as never)},
            ${vec ? toVectorLiteral(vec) : null}::vector, ${parentId})
    returning *`;
  await sql()`select bump_stat('posts')`;
  const full = await getPostRow(row.id);
  return { post: publicPost(full!), created: true };
}

export async function updatePost(publisher: PublisherRow, id: string, patch: z.infer<typeof PostPatchSchema>): Promise<PublicPost> {
  const existing = await getPostRow(id);
  if (!existing || existing.deleted_at) throw new HttpError(404, "not_found", "No such post.");
  if (existing.publisher_id !== publisher.id) throw new HttpError(403, "forbidden", "This post belongs to another publisher.");
  const merged = {
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
  validateWindow({ starts_at: merged.starts_at?.toISOString(), ends_at: merged.ends_at?.toISOString() });
  const expires_at = patch.expires_at || patch.ends_at || patch.starts_at
    ? computeExpiry({ expires_at: patch.expires_at, ends_at: merged.ends_at?.toISOString(), starts_at: merged.starts_at?.toISOString() })
    : existing.expires_at;
  const textChanged = patch.title !== undefined || patch.body !== undefined || patch.tags !== undefined || patch.location !== undefined || patch.kind !== undefined;
  let vecLiteral: string | null | undefined = undefined;
  if (textChanged) {
    const [vec] = await embedDocuments([postEmbeddingText({ ...merged })]);
    vecLiteral = vec ? toVectorLiteral(vec) : null;
  }
  await sql()`
    update posts set
      kind = ${merged.kind}, title = ${merged.title}, body = ${merged.body}, url = ${merged.url}, tags = ${merged.tags},
      place_name = ${merged.place_name}, lat = ${merged.lat}, lng = ${merged.lng},
      starts_at = ${merged.starts_at}, ends_at = ${merged.ends_at}, timezone = ${merged.timezone},
      expires_at = ${expires_at}, source_url = ${merged.source_url}, source_key = ${normalizeSourceKey(merged.source_url)},
      syndicated = ${merged.syndicated}, metadata = ${sql().json(merged.metadata as never)},
      embedding = ${vecLiteral === undefined ? sql()`embedding` : sql()`${vecLiteral}::vector`},
      updated_at = now()
    where id = ${id}`;
  return publicPost((await getPostRow(id))!);
}

export async function deletePost(publisher: PublisherRow, id: string): Promise<void> {
  const existing = await getPostRow(id);
  if (!existing || existing.deleted_at) throw new HttpError(404, "not_found", "No such post.");
  if (existing.publisher_id !== publisher.id) throw new HttpError(403, "forbidden", "This post belongs to another publisher.");
  await sql()`update posts set deleted_at = now(), updated_at = now() where id = ${id}`;
}

export async function getPostRow(id: string | null, by?: { publisherId: string; idempotencyKey: string }): Promise<PostRow | null> {
  const s = sql();
  const rows = by
    ? await s.unsafe<PostRow[]>(`select ${POST_COLUMNS} from posts p join publishers u on u.id = p.publisher_id where p.publisher_id = $1 and p.idempotency_key = $2`, [by.publisherId, by.idempotencyKey])
    : await s.unsafe<PostRow[]>(`select ${POST_COLUMNS} from posts p join publishers u on u.id = p.publisher_id where p.id = $1`, [id!]);
  return rows[0] ?? null;
}

/** Nearest live posts by embedding, excluding the post itself. */
export async function relatedPosts(id: string, limit = 5): Promise<PublicPost[]> {
  const rows = await sql().unsafe<PostRow[]>(
    `select ${POST_COLUMNS}
       from posts p join publishers u on u.id = p.publisher_id, (select embedding from posts where id = $1) q
      where p.id <> $1 and p.parent_id is null and p.deleted_at is null and p.expires_at > now()
        and p.embedding is not null and q.embedding is not null and (p.embedding <=> q.embedding) <= 0.85
      order by p.embedding <=> q.embedding
      limit $2`, [id, limit]);
  return rows.map((r) => publicPost(r));
}

/** Replies to a post, oldest first. */
export async function repliesFor(id: string, limit = 50, after?: string): Promise<{ posts: PublicPost[]; next_cursor: string | null }> {
  const cur = after ? new Date(after) : null;
  const rows = cur
    ? await sql().unsafe<PostRow[]>(`select ${POST_COLUMNS} from posts p join publishers u on u.id = p.publisher_id where p.parent_id = $1 and p.deleted_at is null and p.created_at > $2 order by p.created_at asc, p.id asc limit $3`, [id, cur, limit + 1])
    : await sql().unsafe<PostRow[]>(`select ${POST_COLUMNS} from posts p join publishers u on u.id = p.publisher_id where p.parent_id = $1 and p.deleted_at is null order by p.created_at asc, p.id asc limit $2`, [id, limit + 1]);
  const page = rows.slice(0, limit);
  return { posts: page.map((r) => publicPost(r)), next_cursor: rows.length > limit ? page[page.length - 1].created_at.toISOString() : null };
}

export async function bumpViews(id: string) {
  sql()`update posts set views = views + 1 where id = ${id}`.catch(() => {});
}

export function jsonLd(p: PublicPost) {
  const base: Record<string, unknown> = {
    "@context": "https://schema.org",
    name: p.title,
    description: p.body.slice(0, 500),
    url: p.link ?? p.url,
    identifier: p.id,
    datePublished: p.created_at,
    dateModified: p.updated_at,
    keywords: p.tags.join(", "),
    publisher: { "@type": "Organization", name: p.publisher.name, url: p.publisher.url ?? p.publisher.crier_url },
    mainEntityOfPage: p.url,
  };
  const place = p.location
    ? { "@type": "Place", name: p.location.name ?? undefined, geo: p.location.lat != null ? { "@type": "GeoCoordinates", latitude: p.location.lat, longitude: p.location.lng } : undefined }
    : undefined;
  if (p.kind === "event") {
    return { ...base, "@type": "Event", startDate: p.starts_at ?? undefined, endDate: p.ends_at ?? undefined, location: place, eventStatus: "https://schema.org/EventScheduled" };
  }
  if (p.kind === "offer") {
    return { ...base, "@type": "Offer", availabilityStarts: p.starts_at ?? undefined, availabilityEnds: p.ends_at ?? undefined, areaServed: place, validThrough: p.expires_at };
  }
  if (p.kind === "request") {
    return { ...base, "@type": "Demand", availabilityStarts: p.starts_at ?? undefined, availabilityEnds: p.ends_at ?? undefined, areaServed: place, validThrough: p.expires_at };
  }
  if (p.kind === "thread") {
    return { ...base, "@type": "DiscussionForumPosting", headline: p.title, articleBody: p.body, commentCount: p.reply_count, expires: p.expires_at };
  }
  return { ...base, "@type": "Article", headline: p.title, articleBody: p.body, contentLocation: place, expires: p.expires_at };
}
