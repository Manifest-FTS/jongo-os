"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon } from "@/components/JongoIcons";
import RemedyButton from "@/components/RemedyButton";
import GithubRepoFields, { EMPTY_GITHUB_REPO_VALUE, buildSettingsFor, type GithubRepoValue } from "@/components/GithubRepoFields";
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
  /** Collaborators: create apps (WordPress or from a repository), but not adopt running ones. */
  githubOnly?: boolean;
  /** False until the platform's GitHub App exists: the GitHub option is hidden. */
  githubAvailable?: boolean;
  /** Platform admins only: adopt an app already running on the servers. */
  canAdopt?: boolean;
  /** Start with the form open (the New app page). */
  initiallyOpen?: boolean;
};

type Mode = "link" | "create" | "public" | "private" | "deploykey";

export default function CreateSiteForm({ organizationId, availableApps = [], githubOnly = false, githubAvailable = true, canAdopt = false, initiallyOpen = false }: Props) {
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
  const [open, setOpen] = useState(initiallyOpen);
  // Shown after creating an app from a deploy-key repo: where to send pushes.
  const [webhookInfo, setWebhookInfo] = useState<{ siteId: string; url: string; secret: string; sshUrl: string } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  // Two genuinely different intents shared one form: ADOPT a Coolify resource
  // that already exists, or CREATE one. Only adopting ever worked, so "Add App"
  // silently produced a Jongo record with no infrastructure behind it.
  //
  // Defaults to CREATE. Adding an app is overwhelmingly "make me a new site",
  // and with link as the default that path produced a Jongo row and nothing in
  // Coolify — the exact phantom-record failure this form was reworked to end.
  // Adopting is a migration activity; it costs one click to select.
  const [mode, setMode] = useState<Mode>("create");
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

  function handlePickMode(value: Mode) {
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
      if (mode === "public" || mode === "private" || mode === "deploykey") {
        const res = await fetch(`/api/organizations/${organizationId}/sites/github`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            mode,
            source: github.source,
            repoUrl: github.repoUrl,
            repo: github.repo,
            sshUrl: github.sshUrl,
            deployKeyId: github.deployKeyId,
            branch: github.branch || (mode === "public" ? "main" : ""),
            buildPack: github.buildPack,
            build: buildSettingsFor(github),
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
        if (data.webhook?.url && data.webhook?.secret && data.siteId) {
          // Shown once: the secret is how pushes prove they come from the repo.
          setWebhookInfo({ siteId: data.siteId, url: data.webhook.url, secret: data.webhook.secret, sshUrl: github.sshUrl });
          resetForm();
          return;
        }
        resetForm();
        setOpen(false);
        if (data.siteId) {
          // Straight to the new app, where the first deploy's progress shows.
          router.push(`/apps/${data.siteId}`);
          return;
        }
        setNotice(data.message ?? "App created.");
        setNoticeFix(null);
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

  if (webhookInfo) {
    const copy = async (field: string, text: string) => {
      await navigator.clipboard?.writeText(text).catch(() => undefined);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    };
    const host = /@([^:/]+)/.exec(webhookInfo.sshUrl)?.[1]?.toLowerCase() ?? "";
    const where = host.includes("gitlab")
      ? "GitLab: Settings → Webhooks. Paste the address, put the secret in Secret token, tick Push events."
      : host.includes("bitbucket")
        ? "Bitbucket: Repository settings → Webhooks → Add webhook. Paste the address and the secret, trigger: Repository push."
        : host.includes("github")
          ? "GitHub: Settings → Webhooks → Add webhook. Paste the address, content type application/json, and the secret."
          : "Your Git host: the repository's webhook settings. Paste the address and the secret, for push events.";
    return (
      <div className="card" style={{ marginBottom: "1rem", display: "grid", gap: "0.75rem" }}>
        <h3 className="card-title" style={{ margin: 0 }}>App created — its first deploy is running</h3>
        <p className="card-muted" style={{ margin: 0 }}>
          One more step so every push deploys automatically: add this webhook to the repository. The secret is shown only now; keep it with the webhook.
        </p>
        {[
          ["url", "Webhook address", webhookInfo.url],
          ["secret", "Secret", webhookInfo.secret]
        ].map(([field, label, text]) => (
          <div key={field}>
            <label className="form-label">{label}</label>
            <div className="flex gap-2">
              <input className="form-input mono-input" readOnly value={text} onFocus={(event) => event.currentTarget.select()} />
              <button type="button" className="btn btn-secondary px-3" onClick={() => copy(field, text)}>
                {copiedField === field ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        ))}
        <p className="form-help" style={{ margin: 0 }}>{where}</p>
        <div className="form-row">
          <button type="button" className="btn" onClick={() => router.push(`/apps/${webhookInfo.siteId}`)}>
            Open app
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h3 className="card-title" style={{ marginBottom: "0.5rem" }}>Add App</h3>
      {githubOnly ? null : availableApps.length > 0 ? (
        <p className="card-muted" style={{ marginBottom: "0.9rem" }}>
          Create a new app, or pick one that's already running on Jongo's servers.
        </p>
      ) : (
        <p className="card-muted" style={{ marginBottom: "0.9rem" }}>
          Choose what to create. Hosting is set up automatically.
        </p>
      )}
      <div role="radiogroup" aria-label="How to add this app" style={{ display: "flex", gap: "0.5rem", marginBottom: "0.9rem", flexWrap: "wrap" }}>
        {([
          ["private", "GitHub", "Import a repository from your connected GitHub; every push deploys."],
          ["deploykey", "GitLab, Bitbucket & other Git", "A private repository on any Git host, read with a deploy key; pushes deploy through a webhook."],
          ["public", "Public repository", "Deploy a public GitHub, GitLab, Bitbucket or Codeberg repository by URL."],
          ["create", "WordPress", "Create a new WordPress + MariaDB site."],
          ["link", "Link existing app", "Adopt an app that is already running on Jongo's servers."]
        ] as const).filter(([value]) =>
          (!githubOnly || value !== "link") &&
          (githubAvailable || value !== "private") &&
          (canAdopt || value !== "link")
        ).map(([value, label, help]) => (
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
          : mode === "private"
            ? "Builds the repository and deploys it. Every push to the branch deploys again."
            : mode === "deploykey"
              ? "Builds a private repository from any Git host. After creating it, add the webhook shown so pushes deploy."
            : mode === "public"
              ? "Builds the public repository and deploys it. Use Redeploy to update it."
            : "Adopts an app that is already running. Nothing new is created."}
      </p>
      <form onSubmit={handleSubmit} className="form-stack">
        {mode === "link" && availableApps.length > 0 ? (
          <div>
            <label className="form-label">Running app</label>
            <select
              className="form-input"
              value={selectedAppId}
              onChange={(event) => handlePickApp(event.target.value)}
            >
              <option value="">— Select an app —</option>
              {availableApps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name} {app.projectName ? `· ${app.projectName}` : ""}
                </option>
              ))}
            </select>
            <p className="form-help">
              Choosing an app fills in its name and hosting id for you.
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
        {mode === "public" || mode === "private" || mode === "deploykey" ? <GithubRepoFields organizationId={organizationId} value={github} onChange={setGithub} mode={mode} /> : null}
        {mode === "link" ? (
        <>
        <div>
          <label className="form-label">
            Hosting resource id
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
            {loading ? "Creating…" : mode === "create" || mode === "link" ? "Create App" : "Deploy"}
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
