"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/lib/public-ui";
import { gitSourceSteps } from "@/lib/git-sources";
import type { GitSourceView } from "@/lib/github-installations";

const RETURN: Record<string, { ok: boolean; text: string }> = {
  registered: { ok: true, text: "Registered on GitHub. Next: Install repositories." },
  connected: { ok: true, text: "Installed. This source's repos are ready in Add App → Private repository." },
  requested: { ok: true, text: "GitHub sent an install request to your organization's owners. It connects here once one approves it." },
  in_use: { ok: false, text: "That GitHub installation is already connected to another client in Jongo." },
  register_first: { ok: false, text: "Register this source on GitHub first." },
  already_registered: { ok: true, text: "This source is already registered." },
  link_expired: { ok: false, text: "That link expired. Try again." },
  not_allowed: { ok: false, text: "Your role on this client can't manage Git sources." },
  not_found: { ok: false, text: "That Git source wasn't found." },
  failed: { ok: false, text: "GitHub didn't finish the step. Try again." }
};

function Step({ n, title, state, children }: { n: number; title: string; state: "todo" | "done" | "blocked"; children?: React.ReactNode }) {
  return (
    <div className={cx("flex gap-3 items-start", state === "blocked" && "opacity-50")}>
      <span className={cx("shrink-0 w-6 h-6 rounded-full grid place-items-center text-[12px] font-bold border border-solid", state === "done" ? "bg-healthy-bg border-healthy-border text-healthy-text" : "bg-white border-border text-ink")}>
        {state === "done" ? "✓" : n}
      </span>
      <div className="flex flex-col gap-1.5 min-w-0">
        <p className="m-0 font-semibold text-[13.5px]">{title}</p>
        {children}
      </div>
    </div>
  );
}

