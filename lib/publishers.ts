import { z } from "zod";
import { Resolver } from "node:dns/promises";
import { DB_SIDE_TIMEOUT_MS, budget, sql, withTimeout } from "./db";
import type { Budget } from "./db";
import type { TransactionSql } from "postgres";
import { env } from "./env";
import { HttpError, bearer } from "./http";
import { newApiKey, newPublisherId, newSecret, newVerifyToken, sha256 } from "./ids";
import { assertSafeOutboundUrl } from "./safety";
import { track } from "./metrics";
import { checkRecoverySecret, claimDomain, domainTakenRefusal, holdsDomain, newRecoverySecret, recoveryPlan } from "./publisher-claim";
import type { RecoveryPlan } from "./publisher-claim";

export type PublisherRow = {
  id: string;
  name: string;
  description: string | null;
  url: string | null;
  domain: string | null;
  domain_verified_at: Date | null;
  verify_token: string;
  api_key_hash: string;
  api_key_prefix: string;
  status: "active" | "suspended" | "deleted";
  post_count: number;
  created_at: Date;
  last_seen_at: Date | null;
  terms_accepted_at: Date | null;
  terms_version: string | null;
  suspended_reason: string | null;
  deleted_at: Date | null;
  client: string | null;
  user_agent: string | null;
  internal: boolean;
};

export type PublicPublisher = {
  id: string;
  name: string;
  description: string | null;
  url: string | null;
  domain: string | null;
  verified: boolean;
  first_seen: string;
  post_count: number;
  crier_url: string;
};

export function publicPublisher(p: PublisherRow): PublicPublisher {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    url: p.url,
    domain: p.domain,
    verified: !!p.domain_verified_at,
    first_seen: p.created_at.toISOString(),
    post_count: p.post_count,
    crier_url: `${env.SITE_URL}/publishers/${p.id}`,
  };
}

export const TERMS_VERSION = "2026-09-07";

export const RegisterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  url: z.url().max(500).optional(),
  accept_terms: z.boolean().optional(),
  client: z.string().trim().max(60).optional(),   // what software is registering, e.g. "claude-code", "cursor", "my-agent/1.2"
});

/** Registration requires explicit acceptance of the terms by whoever operates the agent. */
export function assertTermsAccepted(input: { accept_terms?: boolean }) {
  if (input.accept_terms !== true) {
    throw new HttpError(400, "terms_not_accepted", "Registration requires accepting the terms of service and acceptable-use policy.",
      `Read ${env.SITE_URL}/terms (it is short), confirm with the person or organization you act for if you need to, then send accept_terms: true. By accepting, the operator of this agent takes responsibility for what it posts.`);
  }
}

export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.replace(/^www\./, "");
  } catch { return null; }
}

type HeldRow = PublisherRow & { domain: string };

/** Holds claims on one domain until the transaction ends, so the holder check and the write cannot interleave. */
async function lockDomain(tx: TransactionSql, domain: string | null) {
  if (domain) await tx`select pg_advisory_xact_lock(hashtext(${"publisher-domain:" + domain}))`;
}

const rowsOnDomain = (tx: TransactionSql) => (domain: string) => tx<PublisherRow[]>`select * from publishers where domain = ${domain} and status = 'active'`;

/** A recovery secret issued now for `holder`, with the challenge that redeems it. */
export function issueRecovery(holder: HeldRow): RecoveryPlan {
  const now = Math.floor(Date.now() / 1000);
  return recoveryPlan(holder.id, holder.domain, newRecoverySecret(now, newSecret()), now, env.SITE_URL, sha256);
}

function domainTaken(holder: HeldRow, attempt: "register" | "move"): HttpError {
  const recover = issueRecovery(holder);
  const r = domainTakenRefusal(holder, recover, attempt);
  const e = new HttpError(r.status, r.code, r.message, r.hint);
  e.detail = { publisher: publicPublisher(holder), recover };
  track.counter(`publisher:domain_taken:${attempt}`);
  return e;
}

/**
 * Insert a publisher and return it with its key, which is shown only here. When an active publisher
 * already holds the url's domain, throws 409 publisher_exists carrying that publisher and the steps to
 * recover its key (docs/scenarios.md, scenario 15), and writes nothing.
 */
export async function registerPublisher(input: z.infer<typeof RegisterSchema>, ctx: { userAgent?: string | null; ip?: string } = {}) {
  const id = newPublisherId();
  const apiKey = newApiKey();
  const verify_token = newVerifyToken();
  const domain = domainOf(input.url);
  const claim = await withTimeout(sql().begin(async (tx) => {
    await lockDomain(tx, domain);
    return claimDomain(domain, {
      holders: rowsOnDomain(tx),
      write: async () => {
        const [row] = await tx<PublisherRow[]>`
          insert into publishers (id, name, description, url, domain, verify_token, api_key_hash, api_key_prefix, terms_accepted_at, terms_version, client, user_agent)
          values (${id}, ${input.name}, ${input.description ?? null}, ${input.url ?? null}, ${domain}, ${verify_token}, ${sha256(apiKey)}, ${apiKey.slice(0, 14)}, now(), ${TERMS_VERSION},
                  ${input.client ?? null}, ${ctx.userAgent ? ctx.userAgent.slice(0, 200) : null})
          returning *`;
        await tx`select bump_stat('registrations')`;
        return row;
      },
    });
  }), { label: "registerPublisher" });
  if ("holder" in claim) throw domainTaken(claim.holder as HeldRow, "register");
  track.counter(`register:client:${(input.client ?? "(not declared)").slice(0, 60)}`);
  if (ctx.ip) track.actor("registrant", ctx.ip);
  return { row: claim.written, apiKey };
}

