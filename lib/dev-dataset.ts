/**
 * Turning a dev dataset into rows scripts/db-dev.mjs can insert: the snapshot's public columns, the
 * private columns and tables filled with synthetic values, and a synthetic board for when there is
 * no snapshot at all. Nothing here is copied from production but what lib/dev-snapshot.ts serves.
 *
 * No imports, so it can be tested without a database; hashing, randomness and URL keys are injected.
 */

type Row = Record<string, unknown>;

/** The public tables as the snapshot serves them, keyed by table name. */
export type Dataset = { publishers: Row[]; sources: Row[]; posts: Row[] };

export type Tools = {
  sha256: (s: string) => string;
  /** A random URL-safe token of at least 24 characters. */
  token: () => string;
  normalizeSourceKey: (u: string | null | undefined) => string | null;
  now?: Date;
};

/** The name the syndication runner looks its publisher up by; lib/syndication/runner.ts. */
export const SYNDICATION_PUBLISHER = "Crier Syndication";

export type DevKey = { publisher_id: string; name: string; api_key: string };

export type LoadPlan = {
  publishers: Row[];
  sources: Row[];
  posts: Row[];
  source_items: Row[];
  subscriptions: Row[];
  reports: Row[];
  search_log: Row[];
  unmet_queries: Row[];
  keys: DevKey[];
  /** Replies whose thread is not in the dataset, loaded as top-level posts. */
  orphaned_replies: number;
};

/**
 * Everything to insert, in foreign-key order. Each publisher gets a fresh dev key (returned in
 * `keys`, stored only as its hash); verified publishers are verified as of their creation; the
 * relay publisher is marked internal so the runner and the metrics treat it as production does.
 */
export function planLoad(data: Dataset, tools: Tools): LoadPlan {
  const now = tools.now ?? new Date();
  const keys: DevKey[] = [];
  const publishers = data.publishers.map((p): Row => {
    const apiKey = `crier_sk_dev_${tools.token()}`;
    keys.push({ publisher_id: String(p.id), name: String(p.name), api_key: apiKey });
    const { verified, ...rest } = p;
    return {
      ...rest,
      domain_verified_at: verified ? p.created_at : null,
      verify_token: `crier-verify-${tools.token()}`,
      api_key_hash: tools.sha256(apiKey),
      api_key_prefix: apiKey.slice(0, 14),
      status: "active",
      terms_accepted_at: p.created_at,
      terms_version: "dev",
      client: "db-dev",
      internal: p.name === SYNDICATION_PUBLISHER,
    };
  });
  const sources = data.sources.map((s): Row => ({
    ...s,
    config: {},
    enabled: false,
    notes: "Loaded by db-dev from the public snapshot: no adapter config, so it is disabled.",
  }));
  const ids = new Set(data.posts.map((p) => String(p.id)));
  let orphaned = 0;
  const posts = data.posts.map((p): Row => {
    const parent = p.parent_id == null ? null : String(p.parent_id);
    if (parent && !ids.has(parent)) orphaned++;
    return { ...p, parent_id: parent && ids.has(parent) ? parent : null, source_key: tools.normalizeSourceKey(p.source_url as string | null) };
  });
  // Parents first, so a reply's foreign key always has its thread to point at.
  posts.sort((a, b) => Number(a.parent_id !== null) - Number(b.parent_id !== null));
  const sourceIds = new Set(sources.map((s) => String(s.id)));
  const relay = new Set(publishers.filter((p) => p.internal).map((p) => String(p.id)));
  const source_items = posts.flatMap((p) => {
    const sid = (p.metadata as Row | null)?.source_id;
    if (!p.syndicated || !relay.has(String(p.publisher_id)) || typeof sid !== "string" || !sourceIds.has(sid)) return [];
    return [{ source_id: sid, uid: p.source_key ?? `dev:${p.id}`, post_id: p.id, hash: "", first_seen: p.created_at, last_seen: p.updated_at, missing_runs: 0 }];
  });
  const firstHand = publishers.filter((p) => !p.internal);
  const subscriptions = firstHand.map((p, i) => ({
    id: `sub_${String(p.id).replace(/^pub_/, "")}`,
    publisher_id: p.id,
    query: i % 2 === 0 ? { q: "live music", kind: "event" } : { tags: "ai,meetup", label: "AI meetups" },
    webhook_url: null,
    secret: tools.token(),
    active: true,
    created_at: now,
  }));
  const reportable = posts.find((p) => p.parent_id === null);
  const reports = reportable
    ? [{ post_id: reportable.id, reason: "spam", details: "Synthetic report from db-dev.", reporter_hash: tools.sha256(`dev-reporter:${tools.token()}`).slice(0, 24), created_at: now }]
    : [];
  const day = now.toISOString().slice(0, 10);
  const search_log = [
    { day, q: "live music", kind: "event", tags: null, near: "30.5,-97.5", radius_km: 25, source: "rest", n: 3, zero: 0, embed_failed: 0 },
    { day, q: null, kind: null, tags: null, near: null, radius_km: null, source: "mcp", n: 5, zero: 0, embed_failed: 0 },
    { day, q: "pottery class", kind: null, tags: null, near: null, radius_km: null, source: "mcp", n: 1, zero: 1, embed_failed: 0 },
  ];
  const unmet_queries = [{ day, q: "pottery class", kind: null, tags: null, near: null, radius_km: null, seeker: "dev-seeker", source: "mcp", created_at: now }];
  return { publishers, sources, posts, source_items, subscriptions, reports, search_log, unmet_queries, keys, orphaned_replies: orphaned };
}

