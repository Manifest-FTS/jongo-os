"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { USAGE_WINDOWS } from "@/lib/usage-format";

/**
 * One row, above everything it scopes: the date window first, then client and
 * app. Changing any of them re-renders every tile, chart and table below from
 * the same slice, so the numbers always agree with each other.
 */
export default function UsageFilters({
  days,
  clients,
  apps,
  clientId,
  appId
}: {
  days: number;
  clients?: Array<{ id: string; name: string }>;
  apps?: Array<{ id: string; name: string; organizationId: string }>;
  clientId?: string | null;
  appId?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    startTransition(() => router.push(`${pathname}?${next.toString()}`));
  };

  const appOptions = (apps ?? []).filter((a) => !clientId || a.organizationId === clientId);
  const selectClass =
    "h-10 px-3 rounded-lg border border-solid border-border-strong bg-surface text-[0.9rem] text-text";

  return (
    <div className={`flex flex-wrap items-center gap-3 transition-opacity ${pending ? "opacity-60" : ""}`}>
      <div className="tab-rail" role="group" aria-label="Time window">
        {USAGE_WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            className={`tab-link${w === days ? " is-active" : ""}`}
            aria-pressed={w === days}
            onClick={() => update({ window: String(w) })}
          >
            Last {w} days
          </button>
        ))}
      </div>

      {clients && clients.length > 1 ? (
        <label className="flex items-center gap-2 text-[0.88rem] text-muted">
          Client
          <select
            className={selectClass}
            value={clientId ?? ""}
            onChange={(e) => update({ client: e.target.value || null, app: null })}
          >
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      ) : null}

      {apps && apps.length > 1 ? (
        <label className="flex items-center gap-2 text-[0.88rem] text-muted">
          App
          <select className={selectClass} value={appId ?? ""} onChange={(e) => update({ app: e.target.value || null })}>
            <option value="">All apps</option>
            {appOptions.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
