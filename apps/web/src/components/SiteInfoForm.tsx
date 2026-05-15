"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  siteId: string;
  initial: {
    name: string;
    description?: string;
    coolifyServiceUuid?: string;
    gitRepositoryUrl?: string;
  };
};

export default function SiteInfoForm({ siteId, initial }: Props) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [coolifyUuid, setCoolifyUuid] = useState(initial.coolifyServiceUuid ?? "");
  const [gitUrl, setGitUrl] = useState(initial.gitRepositoryUrl ?? "");
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
          gitRepositoryUrl: gitUrl.trim() || undefined
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
    <form onSubmit={handleSubmit}>
      <div style={{ marginBottom: "0.75rem" }}>
        <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.9rem" }}>
          Name <span style={{ color: "var(--error, #e55)" }}>*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setSuccess(false); }}
          required
          style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--surface)", color: "inherit", fontSize: "0.95rem" }}
        />
      </div>
      <div style={{ marginBottom: "0.75rem" }}>
        <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.9rem" }}>Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => { setDescription(e.target.value); setSuccess(false); }}
          style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--surface)", color: "inherit", fontSize: "0.95rem" }}
        />
      </div>
      <div style={{ marginBottom: "0.75rem" }}>
        <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.9rem" }}>Coolify Service UUID</label>
        <input
          type="text"
          value={coolifyUuid}
          onChange={(e) => { setCoolifyUuid(e.target.value); setSuccess(false); }}
          placeholder="Links this site to a Coolify application"
          style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--surface)", color: "inherit", fontSize: "0.95rem", fontFamily: "monospace" }}
        />
      </div>
      <div style={{ marginBottom: "1rem" }}>
        <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.9rem" }}>Git Repository URL</label>
        <input
          type="url"
          value={gitUrl}
          onChange={(e) => { setGitUrl(e.target.value); setSuccess(false); }}
          placeholder="https://github.com/org/repo"
          style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--surface)", color: "inherit", fontSize: "0.95rem" }}
        />
      </div>
      {error && <p style={{ color: "var(--error, #e55)", marginBottom: "0.5rem", fontSize: "0.9rem" }}>{error}</p>}
      {success && <p style={{ color: "var(--success, #4c4)", marginBottom: "0.5rem", fontSize: "0.9rem" }}>Saved successfully</p>}
      <button type="submit" className="btn" disabled={loading}>
        {loading ? "Saving…" : "Save Changes"}
      </button>
    </form>
  );
}
