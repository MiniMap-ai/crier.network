/**
 * One publisher per domain, and the way back to it for whoever controls the domain. Free of imports
 * so unit tests can load it: hashing, randomness, the clock and the database are passed in.
 * The agent's side of it, and why the proof is bound to a secret: docs/scenarios.md, scenario 15.
 */

/** The fields of a publisher row these rules read. */
export type DomainClaimant = {
  id: string;
  domain: string | null;
  status: string;
  domain_verified_at: Date | null;
  created_at: Date;
};

/** Only an active publisher holds its domain; a suspended or deleted one leaves it free to register. */
export function holdsDomain(p: DomainClaimant): boolean {
  return p.status === "active" && !!p.domain;
}

/**
 * The publisher that holds `domain` among `rows`, or null. Verified before unverified, then oldest,
 * then lowest id: the same rows always name the same publisher, and a domain shared by several
 * unverified publishers names the first one registered. `exceptId` leaves the caller's own row out.
 */
export function domainHolder<T extends DomainClaimant>(rows: readonly T[], domain: string, exceptId?: string): T | null {
  const holders = rows.filter((r) => r.domain === domain && r.id !== exceptId && holdsDomain(r));
  holders.sort((a, b) =>
    Number(!a.domain_verified_at) - Number(!b.domain_verified_at) ||
    a.created_at.getTime() - b.created_at.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return holders[0] ?? null;
}

export type ClaimStore<T, R> = {
  /** Every publisher row whose domain is `domain`; rows that do not hold it are filtered here. */
  holders: (domain: string) => Promise<readonly T[]>;
  write: () => Promise<R>;
};

/**
 * Run `store.write` unless another publisher holds `domain`, in which case nothing is written and the
 * holder is returned. A null domain is never held. The caller runs both store calls in one
 * transaction that serializes claims on the domain, or two concurrent claims can both find it free.
 */
export async function claimDomain<T extends DomainClaimant, R>(domain: string | null, store: ClaimStore<T, R>, exceptId?: string): Promise<{ written: R } | { holder: T }> {
  if (domain) {
    const holder = domainHolder(await store.holders(domain), domain, exceptId);
    if (holder) return { holder };
  }
  return { written: await store.write() };
}

/** Seconds a recovery secret stays redeemable: long enough for a DNS change to propagate. */
export const RECOVERY_TTL_S = 7 * 86400;
const CLOCK_SKEW_S = 300;
const SECRET_RE = /^crier_rs_(\d{10})_[A-Za-z0-9_-]{16,64}$/;

/** A recovery secret issued at `nowS` (Unix seconds). `random` must come from a CSPRNG. */
export function newRecoverySecret(nowS: number, random: string): string {
  return `crier_rs_${Math.floor(nowS)}_${random}`;
}

export type SecretCheck = { ok: true; issuedAt: number } | { ok: false; reason: "malformed" | "expired" };

/**
 * Whether `secret` has the shape `newRecoverySecret` gives and is younger than RECOVERY_TTL_S. The
 * issue time is not signed: editing it changes the challenge, which then has to be published again.
 */
export function checkRecoverySecret(secret: string, nowS: number): SecretCheck {
  const m = SECRET_RE.exec(secret);
  if (!m) return { ok: false, reason: "malformed" };
  const issuedAt = Number(m[1]);
  if (issuedAt > nowS + CLOCK_SKEW_S) return { ok: false, reason: "malformed" };
  if (nowS - issuedAt > RECOVERY_TTL_S) return { ok: false, reason: "expired" };
  return { ok: true, issuedAt };
}

/**
 * The value to publish on `domain` to redeem `secret` for `publisherId`. It is public once published
 * and reveals nothing that redeems it: only the holder of the secret can, so whoever watches the
 * domain's DNS cannot take the key.
 */
export function recoveryChallenge(publisherId: string, domain: string, secret: string, sha256Hex: (s: string) => string): string {
  return "crier-recover-" + sha256Hex(`crier-recover:${publisherId}:${domain}:${secret}`).slice(0, 40);
}

export type RecoveryPlan = {
  publisher_id: string;
  domain: string;
  recovery_secret: string;
  expires_at: string;
  challenge: string;
  methods: [{ method: "dns"; record: string; value: string }, { method: "well-known"; url: string; content: string }];
  then: { method: "POST"; url: string; headers: { "Content-Type": "application/json" }; body: { publisher_id: string; recovery_secret: string } };
};

/** Everything an agent needs to prove control of `domain` and take a new key for `publisherId`. */
export function recoveryPlan(publisherId: string, domain: string, secret: string, issuedAtS: number, siteUrl: string, sha256Hex: (s: string) => string): RecoveryPlan {
  const challenge = recoveryChallenge(publisherId, domain, secret, sha256Hex);
  return {
    publisher_id: publisherId,
    domain,
    recovery_secret: secret,
    expires_at: new Date((issuedAtS + RECOVERY_TTL_S) * 1000).toISOString(),
    challenge,
    methods: [
      { method: "dns", record: `TXT _crier.${domain}`, value: challenge },
      { method: "well-known", url: `https://${domain}/.well-known/crier.txt`, content: challenge },
    ],
    then: { method: "POST", url: `${siteUrl}/api/v1/publishers/verify`, headers: { "Content-Type": "application/json" }, body: { publisher_id: publisherId, recovery_secret: secret } },
  };
}

/** `plan` as numbered plain-text steps, for a hint or an MCP text result. */
export function recoverySteps(plan: RecoveryPlan): string {
  return `1. Publish ${plan.challenge} as a TXT record at _crier.${plan.domain}, or as a line of https://${plan.domain}/.well-known/crier.txt. ` +
    `2. POST ${plan.then.url} with body ${JSON.stringify(plan.then.body)} and no Authorization header. ` +
    `The answer carries a new api_key for ${plan.publisher_id}, and its old key stops working. ` +
    `Keep recovery_secret private: it works until ${plan.expires_at}, and until then you can repeat step 2 while DNS propagates.`;
}

export type Refusal = { status: 409; code: "publisher_exists"; message: string; hint: string };

/**
 * The 409 for a claim on a domain `holder` holds. `attempt` is what was refused: registering a new
 * publisher, or pointing an existing one at the domain. Names the holder by id only, since its name
 * is third-party text; the caller attaches `plan` and the holder's public record as detail.
 */
export function domainTakenRefusal(holder: DomainClaimant & { domain: string }, plan: RecoveryPlan, attempt: "register" | "move"): Refusal {
  const which = holder.domain_verified_at ? "a verified publisher" : "a publisher";
  const outcome = attempt === "register" ? "no new key was issued" : "your publisher's url was not changed";
  return {
    status: 409,
    code: "publisher_exists",
    message: `${holder.domain} already has ${which} on Crier, ${holder.id}. Crier keeps one publisher and one key per domain, so ${outcome}.`,
    hint: `If ${holder.id} is yours and you still have its api_key, keep using it and do not register again. ` +
      `If you lost the key, prove you control ${holder.domain} to get a new one: ${recoverySteps(plan)} ` +
      `If ${holder.domain} is not yours, register with your own url, or with none.`,
  };
}
