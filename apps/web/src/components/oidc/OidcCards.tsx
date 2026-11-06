// Vitest compiles JSX with the classic runtime, so React must be in scope.
import React, { type ReactNode } from "react";
import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import SignOutButton from "@/components/auth/SignOutButton";
import type { ConsentView } from "@/lib/oidc/authorize";
import { oidcErrorMessage, type OidcErrorIcon } from "@/lib/oidc/messages";

// Every string on these cards is rendered as React text, never as markup. Titles and names are data, not HTML.

const ROLE_LABELS: Record<string, string> = { reader: "Reader", editor: "Editor", publisher: "Publisher", admin: "Admin" };

export function roleLabel(role: string): string {
  return Object.prototype.hasOwnProperty.call(ROLE_LABELS, role) ? ROLE_LABELS[role] : role;
}

/** Up to two initials from the name, else the first letter of the email. */
export function initialsFor(name: string | null, email: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const source = words.length > 1 ? [words[0], words[words.length - 1]] : words.length === 1 ? [words[0]] : [email.trim()];
  const letters = source.map((word) => Array.from(word)[0] ?? "").join("");
  return (letters || "?").toLocaleUpperCase();
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="oidc-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const ICONS: Record<OidcErrorIcon | "user" | "mail" | "badge", ReactNode> = {
  link: <Svg><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /><path d="M4 4l16 16" /></Svg>,
  clock: <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>,
  shield: <Svg><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z" /><path d="M12 8v5" /><path d="M12 16.5v.01" /></Svg>,
  lock: <Svg><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>,
  pause: <Svg><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></Svg>,
  user: <Svg><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.6-3.6 3.4-5.5 7-5.5s6.4 1.9 7 5.5" /></Svg>,
  mail: <Svg><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="M4 7l8 6 8-6" /></Svg>,
  badge: <Svg><path d="M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 8.7l5.4-.8L12 3z" /></Svg>
};

/** Same shell as the /auth pages (`auth-page`, `auth-card`, `auth-panel`), plus a scoped modifier for this flow. */
export function OidcFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page oidc-page">
      <div className="auth-card auth-panel card oidc-card">
        <div className="auth-brand-block oidc-brand">
          <Link href="/" className="auth-logo-link" aria-label="Go to home">
            <BrandLogo src="/assets/images/jongo-logo-color.png" alt="Jongo" width={132} height={40} fallbackText="Jongo" />
          </Link>
        </div>
        {children}
      </div>
    </div>
  );
}

export function OidcErrorCard({ code }: { code: string }) {
  const { title, message, next, icon } = oidcErrorMessage(code);
  return (
    <OidcFrame>
      <div className="oidc-status">
        <span className={`oidc-status-icon oidc-status-icon--${icon}`}>{ICONS[icon]}</span>
        <h1 className="oidc-title">{title}</h1>
        <p className="oidc-lead">{message}</p>
        <p className="oidc-next"><strong>Next step</strong>{next}</p>
      </div>
    </OidcFrame>
  );
}

export function OidcConsentCard({ view }: { view: ConsentView }) {
  const superAdmin = view.via === "platform_admin";
  const identityLine = view.name ?? view.email;
  return (
    <OidcFrame>
      <p className="oidc-eyebrow">Sign in with Jongo</p>
      <h1 className="oidc-title">Sign in to {view.siteName}</h1>
      <p className="oidc-lead"><strong>{view.siteName}</strong> is asking to use your Jongo account to open its Jongo Craft editor.</p>

      <section className="oidc-identity" aria-labelledby="oidc-identity-label">
        <p className="oidc-label" id="oidc-identity-label">You&rsquo;re signing in as</p>
        <div className="oidc-identity-row">
          <span className="oidc-avatar" aria-hidden="true">{initialsFor(view.name, view.email)}</span>
          <span className="oidc-identity-text">
            <span className="oidc-identity-name">{identityLine}</span>
            {view.name ? <span className="oidc-identity-email">{view.email}</span> : null}
          </span>
        </div>
        <p className="oidc-pills">
          <span className={superAdmin ? "oidc-pill oidc-pill--platform" : "oidc-pill"} data-oidc-role={view.role}>
            {superAdmin ? "Jongo Super Admin" : roleLabel(view.role)}
          </span>
        </p>
      </section>

      <section className="oidc-list-block" aria-labelledby="oidc-receive-label">
        <h2 className="oidc-label" id="oidc-receive-label">What {view.siteName} will receive</h2>
        <ul className="oidc-list">
          {view.name ? <li>{ICONS.user}<span>Your name</span></li> : null}
          <li>{ICONS.mail}<span>Your email address</span></li>
          <li>{ICONS.badge}<span>Your role for the &ldquo;{view.datasetName}&rdquo; content: <strong>{roleLabel(view.role)}</strong></span></li>
        </ul>
        <p className="oidc-not-receive">{ICONS.lock}<span><strong>It will not receive</strong> your Jongo password or access to your other apps.</span></p>
        {superAdmin ? <p className="oidc-note">You have access through Jongo platform administration.</p> : null}
      </section>

      <form method="post" action="/oidc/authorize/consent" className="auth-form oidc-form">
        {Object.entries(view.fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <input type="hidden" name="consent_token" value={view.consentToken} />
        <button type="submit" name="decision" value="allow" className="auth-submit oidc-allow">Allow</button>
        <button type="submit" name="decision" value="deny" className="oidc-cancel">Cancel</button>
      </form>

      <p className="oidc-footer">Not you? <SignOutButton className="oidc-signout" returnHere /></p>
    </OidcFrame>
  );
}
