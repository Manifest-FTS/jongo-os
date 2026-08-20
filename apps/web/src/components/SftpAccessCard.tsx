"use client";

import { useCallback, useEffect, useState } from "react";
import { showSuccessToast } from "@/lib/ui/toast";

type Connection = { host: string; port: number; username: string; protocol: string; uri: string };

type Account = {
  username: string;
  password: string;
  homePath: string;
  status: string;
  providerError: string | null;
  connection: Connection;
};

type Props = { siteId: string; canManage: boolean };

/**
 * SFTP access for the app.
 *
 * The password is masked until asked for and never auto-revealed: this card sits
 * on a dashboard that gets screen-shared with clients, and a credential that is
 * visible by default is a credential that leaks by accident.
 */
export default function SftpAccessCard({ siteId, canManage }: Props) {
  const [configured, setConfigured] = useState(true);
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/sites/${siteId}/sftp`);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        setError(payload?.message ?? "SFTP access could not be loaded.");
        return;
      }
      setConfigured(Boolean(payload.configured));
      setAccount(payload.account ?? null);
    } catch {
      setError("SFTP access could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(method: "POST" | "DELETE", body?: Record<string, unknown>, fallback = "Done.") {
    setBusy(true);
    setError(null);
    setCopied(null);
    try {
      const response = await fetch(`/api/sites/${siteId}/sftp`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        setError(payload?.message ?? "That didn't work.");
        return;
      }
      setConfigured(Boolean(payload.configured));
      setAccount(payload.account ?? null);
      setRevealed(false);
      setConfirmingRevoke(false);
      showSuccessToast(payload.message ?? fallback);
    } catch {
      setError("The request did not complete.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setError("Couldn't copy — select the value and copy it manually.");
    }
  }

  function Row({ label, value, copyable = true }: { label: string; value: string; copyable?: boolean }) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>{label}</p>
          <p style={{ margin: "0.1rem 0 0", fontSize: "0.9rem", fontFamily: "ui-monospace, monospace", overflowWrap: "anywhere" }}>
            {value}
          </p>
        </div>
        {copyable ? (
          <button type="button" className="button button-secondary" onClick={() => copy(label, value)} style={{ flexShrink: 0 }}>
            {copied === label ? "Copied" : "Copy"}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <h3 className="card-title" style={{ margin: 0 }}>SFTP Access</h3>

      {loading ? (
        <p style={{ margin: "0.7rem 0 0", fontSize: "0.9rem", color: "var(--muted)" }}>Checking SFTP access…</p>
      ) : !configured ? (
        <p style={{ margin: "0.7rem 0 0", fontSize: "0.9rem", color: "var(--muted)" }}>
          SFTP is not set up on this platform yet.
        </p>
      ) : !account ? (
        <>
          <p style={{ margin: "0.7rem 0 0", fontSize: "0.9rem", color: "var(--muted)" }}>
            Create an SFTP account to upload and download this app&apos;s files with FileZilla, Cyberduck or any
            SFTP client. Access is limited to this app&apos;s files — no other site on the server is reachable.
          </p>
          <button
            type="button"
            className="btn"
            style={{ marginTop: "0.85rem" }}
            onClick={() => send("POST", {}, "SFTP access is ready.")}
            disabled={!canManage || busy}
          >
            {busy ? "Setting up…" : "Set up SFTP access"}
          </button>
        </>
      ) : (
        <div style={{ marginTop: "0.85rem", display: "grid", gap: "0.8rem" }}>
          <Row label="Host" value={account.connection.host} />
          <Row label="Port" value={String(account.connection.port)} />
          <Row label="Username" value={account.connection.username} />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>Password</p>
              <p style={{ margin: "0.1rem 0 0", fontSize: "0.9rem", fontFamily: "ui-monospace, monospace", overflowWrap: "anywhere" }}>
                {revealed ? account.password : "•".repeat(20)}
              </p>
            </div>
            <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
              <button type="button" className="button button-secondary" onClick={() => setRevealed((v) => !v)}>
                {revealed ? "Hide" : "Reveal"}
              </button>
              <button type="button" className="button button-secondary" onClick={() => copy("Password", account.password)}>
                {copied === "Password" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: "0.8rem" }}>
            <Row label="Quick connect" value={account.connection.uri} />
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
              In FileZilla choose <strong>SFTP – SSH File Transfer Protocol</strong>, then enter the host, port,
              username and password above. In Cyberduck, paste the quick-connect address and it fills the rest.
            </p>
          </div>

          {account.status === "failed" ? (
            <p className="form-error" style={{ margin: 0 }}>
              The last change did not reach the SFTP service ({account.providerError ?? "unknown"}). These
              credentials may not work — try regenerating them.
            </p>
          ) : null}

          {canManage ? (
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: "0.8rem" }}>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => send("POST", { rotate: true }, "A new SFTP password has been generated.")}
                disabled={busy}
                // Said plainly, because anyone already connected will be cut off.
                title="Generates a new password. Anyone using the current one will lose access."
              >
                Regenerate password
              </button>
              {confirmingRevoke ? (
                <>
                  <button type="button" className="btn" onClick={() => send("DELETE", undefined, "SFTP access revoked.")} disabled={busy}>
                    Confirm revoke
                  </button>
                  <button type="button" className="button button-secondary" onClick={() => setConfirmingRevoke(false)} disabled={busy}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className="button button-secondary" onClick={() => setConfirmingRevoke(true)} disabled={busy}>
                  Revoke access
                </button>
              )}
            </div>
          ) : null}
        </div>
      )}

      {error ? <p className="form-error" style={{ margin: "0.6rem 0 0" }}>{error}</p> : null}
    </div>
  );
}
