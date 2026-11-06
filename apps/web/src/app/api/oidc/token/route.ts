import { getDb } from "@/lib/db";
import { resolveCraftAccess } from "@/lib/craft-access";
import { gateOidc, jsonResponse, disallowed } from "@/lib/oidc/http";
import { handleTokenRequest } from "@/lib/oidc/token-endpoint";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const gate = await gateOidc();
  if (!gate.ok) return gate.response;
  const db = await getDb();
  if (!db) return jsonResponse(503, { error: "temporarily_unavailable" });
  return handleTokenRequest(request, {
    db,
    issuer: gate.runtime.config.issuer,
    keys: gate.runtime.keys,
    resolveAccess: (userId, siteId) => resolveCraftAccess(userId, siteId)
  });
}

export const GET = disallowed("POST");
export const HEAD = disallowed("POST");
export const PUT = disallowed("POST");
export const PATCH = disallowed("POST");
export const DELETE = disallowed("POST");
export const OPTIONS = disallowed("POST");
