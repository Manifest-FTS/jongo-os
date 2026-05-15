"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = { organizationId: string };

export default function CreateSiteForm({ organizationId }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [coolifyUuid, setCoolifyUuid] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`/api/organizations/${organizationId}/sites`, {
        method: "POST",
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
        setError(data.error ?? "Failed to create site");
        return;
      }

      setName("");
      setDescription("");
      setCoolifyUuid("");
      setGitUrl("");
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
      <button className="btn" onClick={() => setOpen(true)}>
        + New Site
      </button>
    );
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h3 className="card-title" style={{ marginBottom: "0.75rem" }}>New Site</h3>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.9rem" }}>
            Name <span style={{ color: "var(--error, #e55)" }}>*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-wordpress-site"
            required
            autoFocus
            style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--surface)", color: "inherit", fontSize: "0.95rem" }}
          />
        </div>
        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.9rem" }}>Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--surface)", color: "inherit", fontSize: "0.95rem" }}
          />
        </div>
        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.9rem" }}>
            Coolify Service UUID
          </label>
          <input
            type="text"
            value={coolifyUuid}
            onChange={(e) => setCoolifyUuid(e.target.value)}
            placeholder="e.g. dt0v391xre5rgtp50062tunm"
            style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--surface)", color: "inherit", fontSize: "0.95rem", fontFamily: "monospace" }}
          />
        </div>
        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.9rem" }}>Git Repository URL</label>
          <input
            type="url"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            placeholder="https://github.com/org/repo"
            style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--surface)", color: "inherit", fontSize: "0.95rem" }}
          />
        </div>
        {error && <p style={{ color: "var(--error, #e55)", marginBottom: "0.5rem", fontSize: "0.9rem" }}>{error}</p>}
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="submit" className="btn" disabled={loading}>
            {loading ? "Creating…" : "Create Site"}
          </button>
          <button
            type="button"
            className="btn"
            style={{ background: "transparent", border: "1px solid var(--border)" }}
            onClick={() => { setOpen(false); setError(null); }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
