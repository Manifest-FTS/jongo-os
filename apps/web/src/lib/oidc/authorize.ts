import { SUPPORTED_SCOPES } from "./config";
import { writeOidcAudit, writeOidcAuditBestEffort, type AuditWriter } from "./audit";
import { findActiveClient, redirectUriMatches, type OidcClientRecord } from "./clients";
import { issueAuthCode, type AuthCodeStore } from "./codes";
import { hasConsent, recordConsent, signConsentToken, verifyConsentToken, type ConsentBinding } from "./consent";
import { CODE_CHALLENGE_METHOD, isValidCodeChallenge } from "./pkce";
import type { CraftAccessResult } from "@/lib/craft-access";

export type RawParams = Record<string, string | string[] | undefined>;

export type AuthorizeRequest = {
  client: OidcClientRecord;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scopes: string[];
};

export type ValidationOutcome =
  | { kind: "error_page"; error: string; message: string }
  | { kind: "redirect_error"; redirectUri: string; error: string; description: string; state?: string }
  | { kind: "ok"; request: AuthorizeRequest };

const MAX_TOKEN_PARAM = 512;
const PRINTABLE = /^[\x21-\x7e]+$/;

/** A repeated parameter reads as absent here; validateAuthorizeRequest rejects repeats explicitly. */
function single(params: RawParams, name: string): string | undefined {
  const value = params[name];
  return typeof value === "string" ? value : undefined;
}

type ClientLookupDb = Parameters<typeof findActiveClient>[0];

/**
 * Validates an authorization request. Order matters: until client_id AND redirect_uri are
 * proven, nothing is ever redirected (the error is rendered on Jongo instead); afterwards
 * errors go back to the registered redirect URI as OAuth error responses.
 */
