"use client";

import { useEffect, useRef, useState } from "react";
import { FRAMEWORK_PRESETS, type FrameworkId, type FrameworkPreset } from "@/lib/frameworks";

export type RepoMode = "private" | "public" | "deploykey";

export type GithubRepoValue = {
  /** Git source (GitHub App) for a private GitHub repository. */
  source: string;
  repo: string;
  /** Public repository address (public mode). */
  repoUrl: string;
  /** SSH address of a private repository on any host (deploy key mode). */
  sshUrl: string;
  deployKeyId: string;
  branch: string;
  framework: FrameworkId;
  buildPack: "nixpacks" | "dockerfile" | "static";
  port: number;
  baseDirectory: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  publishDirectory: string;
  isStatic: boolean;
  isSpa: boolean;
  envVars: Array<{ key: string; value: string }>;
};

function presetValues(preset: FrameworkPreset): Partial<GithubRepoValue> {
  return {
    framework: preset.id,
    buildPack: preset.buildPack,
    port: preset.port,
    installCommand: preset.installCommand ?? "",
    buildCommand: preset.buildCommand ?? "",
    startCommand: preset.startCommand ?? "",
    publishDirectory: preset.publishDirectory ?? "",
    isStatic: Boolean(preset.isStatic),
    isSpa: Boolean(preset.isSpa)
  };
}

export const EMPTY_GITHUB_REPO_VALUE: GithubRepoValue = {
  source: "",
  repo: "",
  repoUrl: "",
  sshUrl: "",
  deployKeyId: "",
  branch: "",
  baseDirectory: "",
  envVars: [],
  ...(presetValues(FRAMEWORK_PRESETS.other) as Omit<GithubRepoValue, "source" | "repo" | "repoUrl" | "sshUrl" | "deployKeyId" | "branch" | "baseDirectory" | "envVars">)
};

/** What the create endpoint expects for build settings. */
export function buildSettingsFor(value: GithubRepoValue) {
  return {
    installCommand: value.installCommand,
    buildCommand: value.buildCommand,
    startCommand: value.startCommand,
    publishDirectory: value.publishDirectory,
    isStatic: value.isStatic,
    isSpa: value.isSpa
  };
}

type Repo = { id: number; fullName: string; private: boolean; defaultBranch: string };
type Source = { id: string; name: string; ownerLogin: string | null; installation: { account: string; status: string; ready: boolean } | null };
type DeployKey = { id: string; label: string; publicKey: string };

const FRAMEWORK_ORDER: FrameworkId[] = [
  "nextjs", "nuxt", "remix", "sveltekit", "astro-static", "astro", "vite", "create-react-app", "angular", "node", "dockerfile", "static-html", "other"
];

/** Where each host keeps deploy keys and webhooks, for the instructions. */
function hostHelp(sshUrl: string): { name: string; keys: string; hooks: string } {
  const host = /@([^:/]+)/.exec(sshUrl)?.[1]?.toLowerCase() ?? "";
  if (host.includes("gitlab")) return { name: "GitLab", keys: "Settings → Repository → Deploy keys", hooks: "Settings → Webhooks (Push events, Secret token)" };
  if (host.includes("bitbucket")) return { name: "Bitbucket", keys: "Repository settings → Access keys", hooks: "Repository settings → Webhooks (Repository push, Secret)" };
  if (host.includes("github")) return { name: "GitHub", keys: "Settings → Deploy keys", hooks: "Settings → Webhooks (application/json, Secret)" };
  if (host) return { name: host, keys: "the repository's deploy keys settings", hooks: "the repository's webhook settings" };
  return { name: "your Git host", keys: "the repository's deploy keys settings", hooks: "the repository's webhook settings" };
}

/** Parse pasted .env text into rows; ignores comments and blank lines. */
export function parseDotEnv(text: string): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    rows.push({ key: match[1], value });
  }
  return rows;
}

