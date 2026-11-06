import { CRAFT_ROLES, grantCeiling, grantCraftAccess } from "@/lib/craft-access";
import { getCraftAccessOverview, resolveGrantTarget } from "@/lib/craft-admin/access";
import { badRequest, disallowed, failureResponse, gateCraftManager, readJsonBody, serverError } from "@/lib/craft-admin/gate";
import { CRAFT_ROLE_OPTIONS } from "@/lib/craft-admin/shared";
import { hasOnlyKeys, parseCraftRole, parseEmail } from "@/lib/craft-admin/validation";
import { jsonResponse } from "@/lib/oidc/http";

type Params = { params: Promise<{ siteId: string }> };

/** Jongo Craft access for one app. Owner, client admins and platform admins only; 404 while JONGO_OIDC_ENABLED is not "true". */
export async function GET(request: Request, { params }: Params) {
  const gate = await gateCraftManager(request, (await params).siteId);
  if (!gate.ok) return gate.response;
  try {
    const result = await getCraftAccessOverview(gate.ctx.actorId, gate.ctx.site);
    if (!result.ok) return failureResponse(result.reason === "not_found" ? "not_found" : result.reason === "forbidden" ? "forbidden" : "unavailable");
    return jsonResponse(200, {
      siteId: gate.ctx.site.id,
      roles: CRAFT_ROLE_OPTIONS.map(({ value, label }) => ({ value, label })),
      maxGrantableRole: grantCeiling(gate.ctx.capacity),
      ...result.overview
    });
  } catch (error) {
    return serverError("GET craft-access", error);
  }
}

/** Grant or change a role. Body: { role, email } for any live Jongo user, or { role, userId } for someone already in this client/app. */
export async function POST(request: Request, { params }: Params) {
  const gate = await gateCraftManager(request, (await params).siteId);
  if (!gate.ok) return gate.response;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!hasOnlyKeys(body, ["email", "userId", "role"])) return badRequest("Unexpected or missing fields");
  if ((body.email === undefined) === (body.userId === undefined)) return badRequest("Provide exactly one of email or userId");

  const role = parseCraftRole(body.role);
  if (!role.ok) return badRequest(role.error);
  // Never more than the grantor holds: only platform admins, the owner and client admins reach this point, and they may grant any role.
  if (CRAFT_ROLES.indexOf(role.value) > CRAFT_ROLES.indexOf(grantCeiling(gate.ctx.capacity))) return failureResponse("forbidden", "You cannot grant more access than you hold");

  let email: string | undefined;
  if (body.email !== undefined) {
    const parsedEmail = parseEmail(body.email);
    if (!parsedEmail.ok) return badRequest(parsedEmail.error);
    email = parsedEmail.value;
  } else if (typeof body.userId !== "string") {
    return badRequest("userId must be a string");
  }

  try {
    const target = await resolveGrantTarget(gate.ctx.site, { email, userId: typeof body.userId === "string" ? body.userId : undefined });
    if (!target.ok) return jsonResponse(target.status, { error: target.error });
    const result = await grantCraftAccess({
      actorId: gate.ctx.actorId, siteId: gate.ctx.site.id, userId: target.userId, role: role.value,
      ipAddress: gate.ctx.ipAddress, userAgent: gate.ctx.userAgent
    });
    if (!result.ok) return failureResponse(result.reason);
    return jsonResponse(result.created ? 201 : 200, { ok: true, userId: target.userId, role: role.value, created: result.created });
  } catch (error) {
    return serverError("POST craft-access", error);
  }
}

export const PUT = disallowed("GET, POST");
export const PATCH = disallowed("GET, POST");
export const DELETE = disallowed("GET, POST");
export const HEAD = disallowed("GET, POST");
export const OPTIONS = disallowed("GET, POST");
