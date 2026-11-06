"use client";

import { useEffect, useState } from "react";

/**
 * Push deploys for an app read with a deploy key: the webhook address to add
 * to the repository, and (for admins) a new secret, shown once.
 */
export default function GitWebhookCard({ siteId, canRotate }: { siteId: string; canRotate: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    fetch(`/api/sites/${encodeURIComponent(siteId)}/git-webhook`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setUrl(data?.url ?? null))
      .catch(() => undefined);
  }, [siteId]);

  if (!url) return null;

  async function rotate() {
    setBusy(true);
    setMessage(null);
    const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/git-webhook`, { method: "POST" }).catch(() => null);
    const data = res ? await res.json().catch(() => null) : null;
    setBusy(false);
    setConfirming(false);
    if (!data?.ok) {
      setMessage(data?.message ?? "Couldn't make a new secret. Try again.");
      return;
    }
    setSecret(data.secret);
  }

  return (
    <article className="card">
      <h3 className="card-title">Push deploys</h3>
      <p className="card-muted" style={{ marginTop: "0.25rem" }}>
        Pushes to this app&apos;s branch deploy it when the repository sends them here. Add this address as a webhook for push events, with the app&apos;s secret.
      </p>
      <label className="form-label">Webhook address</label>
      <input className="form-input mono-input" readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
      {secret ? (
        <div style={{ marginTop: "0.75rem" }}>
          <label className="form-label">New secret (shown once)</label>
          <input className="form-input mono-input" readOnly value={secret} onFocus={(event) => event.currentTarget.select()} />
          <p className="form-help">Put this in the repository&apos;s webhook settings now. The previous secret no longer works.</p>
        </div>
      ) : canRotate ? (
        <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          {confirming ? (
            <>
              <span className="form-help" style={{ margin: 0 }}>Pushes stop deploying until the repository has the new secret.</span>
              <button type="button" className="btn" disabled={busy} onClick={rotate}>{busy ? "Making…" : "Make new secret"}</button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)}>Make a new secret</button>
          )}
        </div>
      ) : null}
      {message ? <p className="auth-error" role="alert" style={{ margin: "0.5rem 0 0" }}>{message}</p> : null}
    </article>
  );
}
