"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ModalDrawer from "@/components/overlays/ModalDrawer";
import { GitBranchMark, GithubMark, GlobeMark, LinkMark, WordPressMark } from "@/components/SourceIcons";
import { useRouter } from "next/navigation";
import { PlusIcon } from "@/components/JongoIcons";
import RemedyButton from "@/components/RemedyButton";
import GithubRepoFields, { EMPTY_GITHUB_REPO_VALUE, buildSettingsFor, type GithubRepoValue } from "@/components/GithubRepoFields";
import CreationProgress, { applyStep, postWithProgress, type CreationStep } from "@/components/CreationProgress";
import { remedy as buildRemedy, type Remedy } from "@/lib/remedies";
import type { CoolifyAppPickerOption } from "@/lib/coolify-app-picker";
import { parseCoolifyResourceReference } from "@/lib/coolify-app-picker";
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
  /** "drawer": an Add app button opening a side panel. "inline": in the page. */
  presentation?: "drawer" | "inline";
  /** Set when new hosting needs a paid plan first (lib/hosting-entitlement.ts). */
  paywall?: { message: string; actionUrl: string | null } | null;
};

/** Open the Add app panel from elsewhere on the page (the empty state). */
export const ADD_APP_EVENT = "jongo:add-app";

type Mode = "link" | "create" | "public" | "private" | "deploykey";

const SOURCE_OPTIONS: Array<{ value: Mode; title: string; help: string; detail: string; icon: React.ReactNode }> = [
  { value: "private", title: "GitHub", help: "Import from your connected GitHub. Every push deploys.", detail: "Private or public repository through your GitHub connection", icon: <GithubMark /> },
  { value: "deploykey", title: "GitLab, Bitbucket & other Git", help: "A private repo on any Git host, with a deploy key.", detail: "Private repository, read with a deploy key", icon: <GitBranchMark /> },
  { value: "public", title: "Public repository", help: "Any public GitHub, GitLab, Bitbucket or Codeberg repo.", detail: "Public repository by URL", icon: <GlobeMark /> },
  { value: "create", title: "WordPress", help: "A new WordPress site with its own database.", detail: "WordPress + MariaDB, backed up automatically", icon: <WordPressMark /> },
  { value: "link", title: "Link existing app", help: "Adopt an app already running on Jongo's servers.", detail: "Nothing new is created", icon: <LinkMark /> }
];

