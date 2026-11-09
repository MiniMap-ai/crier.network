import { HttpError, clientIp, corsPreflight, handler, ok, rateLimit } from "@/lib/http";
import { RecoverSchema, checkDomainVerification, markVerified, moveToUrl, publicPublisher, recoverPublisher, requirePublisher, verificationInstructions } from "@/lib/publishers";
import { recoverySteps } from "@/lib/publisher-claim";
import { assertWritable } from "@/lib/limits";
import { budget } from "@/lib/db";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = () => corsPreflight();

const Body = z.object({ url: z.url().max(500).optional() }).optional();

/**
 * With a key: check DNS TXT or /.well-known/crier.txt for the verify token, optionally setting the
 * publisher url first. With `publisher_id` in the body, no key needed: recover a lost key by proving
 * the publisher's domain (docs/scenarios.md, scenario 15).
 */
export const POST = handler(async (req) => {
  const text = await req.text();
  let json: unknown;
  try { json = text.trim() ? JSON.parse(text) : undefined; } catch { throw new HttpError(400, "invalid_json", "Body is not valid JSON.", "Send a JSON object, or no body."); }
  if (json && typeof json === "object" && "publisher_id" in json) return recover(req, json);
  assertWritable();
  let p = await requirePublisher(req);
  const at = budget();
  await rateLimit(`verify:${p.id}`, 20, 3600, "verification attempts", at("verify:rateLimit"));
  const body = Body.parse(json);
  if (body?.url) p = await moveToUrl(p, body.url, at);
  const method = await checkDomainVerification(p);
  if (method) {
    await markVerified(p.id);
    return ok({ ...publicPublisher({ ...p, domain_verified_at: new Date() }), verified_via: method }, { meta: { note: `Verified ${p.domain} via ${method}. Posts from this publisher now carry publisher.verified = true.` } });
  }
  return ok({ ...publicPublisher(p), verified_via: null, verify: verificationInstructions(p) }, {
    status: 202,
    meta: { note: p.domain ? `Not verified yet. Publish the token via DNS or the well-known file (see data.verify), wait for propagation, then call this again.` : "Set a url first (pass {\"url\": \"https://your-domain\"} in this call) so there is a domain to verify." },
  });
});

async function recover(req: Request, json: object): Promise<Response> {
  assertWritable();
  const at = budget();
  await rateLimit(`recover:${clientIp(req)}`, 20, 3600, "key recovery attempts from this address", at("verify:recover:rateLimit"));
  const r = await recoverPublisher(RecoverSchema.parse(json), at);
  if (r.recovered) {
    return ok({ ...publicPublisher(r.row), api_key: r.apiKey, verified_via: r.method, recovered: true }, {
      meta: {
        note: `Proved control of ${r.row.domain} via ${r.method}. Store api_key now; it is shown once, and the previous key for ${r.row.id} is dead. ` +
          `Remove the challenge record from your domain now; the secret cannot be redeemed again. This publisher has ${r.row.post_count} posts; check them at GET /api/v1/publishers/${r.row.id} and delete any that are not yours.`,
      },
    });
  }
  return ok({ ...publicPublisher(r.row), recovered: false, recover: r.recover }, {
    status: 202,
    meta: { note: `${r.checked ? `No key issued: the challenge is not on ${r.recover.domain} yet.` : `To take a new key for ${r.row.id}, prove you control ${r.recover.domain}.`} ${recoverySteps(r.recover)}` },
  });
}
