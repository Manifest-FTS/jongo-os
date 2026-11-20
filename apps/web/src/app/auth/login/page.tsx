"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, Suspense } from "react";
import BrandLogo from "@/components/BrandLogo";
import { EyeIcon, EyeOffIcon } from "@/components/JongoIcons";
import { getCredentialSignInErrorMessage } from "@/lib/auth-error-message";

function safeCallbackUrl(raw: string | null | undefined): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
}

function registerHref(callbackUrl: string): string {
  return callbackUrl === "/dashboard" ? "/auth/register" : `/auth/register?callbackUrl=${encodeURIComponent(callbackUrl)}`;
}

function RegisterLink({ className, children }: { className?: string; children: React.ReactNode }) {
  const searchParams = useSearchParams();
  return (
    <Link href={registerHref(safeCallbackUrl(searchParams?.get("callbackUrl")))} className={className}>
      {children}
    </Link>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = safeCallbackUrl(searchParams?.get("callbackUrl"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Second step: the password was right and the account uses two-step sign-in.
  const [needsCode, setNeedsCode] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const sessionEnded = searchParams?.get("ended") === "1";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email: email.trim().toLowerCase(),
      password,
      ...(needsCode ? { code: code.trim() } : {}),
      redirect: false
    });

    setLoading(false);

    if (result?.error === "AUTH_TOTP_REQUIRED") {
      setNeedsCode(true);
      setCode("");
    } else if (result?.error) {
      setError(getCredentialSignInErrorMessage(result.error));
      if (result.error === "AUTH_TOTP_INVALID") setCode("");
    } else if (result?.ok) {
      router.push(callbackUrl);
    } else {
      setError("Sign-in did not complete. Please try again.");
    }
  }

  if (needsCode) {
    return (
      <form onSubmit={handleSubmit} className="auth-form">
        <p className="auth-subtitle" style={{ marginTop: 0 }}>
          {useRecovery
            ? "Enter one of the recovery codes you saved when you turned on two-step sign-in. Each code works once."
            : "Open your authenticator app and enter the 6-digit code for Jongo."}
        </p>
        <div className="auth-field">
          <label htmlFor="code">{useRecovery ? "Recovery code" : "Authentication code"}</label>
          <input
            id="code"
            key={useRecovery ? "recovery" : "totp"}
            type="text"
            inputMode={useRecovery ? "text" : "numeric"}
            autoComplete="one-time-code"
            autoFocus
            required
            placeholder={useRecovery ? "xxxxx-xxxxx" : "123456"}
            maxLength={useRecovery ? 11 : 7}
            value={code}
            onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/[^\d ]/g, ""))}
            style={{ letterSpacing: useRecovery ? "0.08em" : "0.3em", fontVariantNumeric: "tabular-nums" }}
          />
        </div>
        {error && <p className="auth-error">{error}</p>}
        <button type="submit" className="auth-submit" disabled={loading || !code.trim()}>
          {loading ? "Checking…" : "Verify and sign in"}
        </button>
        <p className="auth-link-row">
          <button
            type="button"
            className="auth-inline-link"
            style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit" }}
            onClick={() => {
              setUseRecovery(!useRecovery);
              setCode("");
              setError("");
            }}
          >
            {useRecovery ? "Use my authenticator app instead" : "Lost your phone? Use a recovery code"}
          </button>
        </p>
        <p className="auth-link-row">
          <button
            type="button"
            className="auth-inline-link"
            style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit" }}
            onClick={() => {
              setNeedsCode(false);
              setUseRecovery(false);
              setCode("");
              setPassword("");
              setError("");
            }}
          >
            Back to sign in
          </button>
        </p>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="auth-form">
      {sessionEnded && !error ? (
        <p className="auth-subtitle" style={{ marginTop: 0 }}>You've been signed out. Sign in again to continue.</p>
      ) : null}
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
        Need an account? <Link href={registerHref(callbackUrl)}>Create one</Link>
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
            Or{" "}
            <Suspense fallback={<Link href="/auth/register" className="auth-inline-link">create a new account</Link>}>
              <RegisterLink className="auth-inline-link">create a new account</RegisterLink>
            </Suspense>
          </p>
        </div>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