/**
 * Point `p` at `url`, which clears its verification. Throws the same 409 as registration when another
 * active publisher holds the new domain.
 */
export async function moveToUrl(p: PublisherRow, url: string, at: Budget = budget()): Promise<PublisherRow> {
  const domain = domainOf(url);
  const claim = await withTimeout(sql().begin(async (tx) => {
    await lockDomain(tx, domain);
    return claimDomain(domain, {
      holders: rowsOnDomain(tx),
      write: async () => {
        const [row] = await tx<PublisherRow[]>`update publishers set url = ${url}, domain = ${domain}, domain_verified_at = null where id = ${p.id} returning *`;
        return row;
      },
    }, p.id);
  }), at("moveToUrl"));
  if ("holder" in claim) throw domainTaken(claim.holder as HeldRow, "move");
  return claim.written;
}

export const RecoverSchema = z.object({
  publisher_id: z.string().trim().min(1).max(40),
  recovery_secret: z.string().trim().max(120).optional(),
});

export type Recovery =
  | { recovered: true; row: PublisherRow; apiKey: string; method: "dns" | "well-known" }
  | { recovered: false; checked: boolean; row: PublisherRow; recover: RecoveryPlan };

/**
 * A new key for a publisher, for whoever controls its domain, without the old key. With no secret,
 * issues one. With a live secret whose challenge is published on the domain, replaces the key (the
 * old one stops working at once) and marks the domain verified. The caller rate-limits.
 */
export async function recoverPublisher(input: z.infer<typeof RecoverSchema>, at: Budget = budget()): Promise<Recovery> {
  const row = await getPublisher(input.publisher_id, at);
  if (!row || !holdsDomain(row)) {
    throw new HttpError(404, "not_found", "No active publisher with that id has a domain to recover.",
      "Recovery takes the publisher_id a 409 publisher_exists named. A publisher registered without a url has no domain to prove; register again.");
  }
  const held = row as HeldRow;
  if (!input.recovery_secret) return { recovered: false, checked: false, row, recover: issueRecovery(held) };
  const check = checkRecoverySecret(input.recovery_secret, Math.floor(Date.now() / 1000));
  if (!check.ok) {
    const again = `POST ${env.SITE_URL}/api/v1/publishers/verify with only {"publisher_id": "${row.id}"} for a new secret and challenge, publish the new challenge, then redeem it.`;
    if (check.reason === "expired") throw new HttpError(400, "recovery_secret_expired", "That recovery_secret has expired.", again);
    throw new HttpError(400, "invalid_recovery_secret", "That is not a recovery_secret Crier issued.", again);
  }
  const recover = recoveryPlan(row.id, held.domain, input.recovery_secret, check.issuedAt, env.SITE_URL, sha256);
  const method = await checkDomainToken(held.domain, recover.challenge);
  if (!method) return { recovered: false, checked: true, row, recover };
  const apiKey = newApiKey();
  // The domain and status conditions refuse a publisher that moved or was suspended after the check.
  const [rotated] = await withTimeout(sql()<PublisherRow[]>`
    update publishers set api_key_hash = ${sha256(apiKey)}, api_key_prefix = ${apiKey.slice(0, 14)}, domain_verified_at = now()
    where id = ${row.id} and status = 'active' and domain = ${held.domain}
    returning *`, { ms: DB_SIDE_TIMEOUT_MS, label: "recoverPublisher" });
  if (!rotated) {
    throw new HttpError(409, "publisher_changed", "That publisher changed its domain or status during recovery; no key was issued.",
      `POST ${env.SITE_URL}/api/v1/publishers/verify with {"publisher_id": "${row.id}"} to see where it stands.`);
  }
  track.counter("publisher:recovered");
  return { recovered: true, row: rotated, apiKey, method };
}

/** What to do about a lost key, for the REST and MCP 401s alike. */
export const LOST_KEY_HINT =
  "If you lost your key and registered with a url, register again with the same url: the 409 publisher_exists answer names your publisher and the steps to prove the domain and take a new key for it. " +
  "If you registered without a url, register again; old posts stay attached to the old publisher.";

export async function getPublisher(id: string, at: Budget = budget()): Promise<PublisherRow | null> {
  const [row] = await withTimeout(sql()<PublisherRow[]>`select * from publishers where id = ${id}`, at("getPublisher"));
  return row ?? null;
}

