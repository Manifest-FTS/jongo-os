"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import BrandLogo from "@/components/BrandLogo";

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
  };
};

export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === "string" ? params.token : "";
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<InvitePayload | null>(null);
  const [mode, setMode] = useState<"register" | "login">("register");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
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

  async function acceptInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, email, fullName, password })
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not accept invitation.");
        return;
      }

      const signInResult = await signIn("credentials", {
        email,
        password,
        redirect: false
      });

      if (signInResult?.error) {
        router.push(`/auth/login?callbackUrl=${encodeURIComponent("/dashboard")}`);
        return;
      }

      router.push("/dashboard");
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
      ? "This invitation has already been used."
      : invite?.state === "expired"
      ? "This invitation has expired. Ask your admin for a new invite."
      : invite?.state === "revoked"
      ? "This invitation was revoked."
      : "This invitation link is invalid.";

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
          <h1 className="auth-title" style={{ marginBottom: "0.25rem" }}>Accept invitation</h1>
          <p className="auth-subtitle">
            You were invited to join {scopeLabel} as <strong>{invite.invite.role}</strong>.
          </p>
          <p className="card-muted" style={{ marginTop: "0.4rem" }}>
            Invite email: {invite.invite.email} · Expires: {new Date(invite.invite.expiresAt).toLocaleString()}
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <button className="btn" type="button" onClick={() => setMode("register")} disabled={busy || mode === "register"}>
            Create account
          </button>
          <button className="btn" type="button" onClick={() => setMode("login")} disabled={busy || mode === "login"}>
            Log in
          </button>
        </div>

        <form onSubmit={acceptInvite} className="auth-form">
          {mode === "register" ? (
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
            <input
              id="password"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error ? <p className="auth-error">{error}</p> : null}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "Accepting invitation…" : mode === "register" ? "Create account and join" : "Log in and join"}
          </button>
        </form>

        <p className="auth-link-row">
          Already signed in? <Link href="/dashboard">Go to dashboard</Link>
        </p>
      </div>
    </div>
  );
}
