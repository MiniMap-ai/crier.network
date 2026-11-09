import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  RECOVERY_TTL_S, checkRecoverySecret, claimDomain, claimedDomain, domainHolder, domainOf, domainTakenRefusal, holdsDomain,
  newRecoverySecret, recoveryChallenge, recoveryPlan, recoverySteps,
} from "../lib/publisher-claim.ts";
import type { DomainClaimant, RecoveryTarget } from "../lib/publisher-claim.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SITE = "https://crier.network";
const NOW = 1_790_000_000;
const SECRET = newRecoverySecret(NOW, "A".repeat(32));

// A row registered with a bare-origin url unless `url` says otherwise; domain follows the url.
const row = (id: string, url: string | null, extra: Partial<DomainClaimant> = {}): DomainClaimant =>
  ({ id, url, domain: domainOf(url), status: "active", domain_verified_at: null, created_at: new Date("2026-09-18T19:39:30Z"), ...extra });

// An in-memory publishers table driven the way registerPublisher drives the real one.
function table(rows: DomainClaimant[] = []) {
  let n = 0;
  return {
    rows,
    register: (url: string | null) => claimDomain(claimedDomain(url), {
      holders: async (d) => rows.filter((r) => r.domain === d),
      write: async () => { const r = row(`pub_new${++n}`, url, { created_at: new Date() }); rows.push(r); return r; },
    }),
  };
}

test("the first registration for a domain writes a publisher", async () => {
  const t = table();
  const claim = await t.register("https://tantive.space");
  assert.ok("written" in claim);
  assert.equal(t.rows.length, 1);
});

test("a second registration for a domain with an active publisher is refused, names it, and writes nothing", async () => {
  const t = table();
  await t.register("https://tantive.space");
  const claim = await t.register("https://www.tantive.space/");
  assert.ok("holder" in claim);
  assert.equal(claim.holder.id, "pub_new1");
  assert.equal(t.rows.length, 1);
});

test("a domain whose publishers are all suspended or deleted can register again", async () => {
  const t = table([row("pub_s", "https://tantive.space", { status: "suspended" }), row("pub_d", "https://tantive.space", { status: "deleted" })]);
  const claim = await t.register("https://tantive.space");
  assert.ok("written" in claim);
  assert.equal(t.rows.length, 3);
});

test("registrations without a url are never refused", async () => {
  const t = table();
  await t.register(null);
  assert.ok("written" in (await t.register(null)));
  assert.equal(t.rows.length, 2);
});

test("two pages on a shared host both register: a url with a path claims nothing", async () => {
  const t = table();
  assert.ok("written" in (await t.register("https://github.com/alice/bot")));
  assert.ok("written" in (await t.register("https://github.com/bob/agent")));
  assert.equal(t.rows.length, 2);
});

test("a path-url registration does not block a later bare-domain claim", async () => {
  const t = table();
  await t.register("https://github.com/alice/bot");
  assert.ok("written" in (await t.register("https://github.com")));
});

test("a bare-domain holder does not block a later path-url registration", async () => {
  const t = table();
  await t.register("https://github.com/");
  assert.ok("written" in (await t.register("https://github.com/bob/agent")));
  assert.equal(t.rows.length, 2);
});

test("only an empty path or / claims; a trailing dot or www. claims the same domain", () => {
  assert.equal(claimedDomain("https://example.com"), "example.com");
  assert.equal(claimedDomain("https://example.com/"), "example.com");
  assert.equal(claimedDomain("https://example.com./"), "example.com");
  assert.equal(claimedDomain("https://WWW.Example.com"), "example.com");
  assert.equal(claimedDomain("https://example.com/about"), null);
  assert.equal(claimedDomain("not a url"), null);
  assert.equal(domainOf("https://example.com./about"), "example.com");
});

test("only an active publisher whose url is a bare origin holds its domain", () => {
  assert.equal(holdsDomain(row("a", "https://x.org")), true);
  assert.equal(holdsDomain(row("a", "https://x.org", { status: "suspended" })), false);
  assert.equal(holdsDomain(row("a", "https://x.org/me")), false);
  assert.equal(holdsDomain(row("a", null)), false);
});

test("a verified publisher is named over an older unverified one", () => {
  const older = row("pub_a", "https://x.org", { created_at: new Date("2026-01-01T00:00:00Z") });
  const verified = row("pub_b", "https://x.org", { created_at: new Date("2026-06-01T00:00:00Z"), domain_verified_at: new Date("2026-06-02T00:00:00Z") });
  assert.equal(domainHolder([older, verified], "x.org")?.id, "pub_b");
});

test("among unverified publishers sharing a domain, the first registered is named, whatever the row order", () => {
  // The four tantive.space rows of CRI-46, newest first as the read returned them.
  const rows = [
    row("pub_d5Eew3azo9ZqEg", "https://tantive.space", { created_at: new Date("2026-09-19T21:08:58Z") }),
    row("pub_m55E7DB7Z5RPut", "https://tantive.space", { created_at: new Date("2026-09-19T11:02:17Z") }),
    row("pub_rmPpfmZPqZtNEP", "https://tantive.space", { created_at: new Date("2026-09-19T08:33:57Z") }),
    row("pub_vgezN7RRBhNfHB", "https://tantive.space", { created_at: new Date("2026-09-18T19:39:30Z") }),
  ];
  assert.equal(domainHolder(rows, "tantive.space")?.id, "pub_vgezN7RRBhNfHB");
  assert.equal(domainHolder([...rows].reverse(), "tantive.space")?.id, "pub_vgezN7RRBhNfHB");
});

