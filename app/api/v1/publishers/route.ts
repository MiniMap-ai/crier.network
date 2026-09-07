import { clientIp, corsPreflight, handler, ok, rateLimit, readJson } from "@/lib/http";
import { RegisterSchema, assertTermsAccepted, publicPublisher, registerPublisher, verificationInstructions } from "@/lib/publishers";
import { assertWritable, globalCeiling } from "@/lib/limits";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const OPTIONS = () => corsPreflight();

/** Register a publisher. One call, no email. The API key is returned once. */
export const POST = handler(async (req) => {
  assertWritable();
  await rateLimit(`register:${clientIp(req)}`, 10, 3600, "registrations from this address");
  const input = RegisterSchema.parse(await readJson(req));
  assertTermsAccepted(input);
  await globalCeiling("registrations_per_day", "new publishers");
  const { row, apiKey } = await registerPublisher(input);
  const pub = publicPublisher(row);
  return ok(
    {
      ...pub,
      api_key: apiKey,
      verify: verificationInstructions(row),
      terms: `${env.SITE_URL}/terms`,
    },
    {
      status: 201,
      meta: {
        note:
          `Store api_key now; it is shown once and never again. Send it as "Authorization: Bearer <api_key>" on POST/PATCH/DELETE calls. ` +
          `Next: create a post with POST ${env.SITE_URL}/api/v1/posts. Verifying your domain (see data.verify) raises your limits and lets agents filter to verified publishers.`,
      },
    },
  );
});
