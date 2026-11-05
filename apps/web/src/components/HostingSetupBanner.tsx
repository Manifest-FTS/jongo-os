"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Shown on a client whose hosting project doesn't exist yet (its automatic
 * setup failed, or the client predates it). Admins can set it up now and,
 * if hosting refuses, see why.
 */
export default function HostingSetupBanner({
  organizationId,
  canSetUp,
  paywall = null
}: {
  organizationId: string;
  canSetUp: boolean;
  paywall?: { message: string; actionUrl: string | null } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; detail?: string | null } | null>(null);

  async function setUp() {
    setBusy(true);
    setResult(null);
    const res = await fetch(`/api/organizations/${encodeURIComponent(organizationId)}/hosting`, { method: "POST" }).catch(() => null);
    const data = res ? await res.json().catch(() => null) : null;
    setBusy(false);
    setResult({ ok: Boolean(data?.ok), message: data?.message ?? "Couldn't reach Jongo. Try again.", detail: data?.detail });
    if (data?.ok) router.refresh();
  }

  if (paywall) {
    return (
      <div className="hosting-banner" role="status">
        <div style={{ display: "grid", gap: "0.2rem" }}>
          <strong>Hosting starts with a plan</strong>
          <span>{paywall.message}</span>
        </div>
        {paywall.actionUrl ? (
          <a className="btn" href={paywall.actionUrl} style={{ flex: "0 0 auto" }}>
            {paywall.actionUrl === "/billing" ? "Update payment" : "See plans"}
          </a>
        ) : null}
      </div>
    );
  }

  if (result?.ok) {
    return (
      <div className="hosting-banner hosting-banner--ok" role="status">
        <strong>{result.message}</strong> Apps for this client can be created now.
      </div>
    );
  }

  return (
    <div className="hosting-banner" role="status">
      <div style={{ display: "grid", gap: "0.2rem" }}>
        <strong>Hosting isn&apos;t set up for this client yet</strong>
        <span>
          {canSetUp
            ? "It's normally created with the client. Set it up now, or it's done automatically with the first app."
            : "It's set up automatically with this client's first app, or by a client admin."}
        </span>
        {result && !result.ok ? (
          <span className="hosting-banner__error">
            {result.message}
            {result.detail ? <> {result.detail}</> : null}
          </span>
        ) : null}
      </div>
      {canSetUp ? (
        <button type="button" className="btn" disabled={busy} onClick={setUp} style={{ flex: "0 0 auto" }}>
          {busy ? "Setting up…" : result ? "Try again" : "Set up hosting"}
        </button>
      ) : null}
    </div>
  );
}
