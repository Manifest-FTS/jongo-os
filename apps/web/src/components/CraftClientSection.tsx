"use client";

import { useEffect, useId, useRef, useState } from "react";
import { buildEnvSnippet, CRAFT_RP_ENV, type CraftClientPayload } from "@/lib/craft-admin/shared";
import { callJson, formatDay, splitUriLines } from "@/components/craft/helpers";

type Props = {
  siteId: string;
  /** Preloaded data (tests, screenshots); otherwise the section fetches it. */
  initial?: CraftClientPayload;
  onStatus: (message: string, isError?: boolean) => void;
};

type Revealed = { secret: string; kind: "created" | "rotated" };
type CreatedOrRotated = { client: NonNullable<CraftClientPayload["client"]>; clientSecret: string; issuer?: string | null };

export default function CraftClientSection({ siteId, initial, onStatus }: Props) {
  const ids = useId();
  const base = `/api/sites/${encodeURIComponent(siteId)}/craft-client`;
  const [data, setData] = useState<CraftClientPayload | null>(initial ?? null);
  const [loading, setLoading] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [uriText, setUriText] = useState(initial?.client?.redirectUris.join("\n") ?? "");
  const [dataset, setDataset] = useState(initial?.client?.datasetName ?? "production");
  const [reveal, setReveal] = useState<Revealed | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    void (async () => {
      const result = await callJson<CraftClientPayload>(base);
      if (cancelled) return;
      if (result.ok) {
        setData(result.data);
        setUriText(result.data.client?.redirectUris.join("\n") ?? "");
        setDataset(result.data.client?.datasetName ?? "production");
      } else {
        setError(result.error);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [base, initial]);

  // Move focus to the one-time secret so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (reveal) revealRef.current?.focus();
  }, [reveal]);

  const client = data?.client ?? null;

  function adopt(next: CraftClientPayload["client"]) {
    setData((current) => ({ siteId, issuer: current?.issuer ?? null, client: next }));
    setUriText(next?.redirectUris.join("\n") ?? "");
    setDataset(next?.datasetName ?? "production");
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      onStatus(`${what} copied to the clipboard.`);
    } catch {
      onStatus(`Could not copy ${what.toLowerCase()}. Select it and copy manually.`, true);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    const result = await callJson<CreatedOrRotated>(base, { method: "POST", body: { redirectUris: splitUriLines(uriText), datasetName: dataset.trim() } });
    setBusy(false);
    if (!result.ok) { setError(result.error); onStatus(result.error, true); return; }
    setData({ siteId, client: result.data.client, issuer: result.data.issuer ?? data?.issuer ?? null });
    setUriText(result.data.client.redirectUris.join("\n"));
    setReveal({ secret: result.data.clientSecret, kind: "created" });
    onStatus("Client created. Copy the client secret now: it is shown only once.");
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    const result = await callJson<{ client: NonNullable<CraftClientPayload["client"]> }>(base, {
      method: "PATCH", body: { redirectUris: splitUriLines(uriText), datasetName: dataset.trim() }
    });
    setBusy(false);
    if (!result.ok) { setError(result.error); onStatus(result.error, true); return; }
    adopt(result.data.client);
    onStatus("Redirect URIs and dataset saved.");
  }

  async function rotate() {
    setBusy(true); setError(null); setConfirmRotate(false);
    const result = await callJson<CreatedOrRotated>(`${base}/rotate`, { method: "POST", body: {} });
    setBusy(false);
    if (!result.ok) { setError(result.error); onStatus(result.error, true); return; }
    adopt(result.data.client);
    setReveal({ secret: result.data.clientSecret, kind: "rotated" });
    onStatus("Secret rotated. Copy the new client secret now: it is shown only once.");
  }

  async function setStatus(status: "active" | "disabled") {
    setBusy(true); setError(null);
    const result = await callJson<{ client: NonNullable<CraftClientPayload["client"]> }>(base, { method: "PATCH", body: { status } });
    setBusy(false);
    if (!result.ok) { setError(result.error); onStatus(result.error, true); return; }
    adopt(result.data.client);
    if (status === "disabled") setReveal(null);
    onStatus(status === "disabled" ? "Client disabled. Nobody can sign in to the app's Craft until it is enabled again." : "Client enabled.");
  }

  if (loading) return <p className="card-muted">Loading client settings…</p>;

  const snippet = client
    ? buildEnvSnippet({ issuer: data?.issuer ?? null, clientId: client.clientId, redirectUri: client.redirectUris[0] ?? null, secret: reveal?.secret })
    : null;

  const uriField = (
    <div>
      <label className="form-label" htmlFor={`${ids}-uris`}>Redirect URIs</label>
      <textarea
        id={`${ids}-uris`} className="form-input mono-input" rows={3} value={uriText} spellCheck={false}
        onChange={(event) => setUriText(event.target.value)} disabled={busy} aria-describedby={`${ids}-uris-help`} required
      />
      <p id={`${ids}-uris-help`} className="form-help">
        One per line. Exact https URLs, for example https://example.com/craft/auth/callback. No wildcards, fragments or credentials; http://localhost is accepted only on development installs.
      </p>
    </div>
  );
  const datasetField = (
    <div>
      <label className="form-label" htmlFor={`${ids}-dataset`}>Craft dataset name</label>
      <input
        id={`${ids}-dataset`} className="form-input mono-input" value={dataset} onChange={(event) => setDataset(event.target.value)}
        disabled={busy} maxLength={64} spellCheck={false} aria-describedby={`${ids}-dataset-help`} required
      />
      <p id={`${ids}-dataset-help`} className="form-help">Lowercase letters, digits, dash or underscore. Defaults to production.</p>
    </div>
  );

  return (
    <div className="craft-section" aria-busy={busy}>
      <h4 className="craft-subheading">Sign-in client</h4>
      <p className="card-muted">The app uses this client to send people to Jongo to sign in. One client per app.</p>

      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {!client ? (
        <form onSubmit={create} className="craft-form">
          {uriField}
          {datasetField}
          <div><button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Creating…" : "Create client"}</button></div>
        </form>
      ) : (
        <>
          {reveal ? (
            <div ref={revealRef} tabIndex={-1} className="craft-reveal" role="group" aria-labelledby={`${ids}-reveal-title`}>
              <p id={`${ids}-reveal-title`} className="craft-reveal__title">
                {reveal.kind === "created" ? "Client secret" : "New client secret"} — shown only once
              </p>
              <p className="form-help">Copy it into the site&apos;s secret store now. Jongo keeps only a hash and cannot show it again; if you lose it, rotate to get a new one.</p>
              <div className="craft-copy-row">
                <input className="form-input mono-input" readOnly value={reveal.secret} aria-label="Client secret (shown once)" onFocus={(event) => event.currentTarget.select()} />
                <button type="button" className="btn" onClick={() => copy(reveal.secret, "Client secret")}>Copy secret</button>
              </div>
              <div><button type="button" className="btn" onClick={() => { setReveal(null); onStatus("Secret hidden."); }}>I have stored it, hide it</button></div>
            </div>
          ) : null}

          <dl className="craft-facts">
            <div><dt>Client ID</dt><dd><code>{client.clientId}</code> <button type="button" className="btn craft-small" onClick={() => copy(client.clientId, "Client ID")}>Copy</button></dd></div>
            <div><dt>Status</dt><dd><span className={`status-chip ${client.status === "active" ? "healthy" : "degraded"}`}>{client.status}</span></dd></div>
            <div><dt>Created</dt><dd>{formatDay(client.createdAt)}</dd></div>
            <div><dt>Secret rotated</dt><dd>{client.rotatedAt ? formatDay(client.rotatedAt) : "Never"}</dd></div>
            {client.previousSecretValidUntil ? <div><dt>Previous secret works until</dt><dd>{formatDay(client.previousSecretValidUntil)}</dd></div> : null}
          </dl>

          <form onSubmit={save} className="craft-form">
            {uriField}
            {datasetField}
            <div><button type="submit" className="btn" disabled={busy}>Save changes</button></div>
          </form>

          <div className="craft-actions">
            {client.status === "active" ? (
              confirmRotate ? (
                <span className="craft-confirm" role="group" aria-label="Confirm secret rotation">
                  <span className="form-help">The current secret stops working after 24 hours. Rotate now?</span>
                  <button type="button" className="btn btn-danger" onClick={rotate} disabled={busy}>Yes, rotate</button>
                  <button type="button" className="btn" onClick={() => setConfirmRotate(false)}>Cancel</button>
                </span>
              ) : (
                <button type="button" className="btn" onClick={() => setConfirmRotate(true)} disabled={busy}>Rotate secret</button>
              )
            ) : null}
            {client.status === "active"
              ? <button type="button" className="btn btn-danger" onClick={() => setStatus("disabled")} disabled={busy}>Disable client</button>
              : <button type="button" className="btn" onClick={() => setStatus("active")} disabled={busy}>Enable client</button>}
          </div>

          <h4 className="craft-subheading">Environment for your site</h4>
          <p className="card-muted">
            Set these variables on the site ({Object.values(CRAFT_RP_ENV).join(", ")}).
            {reveal ? " The snippet below contains the secret you just created; do not share it." : " Use the secret from the one-time reveal for the secret value."}
          </p>
          <pre className="craft-snippet" aria-label="Environment variables for your site">{snippet}</pre>
          <div><button type="button" className="btn" onClick={() => copy(snippet ?? "", "Environment snippet")}>Copy environment</button></div>
        </>
      )}
    </div>
  );
}