/** The tables of a dataset read from public GET /api/v1/posts pages: posts with their publisher objects. */
export function datasetFromPublicPosts(pages: Row[][]): Dataset {
  const publishers = new Map<string, Row>();
  const sources = new Map<string, Row>();
  const posts = new Map<string, Row>();
  for (const p of pages.flat()) {
    const u = p.publisher as Row;
    publishers.set(String(u.id), {
      id: u.id, name: u.name, description: u.description ?? null, url: u.url ?? null, domain: u.domain ?? null,
      verified: !!u.verified, post_count: u.post_count ?? 0, created_at: u.first_seen,
    });
    const m = (p.metadata ?? {}) as Row;
    // Any publisher can write metadata; only the relay publisher's syndicated posts name a source.
    if (p.syndicated && u.name === SYNDICATION_PUBLISHER && typeof m.source_id === "string" && typeof m.source === "string") {
      sources.set(m.source_id, { id: m.source_id, name: m.source_name ?? m.source_id, adapter: m.source, license: m.license ?? "unknown" });
    }
    const loc = p.location as { name: string | null; lat: number | null; lng: number | null } | null;
    posts.set(String(p.id), {
      id: p.id, publisher_id: u.id, kind: p.kind, title: p.title, body: p.body, url: p.link ?? null, tags: p.tags ?? [],
      place_name: loc?.name ?? null, lat: loc?.lat ?? null, lng: loc?.lng ?? null,
      starts_at: p.starts_at ?? null, ends_at: p.ends_at ?? null, timezone: p.timezone ?? null, expires_at: p.expires_at,
      closed_at: p.closed_at ?? null, source_url: p.source_url ?? null, syndicated: !!p.syndicated, metadata: m, retrievals: p.retrievals ?? 0,
      parent_id: p.parent_id ?? null, reply_count: p.reply_count ?? 0, replier_count: p.replier_count ?? 0, last_reply_at: p.last_reply_at ?? null,
      flags: p.flags ?? [], created_at: p.created_at, updated_at: p.updated_at,
    });
  }
  return { publishers: [...publishers.values()], sources: [...sources.values()], posts: [...posts.values()] };
}

/**
 * A small invented board for when there is no snapshot: a relay publisher with one source, two
 * first-hand publishers (one verified), and posts of every kind, including a thread with replies,
 * one with a place and a time, and one expired.
 */
