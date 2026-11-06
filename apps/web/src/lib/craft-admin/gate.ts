import { auth } from "@/lib/auth.config";
import { craftManagerCapacity, type CraftManagerCapacity } from "@/lib/craft-access";
import { isOidcEnabled } from "@/lib/oidc/config";
import { clientIp, jsonResponse, notFoundResponse, disallowed } from "@/lib/oidc/http";
import { isUuid } from "@/lib/site-identity";
import { resolveSiteAccess } from "@/lib/tenant-route-access";
import { MAX_BODY_BYTES } from "./validation";

export { disallowed };

export type CraftManagerContext = {
  actorId: string;
  capacity: CraftManagerCapacity;
  site: { id: string; name: string; organizationId: string; ownerId: string };
  ipAddress: string;
  userAgent: string | null;
};

export type ManagerResolution =
  | { ok: true; capacity: CraftManagerCapacity; site: CraftManagerContext["site"] }
  | { ok: false; status: 403 | 404 };

/**
 * Who may manage a site's Craft access and OIDC client: platform admin, the client's owner, a live client admin.
 * Site-level collaborators (including site admins) can see the site but are NOT managers (403).
 * Unknown/deleted site, deleted client or a site the caller cannot see at all is 404, like the other site routes.
 */
export async function resolveCraftManager(userId: string, siteParam: string): Promise<ManagerResolution> {
  if (!isUuid(siteParam)) return { ok: false, status: 404 };
  const access = await resolveSiteAccess(siteParam, userId);
  if (!access) return { ok: false, status: 404 };
  const organization = access.site.organization;
  const capacity = craftManagerCapacity({
    userId, ownerId: organization.ownerId, orgRole: organization.collaborators[0]?.role, isPlatformAdmin: access.isPlatformAdmin
  });
  if (!capacity) return { ok: false, status: 403 };
  return { ok: true, capacity, site: { id: access.site.id, name: access.site.name, organizationId: access.site.organizationId, ownerId: organization.ownerId } };
}

export type GateOutcome = { ok: true; ctx: CraftManagerContext } | { ok: false; response: Response };

/** First statement of every Craft admin handler. Flag off: 404 and nothing else runs (no session, no database). */
export async function gateCraftManager(request: Request, siteParam: string): Promise<GateOutcome> {
  if (!isOidcEnabled()) return { ok: false, response: notFoundResponse() };
  const session = await auth();
  const actorId = session?.user?.id;
  if (!actorId) return { ok: false, response: jsonResponse(401, { error: "Unauthorized" }) };
  try {
    const resolved = await resolveCraftManager(actorId, siteParam);
    if (!resolved.ok) {
      return { ok: false, response: jsonResponse(resolved.status, { error: resolved.status === 404 ? "Not found" : "Only the client owner or admins can manage Jongo Craft" }) };
    }
    return {
      ok: true,
      ctx: { actorId, capacity: resolved.capacity, site: resolved.site, ipAddress: clientIp(request), userAgent: request.headers.get("user-agent") }
    };
  } catch (error) {
    return { ok: false, response: serverError("gate", error) };
  }
}

/** Never echoes the error: it could contain connection details. */
export function serverError(where: string, error: unknown): Response {
  console.error(`[craft-admin] ${where} failed: ${error instanceof Error ? error.name : "unknown"}`);
  return jsonResponse(500, { error: "Internal server error" });
}

export type JsonBody = { ok: true; body: unknown } | { ok: false; response: Response };

/** JSON only (a non-simple content type cannot be sent by a cross-site form), bounded in size. */
export async function readJsonBody(request: Request): Promise<JsonBody> {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return { ok: false, response: jsonResponse(415, { error: "Content-Type must be application/json" }) };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, response: jsonResponse(413, { error: "Request body too large" }) };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, response: jsonResponse(413, { error: "Request body too large" }) };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: jsonResponse(400, { error: "Invalid JSON" }) };
  }
}

export function badRequest(error: string): Response {
  return jsonResponse(400, { error });
}

const FAILURES = {
  invalid: [400, "Invalid request"],
  forbidden: [403, "Forbidden"],
  not_found: [404, "Not found"],
  conflict: [409, "Conflict"],
  unavailable: [503, "Service unavailable"]
} as const;

export function failureResponse(reason: keyof typeof FAILURES, message?: string): Response {
  const [status, fallback] = FAILURES[reason];
  return jsonResponse(status, { error: message ?? fallback });
}
