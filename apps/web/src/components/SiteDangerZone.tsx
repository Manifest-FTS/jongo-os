"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmDialog from "@/components/ConfirmDialog";
import { ToastStack, useToasts } from "@/components/Toasts";

type Props = {
  siteId: string;
  /** Typed by the operator to confirm. The slug, because it is unambiguous. */
  siteSlug: string;
  siteName: string;
  /** False for non-admins. The whole section is hidden, not just disabled. */
  canDelete: boolean;
  /** Whether this app is linked to a Coolify resource that could also go. */
  hasCoolifyResource: boolean;
};

/**
 * Deleting an app.
 *
 * Two separate things can be destroyed and conflating them is how people lose
 * work: removing the app from Jongo (a soft delete — the record is retained and
 * the running site is untouched), and destroying the underlying Coolify
 * resource (irreversible, takes the site offline and removes its volumes).
 *
 * So the Coolify destroy is opt-in, off by default, and the confirmation names
 * exactly which of the two is about to happen. The dialog requires the app slug
 * to be typed out — this is the one control on the page that can take a
 * customer's site down.
 */
export default function SiteDangerZone({ siteId, siteSlug, siteName, canDelete, hasCoolifyResource }: Props) {
  // Hidden outright rather than shown disabled. A greyed-out "Delete app" still
  // tells a collaborator this is theirs to attempt and invites a support ticket
  // when it refuses; the section is admin-only, so for everyone else there is
  // nothing here worth a heading that says "Danger".
  if (!canDelete) {
    return null;
  }

  const router = useRouter();
  const { toasts, push, dismiss } = useToasts();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [alsoDeleteCoolify, setAlsoDeleteCoolify] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deleteApp() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/sites/${siteId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteCoolifyResource: alsoDeleteCoolify })
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setError(payload?.error ?? "The app could not be deleted.");
        setOpen(false);
        return;
      }

      // Report what actually happened rather than a fixed string: asking for the
      // Coolify resource to go and having that part fail is exactly the thing
      // someone needs to know before they walk away.
      const coolifyFailed = alsoDeleteCoolify && payload?.coolifyDestroyed === false;
      push({
        tone: coolifyFailed ? "error" : "success",
        title: `${siteName} removed from Jongo.`,
        text: alsoDeleteCoolify
          ? coolifyFailed
            ? `Its Coolify resource could NOT be removed${payload?.coolifyDeletionMessage ? `: ${payload.coolifyDeletionMessage}` : ""}. Delete it manually.`
            : "Its Coolify resource was destroyed."
          : undefined,
        ttl: coolifyFailed ? 0 : undefined
      });

      setOpen(false);
      router.push("/apps");
      router.refresh();
    } catch {
      setError("The app could not be deleted — the request did not complete.");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      <article className="card" style={{ borderColor: "var(--danger, #dc2626)", marginTop: "2rem" }}>
        <h2 style={{ margin: 0, color: "var(--danger, #dc2626)" }}>Danger Zone</h2>

        <div
          style={{
            marginTop: "0.75rem",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "1rem",
            flexWrap: "wrap"
          }}
        >
          <div style={{ maxWidth: "38rem" }}>
            <h4 style={{ margin: 0, fontSize: "0.95rem" }}>Delete this app</h4>
            <p className="card-muted" style={{ margin: "0.25rem 0 0" }}>
              Remove <strong>{siteName}</strong> from Jongo. The live site remains online unless you also destroy its Coolify resource.
            </p>

            {hasCoolifyResource ? (
              <label
                style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", marginTop: "0.7rem", cursor: "pointer" }}
              >
                <input
                  type="checkbox"
                  checked={alsoDeleteCoolify}
                  onChange={(event) => setAlsoDeleteCoolify(event.target.checked)}
                  disabled={!canDelete || busy}
                  style={{ marginTop: "0.2rem" }}
                />
                <span className="card-muted" style={{ margin: 0 }}>
                  Also destroy the Coolify resource, including its containers and volumes.
                </span>
              </label>
            ) : null}

            {error ? <p className="form-error" style={{ margin: "0.6rem 0 0" }}>{error}</p> : null}
          </div>

          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setOpen(true)}
            disabled={!canDelete || busy}
            title={!canDelete ? "Only organisation admins can delete an app." : undefined}
          >
            {busy ? "Deleting..." : "Delete app"}
          </button>
        </div>
      </article>

      <ConfirmDialog
        open={open}
        title={`Delete ${siteName}?`}
        body={
          alsoDeleteCoolify
            ? `This removes the app from Jongo AND destroys its Coolify resource. The site goes offline immediately and its containers and volumes are deleted.`
            : `This removes the app from Jongo. The running site in Coolify is left untouched and keeps serving traffic.`
        }
        warning={
          alsoDeleteCoolify
            ? "This cannot be undone. Restore would require an existing backup and a new resource."
            : undefined
        }
        confirmPhrase={siteSlug}
        confirmLabel={alsoDeleteCoolify ? "Delete app and destroy resource" : "Delete app"}
        busy={busy}
        onConfirm={deleteApp}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
