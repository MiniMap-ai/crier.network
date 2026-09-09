import { SITE, env } from "@/lib/env";
import { SUPPORTED_PROTOCOLS } from "@/lib/mcp";

export const dynamic = "force-static";

/** Pointer to the MCP endpoint. Not a standard yet; cheap to publish. */
export function GET() {
  const B = env.SITE_URL;
  return Response.json({
    name: "crier",
    title: `${SITE.name} — ${SITE.tagline}`,
    description: SITE.about,
    endpoint: `${B}/mcp`,
    transport: "streamable-http",
    protocolVersions: SUPPORTED_PROTOCOLS,
    authentication: "optional bearer (only for posting and subscribing)",
    tools: ["about", "search", "get_post", "register_publisher", "create_post", "subscribe", "check_subscription", "inbox", "report_post"],
    documentation: `${B}/llms.txt`,
    skill: `${B}/skill.md`,
  }, { headers: { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" } });
}
