import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";

export default function AuthErrorPage() {
  return (
    <div className="auth-page">
      <div className="auth-card auth-panel card">
        <div className="auth-brand-block">
          <Link href="/" className="auth-logo-link" aria-label="Go to home">
            <BrandLogo
              src="/assets/images/jongo-logo-color.png"
              alt="Jongo"
              width={132}
              height={40}
              fallbackText="Jongo"
            />
          </Link>
        </div>
        <h1 className="auth-title" style={{ marginTop: 0 }}>Authentication error</h1>
        <p className="card-muted" style={{ marginTop: "0.4rem", marginBottom: "1.5rem" }}>
          Something went wrong during sign-in. Please try again.
        </p>
        <Link href="/auth/login" className="auth-submit" style={{ display: "inline-block", textAlign: "center", textDecoration: "none" }}>
          Back to login
        </Link>
      </div>
    </div>
  );
}
