"use client";

import { useState, useTransition } from "react";

type CoolifyProjectOption = {
  id: string;
  name: string;
};

type Props = {
  organizationDbId: string;
  currentProjectId?: string;
  currentProjectName?: string;
  availableProjects: CoolifyProjectOption[];
};

export default function CoolifyProjectMappingForm({
  organizationDbId,
  currentProjectId,
  currentProjectName,
  availableProjects
}: Props) {
  const [selectedId, setSelectedId] = useState(currentProjectId ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const isMapped = Boolean(currentProjectId);

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
              coolifyProjectName: selected?.name ?? null
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
      } catch {
        setErrorMessage("Network error. Please try again.");
        setStatus("error");
      }
    });
  }

  function handleClear(event: React.MouseEvent) {
    event.preventDefault();
    setSelectedId("");
    setStatus("saving");
    setErrorMessage("");

    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/organizations/${organizationDbId}/coolify-mapping`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ coolifyProjectId: null, coolifyProjectName: null })
          }
        );

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setErrorMessage((data as { error?: string }).error ?? "Clear failed.");
          setStatus("error");
          return;
        }

        setStatus("success");
      } catch {
        setErrorMessage("Network error. Please try again.");
        setStatus("error");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="coolify-mapping-form">
      <div className="form-field">
        <label htmlFor={`coolify-project-${organizationDbId}`} className="form-label">
          Coolify Project
        </label>
        {availableProjects.length === 0 ? (
          <p className="form-help">
            No Coolify projects available. Check that your Coolify API connection is configured.
          </p>
        ) : (
          <select
            id={`coolify-project-${organizationDbId}`}
            className="form-input"
            value={selectedId}
            onChange={handleSelect}
            disabled={isPending}
          >
            <option value="">— Unassigned —</option>
            {availableProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
        <p className="form-help">
          Mapping a Coolify Project links this client workspace to all sites deployed under it.
        </p>
      </div>

      <div style={{ display: "flex", gap: "0.65rem", alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={isPending || selectedId === (currentProjectId ?? "")}
        >
          {status === "saving" ? "Saving…" : "Save mapping"}
        </button>

        {isMapped && selectedId !== "" && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleClear}
            disabled={isPending}
          >
            Remove mapping
          </button>
        )}

        {status === "success" && (
          <span style={{ fontSize: "0.85rem", color: "var(--tone-healthy)" }}>Saved.</span>
        )}
        {status === "error" && errorMessage && (
          <span style={{ fontSize: "0.85rem", color: "var(--tone-error)" }}>{errorMessage}</span>
        )}
      </div>

      {isMapped && (
        <p className="form-help" style={{ marginTop: "0.65rem" }}>
          Currently mapped to: <strong>{currentProjectName ?? currentProjectId}</strong>
        </p>
      )}
    </form>
  );
}
