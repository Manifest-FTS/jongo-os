import Link from "next/link";
import { notFound } from "next/navigation";
import BrandLogo from "@/components/BrandLogo";
import { isOidcEnabled } from "@/lib/oidc/config";
import { oidcErrorMessage } from "@/lib/oidc/messages";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function OidcErrorPage({ searchParams }: Props) {
  if (!isOidcEnabled()) notFound();
  const params = await searchParams;
  const code = typeof params.e === "string" ? params.e : undefined;
  const { title, message } = oidcErrorMessage(code);
  return (
    <div className="auth-page">
      <div className="auth-card auth-panel card">
        <div className="auth-brand-block">
          <Link href="/" className="auth-logo-link" aria-label="Go to home">
            <BrandLogo src="/assets/images/jongo-logo-color.png" alt="Jongo" width={132} height={40} fallbackText="Jongo" />
          </Link>
        </div>
        <h1 className="auth-title" style={{ marginTop: 0 }}>{title}</h1>
        <p className="card-muted" style={{ marginTop: "0.4rem" }}>{message}</p>
      </div>
    </div>
  );
}