test("publishers registered at the same instant are ordered by id", () => {
  assert.equal(domainHolder([row("pub_b", "https://x.org"), row("pub_a", "https://x.org")], "x.org")?.id, "pub_a");
});

test("a publisher moving onto its own domain does not refuse itself", async () => {
  const self = row("pub_me", "https://x.org");
  const claim = await claimDomain("x.org", { holders: async () => [self], write: async () => "moved" }, "pub_me");
  assert.deepEqual(claim, { written: "moved" });
});

test("a recovery secret is accepted until its TTL and refused after", () => {
  assert.deepEqual(checkRecoverySecret(SECRET, NOW + RECOVERY_TTL_S), { ok: true, issuedAt: NOW });
  assert.deepEqual(checkRecoverySecret(SECRET, NOW + RECOVERY_TTL_S + 1), { ok: false, reason: "expired" });
});

test("a secret that is not Crier's shape, or is dated in the future, is malformed", () => {
  assert.equal(checkRecoverySecret("crier_sk_abc", NOW).ok, false);
  assert.equal(checkRecoverySecret(`crier_rs_${NOW}_short`, NOW).ok, false);
  assert.deepEqual(checkRecoverySecret(newRecoverySecret(NOW + 3600, "A".repeat(32)), NOW), { ok: false, reason: "malformed" });
});

const target = (extra: Partial<RecoveryTarget> = {}): RecoveryTarget =>
  ({ id: "pub_a", domain: "x.org", domain_verified_at: null, api_key_hash: "hash-1", ...extra });

test("the challenge is bound to the publisher, the domain and the secret, and does not reveal the secret", () => {
  const c = recoveryChallenge(target(), SECRET, sha);
  assert.match(c, /^crier-recover-[0-9a-f]{40}$/);
  assert.notEqual(c, recoveryChallenge(target({ id: "pub_b" }), SECRET, sha));
  assert.notEqual(c, recoveryChallenge(target({ domain: "y.org" }), SECRET, sha));
  assert.notEqual(c, recoveryChallenge(target(), newRecoverySecret(NOW, "B".repeat(32)), sha));
  assert.ok(!c.includes("A".repeat(16)));
});

test("a redeemed secret does not match a second time: the recovery verified the publisher and replaced its key", () => {
  const published = recoveryChallenge(target(), SECRET, sha);
  const afterRecovery = target({ domain_verified_at: new Date(), api_key_hash: "hash-2" });
  assert.notEqual(recoveryChallenge(afterRecovery, SECRET, sha), published);
});

test("on a verified publisher any key change voids a pending challenge", () => {
  const verified = target({ domain_verified_at: new Date() });
  assert.notEqual(recoveryChallenge(verified, SECRET, sha), recoveryChallenge({ ...verified, api_key_hash: "hash-2" }, SECRET, sha));
});

test("whoever holds an unverified publisher's key cannot void the owner's pending challenge by rotating it", () => {
  assert.equal(recoveryChallenge(target(), SECRET, sha), recoveryChallenge(target({ api_key_hash: "hash-2" }), SECRET, sha));
});

test("the refusal is a 409 whose hint and plan name the exact calls that recover the key", () => {
  const holder = { ...row("pub_vgezN7RRBhNfHB", "https://tantive.space"), domain: "tantive.space" };
  const plan = recoveryPlan({ ...holder, api_key_hash: "hash-1" }, SECRET, NOW, SITE, sha);
  const r = domainTakenRefusal(holder, plan, "register");
  assert.equal(r.status, 409);
  assert.equal(r.code, "publisher_exists");
  assert.match(r.message, /pub_vgezN7RRBhNfHB/);
  assert.match(r.message, /no new key was issued/);
  assert.deepEqual(plan.then, { method: "POST", url: `${SITE}/api/v1/publishers/verify`, headers: { "Content-Type": "application/json" }, body: { publisher_id: holder.id, recovery_secret: SECRET } });
  assert.deepEqual(plan.methods.map((m) => m.method), ["dns", "well-known"]);
  assert.equal(plan.expires_at, new Date((NOW + RECOVERY_TTL_S) * 1000).toISOString());
  for (const needle of [plan.challenge, "_crier.tantive.space", "https://tantive.space/.well-known/crier.txt", plan.then.url, SECRET, "a url that has a path"]) {
    assert.ok(r.hint.includes(needle), needle);
  }
  assert.equal(recoverySteps(plan), r.hint.slice(r.hint.indexOf("1. Publish"), r.hint.indexOf(" If tantive.space is not yours")));
});

test("the refusal says whether the holder is verified, and what a refused move left alone", () => {
  const verified = { ...row("pub_v", "https://x.org", { domain_verified_at: new Date() }), domain: "x.org" };
  const plan = recoveryPlan({ ...verified, api_key_hash: "hash-1" }, SECRET, NOW, SITE, sha);
  const r = domainTakenRefusal(verified, plan, "move");
  assert.match(r.message, /a verified publisher/);
  assert.match(r.message, /url was not changed/);
});
