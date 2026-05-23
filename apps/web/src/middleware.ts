import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/auth/login",
  "/auth/register",
  "/auth/error",
  "/auth/invite",
  "/auth/forgot-password",
  "/auth/reset-password",
  "/api/auth",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/invites",
  "/api/health",
  "/api/coolify/connection",
  "/api/setup",
  // Internal collector route is secured by bearer token in its route handler.
  "/api/internal/wordpress-collector"
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths and static assets through
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/assets") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  // Allow unauthenticated access when NEXTAUTH_SECRET is not set (dev / no-auth mode)
  if (!process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET === "dev-secret-change-in-production") {
    return NextResponse.next();
  }

  if (pathname === "/api/coolify/ownership/sync") {
    const syncToken = process.env.OWNERSHIP_SYNC_TOKEN;
    const authHeader = req.headers.get("authorization") ?? "";
    const providedToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (syncToken && providedToken && providedToken === syncToken) {
      return NextResponse.next();
    }
  }

  if (pathname === "/api/diagnostics/runtime") {
    const diagnosticsToken = process.env.OWNERSHIP_SYNC_TOKEN;
    const authHeader = req.headers.get("authorization") ?? "";
    const providedToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (diagnosticsToken && providedToken && providedToken === diagnosticsToken) {
      return NextResponse.next();
    }
  }

  if (/^\/api\/sites\/[^/]+\/staging$/i.test(pathname)) {
    const operationsToken = process.env.OWNERSHIP_SYNC_TOKEN;
    const authHeader = req.headers.get("authorization") ?? "";
    const providedToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (operationsToken && providedToken && providedToken === operationsToken) {
      return NextResponse.next();
    }
  }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });

  if (!token) {
    const loginUrl = new URL("/auth/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - assets/* (public branding and media)
     * - favicon.ico
     */
    "/((?!_next/static|_next/image|assets|favicon.ico).*)"
  ]
};