export default function CreateSiteForm({ organizationId, availableApps = [], githubOnly = false, githubAvailable = true, canAdopt = false, initiallyOpen = false, presentation = "inline", paywall = null }: Props) {
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
  // Step one is choosing the source; step two is configuring it.
  const [sourceChosen, setSourceChosen] = useState(false);
  const [noticeLink, setNoticeLink] = useState<string | null>(null);
  const closedWhileCreating = useRef(false);
  // Shown after creating an app from a deploy-key repo: where to send pushes.
  const [webhookInfo, setWebhookInfo] = useState<{ siteId: string; url: string; secret: string; sshUrl: string } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  // Live checklist while the app is being created (steps come from the server).
  const [progress, setProgress] = useState<{ title: string; steps: CreationStep[]; startedAt: number } | null>(null);
  const onStep = (step: Parameters<typeof applyStep>[1]) =>
    setProgress((current) => (current ? { ...current, steps: applyStep(current.steps, step) } : current));
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
    setGitUrl(selectedApp.gitRepositoryUrl ?? "");
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
    setGitUrl(picked.gitRepositoryUrl ?? "");
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

  useEffect(() => {
    const onAddApp = (event: Event) => {
      const wanted = (event as CustomEvent<{ mode?: Mode }>).detail?.mode;
      if (wanted) {
        handlePickMode(wanted);
        setSourceChosen(true);
      } else {
        setSourceChosen(false);
      }
      setOpen(true);
    };
    window.addEventListener(ADD_APP_EVENT, onAddApp);
    return () => window.removeEventListener(ADD_APP_EVENT, onAddApp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** After success: open the new app, unless the panel was closed meanwhile. */
  function finishCreated(siteId: string, label: string) {
    resetForm();
    setSourceChosen(false);
    if (closedWhileCreating.current) {
      closedWhileCreating.current = false;
      setNotice(`${label} is ready.`);
      setNoticeLink(`/apps/${siteId}`);
      router.refresh();
      return false;
    }
    setOpen(false);
    router.push(`/apps/${siteId}`);
    return true;
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
    // Leaving for the new app's page: keep the checklist up until it opens.
    let navigating = false;

    try {
      const appDomain = buildTemporaryProductionDomain({ slug: effectiveTemporarySlug, suffix: temporaryDomainSuffix });
      if (mode === "public" || mode === "private" || mode === "deploykey") {
        const envCount = github.envVars.filter((row) => row.key.trim()).length;
        const repoLabel = mode === "private" ? github.repo : mode === "public" ? github.repoUrl.replace(/^https:\/\/[^/]+\//, "") : github.sshUrl.replace(/^.*[:/]([^:/]+\/[^/]+?)(\.git)?$/, "$1");
        setProgress({
          title: `Creating ${name.trim() || "your app"}`,
          startedAt: Date.now(),
          steps: [
            { id: "hosting", label: "Preparing the client's hosting space", status: "pending" },
            { id: "create", label: `Creating the app from ${repoLabel || "the repository"}`, status: "pending" },
            ...(envCount ? [{ id: "env", label: `Adding ${envCount} environment variable${envCount === 1 ? "" : "s"}`, status: "pending" as const }] : []),
            ...(appDomain ? [{ id: "address", label: `Setting the address ${appDomain}`, status: "pending" as const }] : []),
            { id: "deploy", label: "Starting the first deploy", status: "pending" }
          ]
        });
        const { status: resStatus, body: data } = await postWithProgress(`/api/organizations/${organizationId}/sites/github`, {
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
        }, onStep);
        if (resStatus >= 400 || !data?.ok) {
          setError(data?.message ?? "Failed to create app");
          return;
        }
        if (data.webhook?.url && data.webhook?.secret && data.siteId) {
          // Shown once: the secret is how pushes prove they come from the repo.
          setWebhookInfo({ siteId: data.siteId, url: data.webhook.url, secret: data.webhook.secret, sshUrl: github.sshUrl });
          closedWhileCreating.current = false;
          setOpen(true);
          resetForm();
          return;
        }
        if (data.siteId) {
          // Straight to the new app, where the first deploy's progress shows.
          navigating = finishCreated(data.siteId, name.trim() || "Your app");
          return;
        }
        resetForm();
        setOpen(false);
        setNotice(data.message ?? "App created.");
        setNoticeFix(null);
        router.refresh();
        return;
      }

      if (mode === "create") {
        setProgress({
          title: `Creating ${name.trim() || "your WordPress site"}`,
          startedAt: Date.now(),
          steps: [
            { id: "hosting", label: "Preparing the client's hosting space", status: "pending" },
            { id: "create", label: "Creating WordPress and its database", status: "pending" },
            ...(appDomain
              ? [
                  { id: "address", label: `Setting the address ${appDomain}`, status: "pending" as const },
                  { id: "start", label: "Starting the site on its address", status: "pending" as const }
                ]
              : [])
          ]
        });
      }
      const { status: resStatus, body: data } = await postWithProgress(`/api/organizations/${organizationId}/sites`, {
          name: name.trim(),
          description: description.trim() || undefined,
          // In create mode the uuid does not exist yet — Coolify assigns it.
          coolifyServiceUuid: mode === "link" ? coolifyUuid.trim() || undefined : undefined,
          gitRepositoryUrl: mode === "link" ? gitUrl.trim() || undefined : undefined,
          provisionWordPress: mode === "create",
          temporaryDomainSlug: normalizeTemporaryDomainSlug(temporaryDomainSlug) || undefined,
          temporaryDomainSuffix
      }, onStep);

      if (resStatus >= 400) {
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
        if (mode === "create" && data?.id) {
          // Clean success: straight to the new site.
          navigating = finishCreated(data.id, name.trim() || "Your site");
          return;
        }
      }

      resetForm();
      setOpen(false);
      router.refresh();
    } catch {
      setError("Couldn't reach Jongo. Check your connection, then look in the app list before trying again.");
    } finally {
      setLoading(false);
      if (!navigating) setProgress(null);
    }
  }

  const webhookPanel = () => {
    if (!webhookInfo) return null;
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
      <div style={{ display: "grid", gap: "0.75rem" }}>
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
          <button type="button" className="btn" onClick={() => { const id = webhookInfo.siteId; setWebhookInfo(null); setOpen(false); router.push(`/apps/${id}`); }}>
            Open app
          </button>
        </div>
      </div>
    );
  };

  const sourceOptions = SOURCE_OPTIONS.filter(({ value }) =>
    (!githubOnly || value !== "link") && (githubAvailable || value !== "private") && (canAdopt || value !== "link")
  );
  const chosen = sourceOptions.find((option) => option.value === mode) ?? null;

  const sourcePicker = (
    <div style={{ display: "grid", gap: "0.85rem" }}>
      <p className="card-muted" style={{ margin: 0 }}>
        Import a Git repository or start a WordPress site. Hosting, the address and the first deploy are set up for you.
      </p>
      {([
        ["Import a Git repository", sourceOptions.filter((option) => option.value === "private" || option.value === "deploykey" || option.value === "public")],
        ["Start something new", sourceOptions.filter((option) => option.value === "create")],
        ["Already running", sourceOptions.filter((option) => option.value === "link")]
      ] as const).filter(([, options]) => options.length > 0).map(([heading, options]) => (
      <section key={heading} style={{ display: "grid", gap: "0.5rem" }}>
      <h3 className="source-group-title">{heading}</h3>
      <div role="list" style={{ display: "grid", gap: "0.6rem", gridTemplateColumns: "repeat(auto-fit, minmax(17rem, 1fr))" }}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="listitem"
            className="source-card"
            onClick={() => {
              handlePickMode(option.value);
              setSourceChosen(true);
            }}
          >
            <span className="source-card__icon">{option.icon}</span>
            <span className="source-card__text">
              <span className="source-card__title">{option.title}</span>
              <span className="source-card__help">{option.help}</span>
            </span>
          </button>
        ))}
      </div>
      </section>
      ))}
    </div>
  );

  const configure = (
    <div style={{ display: "grid", gap: "0.9rem" }}>
      {chosen ? (
        <div className="flex items-center gap-2.5">
          <span className="source-card__icon source-card__icon--small">{chosen.icon}</span>
          <div style={{ display: "grid" }}>
            <span className="font-semibold text-[14px]">{chosen.title}</span>
            <span className="card-muted text-[12.5px]">{chosen.detail}</span>
          </div>
          <button type="button" className="action-link text-[12.5px]" style={{ marginLeft: "auto", background: "none", border: 0, cursor: "pointer" }} onClick={() => { setSourceChosen(false); setError(null); }}>
            Change
          </button>
        </div>
      ) : null}
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
            onChange={(e) => setCoolifyUuid(parseCoolifyResourceReference(e.target.value).id)}
            placeholder={selectedApp ? selectedApp.id : "Paste the app's Coolify address or its id"}
            className="form-input mono-input"
          />
          <p className="form-help">Pasting the app's page address from Coolify works: the id is picked out for you.</p>
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
          <label className="form-label">Address</label>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={temporaryDomainSlug}
              onChange={(e) => setTemporaryDomainSlug(e.target.value)}
              placeholder={derivedTemporarySlug || "my-site"}
              className="form-input mono-input"
              aria-label="Address name"
              style={{ flex: "1 1 auto" }}
            />
            <span className="card-muted" aria-hidden="true">.</span>
            <select
              className="form-input"
              value={temporaryDomainSuffix}
              onChange={(e) => setTemporaryDomainSuffix(e.target.value)}
              aria-label="Address domain"
              style={{ flex: "0 0 auto", width: "auto" }}
            >
              {TEMPORARY_DOMAIN_SUFFIX_OPTIONS.map((suffix) => (
                <option key={suffix} value={suffix}>{suffix}</option>
              ))}
            </select>
          </div>
          <p className="form-help">
            {temporaryDomainPreview
              ? mode !== "link"
                ? `Starts on https://${temporaryDomainPreview}. Add your own domain any time after.`
                : `Recorded as https://${temporaryDomainPreview}; the adopted app keeps the address it already has.`
              : "Choose a name to see the address."}
          </p>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="form-row">
          <button type="submit" className="btn" disabled={loading}>
            {loading ? "Creating…" : mode === "create" ? "Create site" : mode === "link" ? "Link app" : "Deploy"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => { setSourceChosen(false); setError(null); }}>
            Back
          </button>
        </div>
      </form>
    </div>
  );

  const paywallCard = paywall ? (
    <div style={{ display: "grid", gap: "0.85rem", justifyItems: "start" }}>
      <span className="source-card__icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M7 15h3" /></svg>
      </span>
      <div style={{ display: "grid", gap: "0.3rem" }}>
        <h3 className="card-title" style={{ margin: 0 }}>{paywall.actionUrl === "/billing" ? "Update your payment to add apps" : "Choose a plan to start hosting"}</h3>
        <p className="card-muted" style={{ margin: 0 }}>
          {/* The heading already says it; keep the rest of the message. */}
          {paywall.message.replace(/^Choose a plan to start hosting apps\.\s*/, "") || paywall.message}
          {paywall.actionUrl === "/pricing" ? " Every plan includes unlimited sites and staging." : ""}
        </p>
      </div>
      {paywall.actionUrl ? (
        <a className="btn" href={paywall.actionUrl}>{paywall.actionUrl === "/billing" ? "Update payment" : "See plans"}</a>
      ) : null}
    </div>
  ) : null;

  let body: React.ReactNode;
  if (paywallCard && !progress && !webhookInfo) body = paywallCard;
  else if (progress) body = <CreationProgress title={progress.title} steps={progress.steps} startedAt={progress.startedAt} />;
  else if (webhookInfo) body = webhookPanel();
  else if (!sourceChosen) body = sourcePicker;
  else body = configure;

  const noticeBlock = notice ? (
    <div className="form-help" role="status" style={{ margin: 0, display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
      <span>{notice}</span>
      {noticeLink ? <a className="action-link" href={noticeLink}>Open app</a> : null}
      <button type="button" className="btn btn-secondary px-2.5 py-1 text-[12px]" onClick={() => { setNotice(null); setNoticeFix(null); setNoticeLink(null); }}>
        Dismiss
      </button>
      {noticeFix ? <RemedyButton remedy={noticeFix.remedy} endpoint={`/api/sites/${noticeFix.siteId}/remedies`} onDone={(ok) => ok && router.refresh()} /> : null}
    </div>
  ) : null;

  const trigger = (
    <button type="button" className="btn" onClick={() => { setSourceChosen(false); setOpen(true); }}>
      <PlusIcon className="btn-icon" />
      Add app
    </button>
  );

  if (presentation === "drawer") {
    return (
      <div style={{ display: "grid", gap: "0.5rem", justifyItems: "end" }}>
        {trigger}
        {noticeBlock}
        <ModalDrawer
          open={open}
          size="wide"
          title={progress ? "Creating your app" : webhookInfo ? "Connect push deploys" : sourceChosen && chosen ? chosen.title : "Add app"}
          onClose={() => {
            // Closing while it's being created is fine: the work carries on and
            // a notice says when it's ready.
            if (progress) closedWhileCreating.current = true;
            // The webhook secret was shown once; reopening starts a new app.
            if (webhookInfo) setWebhookInfo(null);
            setOpen(false);
          }}
        >
          {body}
        </ModalDrawer>
      </div>
    );
  }

  if (!open) {
    return (
      <div style={{ display: "grid", gap: "0.5rem", justifyItems: "start" }}>
        {trigger}
        {noticeBlock}
      </div>
    );
  }
  return <div className="card" style={{ marginBottom: "1rem" }}>{body}</div>;
}
