import { checkRedirectUriForRegistration } from "@/lib/oidc/clients";
import { isCraftRole, type CraftRole } from "@/lib/craft-access";

export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 2048;
export const MAX_CLIENT_NAME_LENGTH = 80;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_BODY_BYTES = 16 * 1024;
/** Same rule as the Craft server (`DATASET_NAME` in jongo/craft/src/server/auth.ts). */
export const DATASET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DEFAULT_DATASET_NAME = "production";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const EMAIL_SHAPE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export function parseEmail(input: unknown): Parsed<string> {
  if (typeof input !== "string") return { ok: false, error: "email is required" };
  const email = input.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) return { ok: false, error: "email must be a valid address" };
  return { ok: true, value: email };
}

export function parseCraftRole(input: unknown): Parsed<CraftRole> {
  return isCraftRole(input) ? { ok: true, value: input } : { ok: false, error: "role must be reader, editor, publisher or admin" };
}

export function parseDatasetName(input: unknown): Parsed<string> {
  if (typeof input !== "string" || !DATASET_NAME_PATTERN.test(input)) {
    return { ok: false, error: "datasetName must be 1-64 lowercase letters, digits, dash or underscore, starting with a letter or digit" };
  }
  return { ok: true, value: input };
}

export function parseClientName(input: unknown, fallback: string): Parsed<string> {
  if (input === undefined || input === null) return { ok: true, value: fallback.slice(0, MAX_CLIENT_NAME_LENGTH) };
  if (typeof input !== "string") return { ok: false, error: "name must be a string" };
  const name = input.trim();
  if (!name || name.length > MAX_CLIENT_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, error: `name must be 1-${MAX_CLIENT_NAME_LENGTH} characters without control characters` };
  }
  return { ok: true, value: name };
}

const REASONS: Record<string, string> = {
  malformed: "is not a valid URL (no spaces, backslashes, control characters or wildcards)",
  fragment: "must not contain a fragment (#)",
  userinfo: "must not contain a username or password",
  insecure: "must use https (http is accepted only for localhost during development)",
  origin_not_allowed: "has an origin that is not allowed"
};

/** Exact https URLs; http only for loopback outside production. Rejects wildcards, fragments and userinfo. */
export function parseRedirectUris(input: unknown, production: boolean): Parsed<{ redirectUris: string[]; allowedOrigins: string[] }> {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: "redirectUris must be a non-empty list" };
  if (input.length > MAX_REDIRECT_URIS) return { ok: false, error: `at most ${MAX_REDIRECT_URIS} redirect URIs are allowed` };
  const uris: string[] = [];
  for (const [index, uri] of input.entries()) {
    if (typeof uri !== "string") return { ok: false, error: `redirect URI ${index + 1} must be a string` };
    if (uri.length > MAX_REDIRECT_URI_LENGTH) return { ok: false, error: `redirect URI ${index + 1} is too long` };
    // The origin check inside the registration rule is satisfied by construction: origins are derived from the URI itself.
    let origin: string;
    try { origin = new URL(uri).origin; } catch { return { ok: false, error: `redirect URI ${index + 1} ${REASONS.malformed}` }; }
    const check = checkRedirectUriForRegistration(uri, [origin], production);
    if (!check.ok) return { ok: false, error: `redirect URI ${index + 1} ${REASONS[check.reason] ?? "is not allowed"}` };
    if (!uris.includes(uri)) uris.push(uri);
  }
  return { ok: true, value: { redirectUris: uris, allowedOrigins: [...new Set(uris.map((uri) => new URL(uri).origin))] } };
}

export type ClientStatus = "active" | "disabled";
export function parseClientStatus(input: unknown): Parsed<ClientStatus> {
  return input === "active" || input === "disabled" ? { ok: true, value: input } : { ok: false, error: "status must be active or disabled" };
}

export function hasOnlyKeys(body: unknown, keys: readonly string[]): body is Record<string, unknown> {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key)));
}
