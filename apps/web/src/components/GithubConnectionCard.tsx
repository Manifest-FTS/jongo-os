"use client";

import { useCallback, useEffect, useState } from "react";
import { cx } from "@/lib/public-ui";

type Status = {
  appReady: boolean;
  installation: {
    account: string;
    accountType: string;
    status: string;
    repositorySelection: string | null;
    ready: boolean;
    lastError: string | null;
    manageUrl: string;
  } | null;
};

const RETURN_NOTICES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  connected: { tone: "ok", text: "GitHub is connected. Pick a repo when you add an app." },
  requested: { tone: "warn", text: "GitHub sent an install request to your organization's owners. It connects here as soon as one approves it." },
  in_use: { tone: "warn", text: "That GitHub account is already connected to another client in Jongo." },
  link_expired: { tone: "warn", text: "That connect link expired. Try again." },
  wrong_user: { tone: "warn", text: "Finish connecting while signed in as the person who started it." },
  not_admin: { tone: "warn", text: "Only the client's admins can connect GitHub." },
  not_allowed: { tone: "warn", text: "Your role on this client can't connect GitHub." },
  missing_install: { tone: "warn", text: "GitHub didn't say which installation to connect. Try again." },
  failed: { tone: "warn", text: "Couldn't confirm the installation with GitHub. Try again." }
};

/** Client settings: connect this client's GitHub, see which account, disconnect. */
export default function GithubConnectionCard({ organizationId, returnStatus }: { organizationId: string; returnStatus?: string | null }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(returnStatus ? RETURN_NOTICES[returnStatus] ?? null : null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/organizations/${organizationId}/github`).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (payload?.ok) setStatus(payload);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(method: "POST" | "DELETE", body?: unknown, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    const response = await fetch(`/api/organizations/${organizationId}/github`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setNotice({ tone: payload?.ok ? "ok" : "warn", text: payload?.message ?? "Couldn't reach Jongo. Try again." });
    setBusy(false);
    await load();
  }

  const install = status?.installation;

  return (
    <article className="card">
      <h3 className="card-title">GitHub</h3>
      <p className="card-muted mt-1 mb-0">
        Deploy apps from this client's own GitHub, including private repos. Jongo only reads code, and only from the repos you pick on GitHub. Pushes deploy automatically.
      </p>

      {!status ? (
        <p className="card-muted mt-3 mb-0">Loading…</p>
      ) : install ? (
        <div className="mt-3 flex flex-col gap-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-ink">{install.account}</span>
            <span className={`status-chip ${install.status === "active" ? (install.ready ? "healthy" : "degraded") : "error"}`}>
              {install.status === "suspended" ? "Suspended on GitHub" : install.ready ? "Connected" : "Finishing setup"}
            </span>
            <span className="text-[12.5px] text-muted">{install.repositorySelection === "all" ? "All repos shared" : "Selected repos shared"}</span>
          </div>
          <div className="flex gap-2 flex-wrap">
            <a className="btn btn-secondary px-3 py-1.5 text-[12.5px]" href={install.manageUrl} target="_blank" rel="noopener noreferrer">
              Choose repos on GitHub
            </a>
            {install.status === "active" && !install.ready ? (
              <button type="button" className="btn btn-secondary px-3 py-1.5 text-[12.5px]" disabled={busy} onClick={() => void call("POST", { action: "finish_setup" })}>
                Finish setup
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-danger px-3 py-1.5 text-[12.5px]"
              disabled={busy}
              onClick={() => void call("DELETE", undefined, `Disconnect ${install.account}? Apps from GitHub keep running but stop deploying on push.`)}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2 flex-wrap items-center">
          <input
            className="form-input max-w-[260px]"
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            placeholder="GitHub organization (optional)"
            aria-label="GitHub organization"
            autoCapitalize="none"
            spellCheck={false}
          />
          <a className="btn" href={`/api/organizations/${organizationId}/github/connect${owner.trim() ? `?owner=${encodeURIComponent(owner.trim())}` : ""}`}>
            Connect GitHub
          </a>
        </div>
      )}

      {notice ? (
        <p className={cx("mt-3 mb-0 px-3 py-2 rounded-lg text-[12.5px] border border-solid", notice.tone === "ok" ? "bg-healthy-bg border-healthy-border text-healthy-text" : "bg-warn-bg border-warn-border text-warn-text")}>
          {notice.text}
        </p>
      ) : null}
    </article>
  );
}
