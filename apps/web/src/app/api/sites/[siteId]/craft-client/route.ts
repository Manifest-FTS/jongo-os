import { createCraftClient, getCraftClient, updateCraftClient } from "@/lib/craft-admin/client";
import { badRequest, disallowed, failureResponse, gateCraftManager, readJsonBody, serverError } from "@/lib/craft-admin/gate";
import { CRAFT_RP_ENV } from "@/lib/craft-admin/shared";
import {
  DEFAULT_DATASET_NAME, hasOnlyKeys, parseClientName, parseClientStatus, parseDatasetName, parseRedirectUris
} from "@/lib/craft-admin/validation";
import { readOidcConfig } from "@/lib/oidc/config";
import { jsonResponse } from "@/lib/oidc/http";

type Params = { params: Promise<{ siteId: string }> };

const production = () => process.env.NODE_ENV === "production";

/** Issuer is public information; it is read only to build the site's environment snippet. */
function publicIssuer(): string | null {
  const result = readOidcConfig();
  return result.ok ? result.config.issuer : null;
}

/** The app's OIDC client (one per app). Never includes the secret or any hash of it. */
export async function GET(request: Request, { params }: Params) {
  const gate = await gateCraftManager(request, (await params).siteId);
  if (!gate.ok) return gate.response;
  try {
    const result = await getCraftClient(gate.ctx.site);
    if (!result.ok) return failureResponse(result.reason);
    return jsonResponse(200, { siteId: gate.ctx.site.id, client: result.client, issuer: publicIssuer(), envNames: CRAFT_RP_ENV });
  } catch (error) {
    return serverError("GET craft-client", error);
  }
}

/** Create the client. The secret is in this response only; it cannot be read again, only rotated. */
export async function POST(request: Request, { params }: Params) {
  const gate = await gateCraftManager(request, (await params).siteId);
  if (!gate.ok) return gate.response;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!hasOnlyKeys(body, ["name", "redirectUris", "datasetName"])) return badRequest("Unexpected fields");

  const name = parseClientName(body.name, `${gate.ctx.site.name} Craft`);
  if (!name.ok) return badRequest(name.error);
  const uris = parseRedirectUris(body.redirectUris, production());
  if (!uris.ok) return badRequest(uris.error);
  const dataset = parseDatasetName(body.datasetName ?? DEFAULT_DATASET_NAME);
  if (!dataset.ok) return badRequest(dataset.error);

  try {
    const result = await createCraftClient({
      actorId: gate.ctx.actorId, site: gate.ctx.site, name: name.value, datasetName: dataset.value, ...uris.value,
      ipAddress: gate.ctx.ipAddress, userAgent: gate.ctx.userAgent
    });
    if (!result.ok) return failureResponse(result.reason, result.message);
    return jsonResponse(201, { client: result.client, clientSecret: result.secret, secretShownOnce: true, issuer: publicIssuer(), envNames: CRAFT_RP_ENV });
  } catch (error) {
    return serverError("POST craft-client", error);
  }
}

/** Change redirect URIs, dataset name and/or enable or disable the client. */
export async function PATCH(request: Request, { params }: Params) {
  const gate = await gateCraftManager(request, (await params).siteId);
  if (!gate.ok) return gate.response;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (!hasOnlyKeys(body, ["redirectUris", "datasetName", "status"]) || Object.keys(body).length === 0) return badRequest("Provide redirectUris, datasetName or status");

  const update: Parameters<typeof updateCraftClient>[0] = {
    actorId: gate.ctx.actorId, site: gate.ctx.site, ipAddress: gate.ctx.ipAddress, userAgent: gate.ctx.userAgent
  };
  if (body.redirectUris !== undefined) {
    const uris = parseRedirectUris(body.redirectUris, production());
    if (!uris.ok) return badRequest(uris.error);
    update.redirectUris = uris.value;
  }
  if (body.datasetName !== undefined) {
    const dataset = parseDatasetName(body.datasetName);
    if (!dataset.ok) return badRequest(dataset.error);
    update.datasetName = dataset.value;
  }
  if (body.status !== undefined) {
    const status = parseClientStatus(body.status);
    if (!status.ok) return badRequest(status.error);
    update.status = status.value;
  }

  try {
    const result = await updateCraftClient(update);
    if (!result.ok) return failureResponse(result.reason, result.message);
    return jsonResponse(200, { client: result.client });
  } catch (error) {
    return serverError("PATCH craft-client", error);
  }
}

export const PUT = disallowed("GET, POST, PATCH");
export const DELETE = disallowed("GET, POST, PATCH");
export const HEAD = disallowed("GET, POST, PATCH");
export const OPTIONS = disallowed("GET, POST, PATCH");
