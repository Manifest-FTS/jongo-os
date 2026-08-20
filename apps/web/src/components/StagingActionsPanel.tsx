"use client";

import { useState } from "react";
import { ToastStack, useToasts } from "@/components/Toasts";

/**
 * Staging actions and options.
 *
 * Only Flush cache is wired up. Everything else is a PLACEHOLDER, rendered as
 * visibly unavailable rather than as a control that appears to work — the
 * toggles this replaces flipped, showed "WP_DEBUG enabled", and persisted
 * nothing, which cost anyone debugging a site an afternoon.
 *
 * Returns a single wrapper element, not a fragment. As a fragment its two cards
 * became separate children of the page's grid, so "Staging Options" was thrown
 * into the right-hand column and the reference panels were pushed out of it.
 */

type Props = {
  siteId: string;
  /** False when there is no staging copy to act on. */
  stagingReady: boolean;
  canManage: boolean;
};

function PendingRow({ title, help }: { title: string; help: string }) {
  return (
    <div className="panel-row panel-row--pending">
      <div className="panel-row__body">
        <h4 className="panel-row__title">{title}</h4>
        <p className="panel-row__help">{help}</p>
      </div>
      <div className="panel-row__control">
        {/* One quiet chip. A chip AND a dead button AND a dash is three ways
            of saying the same thing, and reads as clutter rather than calm. */}
        <span className="status-chip unknown">Not available yet</span>
      </div>
    </div>
  );
}

export default function StagingActionsPanel({ siteId, stagingReady, canManage }: Props) {
  const { toasts, push, dismiss } = useToasts();
  const [flushing, setFlushing] = useState(false);
  const [syncing, setSyncing] = useState(false);
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

  async function syncFromProduction() {
    if (!window.confirm("Replace staging files and database content with the current production site? Staging-only changes will be lost.")) {
      return;
    }

    setSyncing(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch(`/api/sites/${siteId}/staging/sync`, { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        setError(payload?.message ?? "Production content could not be synced to staging.");
        return;
      }

      push({ tone: "success", title: payload.message ?? "Production content synced to staging." });
    } catch {
      setError("Production content could not be synced to staging — the request did not complete.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="stack">
      <ToastStack toasts={toasts} onDismiss={dismiss} />

      <article className="card">
        <h2 className="panel-heading">Staging Actions</h2>

        <div className="panel-row">
          <div className="panel-row__body">
            <h4 className="panel-row__title">Flush cache</h4>
            <p className="panel-row__help">
              Clears the staging site&apos;s object cache, page cache files and Redis.
            </p>
            {error ? <p className="form-error panel-row__note">{error}</p> : null}
            {note ? <p className="card-muted panel-row__note">{note}</p> : null}
            {!stagingReady ? (
              <p className="card-muted panel-row__note">There is no staging copy to flush yet.</p>
            ) : null}
          </div>
          <div className="panel-row__control">
            <button
              type="button"
              className="btn"
              onClick={flushStagingCache}
              disabled={!canManage || !stagingReady || flushing}
            >
              {flushing ? "Flushing…" : "Flush cache"}
            </button>
          </div>
        </div>

        <div className="panel-row">
          <div className="panel-row__body">
            <h4 className="panel-row__title">Sync from production</h4>
            <p className="panel-row__help">
              Replace staging files and database content with the current live site.
            </p>
          </div>
          <div className="panel-row__control">
            <button
              type="button"
              className="btn"
              onClick={syncFromProduction}
              disabled={!canManage || !stagingReady || syncing}
            >
              {syncing ? "Syncing…" : "Sync content"}
            </button>
          </div>
        </div>
        <PendingRow
          title="Reset login attempts"
          help="Clear a WordPress login lockout without waiting it out."
        />
      </article>

      <article className="card">
        <h2 className="panel-heading">Staging Options</h2>
        <p className="panel-subheading">
          Shown as unavailable until they actually write to the site. A toggle that reports success
          without changing anything is worse than one that is missing.
        </p>
        <div className="stack--tight">
          <PendingRow title="Force HTTPS" help="Redirect all requests to the staging site over HTTPS." />
          <PendingRow title="WP_DEBUG" help="Display WordPress warnings and error messages on staging." />
          <PendingRow title="WP_CACHE" help="Allow approved caching plugins to build a persistent cache." />
          <PendingRow title="Privacy Mode" help="Require a username and password to view the staging site." />
        </div>
      </article>
    </div>
  );
}
