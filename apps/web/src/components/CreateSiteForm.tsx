"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon } from "@/components/JongoIcons";
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
};

export default function CreateSiteForm({ organizationId, availableApps = [] }: Props) {
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
  const [mode, setMode] = useState<"link" | "create">("create");

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
    setError(null);
  }

  function handlePickMode(value: "link" | "create") {
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
        setNotice(data.provision.message ?? "App created, but its domain could not be applied. Set it in Coolify.");
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
            <button type="button" className="btn btn-secondary" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h3 className="card-title" style={{ marginBottom: "0.5rem" }}>Add App</h3>
      {availableApps.length > 0 ? (
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
          ["link", "Link existing app", "Adopt a resource that already exists in Coolify."],
          ["create", "Create WordPress site", "Provision a new WordPress + MariaDB service in Coolify."]
        ] as const).map(([value, label, help]) => (
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
          ? "A new WordPress + MariaDB service is created in Coolify and deployed. It is added here once Coolify confirms it."
          : "Adopts an app that already exists in Coolify. Nothing new is created."}
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
              ? mode === "create"
                ? `Temporary production URL: https://${temporaryDomainPreview} — applied to the new Coolify service.`
                : `Temporary production URL: https://${temporaryDomainPreview} — recorded in Jongo only; the adopted app keeps the domain it already has in Coolify.`
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
