"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import type { MarketingAdminResult } from "@/app/(platform)/clients/[clientId]/content/[datasetId]/actions";

type RevisionOption = { id: string; type: "agencyWork" | "partnerStories" | "article"; label: string };
type Credential = { id: string; prefix: string; createdAt: string; expiresAt: string | null; revokedAt: string | null };
type Actions = {
  publish: (request: { revisionIds: string[]; expectedRevision: number }) => Promise<MarketingAdminResult>;
  unpublish: (request: { expectedRevision: number }) => Promise<MarketingAdminResult>;
  mint: () => Promise<MarketingAdminResult>;
  revoke: (request: { credentialId: string }) => Promise<MarketingAdminResult>;
};
export type MarketingAdminControlsProps = {
  publication: { status: "active" | "revoked"; revision: number; hasRelease: boolean };
  revisions: RevisionOption[];
  credentials: Credential[];
  canPublish: boolean;
  canManage: boolean;
  actions: Actions;
  loadError?: boolean;
};

const labels: Record<RevisionOption["type"], string> = {
  agencyWork: "Work case study", partnerStories: "Partner story", article: "Article"
};
function actionMessage(result: MarketingAdminResult): string {
  if (result.status === "ok") return "";
  return result.status === "denied" ? "This action is no longer available for your access or this dataset."
    : result.status === "conflict" ? "The publication changed since this page loaded. Refresh and review the latest status."
    : result.status === "invalid" ? "The selected saved drafts could not be used. Refresh and try again."
    : "The action could not be completed. No secret or private content was exposed.";
}
function date(value: string | null): string { return value ? new Date(value).toLocaleString() : "No expiry"; }

