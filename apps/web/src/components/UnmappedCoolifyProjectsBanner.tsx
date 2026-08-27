"use client";

import { useEffect, useState } from "react";

type UnmappedProject = { id: string; name: string };

export default function UnmappedCoolifyProjectsBanner() {
  const [projects, setProjects] = useState<UnmappedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/organizations/unmapped-coolify-projects", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setProjects((data as { unmapped?: UnmappedProject[] }).unmapped ?? []);
      }
    } catch {
      // Silent: this is a helpful nudge, not a critical path.
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function createClient(project: UnmappedProject) {
    setCreatingId(project.id);
    setError(null);
    try {
      const res = await fetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: project.name, coolifyProjectId: project.id, coolifyProjectName: project.name })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error ?? `Could not create a client for ${project.name}`);
        return;
      }
      window.location.reload();
    } finally {
      setCreatingId(null);
    }
  }

  if (loading || projects.length === 0) return null;

  return (
    <div className="diagnostic-banner">
      <strong>{projects.length} Coolify project{projects.length === 1 ? "" : "s"} not linked to a client.</strong>
      <span> These exist in Coolify but have no Jongo client yet, so their apps aren't visible here.</span>
      {error ? <p className="form-error" style={{ margin: "0.5rem 0 0" }}>{error}</p> : null}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.6rem" }}>
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            className="btn"
            style={{ padding: "0.25rem 0.6rem", fontSize: "0.8rem" }}
            onClick={() => void createClient(project)}
            disabled={creatingId === project.id}
          >
            {creatingId === project.id ? "Creating…" : `Create client: ${project.name}`}
          </button>
        ))}
      </div>
    </div>
  );
}
