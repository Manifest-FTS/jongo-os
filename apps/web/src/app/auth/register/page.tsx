"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { DM_Sans, Inter } from "next/font/google";
import BrandLogo from "@/components/BrandLogo";
import SelectedPlanNotice from "@/components/SelectedPlanNotice";
import { EyeIcon, EyeOffIcon } from "@/components/JongoIcons";
import { getCredentialSignInErrorMessage } from "@/lib/auth-error-message";

const authHeadings = DM_Sans({ subsets: ["latin"], weight: ["500", "700"], display: "swap", variable: "--font-auth-heading" });
const authBody = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap", variable: "--font-auth-body" });

/** Where to land after signup, e.g. back on the domain order the visitor started. */
function postSignupPath(): string {
  const raw = new URLSearchParams(window.location.search).get("callbackUrl");
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
}

export default function RegisterPage() {
  const router = useRouter();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
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
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          username: username.trim().toLowerCase(),
          email: email.trim().toLowerCase(),
          password
        })
      });

      const payload = await response.json();

      if (!response.ok) {
        setError(payload?.error || "Could not create account.");
        setLoading(false);
        return;
      }

      const result = await signIn("credentials", {
        email: email.trim().toLowerCase(),
        password,
        redirect: false
      });

      setLoading(false);

      if (result?.error) {
        if (result.error === "CredentialsSignin") {
          router.push(`/auth/login?callbackUrl=${encodeURIComponent(postSignupPath())}`);
          return;
        }

        setError(getCredentialSignInErrorMessage(result.error));
        return;
      }

      // New accounts default to collaborator. Signup must never auto-start billing.
      router.push(postSignupPath());
    } catch {
      setLoading(false);
      setError("Could not create account.");
    }
  }

  return (
    <div className={`auth-page auth-register-page ${authHeadings.variable} ${authBody.variable}`}>
      <div className="auth-card auth-panel auth-register-card">
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

        <form onSubmit={handleSubmit} className="auth-form auth-register-form">
          <div className="auth-name-grid">
            <div className="auth-field">
              <label htmlFor="firstName">First name</label>
              <input
                id="firstName"
                type="text"
                autoComplete="given-name"
                maxLength={80}
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>
            <div className="auth-field">
              <label htmlFor="lastName">Last name</label>
              <input
                id="lastName"
                type="text"
                autoComplete="family-name"
                maxLength={80}
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
          </div>

          <div className="auth-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9._-]{3,32}"
              title="Use 3–32 letters, numbers, dots, underscores, or dashes."
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-describedby="username-hint"
            />
            <span id="username-hint" className="auth-field-hint">3–32 characters: letters, numbers, dots, underscores, or dashes.</span>
          </div>

          <div className="auth-field">
            <label htmlFor="email">Email address</label>
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

          {error && <p className="auth-error" role="alert">{error}</p>}

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