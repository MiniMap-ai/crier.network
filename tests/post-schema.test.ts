import { test } from "node:test";
import assert from "node:assert/strict";
import { PostInputSchema, PostPatchSchema, mergeEdit } from "../lib/post-schema.ts";
import type { EditableFields } from "../lib/post-schema.ts";

const stored: EditableFields = {
  kind: "request", title: "Seeking a bassist", body: "Jazz night, Fri Oct 9.", url: "https://example.org/gig", tags: ["music", "jazz"],
  place_name: "Denver", lat: 39.74, lng: -104.99, starts_at: null, ends_at: null, timezone: null,
  source_url: null, syndicated: false, metadata: { ref: "a1" },
};

const editWith = (body: unknown) => mergeEdit(stored, PostPatchSchema.parse(body));

test("a create still defaults kind and tags", () => {
  const input = PostInputSchema.parse({ title: "x", body: "y" });
  assert.equal(input.kind, "announcement");
  assert.deepEqual(input.tags, []);
});

test("a patch carries only the fields that were sent", () => {
  assert.deepEqual(PostPatchSchema.parse({ title: "x" }), { title: "x" });
  assert.deepEqual(PostPatchSchema.parse({ expires_at: "2026-12-01T00:00:00Z" }), { expires_at: "2026-12-01T00:00:00Z" });
});

test("a patch ignores the create-only keys", () => {
  assert.deepEqual(PostPatchSchema.parse({ title: "x", idempotency_key: "k1", parent_id: "8Hq2mZk3" }), { title: "x" });
});

test("a patch with only a title keeps the stored kind, tags and the rest", () => {
  const { merged } = editWith({ title: "x" });
  assert.deepEqual(merged, { ...stored, title: "x" });
});

test("a patch that sends kind or empty tags changes them", () => {
  assert.equal(editWith({ kind: "offer" }).merged.kind, "offer");
  assert.deepEqual(editWith({ tags: [] }).merged.tags, []);
});

test("a patch to dates, link, metadata or coordinates does not count as a text change", () => {
  assert.equal(editWith({ starts_at: "2026-10-09T19:00:00-06:00", ends_at: "2026-10-09T23:00:00-06:00" }).textChanged, false);
  assert.equal(editWith({ expires_at: "2026-10-10T00:00:00Z" }).textChanged, false);
  assert.equal(editWith({ url: "https://example.org/other", metadata: { ref: "b2" }, syndicated: true }).textChanged, false);
  assert.equal(editWith({ location: { name: "Denver", lat: 39.75, lng: -105 } }).textChanged, false);
});

test("a patch that resends the stored text does not count as a text change", () => {
  assert.equal(editWith({ title: stored.title, body: stored.body, kind: stored.kind, tags: ["music", "jazz"] }).textChanged, false);
});

test("a change to kind, title, body, tags or place name is a text change", () => {
  for (const body of [{ kind: "offer" }, { title: "Bassist found" }, { body: "Filled." }, { tags: ["music"] }, { tags: [] }, { location: { name: "Boulder" } }]) {
    assert.equal(editWith(body).textChanged, true, JSON.stringify(body));
  }
});
