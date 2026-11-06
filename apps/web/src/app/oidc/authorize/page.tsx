import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import BrandLogo from "@/components/BrandLogo";
import { auth } from "@/lib/auth.config";
import { resolveCraftAccess } from "@/lib/craft-access";
import { getDb } from "@/lib/db";
import { processAuthorize, type AuthorizeOutcome, type RawParams } from "@/lib/oidc/authorize";
import { isOidcEnabled, readOidcConfig } from "@/lib/oidc/config";
import { loadOidcKeys } from "@/lib/oidc/keys";
import { oidcErrorMessage } from "@/lib/oidc/messages";
import { checkAuthorizeRate } from "@/lib/oidc/rate-limit";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<RawParams> };

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card auth-panel card">
        <div className="auth-brand-block">
          <Link href="/" className="auth-logo-link" aria-label="Go to home">
            <BrandLogo src="/assets/images/jongo-logo-color.png" alt="Jongo" width={132} height={40} fallbackText="Jongo" />
          </Link>
        </div>
        <h1 className="auth-title" style={{ marginTop: 0 }}>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function ErrorCard({ code }: { code: string }) {
  const { title, message } = oidcErrorMessage(code);
  return (
    <Card title={title}>
      <p className="card-muted" style={{ marginTop: "0.4rem" }}>{message}</p>
    </Card>
  );
}

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
    return <ErrorCard code="unavailable" />;
  }

  const session = await auth();
  // The middleware already sent anonymous visitors to login; this also covers any bypass.
  if (!session?.user?.id) redirect(`/auth/login?callbackUrl=${encodeURIComponent(callbackFor(params))}`);

  if (!checkAuthorizeRate(session.user.id).allowed) return <ErrorCard code="rate_limited" />;

  let outcome: AuthorizeOutcome;
  try {
    const db = await getDb();
    if (!db) return <ErrorCard code="unavailable" />;
    const keys = await loadOidcKeys(config.config);
    outcome = await processAuthorize(
      { db, resolveAccess: resolveCraftAccess, consentSecret: keys.consentSecret, issuer: config.config.issuer },
      session.user.id,
      params
    );
  } catch {
    console.error("[oidc] authorize failed");
    return <ErrorCard code="unavailable" />;
  }

  // redirect() throws, so it stays outside the try block.
  if (outcome.kind === "redirect") redirect(outcome.location);
  if (outcome.kind === "error_page") return <ErrorCard code={outcome.error} />;
  if (outcome.kind === "no_access") return <ErrorCard code="no_access" />;

  const { view } = outcome;
  return (
    <Card title={`Sign in to ${view.siteName}`}>
      <p className="card-muted" style={{ marginTop: "0.4rem" }}>
        <strong>{view.siteName}</strong> is asking to use your Jongo account to open its Craft editor.
      </p>
      <ul className="card-muted" style={{ margin: "1rem 0", paddingLeft: "1.2rem" }}>
        <li>Your email: {view.email}</li>
        {view.name ? <li>Your name: {view.name}</li> : null}
        <li>Dataset: {view.datasetName}</li>
        <li>Your role: {view.role}</li>
        {view.via === "platform_admin" ? <li>Access via Jongo platform administration</li> : null}
      </ul>
      <form method="post" action="/oidc/authorize/consent" className="auth-form">
        {Object.entries(view.fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <input type="hidden" name="consent_token" value={view.consentToken} />
        <button type="submit" name="decision" value="allow" className="auth-submit">Allow</button>
        <p className="auth-link-row">
          <button type="submit" name="decision" value="deny" className="auth-inline-link" style={{ background: "none", border: "none", cursor: "pointer" }}>
            Cancel
          </button>
        </p>
      </form>
    </Card>
  );
}
