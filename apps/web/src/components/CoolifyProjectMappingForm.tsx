"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

type CoolifyProjectOption = {
  id: string;
  name: string;
};

type Props = {
  organizationDbId: string;
  organizationName: string;
  availableProjects: CoolifyProjectOption[];
};

type LinkedMapping = {
  coolifyProjectId: string;
  coolifyProjectName?: string | null;
  isPrimary: boolean;
  driftState?: "aligned" | "name_drift" | "unknown";
  hasConflict?: boolean;
  source?: "legacy";
};

type MappingResponse = {
  organizationId: string;
  organizationName: string;
  legacy: {
    coolifyProjectId?: string | null;
    coolifyProjectName?: string | null;
  };
  linkedProjects: LinkedMapping[];
};

export default function CoolifyProjectMappingForm({
  organizationDbId,
  organizationName,
  availableProjects
}: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [mappingState, setMappingState] = useState<MappingResponse | null>(null);
  const [loadingMappings, setLoadingMappings] = useState(true);
  const [status, setStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const linkedProjectIds = useMemo(
    () => new Set((mappingState?.linkedProjects ?? []).map((item) => item.coolifyProjectId)),
    [mappingState]
  );

  const selectableProjects = useMemo(
    () => availableProjects.filter((project) => !linkedProjectIds.has(project.id)),
    [availableProjects, linkedProjectIds]
  );

  async function refreshMappings() {
    setLoadingMappings(true);
    try {
      const response = await fetch(`/api/organizations/${organizationDbId}/coolify-mapping`, {
        method: "GET",
        headers: { Accept: "application/json" }
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Failed to load linked projects");
      }

      const payload = (await response.json()) as MappingResponse;
      setMappingState(payload);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load linked projects");
      setStatus("error");
    } finally {
      setLoadingMappings(false);
    }
  }

  useEffect(() => {
    refreshMappings();
  }, [organizationDbId]);

  function handleSelect(event: React.ChangeEvent<HTMLSelectElement>) {
    setSelectedId(event.target.value);
    setStatus("idle");
    setErrorMessage("");
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("saving");
    setErrorMessage("");

    const selected = availableProjects.find((project) => project.id === selectedId);

    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/organizations/${organizationDbId}/coolify-mapping`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              coolifyProjectId: selectedId || null,
              coolifyProjectName: selected?.name ?? null,
              isPrimary: (mappingState?.linkedProjects.length ?? 0) === 0
            })
          }
        );

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setErrorMessage((data as { error?: string }).error ?? "Save failed.");
          setStatus("error");
          return;
        }

        setStatus("success");
        setSelectedId("");
        await refreshMappings();
      } catch {
        setErrorMessage("Network error. Please try again.");
        setStatus("error");
      }
    });
  }

  function handleRemove(projectId: string) {
    setStatus("saving");
    setErrorMessage("");

    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/organizations/${organizationDbId}/coolify-mapping`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "unlink", coolifyProjectId: projectId })
          }
        );

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setErrorMessage((data as { error?: string }).error ?? "Clear failed.");
          setStatus("error");
          return;
        }

        setStatus("success");
        await refreshMappings();
      } catch {
        setErrorMessage("Network error. Please try again.");
        setStatus("error");
      }
    });
  }

  function handleSetPrimary(projectId: string, projectName?: string | null) {
    setStatus("saving");
    setErrorMessage("");

    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/organizations/${organizationDbId}/coolify-mapping`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "link",
              coolifyProjectId: projectId,
              coolifyProjectName: projectName ?? null,
              isPrimary: true
            })
          }
        );

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setErrorMessage((data as { error?: string }).error ?? "Update failed.");
          setStatus("error");
          return;
        }

        setStatus("success");
        await refreshMappings();
      } catch {
        setErrorMessage("Network error. Please try again.");
        setStatus("error");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="coolify-mapping-form">
      <div className="form-field" style={{ marginBottom: "1rem" }}>
        <p className="form-label" style={{ marginBottom: "0.4rem" }}>Linked Coolify projects</p>
        {loadingMappings ? (
          <p className="form-help">Loading mappings…</p>
        ) : (mappingState?.linkedProjects.length ?? 0) === 0 ? (
          <p className="form-help">No linked projects yet.</p>
        ) : (
          <div style={{ display: "grid", gap: "0.55rem" }}>
            {mappingState?.linkedProjects.map((project) => {
              const label = project.coolifyProjectName ?? project.coolifyProjectId;
              const isDrift = project.driftState === "name_drift";
              return (
                <div key={project.coolifyProjectId} className="diagnostic-banner" style={{ display: "grid", gap: "0.35rem" }}>
                  <div style={{ display: "flex", gap: "0.45rem", alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{label}</strong>
                    <span className="tag">{project.coolifyProjectId}</span>
                    {project.isPrimary ? <span className="status-chip healthy">Primary</span> : <span className="status-chip unknown">Linked</span>}
                    {isDrift ? <span className="status-chip degraded">Name drift</span> : <span className="status-chip healthy">Name aligned</span>}
                    {project.hasConflict ? <span className="status-chip error">Conflict</span> : null}
                    {project.source === "legacy" ? <span className="status-chip unknown">Legacy fallback</span> : null}
                  </div>

                  <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap" }}>
                    {!project.isPrimary ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={isPending}
                        onClick={() => handleSetPrimary(project.coolifyProjectId, project.coolifyProjectName)}
                      >
                        Make primary
                      </button>
                    ) : null}

                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={isPending}
                      onClick={() => handleRemove(project.coolifyProjectId)}
                    >
                      Unlink
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="form-field">
        <label htmlFor={`coolify-project-${organizationDbId}`} className="form-label">
          Add linked project
        </label>
        {selectableProjects.length === 0 ? (
          <p className="form-help">
            No additional Coolify projects are available to link.
          </p>
        ) : (
          <select
            id={`coolify-project-${organizationDbId}`}
            className="form-input"
            value={selectedId}
            onChange={handleSelect}
            disabled={isPending}
          >
            <option value="">— Select project —</option>
            {selectableProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
        <p className="form-help">
          Client-to-project mapping is a link layer. Names are not auto-synced or auto-renamed.
        </p>
      </div>

      <div style={{ display: "flex", gap: "0.65rem", alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={isPending || !selectedId}
        >
          {status === "saving" ? "Saving…" : "Add mapping"}
        </button>

        {status === "success" && (
          <span style={{ fontSize: "0.85rem", color: "var(--tone-healthy)" }}>Saved.</span>
        )}
        {status === "error" && errorMessage && (
          <span style={{ fontSize: "0.85rem", color: "var(--tone-error)" }}>{errorMessage}</span>
        )}
      </div>

      <p className="form-help" style={{ marginTop: "0.65rem" }}>
        Drift check compares linked Coolify project names against client name <strong>{organizationName}</strong>.
      </p>
    </form>
  );
}
