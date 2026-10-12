"use client";

import { useEffect, useState } from "react";

export type GithubRepoValue = {
  repo: string;
  branch: string;
  buildPack: "nixpacks" | "dockerfile";
  port: number;
  baseDirectory: string;
  envVars: Array<{ key: string; value: string }>;
};

export const EMPTY_GITHUB_REPO_VALUE: GithubRepoValue = { repo: "", branch: "", buildPack: "nixpacks", port: 3000, baseDirectory: "", envVars: [] };

type Repo = { id: number; fullName: string; private: boolean; defaultBranch: string };

/**
 * Repo → branch → build settings for "Deploy from GitHub". Lists come from
 * Jongo's server (which holds the GitHub token); the browser only sees names.
 */
export default function GithubRepoFields({
  organizationId,
  value,
  onChange
}: {
  organizationId: string;
  value: GithubRepoValue;
  onChange: (next: GithubRepoValue) => void;
}) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoError, setRepoError] = useState<{ text: string; connect: boolean } | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch(`/api/organizations/${organizationId}/github/repos`).catch(() => null);
      const payload = response ? await response.json().catch(() => null) : null;
      if (cancelled) return;
      if (payload?.ok) setRepos(payload.repos);
      else setRepoError({ text: payload?.message ?? "Couldn't load your repos.", connect: response?.status === 404 || response?.status === 409 });
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  useEffect(() => {
    if (!value.repo) {
      setBranches([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const response = await fetch(`/api/organizations/${organizationId}/github/branches?repo=${encodeURIComponent(value.repo)}`).catch(() => null);
      const payload = response ? await response.json().catch(() => null) : null;
      if (!cancelled && payload?.ok) setBranches(payload.branches);
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, value.repo]);

  if (repoError) {
    return (
      <div className="diagnostic-banner">
        {repoError.text}{" "}
        {repoError.connect ? (
          <a className="action-link font-semibold" href={`/clients/${organizationId}/settings`}>
            Connect GitHub
          </a>
        ) : null}
      </div>
    );
  }
  if (!repos) return <p className="form-help">Loading your repos…</p>;
  if (repos.length === 0) {
    return (
      <div className="diagnostic-banner">
        No repos are shared with Jongo yet. Choose repos on GitHub from{" "}
        <a className="action-link font-semibold" href={`/clients/${organizationId}/settings`}>client settings</a>.
      </div>
    );
  }

  const shown = repos.filter((repo) => !filter || repo.fullName.toLowerCase().includes(filter.toLowerCase()));
  const set = (patch: Partial<GithubRepoValue>) => onChange({ ...value, ...patch });

  return (
    <>
      <div>
        <label className="form-label">
          Repository <span style={{ color: "var(--error, #e55)" }}>*</span>
        </label>
        {repos.length > 8 ? (
          <input className="form-input mb-2" placeholder="Filter repos" value={filter} onChange={(event) => setFilter(event.target.value)} />
        ) : null}
        <select
          className="form-input"
          value={value.repo}
          required
          onChange={(event) => {
            const repo = repos.find((candidate) => candidate.fullName === event.target.value);
            set({ repo: event.target.value, branch: repo?.defaultBranch ?? "" });
          }}
        >
          <option value="">— Choose a repo —</option>
          {shown.map((repo) => (
            <option key={repo.id} value={repo.fullName}>
              {repo.fullName}
              {repo.private ? " (private)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="form-label">Branch</label>
          <select className="form-input" value={value.branch} onChange={(event) => set({ branch: event.target.value })} disabled={!value.repo}>
            {(branches.length ? branches : value.branch ? [value.branch] : []).map((branch) => (
              <option key={branch} value={branch}>{branch}</option>
            ))}
          </select>
          <p className="form-help">Pushes to this branch deploy the site.</p>
        </div>
        <div>
          <label className="form-label">Build</label>
          <select className="form-input" value={value.buildPack} onChange={(event) => set({ buildPack: event.target.value === "dockerfile" ? "dockerfile" : "nixpacks" })}>
            <option value="nixpacks">Auto-detect (Node, PHP, Python, static…)</option>
            <option value="dockerfile">Dockerfile in the repo</option>
          </select>
        </div>
        <div>
          <label className="form-label">Port the app listens on</label>
          <input className="form-input" type="number" min={1} max={65535} value={value.port} onChange={(event) => set({ port: Number(event.target.value) })} />
        </div>
        <div>
          <label className="form-label">Base directory</label>
          <input className="form-input mono-input" value={value.baseDirectory} onChange={(event) => set({ baseDirectory: event.target.value })} placeholder="Leave empty for the repo root" />
        </div>
      </div>
      <div>
        <label className="form-label">Environment variables</label>
        <div className="flex flex-col gap-2">
          {value.envVars.map((row, index) => (
            <div key={index} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
              <input
                className="form-input mono-input"
                placeholder="KEY"
                value={row.key}
                onChange={(event) => set({ envVars: value.envVars.map((r, i) => (i === index ? { ...r, key: event.target.value } : r)) })}
              />
              <input
                className="form-input mono-input"
                placeholder="value"
                value={row.value}
                onChange={(event) => set({ envVars: value.envVars.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)) })}
              />
              <button type="button" className="btn btn-secondary px-2.5" aria-label="Remove variable" onClick={() => set({ envVars: value.envVars.filter((_, i) => i !== index) })}>
                ×
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn btn-secondary px-3 py-1.5 text-[12.5px]" onClick={() => set({ envVars: [...value.envVars, { key: "", value: "" }] })}>
              Add variable
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
