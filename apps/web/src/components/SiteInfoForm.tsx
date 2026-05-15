"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  siteId: string;
  initial: {
    name: string;
    description?: string;
    coolifyServiceUuid?: string;
    coolifyProjectId?: string;
    gitRepositoryUrl?: string;
    stagingEnabled?: boolean;
  };
};

export default function SiteInfoForm({ siteId, initial }: Props) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [coolifyUuid, setCoolifyUuid] = useState(initial.coolifyServiceUuid ?? "");
  const [coolifyProjectId, setCoolifyProjectId] = useState(initial.coolifyProjectId ?? "");
  const [gitUrl, setGitUrl] = useState(initial.gitRepositoryUrl ?? "");
  const [stagingEnabled, setStagingEnabled] = useState(Boolean(initial.stagingEnabled));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

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
          stagingEnabled
        })
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Failed to save changes");
        return;
      }

      setSuccess(true);
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
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
        <label className="form-label">Coolify Service UUID</label>
        <input
          type="text"
          value={coolifyUuid}
          onChange={(e) => { setCoolifyUuid(e.target.value); setSuccess(false); }}
          placeholder="Links this site to a Coolify application"
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
        <label className="form-label">Coolify Project ID</label>
        <input
          type="text"
          value={coolifyProjectId}
          onChange={(e) => { setCoolifyProjectId(e.target.value); setSuccess(false); }}
          placeholder="Project UUID/ID from Coolify"
          className="form-input mono-input"
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <label className="form-label" style={{ marginBottom: 0 }}>Enable Staging Workspace</label>
        <input
          type="checkbox"
          checked={stagingEnabled}
          onChange={(e) => { setStagingEnabled(e.target.checked); setSuccess(false); }}
          style={{ width: "18px", height: "18px" }}
        />
      </div>
      {error && <p className="form-error">{error}</p>}
      {success && <p className="form-success">Saved successfully</p>}
      <button type="submit" className="btn" disabled={loading}>
        {loading ? "Saving…" : "Save Changes"}
      </button>
    </form>
  );
}
