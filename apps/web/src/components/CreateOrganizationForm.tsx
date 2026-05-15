"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon } from "@/components/JongoIcons";

export default function CreateOrganizationForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [coolifyProjectId, setCoolifyProjectId] = useState("");
  const [coolifyProjectName, setCoolifyProjectName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          coolifyProjectId: coolifyProjectId.trim() || undefined,
          coolifyProjectName: coolifyProjectName.trim() || undefined
        })
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Failed to create organization");
        return;
      }

      setName("");
      setDescription("");
      setCoolifyProjectId("");
      setCoolifyProjectName("");
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
        <PlusIcon className="btn-icon" />
        New Client
      </button>
    );
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h3 className="card-title" style={{ marginBottom: "0.75rem" }}>New Client / Organization</h3>
      <form onSubmit={handleSubmit} className="form-stack">
        <div>
          <label className="form-label">
            Name <span style={{ color: "var(--error, #e55)" }}>*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Corp"
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
        <div>
          <label className="form-label">Coolify Project ID (Optional)</label>
          <input
            type="text"
            value={coolifyProjectId}
            onChange={(e) => setCoolifyProjectId(e.target.value)}
            placeholder="e.g. project UUID from Coolify"
            className="form-input mono-input"
          />
        </div>
        <div>
          <label className="form-label">Coolify Project Name (Optional)</label>
          <input
            type="text"
            value={coolifyProjectName}
            onChange={(e) => setCoolifyProjectName(e.target.value)}
            placeholder="e.g. Acme Client"
            className="form-input"
          />
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="form-row">
          <button type="submit" className="btn" disabled={loading}>
            {loading ? "Creating…" : "Create"}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { setOpen(false); setError(null); }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
