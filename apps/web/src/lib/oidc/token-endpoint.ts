import { writeOidcAudit, writeOidcAuditBestEffort, type AuditWriter } from "./audit";
import { authenticateClientSecret, findActiveClient, isClientIdShape, verifyClientSecret, type OidcClientRecord } from "./clients";
import { redeemAuthCode, type AuthCodeStore } from "./codes";
import { checkTokenRate, clientAuthFailures } from "./rate-limit";
import { BASE_HEADERS, clientIp, jsonResponse } from "./http";
import type { OidcKeys } from "./keys";
import { signIdToken } from "./tokens";
import { ID_TOKEN_TTL_SECONDS } from "./config";
import type { CraftAccessResult } from "@/lib/craft-access";

export type TokenDeps = {
  db: Parameters<typeof findActiveClient>[0] & AuthCodeStore & AuditWriter;
  issuer: string;
  keys: OidcKeys;
  resolveAccess: (userId: string, siteId: string) => Promise<CraftAccessResult | null>;
  now?: () => Date;
};

const MAX_BODY = 8 * 1024;
const DUMMY_SECRET_HASH = "v1$AQEBAQEBAQEBAQEBAQEBAQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function oauthError(status: number, error: string, description?: string, extra: Record<string, string> = {}): Response {
  return jsonResponse(status, description ? { error, error_description: description } : { error }, extra);
}

function parseBasic(header: string | null): { id: string; secret: string } | "malformed" | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!match) return header.trim().toLowerCase().startsWith("basic") ? "malformed" : null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return "malformed";
  try {
    // RFC 6749 2.3.1: both parts are form-urlencoded before base64.
    return { id: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " ")), secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " ")) };
  } catch {
    return "malformed";
  }
}

/** POST /api/oidc/token: authorization_code only, confidential client + PKCE, no refresh or access token. */
export async function handleTokenRequest(request: Request, deps: TokenDeps): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const ip = clientIp(request);

  // A browser cross-origin call carries Origin; this endpoint is server-to-server only and has no CORS.
  if (request.headers.get("origin")) return oauthError(400, "invalid_request", "Browser requests are not accepted");
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(contentType)) {
    return oauthError(400, "invalid_request", "Content-Type must be application/x-www-form-urlencoded");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) return oauthError(400, "invalid_request", "Body too large");
  const text = await request.text();
  if (text.length > MAX_BODY) return oauthError(400, "invalid_request", "Body too large");

  const form = new URLSearchParams(text);
  const body: Record<string, string> = {};
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key);
    if (values.length > 1) return oauthError(400, "invalid_request", `Repeated parameter: ${key}`);
    body[key] = values[0];
  }

  const basic = parseBasic(request.headers.get("authorization"));
  if (basic === "malformed") return oauthError(401, "invalid_client", undefined, { "WWW-Authenticate": 'Basic realm="jongo"' });
  if (basic && body.client_secret !== undefined) return oauthError(400, "invalid_request", "Use one client authentication method");
  if (basic && body.client_id !== undefined && body.client_id !== basic.id) return oauthError(400, "invalid_request", "client_id mismatch");
  const clientId = basic ? basic.id : body.client_id;
  const secret = basic ? basic.secret : body.client_secret;
  const challengeHeaders: Record<string, string> = basic ? { "WWW-Authenticate": 'Basic realm="jongo"' } : {};

  const limit = checkTokenRate(clientId ?? "-", ip, now.getTime());
  if (!limit.allowed) return oauthError(429, "temporarily_unavailable", "Too many requests", { "Retry-After": String(limit.retryAfterSeconds) });

  if (!isClientIdShape(clientId) || typeof secret !== "string" || secret.length === 0 || secret.length > 256) {
    verifyClientSecret("x", DUMMY_SECRET_HASH);
    return oauthError(401, "invalid_client", undefined, challengeHeaders);
  }
  if (clientAuthFailures.isLocked(clientId, now.getTime())) {
    return oauthError(429, "temporarily_unavailable", "Client authentication is temporarily locked", { "Retry-After": "900" });
  }

  const client: OidcClientRecord | null = await findActiveClient(deps.db, clientId);
  if (!client) {
    verifyClientSecret(secret, DUMMY_SECRET_HASH);
    clientAuthFailures.recordFailure(clientId, now.getTime());
    return oauthError(401, "invalid_client", undefined, challengeHeaders);
  }
  const audit = (action: "oidc.token.deny" | "oidc.code.replay", userId: string | null, reason: string) =>
    writeOidcAuditBestEffort(deps.db, {
      organizationId: client.organizationId, actorId: userId, action, resourceType: "oidc_client",
      resourceId: client.id, details: { reason }, ipAddress: ip, userAgent: request.headers.get("user-agent")
    });

  if (!authenticateClientSecret(client, secret, now)) {
    clientAuthFailures.recordFailure(clientId, now.getTime());
    await audit("oidc.token.deny", null, "bad_client_secret");
    return oauthError(401, "invalid_client", undefined, challengeHeaders);
  }

  if (body.grant_type !== "authorization_code") return oauthError(400, "unsupported_grant_type", "Only authorization_code is supported");
  const { code, redirect_uri: redirectUri, code_verifier: codeVerifier } = body;
  if (!code || !redirectUri || !codeVerifier) return oauthError(400, "invalid_request", "code, redirect_uri and code_verifier are required");

  const redeemed = await redeemAuthCode(deps.db, { code, oidcClientId: client.id, redirectUri, codeVerifier, now });
  if (!redeemed.ok) {
    await audit(redeemed.reason === "replay" ? "oidc.code.replay" : "oidc.token.deny", redeemed.userId ?? null, redeemed.reason);
    return oauthError(400, "invalid_grant");
  }

  // Authority is re-read at redemption: removal in the 60 s window is honoured.
  const access = await deps.resolveAccess(redeemed.userId, client.siteId);
  if (!access || access.siteId !== client.siteId) {
    await audit("oidc.token.deny", redeemed.userId, "access_revoked");
    return oauthError(400, "invalid_grant");
  }

  const issueAudit = {
    organizationId: client.organizationId, actorId: redeemed.userId, action: "oidc.token.issue" as const,
    resourceType: "oidc_client" as const, resourceId: client.id,
    details: { role: access.role, via: access.via, capped: access.capped, ...(access.via === "platform_admin" ? { reason: "platform_admin" } : {}) },
    ipAddress: ip, userAgent: request.headers.get("user-agent")
  };
  if (access.via === "platform_admin") {
    // Implicit platform-admin access must leave a record before any token exists.
    try {
      await writeOidcAudit(deps.db, issueAudit);
    } catch {
      return oauthError(500, "server_error", "Could not record the sign-in");
    }
  }

  let idToken: string;
  try {
    idToken = await signIdToken(deps.keys, {
      issuer: deps.issuer,
      clientId: client.clientId,
      subject: access.user.id,
      nonce: redeemed.nonce,
      authTime: redeemed.authTime,
      scopes: redeemed.scope.split(" "),
      email: access.user.email,
      emailVerified: access.user.emailVerified,
      name: access.user.name,
      craft: { dataset: client.datasetName, role: access.role, siteId: client.siteId, via: access.via },
      now
    });
  } catch {
    return oauthError(500, "server_error");
  }
  if (access.via !== "platform_admin") await writeOidcAuditBestEffort(deps.db, issueAudit);

  return new Response(JSON.stringify({ id_token: idToken, token_type: "N_A", expires_in: ID_TOKEN_TTL_SECONDS }), {
    status: 200,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" }
  });
}
