import Link from "next/link";

export default function AuthErrorPage() {
  return (
    <div className="auth-page">
      <div className="auth-card card">
        <p className="tag" style={{ marginBottom: "0.4rem" }}>Jongo</p>
        <h1 style={{ margin: 0 }}>
          <span className="brand-text">Auth error</span>
        </h1>
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
