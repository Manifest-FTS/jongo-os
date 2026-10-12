"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/lib/public-ui";
import { GIT_STATUS_WARNINGS, type SiteSource } from "@/lib/site-source-copy";

/** Where a GitHub-deployed app builds from: branch, staging branch, auto-deploy, Deploy now. */
export default function SiteSourceCard({ siteId, source, canManage, canDeploy }: { siteId: string; source: SiteSource; canManage: boolean; canDeploy: boolean }) {
  const router = useRouter();
  const [branches, setBranches] = useState<string[]>([source.branch]);
  const [branch, setBranch] = useState(source.branch);
  const [stagingBranch, setStagingBranch] = useState(source.stagingBranch ?? "");
  const [autoDeploy, setAutoDeploy] = useState(source.autoDeploy);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const broken = source.gitStatus && source.gitStatus !== "linked" ? GIT_STATUS_WARNINGS[source.gitStatus] ?? null : null;

  useEffect(() => {
    if (!canManage || broken) return;
    let cancelled = false;
    (async () => {
      const response = await fetch(`/api/organizations/${source.organizationId}/github/branches?repo=${encodeURIComponent(source.repo)}`).catch(() => null);
      const payload = response ? await response.json().catch(() => null) : null;
      if (!cancelled && payload?.ok) setBranches(payload.branches);
    })();
    return () => {
      cancelled = true;
    };
  }, [canManage, broken, source.organizationId, source.repo]);

  async function send(key: string, method: "PATCH" | "POST", body: unknown) {
    setBusy(key);
    setNotice(null);
    const response = await fetch(`/api/sites/${siteId}/source`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setNotice({ ok: Boolean(payload?.ok), text: payload?.message ?? "Couldn't reach Jongo. Try again." });
    setBusy(null);
    if (payload?.ok) router.refresh();
  }

  const dirty = branch !== source.branch || (stagingBranch || null) !== source.stagingBranch || autoDeploy !== source.autoDeploy;

  return (
    <article className="card" style={{ marginBottom: "1.5rem" }}>
      <h3 className="card-title">Source</h3>
      <p className="card-muted mt-1 mb-0">
        Deploys from{" "}
        <a className="action-link font-semibold" href={`https://github.com/${source.repo}/tree/${encodeURIComponent(source.branch)}`} target="_blank" rel="noopener noreferrer">
          {source.repo}@{source.branch}
        </a>
        {source.lastDeployedSha ? <span className="font-mono text-[12px]"> · last deployed {source.lastDeployedSha.slice(0, 7)}</span> : null}
      </p>

      {broken ? (
        <div className="mt-3 px-3 py-2.5 rounded-lg border border-solid bg-warn-bg border-warn-border text-warn-text text-[13px] flex flex-col gap-2 items-start">
          <span>{broken}</span>
          {source.manageUrl ? (
            <a className="btn btn-secondary px-3 py-1.5 text-[12.5px]" href={source.manageUrl} target="_blank" rel="noopener noreferrer">
              Reconnect on GitHub
            </a>
          ) : null}
        </div>
      ) : null}

      {source.pendingCommitSha && !broken ? (
        <div className="mt-3 px-3 py-2.5 rounded-lg border border-solid border-border bg-bg text-[13px] flex items-center gap-3 flex-wrap">
          <span>
            New commit available: <span className="font-mono">{source.pendingCommitSha.slice(0, 7)}</span>
            {source.pendingCommitMessage ? ` — ${source.pendingCommitMessage}` : ""}
          </span>
          {canDeploy ? (
            <button type="button" className="btn px-3 py-1.5 text-[12.5px]" disabled={busy !== null} onClick={() => void send("deploy", "POST", { action: "deploy" })}>
              {busy === "deploy" ? "Starting…" : "Deploy"}
            </button>
          ) : null}
        </div>
      ) : null}

      {canManage && !broken ? (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="font-semibold">Production branch</span>
            <select className="form-input" value={branch} onChange={(event) => setBranch(event.target.value)}>
              {branches.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="font-semibold">Staging branch</span>
            <select className="form-input" value={stagingBranch} onChange={(event) => setStagingBranch(event.target.value)}>
              <option value="">None (staging isn't deployed on push)</option>
              {branches.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="sm:col-span-2 flex items-center gap-2 text-[13px] cursor-pointer">
            <input type="checkbox" checked={autoDeploy} onChange={(event) => setAutoDeploy(event.target.checked)} />
            <span>Deploy automatically on every push (off: Jongo shows the new commit and waits for Deploy)</span>
          </label>
          <div className="sm:col-span-2 flex gap-2 flex-wrap">
            <button
              type="button"
              className="btn"
              disabled={!dirty || busy !== null}
              onClick={() => void send("save", "PATCH", { branch, stagingBranch: stagingBranch || null, autoDeploy })}
            >
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            {canDeploy ? (
              <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void send("deploy", "POST", { action: "deploy" })}>
                {busy === "deploy" ? "Starting…" : "Deploy now"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {notice ? (
        <p className={cx("mt-3 mb-0 px-3 py-2 rounded-lg text-[12.5px] border border-solid", notice.ok ? "bg-healthy-bg border-healthy-border text-healthy-text" : "bg-warn-bg border-warn-border text-warn-text")}>
          {notice.text}
        </p>
      ) : null}
    </article>
  );
}
