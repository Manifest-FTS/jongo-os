"use client";

import { useCallback, useEffect, useState } from "react";
import { showSuccessToast } from "@/lib/ui/toast";

type Connection = { host: string; port: number; username: string; protocol: string; uri: string };

type PublicKey = { type: string; fingerprint: string; comment: string | null };

type Account = {
  username: string;
  /** Null when the saved password can't be read back: regenerate to recover. */
  password: string | null;
  publicKeys: PublicKey[];
  maxPublicKeys: number;
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
  const [keyInput, setKeyInput] = useState("");
  const [addingKey, setAddingKey] = useState(false);
  /** A private key Jongo just generated: offered for download once, never stored. */
  const [newPrivateKey, setNewPrivateKey] = useState<string | null>(null);

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
      if (typeof payload.privateKey === "string") setNewPrivateKey(payload.privateKey);
      if (body && "addKey" in body) {
        setKeyInput("");
        setAddingKey(false);
      }
      showSuccessToast(payload.message ?? fallback);
    } catch {
      setError("The request did not complete.");
    } finally {
      setBusy(false);
    }
  }

  function downloadPrivateKey() {
    if (!newPrivateKey || !account) return;
    const url = URL.createObjectURL(new Blob([newPrivateKey], { type: "application/x-pem-file" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${account.username}-sftp-key`;
    link.click();
    URL.revokeObjectURL(url);
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
                {account.password === null ? "Unavailable: regenerate it" : revealed ? account.password : "•".repeat(20)}
              </p>
            </div>
            <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
              <button type="button" className="button button-secondary" onClick={() => setRevealed((v) => !v)} disabled={account.password === null}>
                {revealed ? "Hide" : "Reveal"}
              </button>
              <button type="button" className="button button-secondary" onClick={() => account.password && copy("Password", account.password)} disabled={account.password === null}>
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

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: "0.8rem", display: "grid", gap: "0.55rem" }}>
            <div>
              <p style={{ margin: 0, fontSize: "0.86rem", fontWeight: 600 }}>SSH keys</p>
              <p style={{ margin: "0.15rem 0 0", fontSize: "0.8rem", color: "var(--muted)" }}>
                Log in with a key instead of the password. Paste your own public key, or let Jongo make one for you to download.
              </p>
            </div>

            {account.publicKeys.length > 0 ? (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.4rem" }}>
                {account.publicKeys.map((key) => (
                  <li key={key.fingerprint} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", padding: "0.45rem 0.6rem", border: "1px solid var(--border)", borderRadius: 8 }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: "0.84rem" }}>{key.comment || key.type}</span>
                      <span style={{ display: "block", fontSize: "0.74rem", color: "var(--muted)", fontFamily: "ui-monospace, monospace", overflowWrap: "anywhere" }}>{key.fingerprint}</span>
                    </span>
                    {canManage ? (
                      <button type="button" className="button button-secondary" style={{ flexShrink: 0 }} disabled={busy} onClick={() => send("POST", { removeKey: key.fingerprint }, "Key removed.")}>
                        Remove
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {newPrivateKey ? (
              <div style={{ padding: "0.6rem 0.7rem", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface-alt)", display: "grid", gap: "0.45rem" }}>
                <p style={{ margin: 0, fontSize: "0.82rem" }}>
                  <strong>Download your new key now.</strong> Jongo doesn&apos;t keep a copy, so it can&apos;t be shown again. In FileZilla add it under Settings → SFTP; in Cyberduck pick it as the SSH private key.
                </p>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  <button type="button" className="btn" onClick={downloadPrivateKey}>Download key</button>
                  <button type="button" className="button button-secondary" onClick={() => setNewPrivateKey(null)}>I&apos;ve saved it</button>
                </div>
              </div>
            ) : null}

            {canManage && account.publicKeys.length < account.maxPublicKeys ? (
              addingKey ? (
                <form
                  style={{ display: "grid", gap: "0.4rem" }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (keyInput.trim()) void send("POST", { addKey: keyInput }, "Key added.");
                  }}
                >
                  <textarea
                    className="form-input"
                    rows={3}
                    value={keyInput}
                    onChange={(event) => setKeyInput(event.target.value)}
                    placeholder="ssh-ed25519 AAAA… you@laptop"
                    spellCheck={false}
                    aria-label="SSH public key"
                    style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}
                  />
                  <div style={{ display: "flex", gap: "0.4rem" }}>
                    <button type="submit" className="btn" disabled={busy || !keyInput.trim()}>{busy ? "Adding…" : "Add key"}</button>
                    <button type="button" className="button button-secondary" onClick={() => { setAddingKey(false); setKeyInput(""); }}>Cancel</button>
                  </div>
                </form>
              ) : (
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  <button type="button" className="button button-secondary" disabled={busy} onClick={() => setAddingKey(true)}>Add my public key</button>
                  <button type="button" className="button button-secondary" disabled={busy} onClick={() => send("POST", { generateKey: true }, "Key created.")}>
                    {busy ? "Working…" : "Create a key for me"}
                  </button>
                </div>
              )
            ) : null}
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
