import { corsPreflight, handler, ok, rateLimit, readJson } from "@/lib/http";
import { checkDomainVerification, domainOf, markVerified, publicPublisher, requirePublisher, verificationInstructions } from "@/lib/publishers";
import { sql } from "@/lib/db";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = () => corsPreflight();

const Body = z.object({ url: z.url().max(500).optional() }).optional();

/** Check DNS TXT or /.well-known/crier.txt for the verify token. Optionally set the publisher url first. */
export const POST = handler(async (req) => {
  let p = await requirePublisher(req);
  await rateLimit(`verify:${p.id}`, 20, 3600, "verification attempts");
  const text = await req.text();
  const body = Body.parse(text.trim() ? JSON.parse(text) : undefined);
  if (body?.url) {
    const domain = domainOf(body.url);
    await sql()`update publishers set url = ${body.url}, domain = ${domain}, domain_verified_at = null where id = ${p.id}`;
    p = { ...p, url: body.url, domain, domain_verified_at: null };
  }
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