export async function validateAuthorizeRequest(db: ClientLookupDb, params: RawParams): Promise<ValidationOutcome> {
  const clientId = single(params, "client_id");
  const client = clientId ? await findActiveClient(db, clientId) : null;
  if (!client) return { kind: "error_page", error: "invalid_client", message: "This sign-in link is not valid. Return to the site and try again." };

  const redirectUri = single(params, "redirect_uri");
  if (!redirectUriMatches(client.redirectUris, redirectUri)) {
    return { kind: "error_page", error: "invalid_redirect_uri", message: "This sign-in link is not valid. Return to the site and try again." };
  }

  const state = single(params, "state");
  const fail = (error: string, description: string): ValidationOutcome => ({
    kind: "redirect_error",
    redirectUri,
    error,
    description,
    state: typeof state === "string" && state.length <= MAX_TOKEN_PARAM && PRINTABLE.test(state) ? state : undefined
  });

  for (const name of Object.keys(params)) {
    if (Array.isArray(params[name])) return fail("invalid_request", `Repeated parameter: ${name}`);
  }
  if (params.request !== undefined) return fail("request_not_supported", "request objects are not supported");
  if (params.request_uri !== undefined) return fail("request_uri_not_supported", "request_uri is not supported");

  if (single(params, "response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
  const responseMode = single(params, "response_mode");
  if (responseMode !== undefined && responseMode !== "query") return fail("invalid_request", "Only response_mode=query is supported");
  const prompt = single(params, "prompt");
  if (prompt !== undefined && prompt.split(" ").includes("none")) return fail("invalid_request", "prompt=none is not supported");

  if (!state || state.length > MAX_TOKEN_PARAM || !PRINTABLE.test(state)) return fail("invalid_request", "state is required");
  const nonce = single(params, "nonce");
  if (!nonce || nonce.length > MAX_TOKEN_PARAM || !PRINTABLE.test(nonce)) return fail("invalid_request", "nonce is required");

  const method = single(params, "code_challenge_method");
  if (method !== CODE_CHALLENGE_METHOD) return fail("invalid_request", "code_challenge_method must be S256");
  const challenge = single(params, "code_challenge");
  if (!isValidCodeChallenge(challenge)) return fail("invalid_request", "A valid S256 code_challenge is required");

  const scopeRaw = single(params, "scope");
  if (!scopeRaw || scopeRaw.length > 200) return fail("invalid_scope", "scope must include openid");
  const scopes = Array.from(new Set(scopeRaw.split(" ").filter(Boolean)));
  if (!scopes.includes("openid")) return fail("invalid_scope", "scope must include openid");
  if (!scopes.every((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope))) return fail("invalid_scope", "Unsupported scope requested");

  return { kind: "ok", request: { client, redirectUri, state, nonce, codeChallenge: challenge, scopes } };
}

/** Builds the redirect to a registered URI. RFC 9207 `iss` is included so clients can bind the response to this server. */
export function buildRedirect(redirectUri: string, issuer: string, values: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, value);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

export type ConsentView = {
  siteName: string;
  datasetName: string;
  email: string;
  name: string | null;
  role: string;
  via: string;
  scopes: string[];
  fields: Record<string, string>;
  consentToken: string;
};

export type AuthorizeOutcome =
  | { kind: "error_page"; error: string; message: string }
  | { kind: "no_access"; clientName: string }
  | { kind: "redirect"; location: string }
  | { kind: "consent"; view: ConsentView };

export type AuthorizeDeps = {
  db: ClientLookupDb & AuthCodeStore & AuditWriter & Parameters<typeof hasConsent>[0];
  resolveAccess: (userId: string, siteId: string) => Promise<CraftAccessResult | null>;
  consentSecret: Buffer;
  issuer: string;
  now?: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
};

function redirectError(outcome: Extract<ValidationOutcome, { kind: "redirect_error" }>, issuer: string): AuthorizeOutcome {
  return {
    kind: "redirect",
    location: buildRedirect(outcome.redirectUri, issuer, {
      error: outcome.error,
      error_description: outcome.description,
      state: outcome.state
    })
  };
}

async function issueAndRedirect(deps: AuthorizeDeps, userId: string, request: AuthorizeRequest, access: CraftAccessResult): Promise<AuthorizeOutcome> {
  const now = deps.now ?? new Date();
  const { code } = await issueAuthCode(deps.db, {
    oidcClientId: request.client.id,
    userId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    nonce: request.nonce,
    scope: request.scopes.join(" "),
    authTime: now,
    now
  });
  await writeOidcAuditBestEffort(deps.db, {
    organizationId: request.client.organizationId,
    actorId: userId,
    action: "oidc.code.issue",
    resourceType: "oidc_client",
    resourceId: request.client.id,
    details: { role: access.role, via: access.via },
    ipAddress: deps.ipAddress,
    userAgent: deps.userAgent
  });
  return { kind: "redirect", location: buildRedirect(request.redirectUri, deps.issuer, { code, state: request.state }) };
}

/** The app's own name for people: the client is registered as "<app> Craft", but the approval page talks about the app. Display only. */
export function appDisplayName(name: string): string {
  const trimmed = name.replace(/[\s\-–—:|]*\bCraft\b\s*$/i, "").trim();
  return trimmed.length > 0 ? trimmed : name;
}

function bindingFor(userId: string, request: AuthorizeRequest): ConsentBinding {
  return {
    userId,
    clientId: request.client.clientId,
    redirectUri: request.redirectUri,
    state: request.state,
    nonce: request.nonce,
    codeChallenge: request.codeChallenge,
    scope: request.scopes.join(" ")
  };
}

/** GET /oidc/authorize for a signed-in user. */
export async function processAuthorize(deps: AuthorizeDeps, userId: string, params: RawParams): Promise<AuthorizeOutcome> {
  const validated = await validateAuthorizeRequest(deps.db, params);
  if (validated.kind === "error_page") return validated;
  if (validated.kind === "redirect_error") return redirectError(validated, deps.issuer);
  const { request } = validated;

  const access = await deps.resolveAccess(userId, request.client.siteId);
  if (!access) return { kind: "no_access", clientName: appDisplayName(request.client.name) };

  if (await hasConsent(deps.db, userId, request.client.id, request.scopes)) {
    return issueAndRedirect(deps, userId, request, access);
  }

  return {
    kind: "consent",
    view: {
      siteName: appDisplayName(request.client.name),
      datasetName: request.client.datasetName,
      email: access.user.email,
      name: access.user.name,
      role: access.role,
      via: access.via,
      scopes: request.scopes,
      fields: {
        client_id: request.client.clientId,
        redirect_uri: request.redirectUri,
        state: request.state,
        nonce: request.nonce,
        code_challenge: request.codeChallenge,
        code_challenge_method: CODE_CHALLENGE_METHOD,
        response_type: "code",
        scope: request.scopes.join(" ")
      },
      consentToken: signConsentToken(deps.consentSecret, bindingFor(userId, request), deps.now)
    }
  };
}

/** POST /oidc/authorize/consent: the request is re-validated from scratch, never trusted from the form. */
export async function processConsent(
  deps: AuthorizeDeps,
  userId: string,
  fields: RawParams,
  decision: "allow" | "deny",
  consentToken: unknown
): Promise<AuthorizeOutcome> {
  const validated = await validateAuthorizeRequest(deps.db, fields);
  if (validated.kind === "error_page") return validated;
  if (validated.kind === "redirect_error") return redirectError(validated, deps.issuer);
  const { request } = validated;

  if (!verifyConsentToken(deps.consentSecret, bindingFor(userId, request), consentToken, deps.now)) {
    return { kind: "error_page", error: "invalid_request", message: "This approval page expired. Return to the site and sign in again." };
  }
  if (decision !== "allow") {
    return redirectError({ kind: "redirect_error", redirectUri: request.redirectUri, error: "access_denied", description: "The user denied the request", state: request.state }, deps.issuer);
  }

  const access = await deps.resolveAccess(userId, request.client.siteId);
  if (!access) return { kind: "no_access", clientName: appDisplayName(request.client.name) };

  await recordConsent(deps.db, userId, request.client.id, request.scopes, deps.now);
  await writeOidcAudit(deps.db, {
    organizationId: request.client.organizationId,
    actorId: userId,
    action: "oidc.consent.grant",
    resourceType: "oidc_client",
    resourceId: request.client.id,
    details: { scope: request.scopes.join(" ") },
    ipAddress: deps.ipAddress,
    userAgent: deps.userAgent
  });
  return issueAndRedirect(deps, userId, request, access);
}
