"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon } from "@/components/JongoIcons";
import ModalDrawer from "@/components/overlays/ModalDrawer";
import styles from "@/components/overlays/ModalDrawer.module.css";

type Organization = { id: string; name: string };
type Props = { triggerLabel?: string; onCreated?: (org: Organization) => void };

// Client UX bounds only: the API/Prisma text fields have no length limits.
// The API's 60-character slug cap is not a name constraint.
export const ORGANIZATION_NAME_LIMIT = 200;
export const ORGANIZATION_DESCRIPTION_LIMIT = 2000;

export function organizationInputError(name: string, description: string): string | null {
  if (!name.trim()) return "Enter a client name.";
  if (name.length > ORGANIZATION_NAME_LIMIT) return `Use ${ORGANIZATION_NAME_LIMIT} characters or fewer for the name.`;
  if (description.length > ORGANIZATION_DESCRIPTION_LIMIT) return `Use ${ORGANIZATION_DESCRIPTION_LIMIT} characters or fewer for the description.`;
  return null;
}

export function createdOrganization(data: unknown): Organization | null {
  // POST /api/organizations returns a flat DTO, not { organization }.
  if (!data || typeof data !== "object") return null;
  const { id, name } = data as Record<string, unknown>;
  return typeof id === "string" && id.trim() && typeof name === "string" && name.trim()
    ? { id, name } : null;
}

export default function CreateOrganizationForm({ triggerLabel = "New Client", onCreated }: Props = {}) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);

  function close() {
    request.current?.abort();
    request.current = null;
    setLoading(false);
    setError(null);
    setOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Synchronous guard covers a second submit before React rerenders.
    if (request.current) return;
    const validationError = organizationInputError(name, description);
    setError(validationError);
    if (validationError) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    let organization: Organization | null = null;
    try {
      const res = await fetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined
        }),
        signal: controller.signal
      });

      const data = await res.json().catch(() => null);
      if (controller.signal.aborted || request.current !== controller) return;
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Failed to create organization");
        return;
      }
      organization = createdOrganization(data);
      if (!organization) {
        setError("The server returned an unexpected response. Refresh the client list before trying again.");
        return;
      }
    } catch {
      if (!controller.signal.aborted && request.current === controller) setError("Network error — please try again");
      return;
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
    if (!organization || controller.signal.aborted) return;
    setName("");
    setDescription("");
    setOpen(false);
    router.refresh();
    onCreated?.(organization);
  }

  return (
    <>
      <button type="button" className={`btn ${styles.trigger}`} aria-haspopup="dialog"
        aria-expanded={open} aria-controls={`${id}-drawer`}
        onClick={() => { setError(null); setOpen(true); }}>
        {triggerLabel.startsWith("+") ? null : <PlusIcon className="btn-icon" />}
        {triggerLabel}
      </button>
      <ModalDrawer id={`${id}-drawer`} title="New Client / Organization" open={open} onClose={close}>
      <form onSubmit={handleSubmit} className={styles.form} aria-busy={loading}>
        <div className={styles.field}>
          <label htmlFor={`${id}-name`}>
            Name <span aria-hidden="true">*</span>
          </label>
          <input
            id={`${id}-name`}
            name="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Corp"
            required
            autoFocus
            maxLength={ORGANIZATION_NAME_LIMIT}
            aria-describedby={`${id}-name-help`}
            className={styles.input}
          />
          <p id={`${id}-name-help`} className={styles.help}>Required. Up to {ORGANIZATION_NAME_LIMIT} characters.</p>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-description`}>Description</label>
          <textarea
            id={`${id}-description`}
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            maxLength={ORGANIZATION_DESCRIPTION_LIMIT}
            rows={5}
            aria-describedby={`${id}-description-help`}
            className={styles.input}
          />
          <p id={`${id}-description-help`} className={styles.help}>Optional. Up to {ORGANIZATION_DESCRIPTION_LIMIT} characters.</p>
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={loading}>
            {loading ? "Creating…" : "Create"}
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={close}
          >
            Cancel
          </button>
        </div>
      </form>
      </ModalDrawer>
    </>
  );
}
