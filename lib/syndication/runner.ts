/**
 * The syndication runner. Picks sources that are due, fetches them through their adapter,
 * and relays items as posts from the "Crier Syndication" publisher: create new, update changed,
 * retire vanished. Every relayed post carries source_url, syndicated=true and a source note.
 */
import { createHash } from "node:crypto";
import { sql } from "../db";
import { newPostId } from "../ids";
import { PostInput, PostInputSchema, createPost, deletePost, getPostRow, updatePost } from "../posts";
import { PublisherRow } from "../publishers";
import { ADAPTERS } from "./adapters";
import { Item, SourceRow } from "./types";

const SYNDICATION_NAME = "Crier Syndication";
const RETIRE_AFTER_MISSING_RUNS = 3;

export async function syndicationPublisher(): Promise<PublisherRow | null> {
  const [row] = await sql()<PublisherRow[]>`select * from publishers where internal and name = ${SYNDICATION_NAME} and status = 'active' limit 1`;
  return row ?? null;
}

export async function dueSources(limit = 10): Promise<SourceRow[]> {
  return sql()<SourceRow[]>`
    select * from sources where enabled and license <> ''
       and (last_run_at is null or last_run_at < now() - make_interval(mins => run_every_minutes))
     order by last_run_at nulls first limit ${limit}`;
}

function toInput(source: SourceRow, item: Item, now: Date): PostInput {
  const tags = [...new Set((item.tags ?? source.tags).map((t) => t.toLowerCase().trim()).filter(Boolean))].slice(0, 20);
  const raw: Record<string, unknown> = {
    kind: item.kind ?? source.default_kind,
    title: item.title.trim().slice(0, 200),
    body: item.body.trim().slice(0, 8000),
    url: item.url,
    tags,
    location: item.location && (item.location.name || item.location.lat != null) ? {
      name: item.location.name?.slice(0, 200),
      lat: item.location.lat != null && item.location.lng != null ? item.location.lat : undefined,
      lng: item.location.lat != null && item.location.lng != null ? item.location.lng : undefined,
    } : undefined,
    starts_at: item.starts_at,
    ends_at: item.ends_at && item.starts_at && Date.parse(item.ends_at) >= Date.parse(item.starts_at) ? item.ends_at : undefined,
    timezone: item.timezone,
    expires_at: item.expires_at && Date.parse(item.expires_at) > now.getTime() ? item.expires_at : undefined,
    source_url: item.url,
    syndicated: true,
    idempotency_key: `src:${source.id}:${item.uid}`.slice(0, 200),
    metadata: { ...(item.metadata ?? {}), source_id: source.id, source_name: source.name, license: source.license.slice(0, 200) },
  };
  for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
  return PostInputSchema.parse(raw);
}

function hashInput(i: PostInput): string {
  const { idempotency_key, metadata, ...rest } = i;
  void idempotency_key; void metadata;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 32);
}

export type RunResult = { source: string; status: "ok" | "error"; fetched: number; created: number; updated: number; retired: number; skipped: number; error?: string; ms: number };