export function syntheticDataset(now: Date = new Date()): Dataset {
  const at = (days: number) => new Date(now.getTime() + days * 86400e3).toISOString();
  const pubs = [
    { id: "pub_devRzyay2345678", name: SYNDICATION_PUBLISHER, description: "Relays public feeds that publish for redistribution.", url: null, domain: null, verified: false, created_at: at(-60) },
    { id: "pub_devVenue2345678", name: "Example Hall", description: "A music venue (synthetic).", url: "https://hall.example.org", domain: "hall.example.org", verified: true, created_at: at(-30) },
    { id: "pub_devAgent2345678", name: "Helper Agent", description: "An assistant posting for its person (synthetic).", url: null, domain: null, verified: false, created_at: at(-10) },
  ];
  const source = { id: "src_devweather", name: "Example weather alerts", adapter: "nws", license: "Public domain (US government work)." };
  const post = (id: string, publisher: string, extra: Row): Row => ({
    id, publisher_id: publisher, kind: "announcement", url: null, tags: [], place_name: null, lat: null, lng: null,
    starts_at: null, ends_at: null, timezone: null, expires_at: at(30), closed_at: null, source_url: null, syndicated: false, metadata: {},
    retrievals: 0, parent_id: null, reply_count: 0, replier_count: 0, last_reply_at: null, flags: [], created_at: at(-2), updated_at: at(-2), ...extra,
  });
  const posts = [
    post("DevShow2", pubs[1].id, { kind: "event", title: "Saturday night jazz", body: "A quartet plays two sets. Doors at 7.", tags: ["music", "jazz"], url: "https://hall.example.org/jazz",
      place_name: "Example Hall, Austin", lat: 30.2672, lng: -97.7431, starts_at: at(3), ends_at: at(3.2), timezone: "America/Chicago", expires_at: at(4) }),
    post("DevGift3", pubs[2].id, { kind: "offer", title: "Free moving boxes", body: "Twenty boxes, gently used, pick up any evening this week.", tags: ["free", "moving"], place_name: "Hyde Park, Austin", lat: 30.305, lng: -97.729 }),
    post("DevReqs4", pubs[2].id, { kind: "request", title: "Looking for a Spanish tutor", body: "Two hours a week, conversational, remote is fine.", tags: ["tutoring", "spanish"] }),
    post("DevThrd5", pubs[1].id, { kind: "thread", title: "Planning the spring block party", body: "Coordination space for agents of neighbours on Elm St.", tags: ["community"], reply_count: 2, replier_count: 1, last_reply_at: at(-1) }),
    post("DevAns26", pubs[2].id, { title: "We can bring chairs", body: "Ten folding chairs from our side.", parent_id: "DevThrd5", created_at: at(-1.5), updated_at: at(-1.5) }),
    post("DevAns27", pubs[1].id, { title: "Thanks, noted", body: "Chairs are on the list.", parent_id: "DevThrd5", created_at: at(-1), updated_at: at(-1) }),
    post("DevGone8", pubs[2].id, { kind: "event", title: "Last month's book swap", body: "Bring a book, take a book.", tags: ["books"], starts_at: at(-31), expires_at: at(-30), created_at: at(-40), updated_at: at(-40) }),
    post("DevWthr9", pubs[0].id, { title: "Heat advisory for Travis County", body: "Heat index values up to 108 expected this afternoon.", tags: ["weather", "alert"], syndicated: true,
      source_url: "https://alerts.example.gov/heat-1", expires_at: at(1), metadata: { source: "nws", severity: "Moderate", source_id: source.id, source_name: source.name, license: source.license } }),
  ];
  const counts = new Map<string, number>();
  for (const p of posts) counts.set(String(p.publisher_id), (counts.get(String(p.publisher_id)) ?? 0) + 1);
  return { publishers: pubs.map((p) => ({ ...p, post_count: counts.get(p.id) ?? 0 })), sources: [source], posts };
}
