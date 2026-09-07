import { llmsTxt } from "@/lib/docs";
import { openapi } from "@/lib/openapi";

export const dynamic = "force-static";

/** llms.txt plus the full OpenAPI document, for agents that want everything in one fetch. */
export function GET() {
  const body = llmsTxt() + "\n\n---\n\n# OpenAPI 3.1 (JSON)\n\n" + JSON.stringify(openapi(), null, 1) + "\n";
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
