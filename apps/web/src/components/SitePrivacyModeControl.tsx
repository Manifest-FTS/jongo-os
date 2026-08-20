"use client";

import { useCallback, useEffect, useState } from "react";
import { showSuccessToast } from "@/lib/ui/toast";

type Props = {
  siteId: string;
  isWordPress: boolean;
  canToggle: boolean;
  isCollaboratorView: boolean;
};

type PrivacyState = {
  enabled: boolean;
  username: string;
  password: string | null;
  providerState: string | null;
  providerError: string | null;
};

/**
 * Privacy Mode.
 *
 * Every value here comes from the server. The version this replaces held the
 * toggle in local state and its "Update" button only raised a success toast, so
 * a site could be reported as private while serving publicly and the claim
 * vanished on refresh. Nothing in this component now reports success that the
 * API has not confirmed.
 */
export default function SitePrivacyModeControl({
  siteId,
  isWordPress,
  canToggle,
  isCollaboratorView
}: Props) {
  const [state, setState] = useState<PrivacyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameDraft, setUsernameDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const applyPayload = useCallback((payload: PrivacyState) => {
    setState(payload);
    setUsernameDraft(payload.username);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/sites/${siteId}/privacy-mode`);
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok || !payload?.ok) {
          setError(payload?.message ?? "Privacy mode status could not be loaded.");
          return;
        }
        applyPayload(payload);
      } catch {
        if (!cancelled) setError("Privacy mode status could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [siteId, applyPayload]);

  async function send(body: Record<string, unknown>, successFallback: string) {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch(`/api/sites/${siteId}/privacy-mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        // The site's real state is whatever the server just reported, so leave
        // the toggle where it was rather than showing the change as accepted.
        setError(payload?.message ?? "Privacy mode could not be changed.");
        return;
      }
      applyPayload(payload);
      showSuccessToast(payload.message ?? successFallback);
    } catch {
      setError("Privacy mode could not be changed — the request did not complete.");
    } finally {
      setBusy(false);
    }
  }

  const unavailable = !isWordPress;
  const disabled = unavailable || !canToggle || busy || loading;
  const enabled = Boolean(state?.enabled);

  const detail = unavailable
    ? "Privacy mode is currently only available for WordPress sites."
    : enabled
      ? "This site is in privacy mode, which means visitors and search engines will not be able to discover your content without entering the password. Ready for the world to see your site? Feel free to turn off privacy mode at any time."
      : "This site is not in privacy mode, which means visitors and search engines can discover your content. Need to make changes before everyone sees them? Turn on privacy mode at any time.";

  async function onCopyPassword() {
    if (!state?.password) return;
    try {
      await navigator.clipboard.writeText(state.password);
      setCopied(true);
    } catch {
      setError("Couldn't copy to the clipboard — select the password and copy it manually.");
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
        <h3 className="card-title" style={{ margin: 0 }}>Privacy Mode</h3>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle privacy mode"
          onClick={() => send({ enabled: !enabled }, enabled ? "Privacy mode off." : "Privacy mode on.")}
          disabled={disabled}
          style={{
            width: "52px",
            height: "30px",
            borderRadius: "999px",
            border: "1px solid var(--border)",
            background: enabled ? "rgba(var(--privacy-green-rgb), 0.18)" : "var(--surface)",
            display: "inline-flex",
            alignItems: "center",
            padding: "0 4px",
            justifyContent: enabled ? "flex-end" : "flex-start",
            cursor: disabled ? "not-allowed" : "pointer"
          }}
          title={
            unavailable
              ? "Privacy mode is only available for WordPress sites."
              : !canToggle
                ? "You do not have permission to change privacy mode."
                : "Toggle privacy mode"
          }
        >
          <span
            aria-hidden
            style={{
              width: "20px",
              height: "20px",
              borderRadius: "999px",
              background: enabled ? "var(--privacy-green)" : "#cbd5e1",
              transition: "all 160ms ease"
            }}
          />
        </button>
      </div>

      <p style={{ margin: "0.7rem 0 0", fontSize: "0.9rem", color: "var(--muted)" }}>
        {loading && !unavailable ? "Checking privacy mode…" : detail}
      </p>

      {busy ? (
        <p style={{ margin: "0.35rem 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
          Updating the site&apos;s access settings…
        </p>
      ) : null}

      {error ? <p className="form-error" style={{ margin: "0.35rem 0 0" }}>{error}</p> : null}

      {/* The proxy and the database can disagree. Saying so is the whole point:
          a site believed private while serving publicly is the failure that
          matters, and only an operator can act on it. */}
      {!isCollaboratorView && state?.providerState === "failed" ? (
        <p className="form-error" style={{ margin: "0.35rem 0 0" }}>
          The last change did not reach the server ({state.providerError ?? "unknown"}). The site&apos;s access may
          not match the setting above — try again.
        </p>
      ) : null}

      {enabled && state ? (
        <div style={{ marginTop: "0.95rem", paddingTop: "0.95rem", borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "grid", gap: "0.8rem" }}>
            <label style={{ display: "grid", gap: "0.35rem" }}>
              <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>Username</span>
              <input
                className="form-input"
                value={usernameDraft}
                onChange={(event) => setUsernameDraft(event.target.value.toLowerCase().replace(/\s+/g, ""))}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
              />
            </label>

            <label style={{ display: "grid", gap: "0.35rem" }}>
              <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>Current Password</span>
              <input
                className="form-input"
                value={state.password ?? ""}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
                autoComplete="off"
                spellCheck={false}
              />
            </label>

            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button type="button" className="btn" onClick={onCopyPassword} disabled={!state.password}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => send({ enabled: true, username: usernameDraft }, "Privacy credentials updated.")}
                disabled={disabled || !usernameDraft || usernameDraft === state.username}
              >
                Save username
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  send({ enabled: true, username: usernameDraft, regenerate: true }, "New password generated.")
                }
                disabled={disabled}
              >
                Regenerate password
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
