import { icalDate, icalText, parseFeed, parseICal } from "./feeds";
import { Adapter, AdapterContext, Item, SourceRow, fetchJson, fetchText, inHorizon, plainText } from "./types";

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/* ---------------- Ticketmaster Discovery API ----------------
   config: { lat, lng, radius_km, city (label), segment? ("Music" | "Sports" | "Arts & Theatre" | ...) }
   Terms require attribution and a link back; every post says "Source: Ticketmaster" and links the event. */
export const ticketmaster: Adapter = async (source, ctx) => {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) throw new Error("TICKETMASTER_API_KEY is not set");
  const c = source.config;
  const lat = num(c.lat), lng = num(c.lng);
  if (lat === undefined || lng === undefined) throw new Error("config.lat and config.lng are required");
  const radius = Math.min(150, num(c.radius_km) ?? 40);
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const items: Item[] = [];
  const pageSize = 200;
  const maxPages = Math.ceil(source.max_per_run / pageSize);
  for (let page = 0; page < maxPages && page * pageSize < 1000; page++) {
    const params = new URLSearchParams({
      apikey: key, latlong: `${lat},${lng}`, radius: String(Math.round(radius)), unit: "km",
      startDateTime: fmt(ctx.now), endDateTime: fmt(ctx.horizonEnd), size: String(pageSize), page: String(page), sort: "date,asc", locale: "*",
    });
    if (typeof c.segment === "string") params.set("classificationName", c.segment);
    type TM = { _embedded?: { events?: Record<string, unknown>[] }; page?: { totalPages?: number } };
    const data = await fetchJson<TM>(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`, ctx);
    const events = data._embedded?.events ?? [];
    for (const e of events) {
      const id = str(e.id); if (!id) continue;
      const dates = (e.dates ?? {}) as Record<string, unknown>;
      const start = (dates.start ?? {}) as Record<string, unknown>;
      const status = ((dates.status ?? {}) as Record<string, unknown>).code;
      const startsAt = str(start.dateTime) || (str(start.localDate) ? `${start.localDate}T${str(start.localTime, "12:00:00")}` : "");
      const venue = (((e._embedded ?? {}) as Record<string, unknown>).venues as Record<string, unknown>[] | undefined)?.[0] ?? {};
      const vloc = (venue.location ?? {}) as Record<string, unknown>;
      const city = ((venue.city ?? {}) as Record<string, unknown>).name;
      const state = ((venue.state ?? {}) as Record<string, unknown>).stateCode;
      const cls = ((e.classifications as Record<string, unknown>[] | undefined)?.[0] ?? {}) as Record<string, Record<string, unknown>>;
      // Ticketmaster fills empty classifications with the literal name "Undefined"; treat it as absent.
      const cname = (v: unknown) => { const t = str(v); return /^undefined$/i.test(t) ? "" : t; };
      const segment = cname(cls.segment?.name), genre = cname(cls.genre?.name), sub = cname(cls.subGenre?.name);
      const price = ((e.priceRanges as Record<string, unknown>[] | undefined)?.[0] ?? {}) as Record<string, unknown>;
      const priceStr = num(price.min) !== undefined ? `${str(price.currency, "USD")} ${num(price.min)}${num(price.max) !== undefined && num(price.max) !== num(price.min) ? "–" + num(price.max) : ""}` : "";
      const place = [str(venue.name), [city, state].filter(Boolean).join(", ")].filter(Boolean).join(", ");
      const bodyParts = [
        [segment, genre, sub && sub !== genre ? sub : ""].filter(Boolean).join(" · "),
        place ? `At ${place}.` : "",
        priceStr ? `Tickets from ${priceStr}.` : "",
        plainText(str(e.info) || str(e.pleaseNote), 300),
        `Tickets and details: ${str(e.url)}`,
        "Source: Ticketmaster (relayed by Crier; details may change, check the link).",
      ].filter(Boolean);
      const tags = [...source.tags, segment, genre].filter(Boolean).map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter((t) => t.length >= 2 && t.length <= 40);
      items.push({
        uid: id,
        title: str(e.name).slice(0, 200),
        body: bodyParts.join("\n"),
        url: str(e.url) || undefined,
        kind: "event",
        starts_at: startsAt || undefined,
        timezone: str(dates.timezone) || undefined,
        location: { name: place || undefined, lat: num(vloc.latitude), lng: num(vloc.longitude) },
        tags: [...new Set(tags)],
        cancelled: status === "cancelled",
        metadata: { source: "ticketmaster", segment, genre, venue: str(venue.name), status },
      });
    }
    if (events.length < pageSize || (data.page?.totalPages ?? 0) <= page + 1) break;
  }
  return items.filter((i) => inHorizon(i.starts_at, ctx));
};

/* ---------------- iCalendar ----------------
   config: { url, timezone? (default zone for floating times), location_name?, lat?, lng? } */
export const ical: Adapter = async (source, ctx) => {
  const url = str(source.config.url);
  if (!url) throw new Error("config.url is required");
  const text = await fetchText(url, ctx);
  const zone = str(source.config.timezone) || /X-WR-TIMEZONE:([^\r\n]+)/.exec(text)?.[1]?.trim();
  const items: Item[] = [];
  for (const ev of parseICal(text)) {
    const uid = ev.UID?.[0]?.value?.trim(); if (!uid) continue;
    if (ev.RRULE) continue;   // recurring series are not expanded; single instances only
    const st = icalDate(ev.DTSTART?.[0], zone); if (!st) continue;
    const en = icalDate(ev.DTEND?.[0], zone);
    if (ev.STATUS?.[0]?.value?.toUpperCase() === "CANCELLED") { items.push({ uid, title: "cancelled", body: "cancelled", cancelled: true }); continue; }
    const summary = icalText(ev.SUMMARY?.[0]?.value).trim(); if (!summary) continue;
    const desc = plainText(icalText(ev.DESCRIPTION?.[0]?.value), 500);
    const loc = icalText(ev.LOCATION?.[0]?.value).trim();
    const geo = ev.GEO?.[0]?.value?.split(";").map(Number);
    const link = ev.URL?.[0]?.value?.trim();
    items.push({
      uid,
      title: summary.slice(0, 200),
      body: [desc, loc ? `Where: ${loc}` : "", link ? `Details: ${link}` : "", `Source: ${source.name}${source.homepage ? " (" + source.homepage + ")" : ""}, relayed by Crier.`].filter(Boolean).join("\n"),
      url: link || undefined,
      kind: source.default_kind,
      starts_at: st.iso,
      ends_at: en?.iso,
      timezone: zone || undefined,
      location: { name: loc || str(source.config.location_name) || undefined, lat: geo && geo.length === 2 && Number.isFinite(geo[0]) ? geo[0] : num(source.config.lat), lng: geo && geo.length === 2 && Number.isFinite(geo[1]) ? geo[1] : num(source.config.lng) },
      tags: [...source.tags, ...(ev.CATEGORIES?.flatMap((c) => c.value.split(",")) ?? [])].map((t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")).filter((t) => t.length >= 2 && t.length <= 40),
      metadata: { source: "ical", all_day: st.allDay },
    });
  }
  return items.filter((i) => i.cancelled || inHorizon(i.starts_at, ctx));
};

/* ---------------- RSS / Atom ----------------
   config: { url, ttl_days? (default 14), location_name?, lat?, lng? }. Items are notices, not timed events. */
export const rss: Adapter = async (source, ctx) => {
  const url = str(source.config.url);
  if (!url) throw new Error("config.url is required");
  const xml = await fetchText(url, ctx);
  const feed = parseFeed(xml);
  const ttlDays = num(source.config.ttl_days) ?? 14;
  const items: Item[] = [];
  for (const it of feed.items) {
    if (!it.id || !it.title) continue;
    const published = it.published ? new Date(it.published) : undefined;
    if (published && !Number.isNaN(published.getTime()) && published.getTime() < ctx.now.getTime() - ttlDays * 86400e3) continue;
    items.push({
      uid: it.id,
      title: plainText(it.title, 200),
      body: [plainText(it.summary, 600), it.link ? `Read more: ${it.link}` : "", `Source: ${source.name}${source.homepage ? " (" + source.homepage + ")" : ""}, relayed by Crier.`].filter(Boolean).join("\n"),
      url: it.link,
      kind: source.default_kind,
      location: { name: str(source.config.location_name) || undefined, lat: num(source.config.lat), lng: num(source.config.lng) },
      tags: [...source.tags, ...it.categories].map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-")).filter((t) => t.length >= 2 && t.length <= 40).slice(0, 20),
      expires_at: new Date((published && !Number.isNaN(published.getTime()) ? published.getTime() : ctx.now.getTime()) + ttlDays * 86400e3).toISOString(),
      metadata: { source: "rss", feed_title: feed.title.slice(0, 120), published: it.published },
    });
  }
  return items;
};

/* ---------------- Localist (campus/community calendars) ----------------
   config: { base (e.g. https://events.stanford.edu), location_name? } */
export const localist: Adapter = async (source, ctx) => {
  const base = str(source.config.base).replace(/\/$/, "");
  if (!base) throw new Error("config.base is required");
  type L = { events: { event: Record<string, unknown> }[]; page?: { total?: number } };
  const items: Item[] = [];
  for (let page = 1; page <= 5; page++) {
    const data = await fetchJson<L>(`${base}/api/2/events?days=${source.horizon_days}&pp=100&page=${page}`, ctx);
    for (const { event: e } of data.events ?? []) {
      const id = String(e.id ?? ""); if (!id) continue;
      const geo = (e.geo ?? {}) as Record<string, unknown>;
      const instances = ((e.event_instances ?? []) as { event_instance: Record<string, unknown> }[]).map((x) => x.event_instance);
      for (const inst of instances.slice(0, 5)) {
        const start = str(inst.start); if (!start) continue;
        items.push({
          uid: `${id}:${start}`,
          title: plainText(str(e.title), 200),
          body: [plainText(str(e.description_text) || str(e.description), 500), str(e.location_name) ? `Where: ${str(e.location_name)}${str(e.room_number) ? ", " + str(e.room_number) : ""}` : "", `Details: ${str(e.localist_url)}`, `Source: ${source.name}, relayed by Crier.`].filter(Boolean).join("\n"),
          url: str(e.localist_url) || undefined,
          kind: "event",
          starts_at: start,
          ends_at: str(inst.end) || undefined,
          location: { name: str(e.location_name) || str(source.config.location_name) || undefined, lat: num(geo.latitude), lng: num(geo.longitude) },
          tags: [...source.tags, ...Object.values((e.filters ?? {}) as Record<string, { name: string }[]>).flat().map((f) => f?.name ?? "")].map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-")).filter((t) => t.length >= 2 && t.length <= 40).slice(0, 20),
          metadata: { source: "localist", all_day: !!inst.all_day, free: e.free },
        });
      }
    }
    if ((data.events ?? []).length < 100) break;
  }
  return items.filter((i) => inHorizon(i.starts_at, ctx));
};

/* ---------------- NWS active alerts (public domain) ----------------
   config: { area: "TX" (state or marine zone), min_severity?: "Severe" | "Moderate" | "Extreme" } */
const SEVERITY_RANK: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

function centroid(geometry: Record<string, unknown> | null | undefined): { lat: number; lng: number } | undefined {
  if (!geometry) return undefined;
  const coords = geometry.coordinates as unknown;
  const ring = geometry.type === "Polygon" ? (coords as number[][][])[0] : geometry.type === "MultiPolygon" ? (coords as number[][][][])[0]?.[0] : undefined;
  if (!ring || ring.length === 0) return undefined;
  const n = ring.length;
  const lng = ring.reduce((a, p) => a + p[0], 0) / n, lat = ring.reduce((a, p) => a + p[1], 0) / n;
  return { lat, lng };
}

const zoneCentroidCache = new Map<string, { lat: number; lng: number } | null>();

/** Zone-based alerts carry no geometry; resolve the first affected zone's centroid (cached per process, capped per run). */
async function zoneCentroid(zoneUrls: string[], ctx: AdapterContext, budget: { left: number }): Promise<{ lat: number; lng: number } | undefined> {
  for (const url of zoneUrls.slice(0, 3)) {
    if (zoneCentroidCache.has(url)) { const c = zoneCentroidCache.get(url); if (c) return c; continue; }
    if (budget.left <= 0) return undefined;
    budget.left--;
    try {
      const z = await fetchJson<{ geometry: Record<string, unknown> | null }>(url, ctx, { Accept: "application/geo+json" });
      const c = centroid(z.geometry) ?? null;
      zoneCentroidCache.set(url, c);
      if (c) return c;
    } catch { zoneCentroidCache.set(url, null); }
  }
  return undefined;
}

export const nws: Adapter = async (source, ctx) => {
  const area = str(source.config.area);
  if (!area) throw new Error("config.area is required (e.g. TX)");
  const minSev = SEVERITY_RANK[str(source.config.min_severity, "Severe")] ?? 3;
  type F = { features: { properties: Record<string, unknown>; geometry: Record<string, unknown> | null }[] };
  const data = await fetchJson<F>(`https://api.weather.gov/alerts/active?area=${encodeURIComponent(area)}&status=actual&message_type=alert,update`, ctx, { Accept: "application/geo+json" });
  const items: Item[] = [];
  const zoneBudget = { left: 15 };
  for (const f of data.features ?? []) {
    const p = f.properties;
    if ((SEVERITY_RANK[str(p.severity)] ?? 0) < minSev) continue;
    const id = str(p.id); if (!id) continue;
    const c = centroid(f.geometry) ?? (await zoneCentroid((p.affectedZones as string[] | undefined) ?? [], ctx, zoneBudget));
    const expires = str(p.expires) || str(p.ends);
    items.push({
      uid: id,
      title: plainText(str(p.headline) || `${str(p.event)}: ${str(p.areaDesc)}`, 200),
      body: [
        `${str(p.event)} · ${str(p.severity)} · ${str(p.urgency)}. Areas: ${plainText(str(p.areaDesc), 200)}.`,
        plainText(str(p.description), 700),
        str(p.instruction) ? `Instruction: ${plainText(str(p.instruction), 300)}` : "",
        `Issued by ${str(p.senderName)}. Source: National Weather Service (public domain), relayed by Crier.`,
      ].filter(Boolean).join("\n"),
      url: `https://alerts.weather.gov/search?id=${encodeURIComponent(id)}`,
      kind: "announcement",
      starts_at: str(p.onset) || str(p.effective) || undefined,
      ends_at: str(p.ends) || undefined,
      expires_at: expires || undefined,
      location: { name: plainText(str(p.areaDesc), 120) || undefined, lat: c?.lat, lng: c?.lng },
      tags: [...source.tags, "weather", "alert", str(p.event).toLowerCase().replace(/[^a-z0-9]+/g, "-")].filter((t) => t.length >= 2 && t.length <= 40),
      metadata: { source: "nws", severity: p.severity, urgency: p.urgency, certainty: p.certainty, event: p.event },
    });
  }
  return items;
};

export const ADAPTERS: Record<SourceRow["adapter"], Adapter> = { ticketmaster, ical, rss, localist, nws };

export function describeAdapter(a: SourceRow["adapter"]): string {
  return {
    ticketmaster: "Ticketmaster Discovery API: concerts, sports, theatre near a point. Needs TICKETMASTER_API_KEY. config: {lat, lng, radius_km, city, segment?}",
    ical: "Any public iCalendar feed (LibCal, Google Calendar public ICS, venue calendars). config: {url, timezone?, location_name?, lat?, lng?}",
    rss: "Any RSS or Atom feed of notices. Items are announcements with a TTL. config: {url, ttl_days?, location_name?, lat?, lng?}",
    localist: "Localist-powered calendars (most university event sites). config: {base}",
    nws: "National Weather Service active alerts for a state, public domain. config: {area, min_severity?}",
  }[a];
}

export type { AdapterContext };
