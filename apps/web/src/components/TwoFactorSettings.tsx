"use client";

import { useCallback, useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { showSuccessToast } from "@/lib/ui/toast";

type Status = {
  available: boolean;
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
};

type Setup = { secret: string; uri: string; qrSvg: string };

type Mode =
  | { kind: "idle" }
  | { kind: "setup"; setup: Setup }
  | { kind: "codes"; codes: string[]; fresh: boolean }
  | { kind: "confirm"; action: "disable" | "recovery-codes" };

async function call(body: Record<string, unknown>) {
  const res = await fetch("/api/user/two-factor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.message || "Something went wrong. Please try again.");
  return data;
}

function CodeInput({ value, onChange, allowRecovery }: { value: string; onChange: (v: string) => void; allowRecovery?: boolean }) {
  return (
    <input
      className="form-input"
      type="text"
      inputMode={allowRecovery ? "text" : "numeric"}
      autoComplete="one-time-code"
      autoFocus
      placeholder={allowRecovery ? "123456 or recovery code" : "123456"}
      maxLength={allowRecovery ? 11 : 7}
      value={value}
      onChange={(e) => onChange(allowRecovery ? e.target.value : e.target.value.replace(/[^\d ]/g, ""))}
      style={{ maxWidth: "15rem", letterSpacing: "0.15em", fontVariantNumeric: "tabular-nums" }}
    />
  );
}

/** Settings → Security: two-step sign-in with an authenticator app. */
export function TwoFactorCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showKey, setShowKey] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/user/two-factor", { cache: "no-store" });
      const data = await res.json();
      if (res.ok && data.ok) setStatus(data);
      else setError(data.message || "Couldn't load two-step sign-in.");
    } catch {
      setError("Couldn't load two-step sign-in.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const start = () =>
    run(async () => {
      const data = await call({ action: "start" });
      setCode("");
      setShowKey(false);
      setMode({ kind: "setup", setup: data });
    });

  const confirm = () =>
    run(async () => {
      const data = await call({ action: "confirm", code });
      setCode("");
      setMode({ kind: "codes", codes: data.recoveryCodes, fresh: true });
      showSuccessToast("Two-step sign-in is on.");
      await refresh();
    });

  const confirmAction = (action: "disable" | "recovery-codes") =>
    run(async () => {
      const data = await call({ action, code });
      setCode("");
      if (action === "disable") {
        setMode({ kind: "idle" });
        showSuccessToast("Two-step sign-in is off.");
      } else {
        setMode({ kind: "codes", codes: data.recoveryCodes, fresh: false });
        showSuccessToast("New recovery codes created.");
      }
      await refresh();
    });

  const copyCodes = async (codes: string[]) => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      showSuccessToast("Recovery codes copied.");
    } catch {
      setError("Couldn't copy. Select the codes and copy them by hand.");
    }
  };

  const downloadCodes = (codes: string[]) => {
    const text = ["Jongo recovery codes", "Each code works once.", "", ...codes, ""].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "jongo-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  const cancel = () => {
    setMode({ kind: "idle" });
    setCode("");
    setError("");
  };

  return (
    <article className="card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
        <h3 className="card-title" style={{ margin: 0 }}>Two-step sign-in</h3>
        {status ? (
          <span className={`status-chip ${status.enabled ? "healthy" : "unknown"}`}>
            {status.enabled ? "On" : "Off"}
          </span>
        ) : null}
      </div>

      <p className="card-muted" style={{ marginTop: "0.5rem" }}>
        Ask for a code from an authenticator app (such as Google Authenticator, 1Password or Authy) each time you sign in, so a stolen
        password isn't enough to get into your account.
      </p>

      {!status && !error ? <p className="card-muted">Loading…</p> : null}

      {status && !status.available ? (
        <p className="card-muted" style={{ marginBottom: 0 }}>
          Your account signs in through another provider. Turn on two-step sign-in with that provider.
        </p>
      ) : null}

      {status?.available && mode.kind === "idle" ? (
        status.enabled ? (
          <div style={{ display: "grid", gap: "0.75rem" }}>
            <p style={{ margin: 0, fontSize: "0.92rem" }}>
              On since {status.enabledAt ? new Date(status.enabledAt).toLocaleDateString(undefined, { dateStyle: "medium" }) : "recently"}.{" "}
              {status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? "" : "s"} left.
            </p>
            {status.recoveryCodesLeft <= 3 ? (
              <p className="card-muted" style={{ margin: 0, color: "var(--warning, #b45309)" }}>
                You're running low on recovery codes. Create new ones so you can still get in if you lose your phone.
              </p>
            ) : null}
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => { setError(""); setMode({ kind: "confirm", action: "recovery-codes" }); }}>
                New recovery codes
              </button>
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => { setError(""); setMode({ kind: "confirm", action: "disable" }); }}>
                Turn off
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={start}>
            {busy ? "Preparing…" : "Turn on two-step sign-in"}
          </button>
        )
      ) : null}

      {mode.kind === "setup" ? (
        <div style={{ display: "grid", gap: "1rem" }}>
          <ol style={{ margin: 0, paddingLeft: "1.2rem", display: "grid", gap: "0.35rem", fontSize: "0.92rem" }}>
            <li>Open your authenticator app and add an account.</li>
            <li>Scan this QR code, or enter the setup key by hand.</li>
            <li>Type the 6-digit code the app shows.</li>
          </ol>
          <div style={{ display: "flex", gap: "1.25rem", alignItems: "center", flexWrap: "wrap" }}>
            <div
              role="img"
              aria-label="QR code for your authenticator app"
              style={{ width: 176, height: 176, padding: 8, background: "#fff", borderRadius: 12, border: "1px solid var(--border)" }}
              dangerouslySetInnerHTML={{ __html: mode.setup.qrSvg }}
            />
            <div style={{ display: "grid", gap: "0.4rem", minWidth: 0 }}>
              <button type="button" className="auth-inline-link" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left", font: "inherit" }} onClick={() => setShowKey(!showKey)}>
                {showKey ? "Hide setup key" : "Can't scan? Show the setup key"}
              </button>
              {showKey ? (
                <code style={{ fontSize: "0.95rem", letterSpacing: "0.05em", wordBreak: "break-all", userSelect: "all" }}>{mode.setup.secret}</code>
              ) : null}
              <a href={mode.setup.uri} className="card-muted" style={{ fontSize: "0.85rem" }}>
                On this phone? Open in your authenticator app
              </a>
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
            style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}
          >
            <CodeInput value={code} onChange={setCode} />
            <button type="submit" className="btn" disabled={busy || code.replace(/\s/g, "").length !== 6}>
              {busy ? "Checking…" : "Turn on"}
            </button>
            <button type="button" className="button button-secondary" onClick={cancel} disabled={busy}>
              Cancel
            </button>
          </form>
        </div>
      ) : null}

      {mode.kind === "codes" ? (
        <div style={{ display: "grid", gap: "0.85rem" }}>
          <p style={{ margin: 0, fontSize: "0.92rem" }}>
            <strong>Save these recovery codes now.</strong> If you lose your phone, each one lets you sign in once. They won't be shown again.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))",
              gap: "0.4rem 1rem",
              padding: "0.9rem 1rem",
              borderRadius: 10,
              border: "1px solid var(--border)",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "0.95rem",
              userSelect: "all"
            }}
          >
            {mode.codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" className="button button-secondary" onClick={() => copyCodes(mode.codes)}>Copy</button>
            <button type="button" className="button button-secondary" onClick={() => downloadCodes(mode.codes)}>Download</button>
            <button type="button" className="btn" onClick={cancel}>I've saved them</button>
          </div>
        </div>
      ) : null}

      {mode.kind === "confirm" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void confirmAction(mode.action);
          }}
          style={{ display: "grid", gap: "0.6rem" }}
        >
          <p style={{ margin: 0, fontSize: "0.92rem" }}>
            {mode.action === "disable"
              ? "To turn off two-step sign-in, enter a code from your authenticator app or a recovery code."
              : "To create new recovery codes, enter a code from your authenticator app. Your old recovery codes will stop working."}
          </p>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <CodeInput value={code} onChange={setCode} allowRecovery={mode.action === "disable"} />
            <button type="submit" className="btn" disabled={busy || !code.trim()}>
              {busy ? "Checking…" : mode.action === "disable" ? "Turn off" : "Create new codes"}
            </button>
            <button type="button" className="button button-secondary" onClick={cancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {error ? <p className="auth-error" style={{ marginBottom: 0, color: "var(--danger, #b91c1c)" }}>{error}</p> : null}
    </article>
  );
}

/** Settings → Security: end every session, this one included. */
export function SignOutEverywhereCard() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/user/sessions", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || "Couldn't sign out everywhere. Please try again.");
      await signOut({ callbackUrl: "/auth/login?ended=1" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <article className="card">
      <h3 className="card-title">Sign out everywhere</h3>
      <p className="card-muted">
        Sign out of Jongo on every computer and phone, including this one. Use this if you signed in on a shared device or think someone else
        has your password.
      </p>
      {confirming ? (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" className="btn" disabled={busy} onClick={run}>
            {busy ? "Signing out…" : "Yes, sign out everywhere"}
          </button>
          <button type="button" className="button button-secondary" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="button button-secondary" onClick={() => setConfirming(true)}>
          Sign out everywhere
        </button>
      )}
      {error ? <p className="auth-error" style={{ marginBottom: 0, color: "var(--danger, #b91c1c)" }}>{error}</p> : null}
    </article>
  );
}
