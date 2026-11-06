import { revokeCraftAccess } from "@/lib/craft-access";
import { disallowed, failureResponse, gateCraftManager, serverError } from "@/lib/craft-admin/gate";
import { jsonResponse } from "@/lib/oidc/http";
import { isUuid } from "@/lib/site-identity";

type Params = { params: Promise<{ siteId: string; userId: string }> };

/** Revoke one person's explicit Craft grant. Inherited access (owner, client admins, platform admins) cannot be revoked here. */
export async function DELETE(request: Request, { params }: Params) {
  const { siteId, userId } = await params;
  const gate = await gateCraftManager(request, siteId);
  if (!gate.ok) return gate.response;
  if (!isUuid(userId)) return failureResponse("not_found");
  try {
    const result = await revokeCraftAccess({
      actorId: gate.ctx.actorId, siteId: gate.ctx.site.id, userId,
      ipAddress: gate.ctx.ipAddress, userAgent: gate.ctx.userAgent
    });
    if (!result.ok) return failureResponse(result.reason);
    if (!result.revoked) return failureResponse("not_found", "That person has no explicit Craft grant on this app");
    return jsonResponse(200, { ok: true, userId });
  } catch (error) {
    return serverError("DELETE craft-access/[userId]", error);
  }
}

export const GET = disallowed("DELETE");
export const POST = disallowed("DELETE");
export const PUT = disallowed("DELETE");
export const PATCH = disallowed("DELETE");
export const HEAD = disallowed("DELETE");
export const OPTIONS = disallowed("DELETE");
