"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Create: posts the app manifest to GitHub (to a personal account or an
 * organization), which creates the app and sends the admin back to Jongo.
 * Resync: uploads the app's key to the hosting server again.
 */
export default function GithubAppSetup(
  props:
    | { mode: "create"; manifest: string; state: string; disabledReason: string | null }
    | { mode: "resync"; hasKey: boolean }
) {
  const router = useRouter();
  const [owner, setOwner] = useState("manifest-fts");
  const [name, setName] = useState("Jongo Deploys");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (props.mode === "resync") {
    return (
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          className="btn btn-secondary px-3 py-1.5 text-[12.5px]"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const response = await fetch("/api/github/app/manifest-callback", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "resync_key" })
            }).catch(() => null);
            const payload = response ? await response.json().catch(() => null) : null;
            setNotice(payload?.message ?? "Couldn't reach Jongo. Try again.");
            setBusy(false);
            router.refresh();
          }}
        >
          {busy ? "Uploading…" : props.hasKey ? "Re-sync key" : "Upload key"}
        </button>
        {notice ? <span className="text-[12.5px] text-muted">{notice}</span> : null}
      </div>
    );
  }

  const manifest = JSON.stringify({ ...JSON.parse(props.manifest), name: name.trim() || "Jongo Deploys" });
  const target = owner.trim()
    ? `https://github.com/organizations/${encodeURIComponent(owner.trim())}/settings/apps/new?state=${encodeURIComponent(props.state)}`
    : `https://github.com/settings/apps/new?state=${encodeURIComponent(props.state)}`;

  return (
    <form action={target} method="post" className="mt-4 flex flex-col gap-3 max-w-[520px]">
      <input type="hidden" name="manifest" value={manifest} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="font-semibold">App name on GitHub</span>
        <input className="form-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={34} />
        <span className="text-muted text-[12px]">Must be unique on GitHub. Clients see it when they install.</span>
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="font-semibold">GitHub organization that owns it</span>
        <input className="form-input" value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Leave empty for your personal account" />
      </label>
      <div>
        <button type="submit" className="btn" disabled={Boolean(props.disabledReason)}>
          Create Jongo GitHub App
        </button>
      </div>
      {props.disabledReason ? <p className="m-0 text-[12.5px] text-warn-text">{props.disabledReason}</p> : null}
      <p className="m-0 text-[12px] text-muted">
        GitHub asks you to confirm, then sends you back here. Permissions: read code and repository details. Events: pushes and repository changes.
      </p>
    </form>
  );
}
