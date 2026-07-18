"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_TEMPORARY_DOMAIN_SUFFIX,
  TEMPORARY_DOMAIN_SUFFIX_OPTIONS,
  buildTemporaryProductionDomain,
  normalizeTemporaryDomainSlug
} from "@/lib/temporary-domains";

type Props = {
  siteId: string;
  initial: {
    name: string;
    description?: string;
    coolifyServiceUuid?: string;
    coolifyProjectId?: string;
    gitRepositoryUrl?: string;
    temporaryDomainSlug?: string;
    temporaryDomainSuffix?: string;
  };
};

export default function SiteInfoForm({ siteId, initial }: Props) {
  const router = useRouter();
  const initialDerivedTemporarySlug = normalizeTemporaryDomainSlug(initial.name);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [coolifyUuid, setCoolifyUuid] = useState(initial.coolifyServiceUuid ?? "");
  const [coolifyProjectId, setCoolifyProjectId] = useState(initial.coolifyProjectId ?? "");
  const [gitUrl, setGitUrl] = useState(initial.gitRepositoryUrl ?? "");
  const [temporaryDomainSlug, setTemporaryDomainSlug] = useState(initial.temporaryDomainSlug ?? initialDerivedTemporarySlug);
  const [temporaryDomainSuffix, setTemporaryDomainSuffix] = useState<string>(
    initial.temporaryDomainSuffix ?? DEFAULT_TEMPORARY_DOMAIN_SUFFIX
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteCoolifyResource, setDeleteCoolifyResource] = useState(false);
  const derivedTemporarySlug = normalizeTemporaryDomainSlug(name) || initialDerivedTemporarySlug;
  const effectiveTemporarySlug = normalizeTemporaryDomainSlug(temporaryDomainSlug) || derivedTemporarySlug;
  const temporaryDomainPreview = buildTemporaryProductionDomain({
    slug: effectiveTemporarySlug,
    suffix: temporaryDomainSuffix
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setLoading(true);

    try {
      const res = await fetch(`/api/sites/${siteId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          coolifyServiceUuid: coolifyUuid.trim() || undefined,
          coolifyProjectId: coolifyProjectId.trim() || undefined,
          gitRepositoryUrl: gitUrl.trim() || undefined,
          temporaryDomainSlug: normalizeTemporaryDomainSlug(temporaryDomainSlug) || undefined,
          temporaryDomainSuffix
        })
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Failed to save changes");
        return;
      }

      setSuccess(true);
      // If the slug changed (name rename), navigate to the new URL so the page
      // doesn't 404 on the old siteId.
      if (data.slug && data.slug !== siteId) {
        router.replace(`/apps/${data.slug}/settings`);
      } else {
        router.refresh();
      }
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteSite() {
    if (deleting || loading) {
      return;
    }

    const confirmed = window.confirm(
      deleteCoolifyResource
        ? "Delete this app from Jongo and attempt to delete the linked Coolify resource as well?"
        : "Delete this app from Jongo?"
    );
    if (!confirmed) {
      return;
    }

    setError(null);
    setSuccess(false);
    setDeleting(true);

    try {
      const res = await fetch(`/api/sites/${siteId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteCoolifyResource })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to delete app");
        return;
      }

      router.replace("/apps");
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="form-stack">
      <div>
        <label className="form-label">
          Name <span style={{ color: "var(--error, #e55)" }}>*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setSuccess(false); }}
          required
          className="form-input"
        />
      </div>
      <div>
        <label className="form-label">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => { setDescription(e.target.value); setSuccess(false); }}
          className="form-input"
        />
      </div>
      <div>
        <label className="form-label">Service ID</label>
        <input
          type="text"
          value={coolifyUuid}
          onChange={(e) => { setCoolifyUuid(e.target.value); setSuccess(false); }}
          placeholder="Links this site to a deployment target"
          className="form-input mono-input"
        />
      </div>
      <div>
        <label className="form-label">Git Repository URL</label>
        <input
          type="url"
          value={gitUrl}
          onChange={(e) => { setGitUrl(e.target.value); setSuccess(false); }}
          placeholder="https://github.com/org/repo"
          className="form-input"
        />
      </div>
      <div>
        <label className="form-label">Project ID</label>
        <input
          type="text"
          value={coolifyProjectId}
          onChange={(e) => { setCoolifyProjectId(e.target.value); setSuccess(false); }}
          placeholder="Project UUID/ID from the provider"
          className="form-input mono-input"
        />
      </div>
      <div>
        <label className="form-label">Temporary Domain Slug</label>
        <input
          type="text"
          value={temporaryDomainSlug}
          onChange={(e) => { setTemporaryDomainSlug(e.target.value); setSuccess(false); }}
          placeholder={derivedTemporarySlug || "my-site"}
          className="form-input mono-input"
        />
      </div>
      <div>
        <label className="form-label">Temporary Domain Suffix</label>
        <select
          value={temporaryDomainSuffix}
          onChange={(e) => { setTemporaryDomainSuffix(e.target.value); setSuccess(false); }}
          className="form-input"
        >
          {TEMPORARY_DOMAIN_SUFFIX_OPTIONS.map((suffix) => (
            <option key={suffix} value={suffix}>{suffix}</option>
          ))}
        </select>
        <p className="form-help">
          {temporaryDomainPreview ? `Temporary production URL: https://${temporaryDomainPreview}` : "Temporary production URL preview unavailable"}
        </p>
      </div>
      {error && <p className="form-error">{error}</p>}
      {success && <p className="form-success">Saved successfully</p>}
      <button type="submit" className="btn" disabled={loading}>
        {loading ? "Saving…" : "Save Changes"}
      </button>
      <div style={{ marginTop: "1rem", paddingTop: "0.85rem", borderTop: "1px solid var(--border)" }}>
        <label className="form-help" style={{ display: "flex", alignItems: "center", gap: "0.45rem", marginBottom: "0.65rem" }}>
          <input
            type="checkbox"
            checked={deleteCoolifyResource}
            onChange={(e) => setDeleteCoolifyResource(e.target.checked)}
          />
          Also delete linked Coolify resource (if linked)
        </label>
        <button type="button" className="btn btn-danger" disabled={deleting || loading} onClick={handleDeleteSite}>
          {deleting ? "Deleting…" : "Delete App"}
        </button>
      </div>
    </form>
  );
}