function ManualForm({ organizationId, sourceId, onDone }: { organizationId: string; sourceId: string; onDone: (text: string, ok: boolean) => void }) {
  const [fields, setFields] = useState({ appId: "", installationId: "", clientId: "", clientSecret: "", webhookSecret: "", privateKey: "" });
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof fields) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFields({ ...fields, [key]: event.target.value });
  return (
    <form
      className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const response = await fetch(`/api/organizations/${organizationId}/git-sources/${sourceId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...fields, appId: Number(fields.appId), installationId: Number(fields.installationId) })
        }).catch(() => null);
        const payload = response ? await response.json().catch(() => null) : null;
        setBusy(false);
        onDone(payload?.message ?? "Couldn't reach Jongo. Try again.", Boolean(payload?.ok));
      }}
    >
      <label className="flex flex-col gap-1 text-[12.5px]"><span className="font-semibold">App ID</span><input className="form-input mono-input" value={fields.appId} onChange={set("appId")} inputMode="numeric" required /></label>
      <label className="flex flex-col gap-1 text-[12.5px]"><span className="font-semibold">Installation ID</span><input className="form-input mono-input" value={fields.installationId} onChange={set("installationId")} inputMode="numeric" required /></label>
      <label className="flex flex-col gap-1 text-[12.5px]"><span className="font-semibold">Client ID</span><input className="form-input mono-input" value={fields.clientId} onChange={set("clientId")} required /></label>
      <label className="flex flex-col gap-1 text-[12.5px]"><span className="font-semibold">Client secret</span><input className="form-input mono-input" type="password" value={fields.clientSecret} onChange={set("clientSecret")} required autoComplete="off" /></label>
      <label className="flex flex-col gap-1 text-[12.5px] sm:col-span-2"><span className="font-semibold">Webhook secret</span><input className="form-input mono-input" type="password" value={fields.webhookSecret} onChange={set("webhookSecret")} required autoComplete="off" /></label>
      <label className="flex flex-col gap-1 text-[12.5px] sm:col-span-2"><span className="font-semibold">Private key</span><textarea className="form-input mono-input min-h-[110px]" value={fields.privateKey} onChange={set("privateKey")} placeholder="-----BEGIN RSA PRIVATE KEY-----" required /></label>
      <p className="m-0 sm:col-span-2 text-[12px] text-muted">The app&apos;s webhook URL must be https://jongo.app/api/github/webhook. Secrets are stored encrypted and never shown again.</p>
      <div className="sm:col-span-2"><button type="submit" className="btn" disabled={busy}>{busy ? "Checking with GitHub…" : "Save and connect"}</button></div>
    </form>
  );
}

/** Coolify's Sources, for a client: add a GitHub App, register it, install it on repos. */
export default function GitSourcesManager({
  organizationId,
  initialSources,
  canDelete,
  suggestedName,
  returnStatus,
  focusSourceId
}: {
  organizationId: string;
  initialSources: GitSourceView[];
  canDelete: boolean;
  suggestedName: string;
  returnStatus: string | null;
  focusSourceId: string | null;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(initialSources.length === 0);
  const [name, setName] = useState(suggestedName);
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [manualFor, setManualFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(returnStatus ? RETURN[returnStatus] ?? null : null);

  async function addSource(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const response = await fetch(`/api/organizations/${organizationId}/git-sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ownerLogin: owner })
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setBusy(false);
    setNotice({ ok: Boolean(payload?.ok), text: payload?.message ?? "Couldn't reach Jongo. Try again." });
    if (payload?.ok) {
      setAdding(false);
      router.refresh();
    }
  }

  async function remove(source: GitSourceView) {
    if (!window.confirm(`Delete ${source.name}? Apps deployed through it keep running but stop deploying on push.`)) return;
    const response = await fetch(`/api/organizations/${organizationId}/git-sources/${source.id}`, { method: "DELETE" }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setNotice({ ok: Boolean(payload?.ok), text: payload?.message ?? "Couldn't reach Jongo. Try again." });
    if (payload?.githubUrl) window.open(payload.githubUrl, "_blank", "noopener");
    router.refresh();
  }

  return (
    <div className="page-stack">
      <article className="card">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="card-title m-0">Git sources</h2>
            <p className="card-muted mt-1 mb-0">Connect a GitHub App for private repositories and deploys on every push. Jongo only reads code, and only from the repos you choose.</p>
          </div>
          {!adding ? <button type="button" className="btn" onClick={() => setAdding(true)}>+ Add GitHub App</button> : null}
        </div>

        {adding ? (
          <form onSubmit={addSource} className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-[640px]">
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="font-semibold">Name</span>
              <input className="form-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={34} required />
              <span className="text-muted text-[12px]">Must be unique on GitHub.</span>
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="font-semibold">Organization</span>
              <input className="form-input" value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Personal account when empty" autoCapitalize="none" spellCheck={false} />
              <span className="text-muted text-[12px]">If empty, your GitHub user will be used. You must own the organization on GitHub.</span>
            </label>
            <div className="sm:col-span-2 flex gap-2">
              <button type="submit" className="btn" disabled={busy || !name.trim()}>{busy ? "Adding…" : "Continue"}</button>
              {initialSources.length ? <button type="button" className="btn btn-secondary" onClick={() => setAdding(false)}>Cancel</button> : null}
            </div>
          </form>
        ) : null}

        {notice ? (
          <p className={cx("mt-3 mb-0 px-3 py-2 rounded-lg text-[12.5px] border border-solid", notice.ok ? "bg-healthy-bg border-healthy-border text-healthy-text" : "bg-warn-bg border-warn-border text-warn-text")}>{notice.text}</p>
        ) : null}
      </article>

      {initialSources.map((source) => {
        const steps = gitSourceSteps({ appId: source.appId }, source.installation ? { status: source.installation.status, coolifySourceUuid: source.installation.ready ? "ready" : null } : null);
        const chip = {
          draft: { label: "Not registered", tone: "unknown" },
          registered: { label: "Not installed", tone: "degraded" },
          finishing: { label: "Finishing setup", tone: "degraded" },
          ready: { label: "Ready", tone: "healthy" },
          suspended: { label: "Suspended on GitHub", tone: "error" }
        }[steps.status];
        return (
          <article key={source.id} className={cx("card", focusSourceId === source.id && "ring-2 ring-leaf/40")}>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="card-title m-0">{source.name}</h3>
              <span className={`status-chip ${chip.tone}`}>{chip.label}</span>
              <span className="text-[12.5px] text-muted">{source.ownerLogin ? `GitHub organization ${source.ownerLogin}` : "Personal GitHub account"}</span>
            </div>

            <div className="mt-4 flex flex-col gap-4">
              <Step n={1} title="Register on GitHub" state={steps.register}>
                {steps.register === "done" ? (
                  <p className="m-0 text-[12.5px] text-muted">
                    App ID <span className="font-mono">{source.appId}</span>
                    {source.htmlUrl ? <> · <a className="action-link" href={source.htmlUrl} target="_blank" rel="noopener noreferrer">View on GitHub</a></> : null}
                    {source.manual ? " · added manually" : ""}
                  </p>
                ) : (
                  <>
                    <p className="m-0 text-[12.5px] text-muted">Creates the GitHub App with Contents: read and Metadata: read. Webhooks go to Jongo.</p>
                    <div className="flex gap-2 flex-wrap">
                      <a className="btn" href={`/api/organizations/${organizationId}/git-sources/${source.id}/register`}>Register on GitHub</a>
                      <button type="button" className="btn btn-secondary" onClick={() => setManualFor(manualFor === source.id ? null : source.id)}>
                        Manual installation
                      </button>
                    </div>
                    {manualFor === source.id ? (
                      <ManualForm
                        organizationId={organizationId}
                        sourceId={source.id}
                        onDone={(text, ok) => {
                          setNotice({ ok, text });
                          if (ok) {
                            setManualFor(null);
                            router.refresh();
                          }
                        }}
                      />
                    ) : null}
                  </>
                )}
              </Step>

              <Step n={2} title="Install repositories" state={steps.install}>
                {steps.install === "done" && source.installation ? (
                  <p className="m-0 text-[12.5px] text-muted">
                    Installed on <span className="font-semibold text-ink">{source.installation.account}</span> ·{" "}
                    {source.installation.repositorySelection === "all" ? "all repositories" : "selected repositories"} · Installation ID{" "}
                    <span className="font-mono">{source.installation.installationId}</span> ·{" "}
                    <a className="action-link" href={source.installation.manageUrl} target="_blank" rel="noopener noreferrer">Choose repositories on GitHub</a>
                    {steps.status === "finishing" ? " · finishing setup, retries automatically" : ""}
                  </p>
                ) : steps.install === "todo" ? (
                  <>
                    <p className="m-0 text-[12.5px] text-muted">Pick which repositories this app may read.</p>
                    <div><a className="btn" href={`/api/organizations/${organizationId}/git-sources/${source.id}/install`}>Install repositories on GitHub</a></div>
                  </>
                ) : (
                  <p className="m-0 text-[12.5px] text-muted">Available after registering.</p>
                )}
              </Step>
            </div>

            {canDelete ? (
              <div className="mt-4 pt-3 border-0 border-t border-solid border-border">
                <button type="button" className="btn btn-danger px-3 py-1.5 text-[12.5px]" onClick={() => void remove(source)}>Delete GitHub App</button>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
