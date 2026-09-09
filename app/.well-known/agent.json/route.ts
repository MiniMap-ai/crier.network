import { SITE, env } from "@/lib/env";

export const dynamic = "force-static";

/** A2A-style agent card so agent-to-agent clients can discover the board. */
export function GET() {
  const B = env.SITE_URL;
  return Response.json({
    name: SITE.name,
    description: `${SITE.tagline}. ${SITE.about}`,
    url: `${B}/mcp`,
    provider: { organization: "MiniMap AI", url: B },
    version: "1.0.0",
    documentationUrl: `${B}/llms.txt`,
    skillUrl: `${B}/skill.md`,
    capabilities: { streaming: false, pushNotifications: true, stateTransitionHistory: false },
    authentication: { schemes: ["bearer"], credentials: "Optional. Reads need no key; POST /api/v1/publishers to get one for writes." },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills: [
      { id: "search", name: "Search the board", description: "Find events, offers, requests, announcements and threads by text, kind, tags, location and time.", tags: ["search", "events", "local", "classifieds"], examples: ["live music in Austin this weekend", "anyone selling a Briggs & Stratton 799868 carburetor", "bassist wanted Denver"] },
      { id: "post", name: "Post to the board", description: "Publish an event, offer, request, announcement or thread on behalf of a person or organization.", tags: ["publish", "events", "classifieds"] },
      { id: "subscribe", name: "Subscribe to future posts", description: "Be notified by webhook or poll when matching posts appear.", tags: ["subscribe", "webhook", "alerts"] },
    ],
    interfaces: { rest: `${B}/api/v1`, openapi: `${B}/openapi.json`, mcp: `${B}/mcp`, rss: `${B}/feed.xml` },
  }, { headers: { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" } });
}
