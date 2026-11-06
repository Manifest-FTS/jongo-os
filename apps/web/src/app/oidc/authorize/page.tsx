import { notFound, redirect } from "next/navigation";
import { OidcConsentCard, OidcErrorCard } from "@/components/oidc/OidcCards";
import { auth } from "@/lib/auth.config";
import { resolveCraftAccess } from "@/lib/craft-access";
import { getDb } from "@/lib/db";
import { processAuthorize, type AuthorizeOutcome, type RawParams } from "@/lib/oidc/authorize";
import { isOidcEnabled, readOidcConfig } from "@/lib/oidc/config";
import { loadOidcKeys } from "@/lib/oidc/keys";
import { checkAuthorizeRate } from "@/lib/oidc/rate-limit";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<RawParams> };

function callbackFor(params: RawParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  return `/oidc/authorize?${query.toString()}`;
}

export default async function AuthorizePage({ searchParams }: Props) {
  // Flag off: indistinguishable from a route that does not exist.
  if (!isOidcEnabled()) notFound();

  const params = await searchParams;
  const config = readOidcConfig();
  if (!config.ok) {
    console.error(`[oidc] misconfigured: ${config.problems.join(", ")}`);
    return <OidcErrorCard code="unavailable" />;
  }

  const session = await auth();
  // The middleware already sent anonymous visitors to login; this also covers any bypass.
  if (!session?.user?.id) redirect(`/auth/login?callbackUrl=${encodeURIComponent(callbackFor(params))}`);

  if (!checkAuthorizeRate(session.user.id).allowed) return <OidcErrorCard code="rate_limited" />;

  let outcome: AuthorizeOutcome;
  try {
    const db = await getDb();
    if (!db) return <OidcErrorCard code="unavailable" />;
    const keys = await loadOidcKeys(config.config);
    outcome = await processAuthorize(
      { db, resolveAccess: resolveCraftAccess, consentSecret: keys.consentSecret, issuer: config.config.issuer },
      session.user.id,
      params
    );
  } catch {
    console.error("[oidc] authorize failed");
    return <OidcErrorCard code="unavailable" />;
  }

  // redirect() throws, so it stays outside the try block.
  if (outcome.kind === "redirect") redirect(outcome.location);
  if (outcome.kind === "error_page") return <OidcErrorCard code={outcome.error} />;
  if (outcome.kind === "no_access") return <OidcErrorCard code="no_access" />;

  return <OidcConsentCard view={outcome.view} />;
}
