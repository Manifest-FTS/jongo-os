"use client";

import { useEffect, useState } from "react";

export type GithubRepoValue = {
  /** Git source (GitHub App) for a private repository. */
  source: string;
  repo: string;
  /** Public repository address (Public repository mode). */
  repoUrl: string;
  branch: string;
  buildPack: "nixpacks" | "dockerfile";
  port: number;
  baseDirectory: string;
  envVars: Array<{ key: string; value: string }>;
};

export const EMPTY_GITHUB_REPO_VALUE: GithubRepoValue = {
  source: "",
  repo: "",
  repoUrl: "",
  branch: "",
  buildPack: "nixpacks",
  port: 3000,
  baseDirectory: "",
  envVars: []
};

type Repo = { id: number; fullName: string; private: boolean; defaultBranch: string };
type Source = { id: string; name: string; ownerLogin: string | null; installation: { account: string; status: string; ready: boolean } | null };

/**
 * Coolify's application flows: "Private repository (GitHub App)" = choose the
 * Git source → choose the repository → build configuration; "Public
 * repository" = the URL → build configuration. Lists come from Jongo's server
 * (which holds the GitHub tokens); the browser only sees names.
 */
export default function GithubRepoFields({
  organizationId,
  value,
  onChange,
  mode = "private"
}: {
  organizationId: string;
  value: GithubRepoValue;
  onChange: (next: GithubRepoValue) => void;
  mode?: "private" | "public";
}) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const set = (patch: Partial<GithubRepoValue>) => onChange({ ...value, ...patch });

  // Choose GitHub App: only sources that are registered and installed.
  useEffect(() => {
    if (mode !== "private") return;
    let cancelled = false;
    (async () => {
      const response = await fetch(`/api/organizations/${organizationId}/git-sources`).catch(() => null);
      const payload = response ? await response.json().catch(() => null) : null;
      if (cancelled) return;
      const ready = ((payload?.sources ?? []) as Source[]).filter((source) => source.installation?.status === "active" && source.installation.ready);
      setSources(ready);
      if (ready.length && !ready.some((source) => source.id === value.source)) onChange({ ...value, source: ready[0].id, repo: "", branch: "" });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, mode]);

  // Choose repository, for the selected source.
  useEffect(() => {
    if (mode !== "private" || !value.source) return;
    let cancelled = false;
    setRepos(null);
    (async () => {
      const response = await fetch(`/api/organizations/${organizationId}/github/repos?source=${encodeURIComponent(value.source)}`).catch(() => null);
      const payload = response ? await response.json().catch(() => null) : null;
      if (cancelled) return;
      if (payload?.ok) {
        setRepos(payload.repos ?? []);
        setRepoError(null);
      } else {
        setRepoError(payload?.message ?? "Couldn't load the repositories.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, mode, value.source]);

  useEffect(() => {
    if (mode !== "private" || !value.repo || !value.source) {
      setBranches([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const response = await fetch(
        `/api/organizations/${organizationId}/github/branches?repo=${encodeURIComponent(value.repo)}&source=${encodeURIComponent(value.source)}`
      ).catch(() => null);
      const payload = response ? await response.json().catch(() => null) : null;
      if (!cancelled && payload?.ok) setBranches(payload.branches);
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, mode, value.repo, value.source]);

  const sourcesLink = (
    <a className="action-link font-semibold" href={`/clients/${organizationId}/sources`}>
      Git sources
    </a>
  );

  let repoSection: React.ReactNode;
  if (mode === "public") {
    repoSection = (
      <>
        <div>
          <label className="form-label">
            Repository URL <span style={{ color: "var(--error, #e55)" }}>*</span>
          </label>
          <input
            className="form-input mono-input"
            value={value.repoUrl}
            onChange={(event) => set({ repoUrl: event.target.value })}
            placeholder="https://github.com/owner/repo"
            required
            autoCapitalize="none"
            spellCheck={false}
          />
          <p className="form-help">A public GitHub, GitLab, Bitbucket or Codeberg repository. Use Deploy now to update it; pushes aren&apos;t received.</p>
        </div>
        <div>
          <label className="form-label">Branch</label>
          <input className="form-input mono-input" value={value.branch} onChange={(event) => set({ branch: event.target.value })} placeholder="main" />
        </div>
      </>
    );
  } else if (!sources) {
    repoSection = <p className="form-help">Loading your Git sources…</p>;
  } else if (sources.length === 0) {
    repoSection = (
      <div className="diagnostic-banner">
        Connect a GitHub App first: add one under {sourcesLink}, register it on GitHub and install it on your repositories.
      </div>
    );
  } else {
    const shown = (repos ?? []).filter((repo) => !filter || repo.fullName.toLowerCase().includes(filter.toLowerCase()));
    repoSection = (
      <>
        <div>
          <label className="form-label">GitHub App</label>
          <select className="form-input" value={value.source} onChange={(event) => set({ source: event.target.value, repo: "", branch: "" })}>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name} ({source.installation?.account})
              </option>
            ))}
          </select>
          <p className="form-help">Select the installation that can access the repository. Manage them in {sourcesLink}.</p>
        </div>
        <div>
          <label className="form-label">
            Repository <span style={{ color: "var(--error, #e55)" }}>*</span>
          </label>
          {repoError ? (
            <div className="diagnostic-banner">{repoError}</div>
          ) : !repos ? (
            <p className="form-help">Loading repositories…</p>
          ) : repos.length === 0 ? (
            <div className="diagnostic-banner">This GitHub App can&apos;t read any repositories yet. Choose repositories for it in {sourcesLink}.</div>
          ) : (
            <>
              {repos.length > 8 ? (
                <input className="form-input mb-2" placeholder="Filter repositories" value={filter} onChange={(event) => setFilter(event.target.value)} />
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
                <option value="">— Choose a repository —</option>
                {shown.map((repo) => (
                  <option key={repo.id} value={repo.fullName}>
                    {repo.fullName}
                    {repo.private ? " (private)" : ""}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        <div>
          <label className="form-label">Branch</label>
          <select className="form-input" value={value.branch} onChange={(event) => set({ branch: event.target.value })} disabled={!value.repo}>
            {(branches.length ? branches : value.branch ? [value.branch] : []).map((branch) => (
              <option key={branch} value={branch}>{branch}</option>
            ))}
          </select>
          <p className="form-help">Pushes to this branch deploy the app.</p>
        </div>
      </>
    );
  }

  return (
    <>
      {repoSection}
      <p className="m-0 font-semibold text-[13px]">Build configuration</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="form-label">Build pack</label>
          <select className="form-input" value={value.buildPack} onChange={(event) => set({ buildPack: event.target.value === "dockerfile" ? "dockerfile" : "nixpacks" })}>
            <option value="nixpacks">Nixpacks (auto-detect Node, PHP, Python, static…)</option>
            <option value="dockerfile">Dockerfile</option>
          </select>
        </div>
        <div>
          <label className="form-label">Port</label>
          <input className="form-input" type="number" min={1} max={65535} value={value.port} onChange={(event) => set({ port: Number(event.target.value) })} />
          <p className="form-help">Port the application listens on.</p>
        </div>
        <div className="sm:col-span-2">
          <label className="form-label">Base directory</label>
          <input className="form-input mono-input" value={value.baseDirectory} onChange={(event) => set({ baseDirectory: event.target.value })} placeholder="/" />
          <p className="form-help">Repository directory used as the build root.</p>
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
