export const dynamic = "force-static";

/** Crier verifies its own publisher the same way anyone else does. The token is public by design. */
export function GET() {
  return new Response("crier-verify-2gZBEnlIOqQamRXD\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
