import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isSuperAdminUser } from "@/lib/rbac";
import { syncNamecheapDomains } from "@/lib/domain-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 720;

function machineAuthorized(request: Request): boolean {
  const expected = process.env.NAMECHEAP_SYNC_TOKEN?.trim();
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!expected || !match) return false;
  // Fixed-size digests make timingSafeEqual safe even for different lengths.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(match[1]));
}

export async function POST(request: Request) {
  const json = (body: unknown, status: number) => NextResponse.json(body, {
    status, headers: { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" }
  });
  try {
    if (!machineAuthorized(request)) {
      const session = await auth();
      if (!session?.user?.id) return json({ ok: false, reason: "unauthorized" }, 401);
      if (!(await isSuperAdminUser(session.user.id))) return json({ ok: false, reason: "forbidden" }, 403);
    }
    const result = await syncNamecheapDomains();
    return json(result, result.ok ? 200 : 503);
  } catch {
    return json({ ok: false, reason: "sync_failed", errors: [{ code: "INTERNAL_ERROR", page: null }] }, 503);
  }
}