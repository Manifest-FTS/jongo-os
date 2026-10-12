"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon } from "@/components/JongoIcons";
import RemedyButton from "@/components/RemedyButton";
import GithubRepoFields, { EMPTY_GITHUB_REPO_VALUE, type GithubRepoValue } from "@/components/GithubRepoFields";
import { remedy as buildRemedy, type Remedy } from "@/lib/remedies";
import type { CoolifyAppPickerOption } from "@/lib/coolify-app-picker";
import {
  DEFAULT_TEMPORARY_DOMAIN_SUFFIX,
  TEMPORARY_DOMAIN_SUFFIX_OPTIONS,
  buildTemporaryProductionDomain,
  normalizeTemporaryDomainSlug
} from "@/lib/temporary-domains";

type Props = {
  organizationId: string;
  availableApps?: CoolifyAppPickerOption[];
  /** Collaborators: only "Deploy from GitHub" (adopting or creating WordPress is admin-only). */
  githubOnly?: boolean;
};

export default function CreateSiteForm({ organizationId, availableApps = [], githubOnly = false }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [coolifyUuid, setCoolifyUuid] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [temporaryDomainSlug, setTemporaryDomainSlug] = useState("");
  const [temporaryDomainSuffix, setTemporaryDomainSuffix] = useState<string>(DEFAULT_TEMPORARY_DOMAIN_SUFFIX);
  const [selectedAppId, setSelectedAppId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeFix, setNoticeFix] = useState<{ siteId: string; remedy: Remedy } | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  // Two genuinely different intents shared one form: ADOPT a Coolify resource
  // that already exists, or CREATE one. Only adopting ever worked, so "Add App"
  // silently produced a Jongo record with no infrastructure behind it.
  //
  // Defaults to CREATE. Adding an app is overwhelmingly "make me a new site",
  // and with link as the default that path produced a Jongo row and nothing in
  // Coolify — the exact phantom-record failure this form was reworked to end.
  // Adopting is a migration activity; it costs one click to select.
  const [mode, setMode] = useState<"link" | "create" | "github">(githubOnly ? "github" : "create");
  const [github, setGithub] = useState<GithubRepoValue>(EMPTY_GITHUB_REPO_VALUE);

  const selectedApp = useMemo(
    () => availableApps.find((app) => app.id === selectedAppId),
    [availableApps, selectedAppId]
  );

  useEffect(() => {
    if (!selectedApp) {
      return;
    }

    setName(selectedApp.name);
    setCoolifyUuid(selectedApp.id);
  }, [selectedApp]);

  function handlePickApp(appId: string) {
    setSelectedAppId(appId);
    setError(null);

    const picked = availableApps.find((app) => app.id === appId);
    if (!picked) {
      return;
    }

    setName(picked.name);
    setCoolifyUuid(picked.id);
  }

  function resetForm() {
    setName("");
    setDescription("");
    setCoolifyUuid("");
    setGitUrl("");
    setTemporaryDomainSlug("");
    setTemporaryDomainSuffix(DEFAULT_TEMPORARY_DOMAIN_SUFFIX);
    setSelectedAppId("");
    setGithub(EMPTY_GITHUB_REPO_VALUE);
    setError(null);
  }

  function handlePickMode(value: "link" | "create" | "github") {
    setMode(value);
    setError(null);
    setNotice(null);
  }

  const derivedTemporarySlug = normalizeTemporaryDomainSlug(name);
  const effectiveTemporarySlug = normalizeTemporaryDomainSlug(temporaryDomainSlug) || derivedTemporarySlug;
  const temporaryDomainPreview = buildTemporaryProductionDomain({
    slug: effectiveTemporarySlug,
    suffix: temporaryDomainSuffix
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);

    try {
      if (mode === "github") {
        const res = await fetch(`/api/organizations/${organizationId}/sites/github`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            repo: github.repo,
            branch: github.branch,
            buildPack: github.buildPack,
            port: github.port,
            baseDirectory: github.baseDirectory,
            envVars: github.envVars.filter((row) => row.key.trim()),
            temporaryDomainSlug: normalizeTemporaryDomainSlug(temporaryDomainSlug) || undefined,
            temporaryDomainSuffix
          })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          setError(data?.message ?? "Failed to create app");
          return;
        }
        setNotice(data.message ?? "App created.");
        setNoticeFix(null);
        resetForm();
        setOpen(false);
        router.refresh();
        return;
      }

      const res = await fetch(`/api/organizations/${organizationId}/sites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          // In create mode the uuid does not exist yet — Coolify assigns it.
          coolifyServiceUuid: mode === "link" ? coolifyUuid.trim() || undefined : undefined,
          gitRepositoryUrl: mode === "link" ? gitUrl.trim() || undefined : undefined,
          provisionWordPress: mode === "create",
          temporaryDomainSlug: normalizeTemporaryDomainSlug(temporaryDomainSlug) || undefined,
          temporaryDomainSuffix
        })
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Failed to create app");
        return;
      }

      // Creation can half-succeed: Coolify made the service but refused or timed
      // out on the domain. The site is real, so this is not an error — but it
      // must not be swallowed, or the domain looks set when it is not.
      if (data?.provision && data.provision.domainApplied === false) {
        setNotice(data.provision.message ?? "App created, but its address could not be applied yet.");
        setNoticeFix(data?.id ? { siteId: data.id, remedy: buildRemedy("apply_site_domain") } : null);
      } else if (data?.provision && data.provision.restarted === false) {
        // The domain is stored but nothing has re-read it: the server only
        // regenerates routing and the container's FQDN on restart, so the app
        // is still answering on the host it was deployed with.
        setNotice("App created and its address saved, but the restart that makes the address live didn't go through.");
        setNoticeFix(data?.id ? { siteId: data.id, remedy: buildRemedy("restart_site", { target: "production" }) } : null);
      } else {
        setNoticeFix(null);
      }

      resetForm();
      setOpen(false);
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <div style={{ display: "grid", gap: "0.5rem", justifyItems: "start" }}>
        <button className="btn" onClick={() => setOpen(true)}>
          <PlusIcon className="btn-icon" />
          Add App
        </button>
        {notice ? (
          <p className="form-help" role="status" style={{ margin: 0 }}>
            {notice}{" "}
            <button type="button" className="btn btn-secondary" onClick={() => { setNotice(null); setNoticeFix(null); }}>
              Dismiss
            </button>
          </p>
        ) : null}
        {notice && noticeFix ? (
          <RemedyButton remedy={noticeFix.remedy} endpoint={`/api/sites/${noticeFix.siteId}/remedies`} onDone={(ok) => ok && router.refresh()} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h3 className="card-title" style={{ marginBottom: "0.5rem" }}>Add App</h3>
      {githubOnly ? null : availableApps.length > 0 ? (
        <p className="card-muted" style={{ marginBottom: "0.9rem" }}>
          Pick an available Coolify app or enter details manually.
        </p>
      ) : (
        <p className="card-muted" style={{ marginBottom: "0.9rem" }}>
          No linked Coolify apps were found. Enter details manually or link a project in Settings first.
        </p>
      )}
      <div role="radiogroup" aria-label="How to add this app" style={{ display: "flex", gap: "0.5rem", marginBottom: "0.9rem", flexWrap: "wrap" }}>
        {([
          ["link", "Link existing app", "Adopt an app that is already running on Jongo's servers."],
          ["create", "Create WordPress site", "Create a new WordPress + MariaDB site."],
          ["github", "Deploy from GitHub", "Build and deploy an app from one of your GitHub repos."]
        ] as const).filter(([value]) => !githubOnly || value === "github").map(([value, label, help]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            className={`btn${mode === value ? "" : " btn-secondary"}`}
            onClick={() => handlePickMode(value)}
            title={help}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="card-muted" style={{ marginBottom: "0.9rem" }}>
        {mode === "create"
          ? "A new WordPress + MariaDB site is created and deployed. It is added here once the server confirms it."
          : mode === "github"
            ? "Builds the repo and deploys it. Every push to the branch deploys again."
            : "Adopts an app that is already running. Nothing new is created."}
      </p>
      <form onSubmit={handleSubmit} className="form-stack">
        {mode === "link" && availableApps.length > 0 ? (
          <div>
            <label className="form-label">Coolify App Picker</label>
            <select
              className="form-input"
              value={selectedAppId}
              onChange={(event) => handlePickApp(event.target.value)}
            >
              <option value="">— Select a Coolify app —</option>
              {availableApps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name} {app.projectName ? `· ${app.projectName}` : ""}
                </option>
              ))}
            </select>
            <p className="form-help">
              Choosing an app fills in the app name and Coolify service UUID for you.
            </p>
          </div>
        ) : null}
        <div>
          <label className="form-label">
            Name <span style={{ color: "var(--error, #e55)" }}>*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={selectedApp ? selectedApp.name : "my-wordpress-site"}
            required
            autoFocus
            className="form-input"
          />
        </div>
        <div>
          <label className="form-label">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            className="form-input"
          />
        </div>
        {mode === "github" ? <GithubRepoFields organizationId={organizationId} value={github} onChange={setGithub} canConnect={!githubOnly} /> : null}
        {mode === "link" ? (
        <>
        <div>
          <label className="form-label">
            Coolify Service UUID
          </label>
          <input
            type="text"
            value={coolifyUuid}
            onChange={(e) => setCoolifyUuid(e.target.value)}
            placeholder={selectedApp ? selectedApp.id : "e.g. dt0v391xre5rgtp50062tunm"}
            className="form-input mono-input"
          />
        </div>
        <div>
          <label className="form-label">Git Repository URL</label>
          <input
            type="url"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            placeholder="https://github.com/org/repo"
            className="form-input"
          />
        </div>
        </>
        ) : null}
        <div>
          <label className="form-label">Temporary Domain Slug</label>
          <input
            type="text"
            value={temporaryDomainSlug}
            onChange={(e) => setTemporaryDomainSlug(e.target.value)}
            placeholder={derivedTemporarySlug || "my-site"}
            className="form-input mono-input"
          />
        </div>
        <div>
          <label className="form-label">Temporary Domain Suffix</label>
          <select
            className="form-input"
            value={temporaryDomainSuffix}
            onChange={(e) => setTemporaryDomainSuffix(e.target.value)}
          >
            {TEMPORARY_DOMAIN_SUFFIX_OPTIONS.map((suffix) => (
              <option key={suffix} value={suffix}>{suffix}</option>
            ))}
          </select>
          <p className="form-help">
            {temporaryDomainPreview
              ? mode !== "link"
                ? `Temporary production URL: https://${temporaryDomainPreview} — applied to the new app.`
                : `Temporary production URL: https://${temporaryDomainPreview} — recorded in Jongo only; the adopted app keeps the address it already has.`
              : "Temporary production URL preview unavailable"}
          </p>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="form-row">
          <button type="submit" className="btn" disabled={loading}>
            {loading ? "Creating…" : "Create App"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { setOpen(false); resetForm(); }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
