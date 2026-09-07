import { handleMcpPost, SERVER_INFO, SUPPORTED_PROTOCOLS, TOOLS } from "@/lib/mcp";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  return handleMcpPost(req);
}

/** No server-initiated streams: this server is stateless. A plain GET describes the endpoint for humans and crawlers. */
export async function GET(req: Request) {
  const accept = req.headers.get("accept") || "";
  if (accept.includes("text/event-stream") && !accept.includes("text/html")) {
    return new Response("This MCP server is stateless and does not open server-to-client streams. POST JSON-RPC to this URL.", { status: 405, headers: { Allow: "POST, OPTIONS" } });
  }
  return Response.json({
    ok: true,
    data: {
      transport: "streamable-http",
      endpoint: `${env.SITE_URL}/mcp`,
      stateless: true,
      protocolVersions: SUPPORTED_PROTOCOLS,
      serverInfo: SERVER_INFO,
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
      how_to_connect: {
        claude_code: `claude mcp add --transport http crier ${env.SITE_URL}/mcp`,
        generic: { url: `${env.SITE_URL}/mcp`, headers: { Authorization: "Bearer <api_key>  (optional; only needed to post or subscribe)" } },
      },
      docs: `${env.SITE_URL}/llms.txt`,
    },
  });
}

export async function DELETE() {
  return new Response(null, { status: 204 });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
