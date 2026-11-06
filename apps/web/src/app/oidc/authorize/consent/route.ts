import { auth } from "@/lib/auth.config";
import { resolveCraftAccess } from "@/lib/craft-access";
import { getDb } from "@/lib/db";
import { processConsent, type AuthorizeOutcome, type RawParams } from "@/lib/oidc/authorize";
import { BASE_HEADERS, clientIp, disallowed, gateOidc } from "@/lib/oidc/http";
import { checkAuthorizeRate } from "@/lib/oidc/rate-limit";

export const dynamic = "force-dynamic";

function see(location: string): Response {
  // 303 so the browser follows with GET; the referrer is withheld because the URL carries the code.
  return new Response(null, { status: 303, headers: { ...BASE_HEADERS, Location: location, "Referrer-Policy": "no-referrer" } });
}

/** POST /oidc/authorize/consent: session + same-origin + signed token bound to the exact request. */
export async function POST(request: Request): Promise<Response> {
  const gate = await gateOidc();
  if (!gate.ok) return gate.response;
  const { config, keys } = gate.runtime;

  if (request.headers.get("origin") !== config.issuer) return see("/oidc/error?e=origin");

  const session = await auth();
  if (!session?.user?.id) return see("/auth/login");
  if (!checkAuthorizeRate(session.user.id).allowed) return see("/oidc/error?e=rate_limited");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return see("/oidc/error?e=invalid_request");
  }
  const fields: RawParams = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string") return see("/oidc/error?e=invalid_request");
    fields[name] = name in fields ? [String(fields[name]), value] : value;
  }
  const decision = fields.decision === "allow" ? "allow" : "deny";
  delete fields.decision;
  const consentToken = fields.consent_token;
  delete fields.consent_token;

  let outcome: AuthorizeOutcome;
  try {
    const db = await getDb();
    if (!db) return see("/oidc/error?e=unavailable");
    outcome = await processConsent(
      {
        db, resolveAccess: resolveCraftAccess, consentSecret: keys.consentSecret, issuer: config.issuer,
        ipAddress: clientIp(request), userAgent: request.headers.get("user-agent")
      },
      session.user.id, fields, decision, consentToken
    );
  } catch {
    console.error("[oidc] consent failed");
    return see("/oidc/error?e=unavailable");
  }

  if (outcome.kind === "redirect") return see(outcome.location);
  if (outcome.kind === "no_access") return see("/oidc/error?e=no_access");
  if (outcome.kind === "error_page") return see(`/oidc/error?e=${encodeURIComponent(outcome.error)}`);
  return see("/oidc/error?e=unavailable");
}

export const GET = disallowed("POST");
export const PUT = disallowed("POST");
export const PATCH = disallowed("POST");
export const DELETE = disallowed("POST");
export const OPTIONS = disallowed("POST");
