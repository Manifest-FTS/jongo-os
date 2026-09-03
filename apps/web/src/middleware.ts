import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/parked",
  // The public hosting signup page: the one surface someone with no account is
  // meant to land on, so it must never redirect to /auth/login.
  "/hosting",
  "/contact",
  "/api/contact",
  "/pricing",
  // Domain registration and transfer. The search endpoints have to answer an
  // anonymous visitor on the homepage, so they cannot sit behind auth.
  "/domains",
  "/api/domains",
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

const PARKING_SUFFIX = ".mfts.link";

function parkedDomainHost(req: NextRequest): string | null {
  const host = (req.headers.get("host") ?? "").split(":")[0].toLowerCase();
  if (!host.endsWith(PARKING_SUFFIX) || host === PARKING_SUFFIX.slice(1)) {
    return null;
  }

  return host;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const parkedHost = parkedDomainHost(req);
  if (parkedHost && pathname !== "/parked" && !pathname.startsWith("/_next") && !pathname.startsWith("/assets")) {
    const url = req.nextUrl.clone();
    url.pathname = "/parked";
    url.searchParams.set("domain", parkedHost);
    return NextResponse.rewrite(url);
  }

  const ownershipSyncToken = process.env.OWNERSHIP_SYNC_TOKEN;
  const backupReconcileToken = process.env.BACKUP_RECONCILE_TOKEN;
  const authHeader = req.headers.get("authorization") ?? "";
  const providedToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const hasOwnershipOpsToken = Boolean(
    ownershipSyncToken && providedToken && providedToken === ownershipSyncToken
  );
  const hasBackupReconcileToken = Boolean(
    backupReconcileToken && providedToken && providedToken === backupReconcileToken
  );
  const hasOpsToken = hasOwnershipOpsToken || hasBackupReconcileToken;

  // Allow public paths and static assets through
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/assets") ||
    pathname.startsWith("/favicon") ||
    // EXACT match, deliberately not a PUBLIC_PATHS entry: that list is matched
    // with startsWith, so "/" in it would make every route on the platform
    // public. The root page itself decides where to send you — the dashboard
    // when signed in, the public hosting page when not.
    pathname === "/"
  ) {
    return NextResponse.next();
  }

  // Allow unauthenticated access when NEXTAUTH_SECRET is not set (dev / no-auth mode)
  if (!process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET === "dev-secret-change-in-production") {
    return NextResponse.next();
  }

  if (pathname === "/api/coolify/ownership/sync" && hasOpsToken) {
    return NextResponse.next();
  }

  if (pathname === "/api/diagnostics/runtime" && hasOpsToken) {
    return NextResponse.next();
  }

  if (pathname === "/api/ops/staging-sync-automation" && hasOpsToken) {
    return NextResponse.next();
  }

  if (pathname === "/api/ops/backup-reconcile" && hasBackupReconcileToken) {
    return NextResponse.next();
  }

  // Ticked every minute by scripts/coolify-deletion-watcher.mjs. Without it here
  // the POST is redirected to /auth/login (307); fetch follows a 307 with the
  // method intact, so the watcher saw "HTTP 405" from the login page and no
  // deletion was ever synced.
  if (pathname === "/api/ops/coolify-deletion-watch" && hasBackupReconcileToken) {
    return NextResponse.next();
  }

  // The webhook authenticates itself — HMAC over the raw body, or a shared token —
  // and fails closed when no secret is configured. It therefore has to reach its
  // own handler unauthenticated at this layer; gating it on a session would make
  // every delivery a 307 to the login page.
  if (pathname === "/api/webhooks/coolify") {
    return NextResponse.next();
  }

  // Result callbacks from the backup/restore scripts. These run detached on the
  // server and report back with a machine token — without them listed here the
  // middleware redirects the POST to /login (307), the result is never recorded,
  // and the row hangs in "Backing up…" forever.
  if (
    hasOpsToken &&
    (pathname === "/api/ops/site-backup-record" ||
      pathname === "/api/ops/site-restore-record" ||
      pathname === "/api/ops/backup-restore-verification")
  ) {
    return NextResponse.next();
  }

  // Operational staging endpoints support machine-token auth for scripted checks.
  if (hasOpsToken) {
    if (pathname === "/api/sites/staging-targets") {
      return NextResponse.next();
    }

    const isStagingRoute = /^\/api\/sites\/[^/]+\/staging(?:\/|$)/.test(pathname);
    if (isStagingRoute) {
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
