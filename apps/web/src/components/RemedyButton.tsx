"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/lib/public-ui";
import type { Remedy } from "@/lib/remedies";

/**
 * The button next to a message that used to say "do this in Coolify". Runs the
 * remedy in place and shows the result; a remedy that only partly worked can
 * hand back the next one (e.g. address applied, restart refused -> Restart).
 */
export default function RemedyButton({
  remedy: initial,
  endpoint,
  onDone,
  confirmText,
  className
}: {
  remedy: Remedy;
  /** `/api/sites/<id>/remedies` or `/api/domains/charges/<id>/remedies`. */
  endpoint: string;
  onDone?: (ok: boolean) => void;
  confirmText?: string;
  className?: string;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<Remedy | null>(initial);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    if (!current) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: current.action, target: current.target, params: current.params })
      });
      const payload = await response.json().catch(() => null);
      const ok = Boolean(payload?.ok);
      setResult({ ok, text: payload?.message ?? (ok ? "Done." : `That didn't work (HTTP ${response.status}).`) });
      setCurrent(ok ? null : (payload?.remedy as Remedy | null) ?? current);
      if (onDone) onDone(ok);
      else if (ok) router.refresh();
    } catch {
      setResult({ ok: false, text: "Lost the connection. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={cx("inline-flex flex-col items-start gap-1.5", className)}>
      {current ? (
        <button type="button" className="btn btn-secondary px-3 py-1.5 text-[12.5px]" disabled={busy} onClick={() => void run()}>
          {busy ? "Working…" : current.label}
        </button>
      ) : null}
      {result ? (
        <span className={cx("text-[12.5px]", result.ok ? "text-healthy-text" : "text-warn-text")} role="status">
          {result.text}
        </span>
      ) : null}
    </span>
  );
}
