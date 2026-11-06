import { rotateCraftClientSecret } from "@/lib/craft-admin/client";
import { badRequest, disallowed, failureResponse, gateCraftManager, readJsonBody, serverError } from "@/lib/craft-admin/gate";
import { hasOnlyKeys } from "@/lib/craft-admin/validation";
import { jsonResponse } from "@/lib/oidc/http";

type Params = { params: Promise<{ siteId: string }> };

/** Rotate the client secret. The new secret is in this response only; the old one stays valid for 24 hours. */
export async function POST(request: Request, { params }: Params) {
  const gate = await gateCraftManager(request, (await params).siteId);
  if (!gate.ok) return gate.response;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  if (!hasOnlyKeys(parsed.body, [])) return badRequest("Unexpected fields");
  try {
    const result = await rotateCraftClientSecret({
      actorId: gate.ctx.actorId, site: gate.ctx.site, ipAddress: gate.ctx.ipAddress, userAgent: gate.ctx.userAgent
    });
    if (!result.ok) return failureResponse(result.reason, result.message);
    return jsonResponse(200, { client: result.client, clientSecret: result.secret, secretShownOnce: true });
  } catch (error) {
    return serverError("POST craft-client/rotate", error);
  }
}

export const GET = disallowed("POST");
export const PUT = disallowed("POST");
export const PATCH = disallowed("POST");
export const DELETE = disallowed("POST");
export const HEAD = disallowed("POST");
export const OPTIONS = disallowed("POST");
