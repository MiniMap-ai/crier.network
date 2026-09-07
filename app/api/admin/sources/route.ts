import { z } from "zod";
import { handler, ok, readJson, HttpError } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { sql } from "@/lib/db";
import { ADAPTERS, describeAdapter } from "@/lib/syndication/adapters";
import { newSourceId, runSource, syndicationPublisher } from "@/lib/syndication/runner";
import type { SourceRow } from "@/lib/syndication/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Sources with their last run. */
export const GET = handler(async (req) => {
  requireAdmin(req);
  const rows = await sql()<SourceRow[]>`select * from sources order by created_at desc`;
  const items = await sql()<{ source_id: string; n: number }[]>`select source_id, count(*)::int as n from source_items group by source_id`;
  const byId = new Map(items.map((i) => [i.source_id, i.n]));
  return ok({
    adapters: Object.fromEntries(Object.keys(ADAPTERS).map((a) => [a, describeAdapter(a as SourceRow["adapter"])])),
    sources: rows.map((r) => ({ ...r, relayed_items: byId.get(r.id) ?? 0 })),
  });
});

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  adapter: z.enum(["ticketmaster", "ical", "rss", "localist", "nws"]),
  config: z.record(z.string(), z.unknown()).default({}),
  homepage: z.url().optional(),
  license: z.string().trim().min(10).max(500),   // why we may redistribute this
  default_kind: z.enum(["event", "offer", "request", "announcement"]).default("event"),
  tags: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(10).default([]),
  run_every_minutes: z.number().int().min(15).max(10080).default(360),
  max_per_run: z.number().int().min(1).max(500).default(100),
  horizon_days: z.number().int().min(1).max(90).default(30),
  added_by: z.string().trim().max(60).default("operator"),
  notes: z.string().trim().max(1000).optional(),
  dry_run: z.boolean().default(false),   // fetch and return a sample without saving
});

/** Add a source. A test fetch runs first; a source that yields nothing or errors is not saved unless force=true. */
export const POST = handler(async (req) => {
  requireAdmin(req);
  const body = await readJson(req) as Record<string, unknown>;
  const input = CreateSchema.parse(body);
  const force = body.force === true;
  const source: SourceRow = {
    id: newSourceId(), name: input.name, adapter: input.adapter, config: input.config, homepage: input.homepage ?? null, license: input.license,
    default_kind: input.default_kind, tags: input.tags, enabled: true, run_every_minutes: input.run_every_minutes, max_per_run: input.max_per_run,
    horizon_days: input.horizon_days, added_by: input.added_by, notes: input.notes ?? null, created_at: new Date(), last_run_at: null, last_status: null, last_error: null, last_counts: null,
  };
  // Test fetch.
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  let sample: unknown[] = []; let error: string | undefined;
  try {
    const now = new Date();
    const items = await ADAPTERS[source.adapter](source, { now, horizonEnd: new Date(now.getTime() + source.horizon_days * 86400e3), signal: ctrl.signal });
    sample = items.slice(0, 5).map((i) => ({ uid: i.uid, title: i.title, starts_at: i.starts_at, location: i.location, url: i.url }));
    if (items.length === 0 && !force) error = "The source fetched but yielded no items in the horizon.";
  } catch (e) { error = (e as Error).message; }
  finally { clearTimeout(t); }
  if (input.dry_run) return ok({ dry_run: true, sample, error: error ?? null });
  if (error && !force) throw new HttpError(422, "source_test_failed", `Test fetch failed: ${error}`, "Fix the config, or pass force: true to save anyway (it will retry on schedule).");
  await sql()`insert into sources (id, name, adapter, config, homepage, license, default_kind, tags, enabled, run_every_minutes, max_per_run, horizon_days, added_by, notes)
    values (${source.id}, ${source.name}, ${source.adapter}, ${sql().json(source.config as never)}, ${source.homepage}, ${source.license}, ${source.default_kind}, ${source.tags}, true, ${source.run_every_minutes}, ${source.max_per_run}, ${source.horizon_days}, ${source.added_by}, ${source.notes})`;
  return ok({ id: source.id, sample, warning: error ?? null }, { status: 201, meta: { note: "Saved and enabled. It runs on the next hourly syndication tick, or POST /api/admin/sources/{id} {\"action\":\"run\"} to run now." } });
});