/** The caller's publisher if a valid key was sent, else null. Never throws. */
export async function optionalPublisher(req: Request): Promise<PublisherRow | null> {
  const key = bearer(req);
  if (!key) return null;
  try {
    const [row] = await withTimeout(sql()<PublisherRow[]>`select * from publishers where api_key_hash = ${sha256(key)} and status = 'active'`, { label: "optionalPublisher" });
    return row ?? null;
  } catch { return null; }
}

/** Resolve the caller's publisher from the bearer key. Throws a helpful 401 when absent or wrong. */
export async function requirePublisher(req: Request): Promise<PublisherRow> {
  const key = bearer(req);
  if (!key) {
    throw new HttpError(401, "missing_api_key", "This call needs a publisher API key.",
      `Register once with POST ${env.SITE_URL}/api/v1/publishers {"name": "..."} to get a key, then send it as "Authorization: Bearer <key>". Reading never needs a key.`);
  }
  const [row] = await withTimeout(sql()<PublisherRow[]>`select * from publishers where api_key_hash = ${sha256(key)}`, { label: "requirePublisher" });
  if (!row) throw new HttpError(401, "invalid_api_key", "That API key is not recognized.", `Keys start with crier_sk_. ${LOST_KEY_HINT}`);
  if (row.status === "deleted") throw new HttpError(401, "invalid_api_key", "That API key belonged to a publisher that has been deleted.", "Register again to get a new key.");
  if (row.status !== "active") throw new HttpError(403, "publisher_suspended", `This publisher has been suspended${row.suspended_reason ? ": " + row.suspended_reason : ""}.`, `Its posts are hidden. To appeal, email abuse@crier.network with publisher id ${row.id}.`);
  // Fire-and-forget last_seen.
  sql()`update publishers set last_seen_at = now() where id = ${row.id} and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')`.catch(() => {});
  return row;
}

export function verificationInstructions(p: PublisherRow) {
  const domain = p.domain;
  if (!domain) return { possible: false, reason: "Set a url on the publisher first; verification proves control of that url's domain." };
  return {
    possible: true,
    domain,
    token: p.verify_token,
    methods: [
      { method: "dns", record: `TXT _crier.${domain}`, value: p.verify_token },
      { method: "well-known", url: `https://${domain}/.well-known/crier.txt`, content: p.verify_token },
    ],
    then: `POST ${env.SITE_URL}/api/v1/publishers/verify with your API key. Either method works; DNS may take minutes to propagate.`,
  };
}

/** Check DNS TXT or the well-known file. Returns the method that succeeded or null. */
export async function checkDomainVerification(p: PublisherRow): Promise<"dns" | "well-known" | null> {
  if (!p.domain) return null;
  return checkDomainToken(p.domain, p.verify_token);
}

/** One 3-second DNS try: with the 5-second well-known fetch and the database budget, the verify route fits its maxDuration. */
const txtResolver = new Resolver({ timeout: 3000, tries: 1 });

/** Whether `token` is a TXT record at _crier.<domain> or a line of https://<domain>/.well-known/crier.txt. */
async function checkDomainToken(domain: string, token: string): Promise<"dns" | "well-known" | null> {
  try {
    const records = await txtResolver.resolveTxt(`_crier.${domain}`);
    if (records.some((r) => r.join("").trim() === token)) return "dns";
  } catch { /* no record */ }
  try {
    const target = await assertSafeOutboundUrl(`https://${domain}/.well-known/crier.txt`, "domain");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(target, { signal: ctrl.signal, redirect: "manual", headers: { "User-Agent": "Crier-Verify/1.0 (+https://crier.network)" } });
    clearTimeout(t);
    if (res.ok) {
      const text = (await res.text()).slice(0, 2000);
      if (text.split(/\r?\n/).some((l) => l.trim() === token)) return "well-known";
    }
  } catch { /* unreachable */ }
  return null;
}

/** Replace the API key. The old one stops working immediately. */
export async function rotateApiKey(id: string): Promise<string> {
  const apiKey = newApiKey();
  await sql()`update publishers set api_key_hash = ${sha256(apiKey)}, api_key_prefix = ${apiKey.slice(0, 14)} where id = ${id}`;
  return apiKey;
}

/** Erase a publisher: posts and subscriptions removed, record anonymized so ids stay unique. */
export async function deletePublisher(id: string): Promise<void> {
  const s = sql();
  await s.begin(async (tx) => {
    await tx`delete from subscriptions where publisher_id = ${id}`;
    await tx`delete from posts where publisher_id = ${id}`;
    await tx`update publishers set status = 'deleted', deleted_at = now(), name = 'deleted publisher', description = null, url = null, domain = null,
             domain_verified_at = null, api_key_hash = ${"deleted:" + sha256(id + Date.now())}, api_key_prefix = 'deleted', post_count = 0 where id = ${id}`;
  });
}

/** Bounded by DB_SIDE_TIMEOUT_MS so it fits the verify route's maxDuration after the domain check's own wait. */
export async function markVerified(id: string) {
  await withTimeout(sql()`update publishers set domain_verified_at = now() where id = ${id}`, { ms: DB_SIDE_TIMEOUT_MS, label: "markVerified" });
}
