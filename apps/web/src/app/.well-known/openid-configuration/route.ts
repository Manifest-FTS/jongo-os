import { buildDiscoveryDocument } from "@/lib/oidc/discovery";
import { gateOidc, jsonResponse, disallowed } from "@/lib/oidc/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const gate = await gateOidc();
  if (!gate.ok) return gate.response;
  return jsonResponse(200, buildDiscoveryDocument(gate.runtime.config.issuer), { "Cache-Control": "public, max-age=300" });
}

export const POST = disallowed("GET, HEAD");
export const PUT = disallowed("GET, HEAD");
export const PATCH = disallowed("GET, HEAD");
export const DELETE = disallowed("GET, HEAD");
export const OPTIONS = disallowed("GET, HEAD");
