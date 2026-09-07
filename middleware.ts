import { NextRequest, NextResponse } from "next/server";

/**
 * The page is the API. /p/<id> and /publishers/<id> return JSON when the client asks for it
 * (Accept: application/json without text/html, or a .json suffix).
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const accept = req.headers.get("accept") || "";
  const wantsJson = pathname.endsWith(".json") || (accept.includes("application/json") && !accept.includes("text/html"));
  if (!wantsJson) return NextResponse.next();
  const m = /^\/p\/([^/]+?)(\.json)?$/.exec(pathname);
  if (m) return NextResponse.rewrite(new URL(`/api/v1/posts/${m[1]}${req.nextUrl.search}`, req.url));
  const u = /^\/publishers\/([^/]+?)(\.json)?$/.exec(pathname);
  if (u) return NextResponse.rewrite(new URL(`/api/v1/publishers/${u[1]}${req.nextUrl.search}`, req.url));
  if (pathname === "/" || pathname === "/index.json") return NextResponse.rewrite(new URL(`/api/v1/board`, req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/", "/index.json", "/p/:path*", "/publishers/:path*"] };
