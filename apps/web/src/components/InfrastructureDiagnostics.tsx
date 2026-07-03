import Link from "next/link";
import { ArrowRightIcon } from "@/components/JongoIcons";

type ReadinessState = "ready" | "attention" | "not_configured" | "unknown";

type ReadinessCheck = {
  key: string;
  label: string;
  state: ReadinessState;
  detail: string;
  nextStep?: string;
};

type Props = {
  readinessChecks: ReadinessCheck[];
  readinessSummary: { state: ReadinessState; detail: string };
  siteId: string;
};

function chipClassForReadiness(state: ReadinessState): string {
  if (state === "ready") return "healthy";
  if (state === "attention") return "degraded";
  if (state === "not_configured") return "error";
  return "unknown";
}

function labelForReadiness(state: ReadinessState): string {
  if (state === "ready") return "Ready";
  if (state === "attention") return "Needs attention";
  if (state === "not_configured") return "Not configured";
  return "Unknown";
}

export default function InfrastructureDiagnostics({ readinessChecks, readinessSummary, siteId }: Props) {
  return (
    <>
      <article className="card" style={{ gridColumn: "1 / -1", marginTop: "1rem" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <h3 className="card-title" style={{ marginTop: 0 }}>Operational Readiness</h3>
            <p className="card-muted" style={{ margin: "0.35rem 0 0" }}>
              Read-only Jongo checkpoints for backup, staging, and provider readiness. No actions here trigger deployments.
            </p>
          </div>
          <span className={`status-chip ${chipClassForReadiness(readinessSummary.state)}`}>
            {labelForReadiness(readinessSummary.state)}
          </span>
        </div>

        <p style={{ margin: "0.6rem 0 0", fontSize: "0.88rem", color: "var(--muted)" }}>
          {readinessSummary.detail}
        </p>

        <div style={{ display: "grid", gap: "0.7rem", marginTop: "0.85rem" }}>
          {readinessChecks.map((check) => (
            <div key={check.key} style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.65rem 0.75rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <strong style={{ fontSize: "0.9rem" }}>{check.label}</strong>
                <span className={`status-chip ${chipClassForReadiness(check.state)}`}>{labelForReadiness(check.state)}</span>
              </div>
              <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>{check.detail}</p>
              {check.state !== "ready" && check.nextStep ? (
                <p style={{ margin: "0.3rem 0 0", fontSize: "0.8rem" }}>
                  <strong>Next step:</strong> {check.nextStep}
                </p>
              ) : null}
            </div>
          ))}
        </div>

        <p style={{ margin: "0.75rem 0 0", fontSize: "0.84rem", color: "var(--muted)" }}>
          Need deeper troubleshooting? Open app settings for maintenance details or platform diagnostics.
        </p>
      </article>

      <article className="card" style={{ marginTop: "1rem" }}>
        <h3 className="card-title">Need Maintenance Details?</h3>
        <p className="card-muted" style={{ marginBottom: "0.6rem" }}>
          Use settings for mapping and provider linkage checks.
        </p>
        <p style={{ margin: 0, fontSize: "0.9rem" }}>
          <Link href={`/apps/${siteId}/settings`} className="action-link">
            Open app settings <ArrowRightIcon className="btn-icon" />
          </Link>
        </p>
      </article>
    </>
  );
}