export default function MarketingAdminControls({ publication, revisions, credentials, canPublish, canManage, actions, loadError = false }: MarketingAdminControlsProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(revisions.map(item => item.id));
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("");
  const [token, setToken] = useState("");
  const [copyStatus, setCopyStatus] = useState("");

  async function perform(key: string, call: () => Promise<MarketingAdminResult>) {
    if (busy) return;
    setBusy(key); setStatus("");
    try {
      const result = await call();
      if (result.status !== "ok") { setStatus(actionMessage(result)); return; }
      if (key === "mint" && result.token) {
        setToken(result.token);
        setStatus("Credential created. Copy and store it now; it will not be shown again.");
        router.refresh();
      } else if (key === "publish") {
        setStatus(`Published successfully. Publication revision ${result.publicationRevision ?? "updated"}.`);
        setConfirmPublish(false);
        router.refresh();
      } else if (key === "unpublish") {
        setStatus(`The website release is now unpublished. Publication revision ${result.publicationRevision ?? "updated"}.`);
        setConfirmUnpublish(false);
        router.refresh();
      } else if (key.startsWith("revoke:")) {
        setStatus("Credential revoked.");
        router.refresh();
      }
    } catch {
      setStatus("The action could not be completed. Your changes were not confirmed; refresh before retrying.");
    } finally { setBusy(""); }
  }

  async function copyToken() {
    if (!token || !navigator.clipboard) { setCopyStatus("Copy is unavailable in this browser. Select and copy the token manually."); return; }
    try { await navigator.clipboard.writeText(token); setCopyStatus("Copied. Store this secret in the consumer's server-side secret manager."); }
    catch { setCopyStatus("Copy failed. Select and copy the token manually."); }
  }

  return <section className="card page-stack" aria-label="Website publishing and delivery access">
    <div>
      <h2>Website publishing</h2>
      {loadError && <p role="alert">Publication and credential details are unavailable. Reload the page before taking action.</p>}
      <p className="card-muted" role="status">Current status: <strong>{publication.status === "active" && publication.hasRelease ? "Published" : "Unpublished"}</strong>
        {" · "}Publication revision {publication.revision}. Publishing updates the public website; unpublishing removes its current release.</p>
    </div>
    <fieldset disabled={!canPublish || !!busy}>
      <legend>Choose saved current drafts</legend>
      {revisions.length ? <div className="page-stack">{revisions.map(item => <label key={item.id}>
        <input type="checkbox" checked={selected.includes(item.id)} onChange={event => setSelected(previous =>
          event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />
        {labels[item.type]}: {item.label}
      </label>)}</div> : <p>No saved current Work, Partner story, or Article drafts are available to publish.</p>}
      {!canPublish && <p className="card-muted">Publishing is disabled for your access or while CMS writes are unavailable.</p>}
      <label><input type="checkbox" checked={confirmPublish} onChange={event => setConfirmPublish(event.target.checked)} />
        I have reviewed the selected drafts and want them on the public website.
      </label>{" "}
      <button className="btn" type="button" disabled={!canPublish || !confirmPublish || !selected.length || !!busy}
        onClick={() => void perform("publish", () => actions.publish({ revisionIds: selected, expectedRevision: publication.revision }))}>
        {busy === "publish" ? "Publishing…" : "Publish selected drafts"}
      </button>
    </fieldset>
    {publication.status === "active" && publication.hasRelease && <fieldset disabled={!canPublish || !!busy}>
      <legend>Remove the current website release</legend>
      <p className="card-muted">This does not delete saved drafts or release history.</p>
      <label><input type="checkbox" checked={confirmUnpublish} onChange={event => setConfirmUnpublish(event.target.checked)} />
        I understand the current public release will be removed.
      </label>{" "}
      <button className="btn btn-danger" type="button" disabled={!canPublish || !confirmUnpublish || !!busy}
        onClick={() => void perform("unpublish", () => actions.unpublish({ expectedRevision: publication.revision }))}>
        {busy === "unpublish" ? "Unpublishing…" : "Unpublish website"}
      </button>
    </fieldset>}

    <div>
      <h2>Delivery credentials</h2>
      <p className="card-muted">Read-only credentials let a website retrieve this dataset’s published marketing content. A new token is shown once.</p>
      {!canManage && <p className="card-muted">Credential management is disabled for your access.</p>}
      <button className="btn btn-secondary" type="button" disabled={!canManage || !!busy}
        onClick={() => { setToken(""); setCopyStatus(""); void perform("mint", actions.mint); }}>
        {busy === "mint" ? "Creating credential…" : "Create delivery credential"}
      </button>
      {token && <div className="card" aria-label="New one-time credential">
        <p><strong>Copy this token now. It cannot be viewed again.</strong></p>
        <input aria-label="New delivery token" readOnly value={token} autoComplete="off" />{" "}
        <button className="btn btn-secondary" type="button" onClick={() => void copyToken()}>Copy token</button>
        <p className="card-muted" role="status">{copyStatus}</p>
        <button className="btn btn-secondary" type="button" onClick={() => { setToken(""); setCopyStatus(""); }}>Hide token</button>
      </div>}
      {loadError ? <p role="status">Credential details could not be loaded.</p> : credentials.length ? <ul aria-label="Delivery credentials">{credentials.map(item => <li key={item.id}>
        <strong>{item.prefix}</strong> · ID {item.id} · Created {date(item.createdAt)} · Expires {date(item.expiresAt)} ·
        {item.revokedAt ? ` Revoked ${date(item.revokedAt)}` : " Active"}{" "}
        {!item.revokedAt && <button className="btn btn-danger" type="button" disabled={!canManage || !!busy}
          onClick={() => void perform(`revoke:${item.id}`, () => actions.revoke({ credentialId: item.id }))}>
          {busy === `revoke:${item.id}` ? "Revoking…" : "Revoke"}
        </button>}
      </li>)}</ul> : <p>No delivery credentials have been created for this dataset.</p>}
    </div>
    <p className="card-muted" role="status" aria-live="polite">{status}</p>
  </section>;
}
