"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, Suspense } from "react";
import BrandLogo from "@/components/BrandLogo";
import { EyeIcon, EyeOffIcon } from "@/components/JongoIcons";
import { getCredentialSignInErrorMessage } from "@/lib/auth-error-message";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams?.get("callbackUrl") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email: email.trim().toLowerCase(),
      password,
      redirect: false
    });

    setLoading(false);

    if (result?.error) {
      setError(getCredentialSignInErrorMessage(result.error));
    } else if (result?.ok) {
      router.push(callbackUrl);
    } else {
      setError("Sign-in did not complete. Please try again.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="auth-form">
      <div className="auth-field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="auth-field">
        <label htmlFor="password">Password</label>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", paddingRight: "40px", boxSizing: "border-box" }}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            style={{
              position: "absolute",
              right: "10px",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "inherit",
              opacity: 0.6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0
            }}
          >
            {showPassword ? (
              <EyeOffIcon style={{ width: "20px", height: "20px" }} />
            ) : (
              <EyeIcon style={{ width: "20px", height: "20px" }} />
            )}
          </button>
        </div>
      </div>
      {error && <p className="auth-error">{error}</p>}
      <button type="submit" className="auth-submit" disabled={loading}>
        {loading ? "Signing in…" : "Sign in"}
      </button>
      <p className="auth-link-row">
        <Link href="/auth/forgot-password" className="auth-inline-link">Forgot password?</Link>
      </p>
      <p className="auth-link-row">
        Need an account? <Link href="/auth/register">Create one</Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="auth-page">
      <div className="auth-card auth-panel">
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
          <h1 className="auth-title">Sign in to your account</h1>
          <p className="auth-subtitle">
            Or <Link href="/auth/register" className="auth-inline-link">create a new account</Link>
          </p>
        </div>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