/**
 * The "configure project" step, Vercel-style: pick the repository, see the
 * detected framework (and change it), adjust build settings and variables.
 * Lists and detection come from Jongo's server, which holds the Git tokens.
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
  mode?: RepoMode;
}) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [detected, setDetected] = useState<{ label: string; reason: string } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [keys, setKeys] = useState<DeployKey[] | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const latest = useRef(value);
  latest.current = value;
  const set = (patch: Partial<GithubRepoValue>) => onChange({ ...latest.current, ...patch });

  // Private GitHub: sources, then repositories, then branches.
  useEffect(() => {
    if (mode !== "private") return;
    let cancelled = false;
    (async () => {
      const response = await fetch(`/api/organizations/${organizationId}/git-sources`).catch(() => null);
      const payload = response ? await response.json().catch(() => null) : null;
      if (cancelled) return;
      const ready = ((payload?.sources ?? []) as Source[]).filter((source) => source.installation?.status === "active" && source.installation.ready);
      setSources(ready);
      if (ready.length && !ready.some((source) => source.id === latest.current.source)) set({ source: ready[0].id, repo: "", branch: "" });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, mode]);

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

  // Deploy keys for this client.
  useEffect(() => {
    if (mode !== "deploykey") return;
    let cancelled = false;
    fetch(`/api/organizations/${organizationId}/deploy-keys`)
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (cancelled) return;
        const list: DeployKey[] = payload?.keys ?? [];
        setKeys(list);
        if (list.length && !list.some((key) => key.id === latest.current.deployKeyId)) set({ deployKeyId: list[0].id });
      })
      .catch(() => setKeys([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, mode]);

  // Framework detection whenever the repository, branch or root folder changes.
  const detectKey =
    mode === "private"
      ? value.source && value.repo && value.branch ? `p|${value.source}|${value.repo}|${value.branch}|${value.baseDirectory}` : ""
      : mode === "public"
        ? /^https:\/\/[^/]+\/[^/]+\/[^/]+/.test(value.repoUrl.trim()) ? `u|${value.repoUrl.trim()}|${value.branch}|${value.baseDirectory}` : ""
        : "";
  useEffect(() => {
    if (!detectKey) {
      setDetected(null);
      setDetectError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setDetecting(true);
      setDetectError(null);
      const current = latest.current;
      const response = await fetch(`/api/organizations/${organizationId}/sites/github/inspect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          mode === "private"
            ? { mode, source: current.source, repo: current.repo, branch: current.branch, baseDirectory: current.baseDirectory }
            : { mode, repoUrl: current.repoUrl.trim(), branch: current.branch, baseDirectory: current.baseDirectory }
        )
      }).catch(() => null);
      const payload = response ? await response.json().catch(() => null) : null;
      if (cancelled) return;
      setDetecting(false);
      if (!payload?.ok) {
        setDetected(null);
        setDetectError(payload?.message ?? "Couldn't read the repository to detect its framework. Choose it below.");
        return;
      }
      const preset = payload.framework as FrameworkPreset;
      setDetected({ label: preset.label, reason: payload.reason });
      set({ ...presetValues(preset), ...(mode === "public" && !current.branch && payload.defaultBranch ? { branch: payload.defaultBranch } : {}) });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectKey, organizationId, mode]);

  async function createKey() {
    setKeyBusy(true);
    setKeyError(null);
    const response = await fetch(`/api/organizations/${organizationId}/deploy-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: value.sshUrl.split(/[:/]/).pop()?.replace(/\.git$/, "") || "deploy key" })
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setKeyBusy(false);
    if (!payload?.ok) {
      setKeyError(payload?.message ?? "Couldn't create the deploy key. Try again.");
      return;
    }
    const key: DeployKey = { id: payload.id, label: "new", publicKey: payload.publicKey };
    setKeys((list) => [key, ...(list ?? [])]);
    set({ deployKeyId: key.id });
  }

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
          <p className="form-help">A public GitHub, GitLab, Bitbucket or Codeberg repository. Pushes aren&apos;t received; use Redeploy to update it.</p>
        </div>
        <div>
          <label className="form-label">Branch</label>
          <input className="form-input mono-input" value={value.branch} onChange={(event) => set({ branch: event.target.value })} placeholder="the default branch" />
        </div>
      </>
    );
  } else if (mode === "deploykey") {
    const help = hostHelp(value.sshUrl);
    const key = (keys ?? []).find((candidate) => candidate.id === value.deployKeyId) ?? null;
    repoSection = (
      <>
        <div>
          <label className="form-label">
            Repository SSH address <span style={{ color: "var(--error, #e55)" }}>*</span>
          </label>
          <input
            className="form-input mono-input"
            value={value.sshUrl}
            onChange={(event) => set({ sshUrl: event.target.value })}
            placeholder="git@gitlab.com:team/app.git"
            required
            autoCapitalize="none"
            spellCheck={false}
          />
          <p className="form-help">Works with GitLab, Bitbucket, GitHub, Gitea, Forgejo, Codeberg or your own Git server. Use the SSH address from the repository&apos;s Clone button.</p>
        </div>
        <div>
          <label className="form-label">
            Branch <span style={{ color: "var(--error, #e55)" }}>*</span>
          </label>
          <input className="form-input mono-input" value={value.branch} onChange={(event) => set({ branch: event.target.value })} placeholder="main" required />
        </div>
        <div className="card" style={{ padding: "0.85rem", display: "grid", gap: "0.5rem" }}>
          <p className="m-0 font-semibold text-[13px]">Deploy key</p>
          {keys === null ? (
            <p className="form-help m-0">Loading deploy keys…</p>
          ) : (
            <>
              {keys.length ? (
                <select className="form-input" value={value.deployKeyId} onChange={(event) => set({ deployKeyId: event.target.value })}>
                  {keys.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label} · {candidate.publicKey.slice(12, 28)}…
                    </option>
                  ))}
                </select>
              ) : null}
              <div>
                <button type="button" className="btn btn-secondary px-3 py-1.5 text-[12.5px]" disabled={keyBusy} onClick={createKey}>
                  {keyBusy ? "Creating…" : keys.length ? "Create another key" : "Create deploy key"}
                </button>
              </div>
              {keyError ? <p className="auth-error m-0 text-[12.5px]" role="alert">{keyError}</p> : null}
              {key ? (
                <>
                  <textarea className="form-input mono-input" readOnly rows={3} value={key.publicKey} onFocus={(event) => event.currentTarget.select()} />
                  <div className="flex gap-2 items-center flex-wrap">
                    <button
                      type="button"
                      className="btn btn-secondary px-3 py-1.5 text-[12.5px]"
                      onClick={async () => {
                        await navigator.clipboard?.writeText(key.publicKey).catch(() => undefined);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                    >
                      {copied ? "Copied" : "Copy key"}
                    </button>
                    <span className="form-help m-0">
                      Add it in {help.name}: {help.keys}. Read-only access is enough.
                    </span>
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
      </>
    );
  } else if (!sources) {
    repoSection = <p className="form-help">Loading your Git sources…</p>;
  } else if (sources.length === 0) {
    repoSection = (
      <div className="diagnostic-banner">
        Connect GitHub first: add a GitHub App under {sourcesLink} and install it on your repositories. For GitLab, Bitbucket or other hosts, choose &quot;Other Git (private)&quot;.
      </div>
    );
  } else {
    const shown = (repos ?? []).filter((repo) => !filter || repo.fullName.toLowerCase().includes(filter.toLowerCase()));
    repoSection = (
      <>
        {sources.length > 1 ? (
          <div>
            <label className="form-label">GitHub account</label>
            <select className="form-input" value={value.source} onChange={(event) => set({ source: event.target.value, repo: "", branch: "" })}>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.installation?.account} ({source.name})
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div>
          <label className="form-label">
            Repository <span style={{ color: "var(--error, #e55)" }}>*</span>
          </label>
          {repoError ? (
            <div className="diagnostic-banner">{repoError}</div>
          ) : !repos ? (
            <p className="form-help">Loading repositories…</p>
          ) : repos.length === 0 ? (
            <div className="diagnostic-banner">GitHub hasn&apos;t shared any repositories with Jongo yet. Choose repositories in {sourcesLink}.</div>
          ) : (
            <>
              {repos.length > 8 ? (
                <input className="form-input mb-2" placeholder="Search repositories" value={filter} onChange={(event) => setFilter(event.target.value)} />
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

  const serveStatic = value.buildPack === "static" || value.isStatic;
  const preset = FRAMEWORK_PRESETS[value.framework] ?? FRAMEWORK_PRESETS.other;

  return (
    <>
      {repoSection}

      <div>
        <label className="form-label">Framework</label>
        <select
          className="form-input"
          value={value.framework}
          onChange={(event) => set(presetValues(FRAMEWORK_PRESETS[event.target.value as FrameworkId] ?? FRAMEWORK_PRESETS.other))}
        >
          {FRAMEWORK_ORDER.map((id) => (
            <option key={id} value={id}>{FRAMEWORK_PRESETS[id].label}</option>
          ))}
        </select>
        <p className="form-help" role="status" aria-live="polite">
          {detecting
            ? "Detecting the framework…"
            : detected
              ? `Detected ${detected.label} (${detected.reason}).`
              : detectError
                ? detectError
                : mode === "deploykey"
                  ? "Jongo can't look inside a private repo on this host, so choose the framework."
                  : "Detected automatically once the repository is chosen."}
        </p>
      </div>

      <div>
        <label className="form-label">Root folder</label>
        <input className="form-input mono-input" value={value.baseDirectory} onChange={(event) => set({ baseDirectory: event.target.value })} placeholder="/ (the repository root)" />
        <p className="form-help">For a monorepo, the folder that holds this app, like apps/web.</p>
      </div>

      <details className="card" style={{ padding: "0.75rem 0.85rem" }}>
        <summary className="font-semibold text-[13px]" style={{ cursor: "pointer" }}>Build and output settings</summary>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ marginTop: "0.75rem" }}>
          <div>
            <label className="form-label">Install command</label>
            <input className="form-input mono-input" value={value.installCommand} onChange={(event) => set({ installCommand: event.target.value })} placeholder="detected (npm install, pnpm install…)" />
          </div>
          <div>
            <label className="form-label">Build command</label>
            <input className="form-input mono-input" value={value.buildCommand} onChange={(event) => set({ buildCommand: event.target.value })} placeholder={preset.buildCommand ?? "detected (npm run build…)"} />
          </div>
          {serveStatic ? (
            <>
              <div>
                <label className="form-label">Output folder</label>
                <input className="form-input mono-input" value={value.publishDirectory} onChange={(event) => set({ publishDirectory: event.target.value })} placeholder="/dist" />
              </div>
              <label className="flex items-center gap-2 text-[13px]" style={{ alignSelf: "end", paddingBottom: "0.5rem" }}>
                <input type="checkbox" checked={value.isSpa} onChange={(event) => set({ isSpa: event.target.checked })} />
                Single-page app (send every path to index.html)
              </label>
            </>
          ) : (
            <>
              <div>
                <label className="form-label">Start command</label>
                <input className="form-input mono-input" value={value.startCommand} onChange={(event) => set({ startCommand: event.target.value })} placeholder="detected (npm start…)" />
              </div>
              <div>
                <label className="form-label">Port</label>
                <input className="form-input" type="number" min={1} max={65535} value={value.port} onChange={(event) => set({ port: Number(event.target.value) })} />
                <p className="form-help">The port the app listens on.</p>
              </div>
            </>
          )}
        </div>
        <p className="form-help" style={{ marginBottom: 0 }}>Leave a command empty to use what the framework detects.</p>
      </details>

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
          {pasteOpen ? (
            <div className="flex flex-col gap-2">
              <textarea
                className="form-input mono-input"
                rows={5}
                placeholder={"DATABASE_URL=postgres://…\nAPI_KEY=…"}
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-secondary px-3 py-1.5 text-[12.5px]"
                  onClick={() => {
                    const rows = parseDotEnv(pasteText);
                    const byKey = new Map(value.envVars.filter((row) => row.key.trim()).map((row) => [row.key, row]));
                    for (const row of rows) byKey.set(row.key, row);
                    set({ envVars: [...byKey.values()] });
                    setPasteText("");
                    setPasteOpen(false);
                  }}
                >
                  Add these
                </button>
                <button type="button" className="btn btn-secondary px-3 py-1.5 text-[12.5px]" onClick={() => setPasteOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary px-3 py-1.5 text-[12.5px]" onClick={() => set({ envVars: [...value.envVars, { key: "", value: "" }] })}>
              Add variable
            </button>
            {!pasteOpen ? (
              <button type="button" className="btn btn-secondary px-3 py-1.5 text-[12.5px]" onClick={() => setPasteOpen(true)}>
                Paste .env
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
