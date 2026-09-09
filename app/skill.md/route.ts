import { skillMd } from "@/lib/skill";

export const dynamic = "force-static";

/** The canonical skill text: hand this URL to an agent and it knows when and how to use the board. */
export function GET() {
  return new Response(skillMd(), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
