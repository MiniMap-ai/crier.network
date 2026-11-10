import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SYNDICATION_PUBLISHER, datasetFromPublicPosts, planLoad, syntheticDataset } from "../lib/dev-dataset.ts";
import { SNAPSHOT_TABLES } from "../lib/dev-snapshot.ts";
import { normalizeSourceKey } from "../lib/source-key.ts";

// lib/ids.ts ALPHABET, eight characters.
const POST_ID_RE = /^[2-9A-HJ-NP-Za-km-z]{8}$/;
let n = 0;
const tools = { sha256: (s: string) => createHash("sha256").update(s).digest("hex"), token: () => `tok${String(++n).padStart(22, "0")}`, normalizeSourceKey, now: new Date("2026-11-10T12:00:00Z") };
const columns = (name: string) => SNAPSHOT_TABLES.find((t) => t.name === name)!.columns.map((c) => c.name);

test("the synthetic board has exactly the snapshot's columns, so fixtures and snapshots load the same way", () => {
  const d = syntheticDataset(tools.now);
  for (const t of ["publishers", "sources", "posts"] as const) {
    for (const r of d[t]) assert.deepEqual(Object.keys(r).sort(), columns(t).sort(), `${t} ${r.id}`);
  }
});

test("synthetic post ids are real post ids, so the routes and pages serve them", () => {
  for (const p of syntheticDataset(tools.now).posts) assert.match(String(p.id), POST_ID_RE);
});

test("every publisher gets its own dev key, stored only as its hash", () => {
  const plan = planLoad(syntheticDataset(tools.now), tools);
  assert.equal(plan.keys.length, plan.publishers.length);
  assert.equal(new Set(plan.keys.map((k) => k.api_key)).size, plan.keys.length);
  for (const k of plan.keys) {
    const p = plan.publishers.find((x) => x.id === k.publisher_id)!;
    assert.match(k.api_key, /^crier_sk_dev_/);
    assert.equal(p.api_key_hash, tools.sha256(k.api_key));
    assert.equal(p.api_key_prefix, k.api_key.slice(0, 14));
    assert.ok(!JSON.stringify(p).includes(k.api_key), "the raw key is not in the row");
  }
});

test("verified becomes a verification time, and the relay publisher is internal", () => {
  const plan = planLoad(syntheticDataset(tools.now), tools);
  const venue = plan.publishers.find((p) => p.name === "Example Hall")!;
  assert.equal(venue.domain_verified_at, venue.created_at);
  assert.ok(!("verified" in venue));
  assert.equal(plan.publishers.find((p) => p.name === SYNDICATION_PUBLISHER)!.internal, true);
  assert.equal(plan.publishers.filter((p) => p.internal).length, 1);
});

test("replies load after their threads, and a reply whose thread is not in the dataset loads top-level", () => {
  const d = syntheticDataset(tools.now);
  d.posts.reverse();
  d.posts.push({ ...d.posts[0], id: "Orphan22", parent_id: "Missing2" });
  const plan = planLoad(d, tools);
  const seen = new Set<unknown>();
  for (const p of plan.posts) {
    if (p.parent_id) assert.ok(seen.has(p.parent_id), `${p.id} before its thread`);
    seen.add(p.id);
  }
  assert.equal(plan.posts.find((p) => p.id === "Orphan22")!.parent_id, null);
  assert.equal(plan.orphaned_replies, 1);
});

test("source_key is derived from source_url, and each relayed post gets its source_items row", () => {
  const plan = planLoad(syntheticDataset(tools.now), tools);
  const relayed = plan.posts.find((p) => p.syndicated)!;
  assert.equal(relayed.source_key, "alerts.example.gov/heat-1");
  assert.deepEqual(plan.source_items.map((r) => [r.source_id, r.uid, r.post_id]), [["src_devweather", "alerts.example.gov/heat-1", relayed.id]]);
  assert.ok(plan.sources.every((s) => s.enabled === false), "no adapter config, so no source runs");
});

test("the private tables get synthetic rows: a polling subscription per first-hand publisher, a report, search demand", () => {
  const plan = planLoad(syntheticDataset(tools.now), tools);
  assert.equal(plan.subscriptions.length, plan.publishers.filter((p) => !p.internal).length);
  for (const s of plan.subscriptions) { assert.equal(s.webhook_url, null); assert.ok(String(s.secret).length >= 24); }
  assert.equal(plan.reports.length, 1);
  assert.ok(plan.search_log.some((r) => r.zero === 1));
  assert.equal(plan.unmet_queries.length, 1);
});

test("a dataset read from public posts has the snapshot's columns and its publishers and sources", () => {
  const pub = { id: "pub_x", name: SYNDICATION_PUBLISHER, description: null, url: null, domain: null, verified: true, first_seen: "2026-10-01T00:00:00.000Z", post_count: 1, crier_url: "u" };
  const post = {
    id: "AbCd2345", url: "https://crier.network/p/AbCd2345", kind: "event", title: "T", body: "B", link: "https://e.org", tags: ["a"],
    location: { name: "Here", lat: 1, lng: 2 }, starts_at: null, ends_at: null, timezone: null, expires_at: "2026-12-01T00:00:00.000Z",
    source_url: "https://e.org/x", syndicated: true, metadata: { source: "rss", source_id: "src_1", source_name: "Feed", license: "CC BY" },
    retrievals: 4, parent_id: null, thread_url: null, reply_count: 0, last_reply_at: null, flags: [], created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z", publisher: pub,
  };
  const d = datasetFromPublicPosts([[post], [post]]);
  assert.equal(d.posts.length, 1);
  assert.deepEqual(Object.keys(d.posts[0]).sort(), columns("posts").sort());
  assert.deepEqual(Object.keys(d.publishers[0]).sort(), columns("publishers").sort());
  assert.deepEqual(d.sources, [{ id: "src_1", name: "Feed", adapter: "rss", license: "CC BY" }]);
  assert.equal(d.posts[0].url, "https://e.org", "the outbound link, not the Crier URL");
  assert.equal(d.publishers[0].created_at, pub.first_seen);
});

test("a first-hand post that writes a source_id into its metadata names no source and gets no source_items row", () => {
  const d = syntheticDataset(tools.now);
  const forged = { ...d.posts.find((p) => p.id === "DevGift3")!, syndicated: true, metadata: { source: "rss", source_id: "src_devweather", source_name: "x", license: "y" } };
  d.posts = d.posts.map((p) => (p.id === "DevGift3" ? forged : p));
  assert.deepEqual(planLoad(d, tools).source_items.map((r) => r.post_id), ["DevWthr9"]);
  const pub = { id: "pub_y", name: "Someone", verified: false, first_seen: "2026-10-01T00:00:00.000Z", post_count: 1 };
  assert.deepEqual(datasetFromPublicPosts([[{ ...forged, link: null, location: null, publisher: pub }]]).sources, []);
});
