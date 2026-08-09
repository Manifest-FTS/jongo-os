"use client";

import { useState } from "react";
import { ToastStack, useToasts } from "@/components/Toasts";

/**
 * Staging actions and options.
 *
 * Only Flush cache is wired up. Everything else is a PLACEHOLDER, and is
 * rendered as visibly unavailable — disabled, labelled "Not available yet" —
 * rather than as a control that appears to work.
 *
 * That distinction is the whole point. The WP_DEBUG and WP_CACHE toggles this
 * replaces flipped, showed a success toast, and persisted nothing; someone
 * debugging a site would turn WP_DEBUG on, see it confirmed, and conclude the
 * problem lay elsewhere. A disabled control tells the truth. A fake one costs
 * somebody an afternoon.
 */

type Props = {
  siteId: string;
  /** False when there is no staging copy to act on. */
  stagingReady: boolean;
  canManage: boolean;
};

function Placeholder({
  title,
  help,
  control
}: {
  title: string;
  help: string;
  control: "button" | "toggle";
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "1rem",
        padding: "0.85rem 0",
        borderTop: "1px solid var(--border, #e5e7eb)"
      }}
    >
      <div style={{ maxWidth: "32rem" }}>
        <h4 style={{ margin: 0, fontSize: "0.95rem" }}>{title}</h4>
        <p className="card-muted" style={{ margin: "0.25rem 0 0" }}>{help}</p>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexShrink: 0 }}>
        <span className="status-chip unknown">Not available yet</span>
        {control === "button" ? (
          <button type="button" className="btn" disabled aria-disabled="true">
            Unavailable
          </button>
        ) : (
          <span className="card-muted" aria-hidden="true" style={{ fontSize: "0.8rem" }}>
            —
          </span>
        )}
      </div>
    </div>
  );
}

export default function StagingActionsPanel({ siteId, stagingReady, canManage }: Props) {
  const { toasts, push, dismiss } = useToasts();
  const [flushing, setFlushing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function flushStagingCache() {
    setFlushing(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch(`/api/sites/${siteId}/cache/flush`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Explicit: the default is production, and silently flushing the live
        // site when staging was asked for would be both wrong and invisible.
        body: JSON.stringify({ target: "staging" })
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.ok) {
        // "Nothing to flush" is a normal state, not a malfunction.
        if (payload?.reason === "nothing_to_flush") {
          setNote(payload.message);
          return;
        }
        setError(payload?.message ?? "The staging cache could not be flushed.");
        return;
      }

      push({ tone: "success", title: payload.message ?? "Staging cache flushed." });
    } catch {
      setError("The staging cache could not be flushed — the request did not complete.");
    } finally {
      setFlushing(false);
    }
  }

  return (
    <>
      <ToastStack toasts={toasts} onDismiss={dismiss} />

      <article className="card">
        <h2 style={{ margin: 0 }}>Staging Actions</h2>

        <div
          style={{
            marginTop: "0.9rem",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "1rem"
          }}
        >
          <div style={{ maxWidth: "32rem" }}>
            <h4 style={{ margin: 0, fontSize: "0.95rem" }}>Flush cache</h4>
            <p className="card-muted" style={{ margin: "0.25rem 0 0" }}>
              Clears the staging site&apos;s object cache, page cache files and Redis.
            </p>
            {error ? <p className="form-error" style={{ margin: "0.5rem 0 0" }}>{error}</p> : null}
            {note ? <p className="card-muted" style={{ margin: "0.5rem 0 0" }}>{note}</p> : null}
            {!stagingReady ? (
              <p className="card-muted" style={{ margin: "0.5rem 0 0" }}>
                There is no staging copy to flush yet.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="btn"
            onClick={flushStagingCache}
            disabled={!canManage || !stagingReady || flushing}
          >
            {flushing ? "Flushing..." : "Flush cache"}
          </button>
        </div>

        <Placeholder
          title="Reset staging environment"
          help="Create a new staging copy from the live site. The current staging site will be lost."
          control="button"
        />
        <Placeholder
          title="Reset login attempts"
          help="Clear a WordPress login lockout without waiting it out."
          control="button"
        />
      </article>

      <article className="card" style={{ marginTop: "1rem" }}>
        <h2 style={{ margin: 0 }}>Staging Options</h2>
        <p className="card-muted" style={{ margin: "0.35rem 0 0" }}>
          These are shown as disabled until they actually write to the site. A toggle that reports
          success without changing anything is worse than one that is missing.
        </p>
        <div style={{ marginTop: "0.4rem" }}>
          <Placeholder
            title="Force HTTPS"
            help="Redirect all requests to the staging site over HTTPS."
            control="toggle"
          />
          <Placeholder
            title="WP_DEBUG"
            help="Display WordPress warnings and error messages on staging."
            control="toggle"
          />
          <Placeholder
            title="WP_CACHE"
            help="Allow approved caching plugins to build a persistent cache."
            control="toggle"
          />
          <Placeholder
            title="Privacy Mode"
            help="Require a username and password to view the staging site."
            control="toggle"
          />
        </div>
      </article>
    </>
  );
}
