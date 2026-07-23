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

function StubToggle({
  label,
  help,
  initialEnabled = false
}: {
  label: string;
  help: string;
  initialEnabled?: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);

  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
      <div>
        <h4 style={{ margin: 0, fontSize: "0.95rem" }}>{label}</h4>
        <p className="card-muted" style={{ margin: "0.25rem 0 0" }}>{help}</p>
      </div>
      <button
        type="button"
        aria-label={`Toggle ${label}`}
        aria-pressed={enabled}
        style={{
          width: "58px",
          height: "32px",
          borderRadius: "999px",
          border: `1px solid ${enabled ? "var(--accent)" : "var(--border)"}`,
          background: enabled ? "var(--accent)" : "var(--surface-alt)",
          position: "relative",
          cursor: "pointer",
          transition: "background 0.2s ease, border-color 0.2s ease"
        }}
        onClick={() => {
          const next = !enabled;
          setEnabled(next);
          showSuccessToast(`${label} ${next ? "enabled" : "disabled"}.`);
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: "3px",
            left: enabled ? "30px" : "3px",
            width: "24px",
            height: "24px",
            borderRadius: "999px",
            background: "#fff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            transition: "left 0.2s ease"
          }}
        />
      </button>
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

  const normalizedSlug = useMemo(() => normalizeTemporaryDomainSlug(domainSlug) || "", [domainSlug]);
  const previewDomain = useMemo(
    () => buildTemporaryProductionDomain({ slug: normalizedSlug || "site", suffix: domainSuffix }),
    [normalizedSlug, domainSuffix]
  );

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
              <button
                type="button"
                className="btn"
                onClick={saveDomainSettings}
                disabled={!canManageDomainSlug || savingDomain}
              >
                {savingDomain ? "Saving..." : "Save"}
              </button>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
            <div>
              <h4 style={{ margin: 0, fontSize: "0.95rem" }}>Flush Cache</h4>
              <p className="card-muted" style={{ margin: "0.25rem 0 0" }}>Flush this environment's cache.</p>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => showSuccessToast("Cache flush request queued.")}
            >
              Flush Cache
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
