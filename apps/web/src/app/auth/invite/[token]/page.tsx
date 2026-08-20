"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import BrandLogo from "@/components/BrandLogo";
import { getCredentialSignInErrorMessage } from "@/lib/auth-error-message";

type InvitePayload = {
  valid: boolean;
  state?: "not_found" | "revoked" | "used" | "expired";
  invite?: {
    email: string;
    role: string;
    inviteType: string;
    expiresAt: string;
    organizationName: string;
    siteName?: string | null;
    inviterName: string;
    existingUser: boolean;
    redirectTo: string;
  };
};

export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === "string" ? params.token : "";
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<InvitePayload | null>(null);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    async function loadInvite() {
      setLoading(true);
      try {
        const res = await fetch(`/api/invites/${encodeURIComponent(token)}`, { cache: "no-store" });
        const data = (await res.json()) as InvitePayload;
        setInvite(data);
        if (data.invite?.email) {
          setEmail(data.invite.email);
        }
      } catch {
        setInvite({ valid: false, state: "not_found" });
      } finally {
        setLoading(false);
      }
    }

    if (token) {
      void loadInvite();
    }
  }, [token]);

  const scopeLabel = useMemo(() => {
    if (!invite?.invite) return "team";
    if (invite.invite.inviteType === "site") {
      return invite.invite.siteName ? `app ${invite.invite.siteName}` : "app team";
    }
    return `client ${invite.invite.organizationName}`;
  }, [invite]);

  const isExistingUserFlow = Boolean(invite?.invite?.existingUser);
  const ctaLabel = isExistingUserFlow ? "Sign in and join" : "Create account and join";

  async function acceptInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          username,
          firstName,
          lastName,
          password
        })
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not accept invitation.");
        return;
      }

      const signInResult = await signIn("credentials", {
        email: email.trim().toLowerCase(),
        password,
        redirect: false
      });

      if (signInResult?.error) {
        if (signInResult.error !== "CredentialsSignin") {
          setError(getCredentialSignInErrorMessage(signInResult.error));
          return;
        }

        const callbackUrl = data.redirectTo || invite?.invite?.redirectTo || "/dashboard";
        router.push(`/auth/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
        return;
      }

      router.push(data.redirectTo || invite?.invite?.redirectTo || "/dashboard");
    } catch {
      setError("Could not accept invitation.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="auth-page">
        <div className="auth-card auth-panel card">
          <p className="card-muted">Loading invitation…</p>
        </div>
      </div>
    );
  }

  if (!invite?.valid || !invite.invite) {
    const reason = invite?.state === "used"
      ? "This invite has already been used."
      : invite?.state === "expired"
      ? "This invite has expired. Ask your admin for a new one."
      : invite?.state === "revoked"
      ? "This invite was canceled by your admin."
      : "This invite link is no longer available.";

    return (
      <div className="auth-page">
        <div className="auth-card auth-panel card">
          <h1 className="auth-title" style={{ marginTop: 0 }}>Invite unavailable</h1>
          <p className="auth-subtitle">{reason}</p>
          <p className="auth-link-row">
            <Link href="/auth/login">Go to login</Link>
          </p>
        </div>
      </div>
    );
  }

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
          <h1 className="auth-title" style={{ marginBottom: "0.25rem" }}>Join {invite.invite.inviterName}</h1>
          <p className="auth-subtitle">
            You&apos;ve been invited as collaborator.
          </p>
          <p className="card-muted" style={{ marginTop: "0.4rem" }}>
            You&apos;ve been invited as {invite.invite.role} in {scopeLabel}.
          </p>
          <p className="card-muted" style={{ marginTop: "0.25rem" }}>
            Expires: {new Date(invite.invite.expiresAt).toLocaleString()}
          </p>
        </div>

        <form onSubmit={acceptInvite} className="auth-form">
          {!isExistingUserFlow ? (
            <>
              <div className="auth-field">
                <label htmlFor="username">Username</label>
                <input
                  id="username"
                  type="text"
                  autoComplete="username"
                  required
                  minLength={3}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="kevin.adams"
                />
              </div>
              <div className="auth-name-grid">
                <div className="auth-field" style={{ marginBottom: 0 }}>
                  <label htmlFor="firstName">First name</label>
                  <input
                    id="firstName"
                    type="text"
                    autoComplete="given-name"
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </div>
                <div className="auth-field" style={{ marginBottom: 0 }}>
                  <label htmlFor="lastName">Last name</label>
                  <input
                    id="lastName"
                    type="text"
                    autoComplete="family-name"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </div>
              </div>
            </>
          ) : null}

          <div className="auth-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              readOnly
              className="auth-readonly"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={isExistingUserFlow ? "current-password" : "new-password"}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error ? <p className="auth-error">{error}</p> : null}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "Joining…" : ctaLabel}
          </button>
        </form>
      </div>
    </div>
  );
}
