"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import SiteStagingToggle from "@/components/SiteStagingToggle";
import {
  DEFAULT_TEMPORARY_DOMAIN_SUFFIX,
  TEMPORARY_DOMAIN_SUFFIX_OPTIONS,
  buildTemporaryProductionDomain,
  normalizeTemporaryDomainSlug
} from "@/lib/temporary-domains";
import { showSuccessToast } from "@/lib/ui/toast";

type Props = {
  siteId: string;
  canManageDomainSlug: boolean;
  initialDomainSlug?: string;
  initialDomainSuffix?: string;
  initialStagingEnabled: boolean;
  hasDetectedStagingTarget: boolean;
};

/**
 * A control that is not built yet.
 *
 * This replaces a toggle that flipped, showed "WP_DEBUG enabled", and wrote
 * nothing anywhere. Someone debugging a site would turn it on, see it
 * confirmed, and rule the setting out — the toggle actively cost them time.
 * Rendered disabled and labelled, it costs them nothing.
 */
function StubToggle({
  label,
  help
}: {
  label: string;
  help: string;
  initialEnabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
      <div>
        <h4 style={{ margin: 0, fontSize: "0.95rem" }}>{label}</h4>
        <p className="card-muted" style={{ margin: "0.25rem 0 0" }}>{help}</p>
      </div>
      <span className="status-chip unknown" style={{ flexShrink: 0 }}>Not available yet</span>
    </div>
  );
}

export default function WordPressAdvancedControls({
  siteId,
  canManageDomainSlug,
  initialDomainSlug,
  initialDomainSuffix,
  initialStagingEnabled,
  hasDetectedStagingTarget
}: Props) {
  const router = useRouter();
  const [domainSlug, setDomainSlug] = useState(initialDomainSlug ?? "");
  const [domainSuffix, setDomainSuffix] = useState(initialDomainSuffix ?? DEFAULT_TEMPORARY_DOMAIN_SUFFIX);
  const [savingDomain, setSavingDomain] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [flushingCache, setFlushingCache] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [cacheNote, setCacheNote] = useState<string | null>(null);

  const normalizedSlug = useMemo(() => normalizeTemporaryDomainSlug(domainSlug) || "", [domainSlug]);
  const previewDomain = useMemo(
    () => buildTemporaryProductionDomain({ slug: normalizedSlug || "site", suffix: domainSuffix }),
    [normalizedSlug, domainSuffix]
  );

  /**
   * Flush the site's caches.
   *
   * The success toast reports what the SERVER says was cleared, never a fixed
   * string. This button used to show "Cache flush request queued." with no
   * request behind it, so anyone debugging a stale page would rule out caching
   * on the strength of a message that meant nothing. A flush that finds nothing
   * to clear is surfaced as an error, because it is not a success.
   */
  async function flushCache() {
    setFlushingCache(true);
    setCacheError(null);
    setCacheNote(null);

    try {
      const response = await fetch(`/api/sites/${siteId}/cache/flush`, { method: "POST" });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.ok) {
        // "This site has no cache" is a normal state, not a malfunction.
        // Showing it in red made a stock WordPress install look broken, so it
        // reads as a note. It still is not a success — nothing was cleared.
        if (payload?.reason === "nothing_to_flush") {
          setCacheNote(payload.message);
          return;
        }
        setCacheError(payload?.message ?? "The cache could not be flushed.");
        return;
      }

      showSuccessToast(payload.message ?? "Cache flushed.");
    } catch {
      setCacheError("The cache could not be flushed — the request did not complete.");
    } finally {
      setFlushingCache(false);
    }
  }

  async function saveDomainSettings() {
    setSavingDomain(true);
    setDomainError(null);

    try {
      const response = await fetch(`/api/sites/${siteId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          temporaryDomainSlug: normalizedSlug || undefined,
          temporaryDomainSuffix: domainSuffix
        })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDomainError(data.error ?? "Failed to save domain slug settings");
        return;
      }

      showSuccessToast("Domain slug settings saved.");
      router.refresh();
    } catch {
      setDomainError("Network error while saving domain settings.");
    } finally {
      setSavingDomain(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <article className="card">
        <h2 style={{ margin: 0 }}>Quick Actions</h2>

        <div style={{ marginTop: "0.9rem", display: "grid", gap: "0.8rem" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "1rem" }}>Domain Slug</h3>
            <p className="card-muted" style={{ margin: "0.35rem 0 0.75rem" }}>
              Control the preferred temporary production domain for this app.
            </p>
            <div className="form-stack" style={{ marginTop: 0 }}>
              <label className="form-label" style={{ marginBottom: "-0.25rem" }}>Site Slug</label>
              <input
                className="form-input mono-input"
                value={domainSlug}
                onChange={(event) => setDomainSlug(event.target.value)}
                placeholder="site-slug"
                disabled={!canManageDomainSlug}
              />
              <label className="form-label" style={{ marginBottom: "-0.25rem" }}>Preferred Domain</label>
              <select
                className="form-input"
                value={domainSuffix}
                onChange={(event) => setDomainSuffix(event.target.value)}
                disabled={!canManageDomainSlug}
              >
                {TEMPORARY_DOMAIN_SUFFIX_OPTIONS.map((suffix) => (
                  <option key={suffix} value={suffix}>
                    https://{buildTemporaryProductionDomain({ slug: normalizedSlug || "site", suffix }) ?? `site.${suffix}`}
                  </option>
                ))}
              </select>
              {domainError ? <p className="form-error" style={{ margin: 0 }}>{domainError}</p> : null}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn"
                  style={{ width: "min(100%, 7.5rem)" }}
                  onClick={saveDomainSettings}
                  disabled={!canManageDomainSlug || savingDomain}
                >
                  {savingDomain ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
            <div>
              <h4 style={{ margin: 0, fontSize: "0.95rem" }}>Flush Cache</h4>
              <p className="card-muted" style={{ margin: "0.25rem 0 0" }}>
                Clear this app&apos;s object cache, page cache files and Redis.
              </p>
              {cacheError ? <p className="form-error" style={{ margin: "0.35rem 0 0" }}>{cacheError}</p> : null}
              {cacheNote ? <p className="card-muted" style={{ margin: "0.35rem 0 0" }}>{cacheNote}</p> : null}
            </div>
            <button
              type="button"
              className="btn"
              onClick={flushCache}
              disabled={!canManageDomainSlug || flushingCache}
            >
              {flushingCache ? "Flushing..." : "Flush Cache"}
            </button>
          </div>
        </div>
      </article>

      <article className="card">
        <h2 style={{ margin: 0 }}>App Settings</h2>
        <div style={{ marginTop: "0.9rem", display: "grid", gap: "0.9rem" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
            <div>
              <h4 style={{ margin: 0, fontSize: "0.95rem" }}>Staging</h4>
              <p className="card-muted" style={{ margin: "0.25rem 0 0" }}>
                Enable staging environment copy of your production site.
              </p>
            </div>
            <SiteStagingToggle
              siteId={siteId}
              initialEnabled={initialStagingEnabled}
              hasDetectedStagingTarget={hasDetectedStagingTarget}
            />
          </div>

          <StubToggle
            label="WP_DEBUG"
            help="Enable WordPress debug mode. Warning: this can negatively impact site appearance and performance."
          />

          <StubToggle
            label="WP_CACHE"
            help="Enable wp_cache to allow approved caching plugins to build and control a persistent cache."
          />
        </div>
      </article>
    </div>
  );
}
