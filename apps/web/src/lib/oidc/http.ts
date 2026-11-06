import { isOidcEnabled, readOidcConfig, type OidcConfig } from "./config";
import { loadOidcKeys, type OidcKeys } from "./keys";

/** Every response from these routes: never cached, never framed, never sniffed. */
export const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff"
};

export function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra }
  });
}

export function notFoundResponse(): Response {
  return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** For methods a route does not implement: 404 while the flag is off, 405 once it is on. */
export function disallowed(allow: string) {
  return async function handler(): Promise<Response> {
    if (!isOidcEnabled()) return notFoundResponse();
    return new Response(null, { status: 405, headers: { ...BASE_HEADERS, Allow: allow } });
  };
}

export type OidcRuntime = { config: OidcConfig; keys: OidcKeys };
export type GateResult = { ok: true; runtime: OidcRuntime } | { ok: false; response: Response };

/**
 * First statement of every OIDC handler. Flag off: 404, nothing else runs.
 * Flag on but misconfigured: 503 and a log line naming variables only.
 */
export async function gateOidc(): Promise<GateResult> {
  if (!isOidcEnabled()) return { ok: false, response: notFoundResponse() };
  const result = readOidcConfig();
  if (!result.ok) {
    console.error(`[oidc] misconfigured: ${result.problems.join(", ")}`);
    return { ok: false, response: jsonResponse(503, { error: "server_error", error_description: "OpenID Connect is not available" }) };
  }
  try {
    return { ok: true, runtime: { config: result.config, keys: await loadOidcKeys(result.config) } };
  } catch (error) {
    console.error(`[oidc] key configuration invalid: ${error instanceof Error ? error.message : "unknown"}`);
    return { ok: false, response: jsonResponse(503, { error: "server_error", error_description: "OpenID Connect is not available" }) };
  }
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip")?.trim() || "unknown";
}
