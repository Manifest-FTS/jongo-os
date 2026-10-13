import RemedyButton from "@/components/RemedyButton";
import { remedy } from "@/lib/remedies";
import type { StagingDatabaseView } from "@/lib/staging-databases";

const STATUS: Record<string, { label: string; tone: string }> = {
  creating: { label: "Creating", tone: "degraded" },
  copying: { label: "Copying production's data", tone: "degraded" },
  ready: { label: "Ready", tone: "healthy" },
  failed: { label: "Not ready", tone: "error" }
};

function ago(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** Staging's own databases (copies of production's) and anything it still shares with production. */
export default function StagingDatabasesSummary({ siteId, view, canRetry }: { siteId: string; view: StagingDatabaseView; canRetry: boolean }) {
  if (view.databases.length === 0 && view.shared.length === 0) return null;
  const anyFailed = view.databases.some((db) => db.status === "failed");
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 rounded-[10px] border border-solid border-border">
      {view.databases.map((db) => {
        const status = STATUS[db.status] ?? { label: db.status, tone: "unknown" };
        return (
          <div key={db.id} className="flex items-center gap-2 flex-wrap text-[13px]">
            <span className="text-muted text-[12px]">Staging database</span>
            <span className="font-semibold">copy of {db.name}</span>
            <span className={`status-chip ${status.tone}`}>{status.label}</span>
            {db.lastCopiedAt ? <span className="text-muted text-[12px]">last copied {ago(db.lastCopiedAt)}{db.tableCount !== null ? ` · ${db.tableCount} tables` : ""}</span> : null}
            {db.status === "failed" && db.lastError ? <span className="basis-full text-warn-text text-[12.5px]">{db.lastError}</span> : null}
          </div>
        );
      })}
      {view.shared.length ? (
        <p className="m-0 text-[12.5px] text-warn-text">
          Staging shares {view.shared.join(", ")} with production: changes made on staging there are real.
        </p>
      ) : null}
      {anyFailed && canRetry ? <RemedyButton remedy={remedy("retry_staging_database")} endpoint={`/api/sites/${siteId}/remedies`} /> : null}
    </div>
  );
}
