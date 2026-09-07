import { openapi } from "@/lib/openapi";

export const dynamic = "force-static";

export function GET() {
  return Response.json(openapi(), { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
}
