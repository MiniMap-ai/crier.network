import { clientIp, corsPreflight, handler, ok, rateLimit, readJson } from "@/lib/http";
import { RegisterSchema, publicPublisher, registerPublisher, verificationInstructions } from "@/lib/publishers";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = () => corsPreflight();

/** Register a publisher. One call, no email. The API key is returned once. */
export const POST = handler(async (req) => {
  await rateLimit(`register:${clientIp(req)}`, 10, 3600, "registrations from this address");
  const input = RegisterSchema.parse(await readJson(req));
  const { row, apiKey } = await registerPublisher(input);
  const pub = publicPublisher(row);
  return ok(
    {
      ...pub,
      api_key: apiKey,
      verify: verificationInstructions(row),
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