export async function runSource(source: SourceRow, publisher: PublisherRow, deadline: number): Promise<RunResult> {
  const s = sql();
  const started = Date.now();
  const [run] = await s<{ id: number }[]>`insert into source_runs (source_id) values (${source.id}) returning id`;
  const counts = { fetched: 0, created: 0, updated: 0, retired: 0, skipped: 0 };
  const finish = async (status: "ok" | "error", error?: string): Promise<RunResult> => {
    await s`update source_runs set finished_at = now(), status = ${status}, fetched = ${counts.fetched}, created = ${counts.created}, updated = ${counts.updated}, retired = ${counts.retired}, skipped = ${counts.skipped}, error = ${error ?? null} where id = ${run.id}`;
    await s`update sources set last_run_at = now(), last_status = ${status}, last_error = ${error ?? null}, last_counts = ${s.json(counts)} where id = ${source.id}`;
    return { source: source.id, status, ...counts, error, ms: Date.now() - started };
  };
  try {
    const now = new Date();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(5000, Math.min(25000, deadline - Date.now() - 5000)));
    let items: Item[];
    try { items = await ADAPTERS[source.adapter](source, { now, horizonEnd: new Date(now.getTime() + source.horizon_days * 86400e3), signal: ctrl.signal }); }
    finally { clearTimeout(t); }
    counts.fetched = items.length;
    items.sort((a, b) => (a.starts_at ? Date.parse(a.starts_at) : 0) - (b.starts_at ? Date.parse(b.starts_at) : 0));
    const seen = new Set<string>();
    const existing = new Map((await s<{ uid: string; post_id: string | null; hash: string }[]>`select uid, post_id, hash from source_items where source_id = ${source.id}`).map((r) => [r.uid, r]));

    for (const item of items) {
      if (Date.now() > deadline - 3000) { counts.skipped += 1; continue; }
      seen.add(item.uid);
      const ex = existing.get(item.uid);
      if (item.cancelled) {
        if (ex?.post_id) { const row = await getPostRow(ex.post_id); if (row && !row.deleted_at) { await deletePost(publisher, ex.post_id); counts.retired++; } }
        await s`delete from source_items where source_id = ${source.id} and uid = ${item.uid}`;
        continue;
      }
      if (counts.created + counts.updated >= source.max_per_run) { counts.skipped++; continue; }
      let input: PostInput;
      try { input = toInput(source, item, now); } catch { counts.skipped++; continue; }
      const hash = hashInput(input);
      if (ex && ex.hash === hash && ex.post_id) {
        await s`update source_items set last_seen = now(), missing_runs = 0 where source_id = ${source.id} and uid = ${item.uid}`;
        continue;
      }
      if (ex?.post_id) {
        const row = await getPostRow(ex.post_id);
        if (row && !row.deleted_at) {
          const { idempotency_key, parent_id, ...patch } = input; void idempotency_key; void parent_id;
          await updatePost(publisher, ex.post_id, patch);
          await s`update source_items set hash = ${hash}, last_seen = now(), missing_runs = 0 where source_id = ${source.id} and uid = ${item.uid}`;
          counts.updated++;
          continue;
        }
      }
      const { post } = await createPost(publisher, input);
      await s`insert into source_items (source_id, uid, post_id, hash) values (${source.id}, ${item.uid}, ${post.id}, ${hash})
              on conflict (source_id, uid) do update set post_id = excluded.post_id, hash = excluded.hash, last_seen = now(), missing_runs = 0`;
      counts.created++;
    }

    // Items that were not in this fetch: count a miss; retire after a few consecutive misses (only future-dated ones matter).
    if (counts.skipped === 0) {
      const missing = await s<{ uid: string; post_id: string | null; missing_runs: number }[]>`
        update source_items set missing_runs = missing_runs + 1 where source_id = ${source.id} and uid <> all(${[...seen]}::text[]) returning uid, post_id, missing_runs`;
      for (const m of missing) {
        if (m.missing_runs < RETIRE_AFTER_MISSING_RUNS) continue;
        if (m.post_id) {
          const row = await getPostRow(m.post_id);
          if (row && !row.deleted_at && (!row.starts_at || row.starts_at.getTime() > Date.now())) { await deletePost(publisher, m.post_id); counts.retired++; }
        }
        await s`delete from source_items where source_id = ${source.id} and uid = ${m.uid}`;
      }
    }
    return finish("ok");
  } catch (e) {
    return finish("error", (e as Error).message.slice(0, 500));
  }
}

/** Run every due source within a wall-clock budget. */
export async function runDue(budgetMs: number): Promise<{ publisher: string | null; runs: RunResult[] }> {
  const publisher = await syndicationPublisher();
  if (!publisher) return { publisher: null, runs: [] };
  const deadline = Date.now() + budgetMs;
  const runs: RunResult[] = [];
  for (const source of await dueSources()) {
    if (Date.now() > deadline - 10000) break;
    runs.push(await runSource(source, publisher, deadline));
  }
  return { publisher: publisher.id, runs };
}

export function newSourceId() { return "src_" + newPostId(); }
