"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import BrandLogo from "@/components/BrandLogo";
import SelectedPlanNotice from "@/components/SelectedPlanNotice";
import { EyeIcon, EyeOffIcon } from "@/components/JongoIcons";
import { getCredentialSignInErrorMessage } from "@/lib/auth-error-message";

export default function RegisterPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, fullName, password })
      });

      const payload = await response.json();

      if (!response.ok) {
        setError(payload?.error || "Could not create account.");
        setLoading(false);
        return;
      }

      const result = await signIn("credentials", {
        email,
        password,
        redirect: false
      });

      setLoading(false);

      if (result?.error) {
        if (result.error === "CredentialsSignin") {
          router.push("/auth/login");
          return;
        }

        setError(getCredentialSignInErrorMessage(result.error));
        return;
      }

      router.push("/dashboard");
    } catch {
      setLoading(false);
      setError("Could not create account.");
    }
  }

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
          <h1 className="auth-title">Create your account</h1>
          <p className="auth-subtitle">
            Or <Link href="/auth/login" className="auth-inline-link">sign in to your existing account</Link>
          </p>
          {/* Suspense so reading the query string cannot opt the form itself
              out of prerendering. */}
          <Suspense fallback={null}>
            <SelectedPlanNotice />
          </Suspense>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-field">
            <label htmlFor="fullName">Full name</label>
            <input
              id="fullName"
              type="text"
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>

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
                autoComplete="new-password"
                required
                minLength={8}
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

          <div className="auth-field">
            <label htmlFor="confirmPassword">Confirm password</label>
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <input
                id="confirmPassword"
                type={showConfirmPassword ? "text" : "password"}
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                style={{ width: "100%", paddingRight: "40px", boxSizing: "border-box" }}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
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
                {showConfirmPassword ? (
                  <EyeOffIcon style={{ width: "20px", height: "20px" }} />
                ) : (
                  <EyeIcon style={{ width: "20px", height: "20px" }} />
                )}
              </button>
            </div>
          </div>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="auth-link-row">
          Already have an account? <Link href="/auth/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}