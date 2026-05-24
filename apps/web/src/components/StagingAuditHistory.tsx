"use client";

import { useEffect, useMemo, useState } from "react";

type StagingAuditHistoryItem = {
  id: string;
  createdAt: string;
  actionType?: string;
  promoteAttemptId?: string;
  message: string;
  domains: string[];
  preferredStagingDomain?: string;
};

type Props = {
  siteId: string;
  items: StagingAuditHistoryItem[];
  initialAttemptId?: string;
};

type FilterMode = "all" | "domain-sync" | "attempt";
type AttemptStatusTone = "healthy" | "degraded" | "error" | "unknown";

type AttemptStatusResponse = {
  ok?: boolean;
  attemptId?: string;
  status?: "blocked" | "triggered" | "in_progress" | "succeeded" | "failed";
  statusLabel?: string;
  statusTone?: AttemptStatusTone;
  message?: string;
  deploymentId?: string;
  deploymentStatus?: string;
  blockingReason?: string;
  triggeredAt?: string;
  finishedAt?: string;
  updatedAt?: string;
  events?: Array<{
    createdAt: string;
    actionType: string;
    message: string;
    deploymentId?: string;
    deploymentStatus?: string;
    blockingReason?: string;
  }>;
  error?: string;
};

type AttemptStatusDetails = {
  statusLabel: string;
  tone: AttemptStatusTone;
  status?: "blocked" | "triggered" | "in_progress" | "succeeded" | "failed";
  message?: string;
  deploymentId?: string;
  deploymentStatus?: string;
  blockingReason?: string;
  triggeredAt?: string;
  finishedAt?: string;
  updatedAt?: string;
  events: Array<{
    createdAt: string;
    actionType: string;
    message: string;
    deploymentId?: string;
    deploymentStatus?: string;
    blockingReason?: string;
  }>;
};

const INITIAL_VISIBLE_COUNT = 5;
const SHOW_MORE_STEP = 5;
const INCIDENT_METADATA_STORAGE_PREFIX = "jongo-os:incident-package-metadata";

type IncidentPackageMetadata = {
  owner: string;
  ticketId: string;
  environmentNote: string;
};

type IncidentPackageSummary = {
  status: string;
  statusLabel: string;
  severity: "high" | "medium" | "low" | "unknown";
  isIncident: boolean;
  blockingReason?: string;
  recommendedNextAction: string;
  owner?: string;
  ticketId?: string;
  environmentNote?: string;
};

function buildIncidentMetadataStorageKey(siteId: string, attemptId: string): string {
  return `${INCIDENT_METADATA_STORAGE_PREFIX}:${siteId}:${attemptId}`;
}

function readIncidentPackageMetadata(siteId: string, attemptId: string): IncidentPackageMetadata {
  if (typeof window === "undefined") {
    return { owner: "", ticketId: "", environmentNote: "" };
  }

  try {
    const raw = window.localStorage.getItem(buildIncidentMetadataStorageKey(siteId, attemptId));
    if (!raw) {
      return { owner: "", ticketId: "", environmentNote: "" };
    }

    const parsed = JSON.parse(raw) as Partial<IncidentPackageMetadata>;
    return {
      owner: typeof parsed.owner === "string" ? parsed.owner : "",
      ticketId: typeof parsed.ticketId === "string" ? parsed.ticketId : "",
      environmentNote: typeof parsed.environmentNote === "string" ? parsed.environmentNote : ""
    };
  } catch {
    return { owner: "", ticketId: "", environmentNote: "" };
  }
}

function writeIncidentPackageMetadata(siteId: string, attemptId: string, metadata: IncidentPackageMetadata): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const isEmpty =
      metadata.owner.trim().length === 0 &&
      metadata.ticketId.trim().length === 0 &&
      metadata.environmentNote.trim().length === 0;

    if (isEmpty) {
      window.localStorage.removeItem(buildIncidentMetadataStorageKey(siteId, attemptId));
      return;
    }

    window.localStorage.setItem(buildIncidentMetadataStorageKey(siteId, attemptId), JSON.stringify(metadata));
  } catch {
    // Ignore storage quota or privacy mode failures.
  }
}

function clearIncidentPackageMetadata(siteId: string, attemptId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(buildIncidentMetadataStorageKey(siteId, attemptId));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

function formatIncidentSummaryText(attemptId: string, summary: IncidentPackageSummary): string {
  const lines = [
    `Attempt id: ${attemptId}`,
    `Status: ${summary.statusLabel} (${summary.status})`,
    `Severity: ${summary.severity}`,
    `Incident: ${summary.isIncident ? "yes" : "no"}`,
    `Recommended next action: ${summary.recommendedNextAction}`
  ];

  if (summary.blockingReason) {
    lines.push(`Blocking reason: ${summary.blockingReason}`);
  }

  if (summary.owner) {
    lines.push(`Owner: ${summary.owner}`);
  }

  if (summary.ticketId) {
    lines.push(`Ticket id: ${summary.ticketId}`);
  }

  if (summary.environmentNote) {
    lines.push(`Environment note: ${summary.environmentNote}`);
  }

  return lines.join("\n");
}

function formatAuditAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatActionLabel(actionType?: string): string {
  switch (actionType) {
    case "staging_enable_requested":
      return "Staging enable requested";
    case "staging_enable_existing":
      return "Staging already present";
    case "staging_enable_provision":
      return "Staging provisioned";
    case "staging_disable_requested":
      return "Staging disable requested";
    case "staging_disable_destroy":
      return "Staging disabled and destroyed";
    case "staging_domains_updated":
      return "Staging domains updated";
    case "staging_domains_update_failed":
      return "Staging domains update failed";
    case "staging_promote_blocked":
      return "Promotion blocked by preflight";
    case "staging_promote_triggered":
      return "Production promotion triggered";
    case "staging_promote_in_progress":
      return "Production promotion in progress";
    case "staging_promote_succeeded":
      return "Production promotion succeeded";
    case "staging_promote_failed":
      return "Production promotion failed";
    default:
      return actionType ?? "Staging action";
  }
}

function isDomainSyncAction(actionType?: string): boolean {
  return actionType === "staging_domains_updated" || actionType === "staging_domains_update_failed";
}

function isPromoteAction(actionType?: string): boolean {
  return actionType === "staging_promote_blocked"
    || actionType === "staging_promote_triggered"
    || actionType === "staging_promote_in_progress"
    || actionType === "staging_promote_succeeded"
    || actionType === "staging_promote_failed";
}

function fallbackAttemptStatus(actionType?: string): { label: string; tone: AttemptStatusTone } | null {
  if (actionType === "staging_promote_blocked") {
    return { label: "Blocked", tone: "error" };
  }

  if (actionType === "staging_promote_failed") {
    return { label: "Failed", tone: "error" };
  }

  if (actionType === "staging_promote_succeeded") {
    return { label: "Succeeded", tone: "healthy" };
  }

  if (actionType === "staging_promote_in_progress") {
    return { label: "In progress", tone: "degraded" };
  }

  if (actionType === "staging_promote_triggered") {
    return { label: "Triggered", tone: "degraded" };
  }

  return null;
}

function normalizeAttemptStatusKey(label: string): "triggered" | "in_progress" | "succeeded" | "failed" | "blocked" {
  const normalized = label.trim().toLowerCase();
  if (normalized.includes("blocked")) {
    return "blocked";
  }

  if (normalized.includes("failed")) {
    return "failed";
  }

  if (normalized.includes("succeed")) {
    return "succeeded";
  }

  if (normalized.includes("progress")) {
    return "in_progress";
  }

  return "triggered";
}

function isIncidentStatusLabel(label?: string): boolean {
  if (!label) {
    return false;
  }

  const normalized = label.trim().toLowerCase();
  return normalized.includes("failed") || normalized.includes("blocked");
}

function formatAuditExportText(items: StagingAuditHistoryItem[], activeFilterLabel: string): string {
  const content = items
    .map((item) => {
      const lines = [
        `${formatActionLabel(item.actionType)} (${formatAuditAgo(item.createdAt)})`,
        `Message: ${item.message}`
      ];

      if (item.promoteAttemptId) {
        lines.push(`Attempt id: ${item.promoteAttemptId}`);
      }

      if (item.domains.length > 0) {
        lines.push(`Domains: ${item.domains.join(", ")}`);
      }

      if (item.preferredStagingDomain) {
        lines.push(`Preferred staging domain: ${item.preferredStagingDomain}`);
      }

      return lines.join("\n");
    })
    .join("\n\n");

  return [`Active filter: ${activeFilterLabel}`, `Exported events: ${items.length}`, "", content].join("\n").trim();
}

function formatIncidentHandoffText(params: {
  attemptId: string;
  statusLabel: string;
  items: StagingAuditHistoryItem[];
  latestMessage: string;
  deploymentId?: string;
  deploymentStatus?: string;
  blockingReason?: string;
  triggeredAt?: string;
  finishedAt?: string;
  updatedAt?: string;
  latestEventAt?: string;
  firstEventAt?: string;
}): string {
  const latestEventAt = params.latestEventAt ?? params.items[0]?.createdAt;
  const firstEventAt = params.firstEventAt ?? params.items[params.items.length - 1]?.createdAt;

  const lines = [
    `Attempt id: ${params.attemptId}`,
    `Status: ${params.statusLabel}`,
    `Timeline events: ${params.items.length}`,
    `Latest event at: ${latestEventAt ?? "unknown"}`,
    `First event at: ${firstEventAt ?? "unknown"}`,
    `Latest message: ${params.latestMessage}`
  ];

  if (params.deploymentId) {
    lines.push(`Deployment id: ${params.deploymentId}`);
  }

  if (params.deploymentStatus) {
    lines.push(`Deployment status: ${params.deploymentStatus}`);
  }

  if (params.blockingReason) {
    lines.push(`Blocking reason: ${params.blockingReason}`);
  }

  if (params.triggeredAt) {
    lines.push(`Triggered at: ${params.triggeredAt}`);
  }

  if (params.finishedAt) {
    lines.push(`Finished at: ${params.finishedAt}`);
  }

  if (params.updatedAt) {
    lines.push(`Updated at: ${params.updatedAt}`);
  }

  return lines.join("\n");
}

export default function StagingAuditHistory({ siteId, items, initialAttemptId }: Props) {
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [attemptFilter, setAttemptFilter] = useState("");
  const [incidentOwner, setIncidentOwner] = useState("");
  const [incidentTicketId, setIncidentTicketId] = useState("");
  const [incidentEnvironmentNote, setIncidentEnvironmentNote] = useState("");
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);
  const [copyStatus, setCopyStatus] = useState<"idle" | "success" | "error">("idle");
  const [copyMessage, setCopyMessage] = useState("");
  const [attemptStatusById, setAttemptStatusById] = useState<Record<string, { label: string; tone: AttemptStatusTone }>>({});
  const [attemptDetailsById, setAttemptDetailsById] = useState<Record<string, AttemptStatusDetails>>({});

  const latestAttemptId = useMemo(() => {
    const entry = items.find((item) => typeof item.promoteAttemptId === "string" && item.promoteAttemptId.length > 0);
    return entry?.promoteAttemptId ?? "";
  }, [items]);

  const latestIncidentAttemptId = useMemo(() => {
    const attempted = new Set<string>();

    for (const item of items) {
      const attemptId = item.promoteAttemptId?.trim();
      if (!attemptId || attempted.has(attemptId)) {
        continue;
      }

      attempted.add(attemptId);
      const statusLabel = attemptStatusById[attemptId]?.label;
      if (isIncidentStatusLabel(statusLabel)) {
        return attemptId;
      }

      if (item.actionType === "staging_promote_failed" || item.actionType === "staging_promote_blocked") {
        return attemptId;
      }
    }

    return "";
  }, [items, attemptStatusById]);

  const normalizedAttemptFilter = attemptFilter.trim();

  useEffect(() => {
    if (filterMode !== "attempt" || !normalizedAttemptFilter) {
      return;
    }

    const metadata = readIncidentPackageMetadata(siteId, normalizedAttemptFilter);
    setIncidentOwner(metadata.owner);
    setIncidentTicketId(metadata.ticketId);
    setIncidentEnvironmentNote(metadata.environmentNote);
  }, [filterMode, normalizedAttemptFilter, siteId]);

  useEffect(() => {
    if (filterMode !== "attempt" || !normalizedAttemptFilter) {
      return;
    }

    writeIncidentPackageMetadata(siteId, normalizedAttemptFilter, {
      owner: incidentOwner,
      ticketId: incidentTicketId,
      environmentNote: incidentEnvironmentNote
    });
  }, [filterMode, normalizedAttemptFilter, siteId, incidentOwner, incidentTicketId, incidentEnvironmentNote]);

  const activeFilterLabel = useMemo(() => {
    if (filterMode === "all") {
      return "All events";
    }

    if (filterMode === "domain-sync") {
      return "Domain sync events";
    }

    return normalizedAttemptFilter
      ? `Attempt: ${normalizedAttemptFilter}`
      : "Attempt filter (no id set)";
  }, [filterMode, normalizedAttemptFilter]);

  const isLatestAttemptActive =
    filterMode === "attempt" &&
    normalizedAttemptFilter.length > 0 &&
    normalizedAttemptFilter === latestAttemptId;
  const isIncidentAttemptActive =
    filterMode === "attempt" &&
    normalizedAttemptFilter.length > 0 &&
    normalizedAttemptFilter === latestIncidentAttemptId;

  const filteredItems = useMemo(() => {
    if (filterMode === "all") {
      return items;
    }

    if (filterMode === "attempt") {
      if (!normalizedAttemptFilter) {
        return [];
      }

      return items.filter((item) => item.promoteAttemptId === normalizedAttemptFilter);
    }

    return items.filter((item) => isDomainSyncAction(item.actionType));
  }, [items, filterMode, normalizedAttemptFilter]);

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT);
  }, [filterMode, normalizedAttemptFilter]);

  useEffect(() => {
    const normalized = initialAttemptId?.trim() ?? "";
    if (!normalized) {
      return;
    }

    setAttemptFilter(normalized);
    setFilterMode("attempt");
  }, [initialAttemptId]);

  useEffect(() => {
    const attemptIds = Array.from(new Set(items
      .map((item) => item.promoteAttemptId?.trim() ?? "")
      .filter((value) => value.length > 0)));

    const missingAttemptIds = attemptIds.filter((attemptId) => !attemptDetailsById[attemptId]);
    if (missingAttemptIds.length === 0) {
      return;
    }

    let cancelled = false;

    async function loadAttemptStatuses() {
      const updates: Record<string, AttemptStatusDetails> = {};

      await Promise.all(missingAttemptIds.map(async (attemptId) => {
        try {
          const response = await fetch(
            `/api/sites/${siteId}/staging/promote-attempt?attemptId=${encodeURIComponent(attemptId)}`,
            { cache: "no-store" }
          );
          const payload = (await response.json()) as AttemptStatusResponse;

          if (!response.ok || !payload.ok) {
            return;
          }

          const label = payload.statusLabel?.trim();
          const tone = payload.statusTone;
          if (!label || !tone) {
            return;
          }

          updates[attemptId] = {
            statusLabel: label,
            tone,
            status: payload.status,
            message: typeof payload.message === "string" ? payload.message : undefined,
            deploymentId: typeof payload.deploymentId === "string" ? payload.deploymentId : undefined,
            deploymentStatus: typeof payload.deploymentStatus === "string" ? payload.deploymentStatus : undefined,
            blockingReason: typeof payload.blockingReason === "string" ? payload.blockingReason : undefined,
            triggeredAt: typeof payload.triggeredAt === "string" ? payload.triggeredAt : undefined,
            finishedAt: typeof payload.finishedAt === "string" ? payload.finishedAt : undefined,
            updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : undefined,
            events: Array.isArray(payload.events)
              ? payload.events.map((event) => ({
                createdAt: event.createdAt,
                actionType: event.actionType,
                message: event.message,
                deploymentId: event.deploymentId,
                deploymentStatus: event.deploymentStatus,
                blockingReason: event.blockingReason
              }))
              : []
          };
        } catch {
          // Ignore transient fetch errors; fallback badge mapping still applies.
        }
      }));

      if (cancelled || Object.keys(updates).length === 0) {
        return;
      }

      setAttemptDetailsById((current) => ({ ...current, ...updates }));
      setAttemptStatusById((current) => {
        const statusUpdates = Object.fromEntries(
          Object.entries(updates).map(([attemptId, details]) => [attemptId, { label: details.statusLabel, tone: details.tone }])
        );

        return { ...current, ...statusUpdates };
      });
    }

    loadAttemptStatuses();

    return () => {
      cancelled = true;
    };
  }, [items, siteId, attemptDetailsById]);

  function clearAttemptFilter() {
    setAttemptFilter("");
    setFilterMode("all");
  }

  function activateLatestAttemptFilter() {
    if (!latestAttemptId) {
      return;
    }

    if (isLatestAttemptActive) {
      clearAttemptFilter();
      return;
    }

    setAttemptFilter(latestAttemptId);
    setFilterMode("attempt");
  }

  function activateLatestIncidentAttemptFilter() {
    if (!latestIncidentAttemptId) {
      return;
    }

    if (isIncidentAttemptActive) {
      clearAttemptFilter();
      return;
    }

    setAttemptFilter(latestIncidentAttemptId);
    setFilterMode("attempt");
  }

  const visibleItems = filteredItems.slice(0, visibleCount);
  const canShowMore = visibleItems.length < filteredItems.length;
  const canShowLess = filteredItems.length > INITIAL_VISIBLE_COUNT && visibleCount > INITIAL_VISIBLE_COUNT;

  const promoteStatusSummary = useMemo(() => {
    const summary = {
      total: 0,
      triggered: 0,
      in_progress: 0,
      succeeded: 0,
      failed: 0,
      blocked: 0
    };

    for (const item of filteredItems) {
      if (!isPromoteAction(item.actionType)) {
        continue;
      }

      const endpointStatus = item.promoteAttemptId ? attemptStatusById[item.promoteAttemptId] : undefined;
      const fallbackStatusInfo = fallbackAttemptStatus(item.actionType);
      const attemptStatus = endpointStatus ?? fallbackStatusInfo;
      if (!attemptStatus) {
        continue;
      }

      const key = normalizeAttemptStatusKey(attemptStatus.label);
      summary.total += 1;
      summary[key] += 1;
    }

    return summary;
  }, [filteredItems, attemptStatusById]);

  const scopedAttemptItems = useMemo(
    () => (filterMode === "attempt" && normalizedAttemptFilter
      ? filteredItems.filter((item) => item.promoteAttemptId === normalizedAttemptFilter)
      : []),
    [filterMode, normalizedAttemptFilter, filteredItems]
  );

  const incidentHandoff = useMemo(() => {
    if (filterMode !== "attempt" || !normalizedAttemptFilter || scopedAttemptItems.length === 0) {
      return null;
    }

    const latestPromoteEvent = scopedAttemptItems.find((item) => isPromoteAction(item.actionType));
    const attemptDetails = attemptDetailsById[normalizedAttemptFilter];
    const endpointStatus = attemptStatusById[normalizedAttemptFilter];
    const fallbackStatus = fallbackAttemptStatus(latestPromoteEvent?.actionType);
    const statusLabel = attemptDetails?.statusLabel ?? endpointStatus?.label ?? fallbackStatus?.label ?? "Unknown";

    const deploymentId =
      attemptDetails?.deploymentId
      ?? attemptDetails?.events.find((event) => typeof event.deploymentId === "string")?.deploymentId;
    const deploymentStatus =
      attemptDetails?.deploymentStatus
      ?? attemptDetails?.events.find((event) => typeof event.deploymentStatus === "string")?.deploymentStatus;
    const blockingReason =
      attemptDetails?.blockingReason
      ?? attemptDetails?.events.find((event) => typeof event.blockingReason === "string")?.blockingReason;

    const latestEventAt = attemptDetails?.events[0]?.createdAt ?? scopedAttemptItems[0]?.createdAt;
    const firstEventAt =
      attemptDetails?.events[attemptDetails.events.length - 1]?.createdAt
      ?? scopedAttemptItems[scopedAttemptItems.length - 1]?.createdAt;

    return formatIncidentHandoffText({
      attemptId: normalizedAttemptFilter,
      statusLabel,
      items: scopedAttemptItems,
      latestMessage: attemptDetails?.message ?? latestPromoteEvent?.message ?? scopedAttemptItems[0].message,
      deploymentId,
      deploymentStatus,
      blockingReason,
      triggeredAt: attemptDetails?.triggeredAt,
      finishedAt: attemptDetails?.finishedAt,
      updatedAt: attemptDetails?.updatedAt,
      latestEventAt,
      firstEventAt
    });
  }, [filterMode, normalizedAttemptFilter, scopedAttemptItems, attemptStatusById, attemptDetailsById]);

  const incidentHandoffJson = useMemo(() => {
    if (filterMode !== "attempt" || !normalizedAttemptFilter || scopedAttemptItems.length === 0) {
      return null;
    }

    const latestPromoteEvent = scopedAttemptItems.find((item) => isPromoteAction(item.actionType));
    const attemptDetails = attemptDetailsById[normalizedAttemptFilter];
    const endpointStatus = attemptStatusById[normalizedAttemptFilter];
    const fallbackStatus = fallbackAttemptStatus(latestPromoteEvent?.actionType);
    const statusLabel = attemptDetails?.statusLabel ?? endpointStatus?.label ?? fallbackStatus?.label ?? "Unknown";

    const deploymentId =
      attemptDetails?.deploymentId
      ?? attemptDetails?.events.find((event) => typeof event.deploymentId === "string")?.deploymentId;
    const deploymentStatus =
      attemptDetails?.deploymentStatus
      ?? attemptDetails?.events.find((event) => typeof event.deploymentStatus === "string")?.deploymentStatus;
    const blockingReason =
      attemptDetails?.blockingReason
      ?? attemptDetails?.events.find((event) => typeof event.blockingReason === "string")?.blockingReason;

    const latest = scopedAttemptItems[0];
    const oldest = scopedAttemptItems[scopedAttemptItems.length - 1];
    const endpointEvents = attemptDetails?.events ?? [];

    return JSON.stringify({
      attemptId: normalizedAttemptFilter,
      status: attemptDetails?.status ?? normalizeAttemptStatusKey(statusLabel),
      statusLabel,
      timelineEventCount: scopedAttemptItems.length,
      latestEventAt: endpointEvents[0]?.createdAt ?? latest?.createdAt,
      firstEventAt: endpointEvents[endpointEvents.length - 1]?.createdAt ?? oldest?.createdAt,
      latestMessage: attemptDetails?.message ?? latestPromoteEvent?.message ?? latest?.message,
      deploymentId,
      deploymentStatus,
      blockingReason,
      triggeredAt: attemptDetails?.triggeredAt,
      finishedAt: attemptDetails?.finishedAt,
      updatedAt: attemptDetails?.updatedAt,
      events: endpointEvents.length > 0
        ? endpointEvents
        : scopedAttemptItems.map((item) => ({
          createdAt: item.createdAt,
          actionType: item.actionType ?? "staging_promote_triggered",
          message: item.message
        }))
    }, null, 2);
  }, [filterMode, normalizedAttemptFilter, scopedAttemptItems, attemptStatusById, attemptDetailsById]);

  const incidentHandoffPackageJson = useMemo(() => {
    if (!incidentHandoff || !incidentHandoffJson || !normalizedAttemptFilter) {
      return null;
    }

    let structuredPayload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(incidentHandoffJson) as unknown;
      structuredPayload = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }

    if (!structuredPayload) {
      return null;
    }

    const statusRaw = typeof structuredPayload.status === "string" ? structuredPayload.status : "unknown";
    const statusLabelRaw = typeof structuredPayload.statusLabel === "string" ? structuredPayload.statusLabel : "Unknown";
    const blockingReasonRaw = typeof structuredPayload.blockingReason === "string" ? structuredPayload.blockingReason : undefined;
    const ownerRaw = incidentOwner.trim() || undefined;
    const ticketIdRaw = incidentTicketId.trim() || undefined;
    const environmentNoteRaw = incidentEnvironmentNote.trim() || undefined;

    const severity: IncidentPackageSummary["severity"] =
      statusRaw === "failed" || statusRaw === "blocked"
        ? "high"
        : statusRaw === "in_progress" || statusRaw === "triggered"
          ? "medium"
          : statusRaw === "succeeded"
            ? "low"
            : "unknown";

    const recommendedNextAction =
      statusRaw === "blocked"
        ? "Resolve blocking condition and retry promote after cooldown guidance."
        : statusRaw === "failed"
          ? "Review deployment logs, identify failure point, and rerun promote when corrected."
          : statusRaw === "in_progress" || statusRaw === "triggered"
            ? "Monitor deployment status until terminal state before taking further action."
            : statusRaw === "succeeded"
              ? "No incident action required; record completion in operations log."
              : "Review attempt timeline and deployment context to determine next operator step.";

    const summary: IncidentPackageSummary = {
      status: statusRaw,
      statusLabel: statusLabelRaw,
      severity,
      isIncident: severity === "high",
      blockingReason: blockingReasonRaw,
      recommendedNextAction,
      owner: ownerRaw,
      ticketId: ticketIdRaw,
      environmentNote: environmentNoteRaw
    };

    return JSON.stringify({
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      attemptId: normalizedAttemptFilter,
      summary,
      handoffText: incidentHandoff,
      handoffJson: structuredPayload
    }, null, 2);
  }, [incidentHandoff, incidentHandoffJson, normalizedAttemptFilter, incidentOwner, incidentTicketId, incidentEnvironmentNote]);

  const incidentSummaryOnlyText = useMemo(() => {
    if (!incidentHandoffPackageJson || !normalizedAttemptFilter) {
      return null;
    }

    try {
      const parsed = JSON.parse(incidentHandoffPackageJson) as {
        summary?: IncidentPackageSummary;
      };

      if (!parsed.summary) {
        return null;
      }

      return formatIncidentSummaryText(normalizedAttemptFilter, parsed.summary);
    } catch {
      return null;
    }
  }, [incidentHandoffPackageJson, normalizedAttemptFilter]);

  async function copyToClipboard(content: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopyStatus("success");
      setCopyMessage(successMessage);
    } catch {
      setCopyStatus("error");
      setCopyMessage("Unable to copy from this browser context.");
    }
  }

  async function copyAsJson() {
    await copyToClipboard(
      JSON.stringify(filteredItems, null, 2),
      `Copied ${filteredItems.length} ${activeFilterLabel.toLowerCase()} as JSON.`
    );
  }

  async function copyAsText() {
    await copyToClipboard(
      formatAuditExportText(filteredItems, activeFilterLabel),
      `Copied ${filteredItems.length} ${activeFilterLabel.toLowerCase()} as text.`
    );
  }

  function downloadContent(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);
    setCopyStatus("success");
    setCopyMessage(`Downloaded ${filename}.`);
  }

  function buildExportFilename(extension: "txt" | "json") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const scope =
      filterMode === "domain-sync"
        ? "domain-sync"
        : filterMode === "attempt"
          ? `attempt-${(normalizedAttemptFilter || "unspecified")
              .replace(/[^a-zA-Z0-9-]+/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "") || "unspecified"}`
          : "all";
    return `staging-audit-${scope}-${stamp}.${extension}`;
  }

  function buildIncidentHandoffFilename(attemptId: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = attemptId
      .replace(/[^a-zA-Z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "unspecified";
    return `incident-handoff-attempt-${slug}-${stamp}.json`;
  }

  function buildIncidentPackageFilename(attemptId: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = attemptId
      .replace(/[^a-zA-Z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "unspecified";
    return `incident-package-attempt-${slug}-${stamp}.json`;
  }

  function downloadAsText() {
    downloadContent(
      formatAuditExportText(filteredItems, activeFilterLabel),
      buildExportFilename("txt"),
      "text/plain;charset=utf-8"
    );
  }

  function downloadAsJson() {
    downloadContent(
      JSON.stringify(filteredItems, null, 2),
      buildExportFilename("json"),
      "application/json;charset=utf-8"
    );
  }

  function clearSavedIncidentMetadata() {
    if (!normalizedAttemptFilter) {
      return;
    }

    clearIncidentPackageMetadata(siteId, normalizedAttemptFilter);
    setIncidentOwner("");
    setIncidentTicketId("");
    setIncidentEnvironmentNote("");
    setCopyStatus("success");
    setCopyMessage(`Cleared saved incident metadata for attempt ${normalizedAttemptFilter}.`);
  }

  return (
    <article className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", marginBottom: "0.4rem" }}>
        <h3 className="card-title" style={{ margin: 0 }}>Staging Audit History</h3>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <button
            type="button"
            className={filterMode === "all" ? "button" : "button button-secondary"}
            onClick={() => setFilterMode("all")}
          >
            All
          </button>
          <button
            type="button"
            className={filterMode === "domain-sync" ? "button" : "button button-secondary"}
            onClick={() => setFilterMode("domain-sync")}
          >
            Domain sync
          </button>
          <button
            type="button"
            className={filterMode === "attempt" ? "button" : "button button-secondary"}
            onClick={() => setFilterMode("attempt")}
          >
            Attempt
          </button>
        </div>
      </div>

      <p className="card-muted" style={{ marginBottom: "0.75rem" }}>
        Recent staging enable, disable, and domain update actions recorded by Jongo.
      </p>

      <div style={{ marginBottom: "0.75rem" }}>
        <span className="tag">Active filter: {activeFilterLabel}</span>
      </div>

      <div style={{ display: "grid", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <label htmlFor="staging-audit-attempt-filter" style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
            Attempt id filter:
          </label>
          <input
            id="staging-audit-attempt-filter"
            type="text"
            value={attemptFilter}
            onChange={(event) => {
              setAttemptFilter(event.target.value);
              setFilterMode("attempt");
            }}
            placeholder="Enter promote attempt id"
            style={{
              minWidth: "220px",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              background: "var(--surface)",
              color: "var(--text)",
              padding: "0.4rem 0.55rem",
              fontSize: "0.8rem"
            }}
          />
          <button
            type="button"
            className="button button-secondary"
            onClick={clearAttemptFilter}
          >
            Clear
          </button>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className={isLatestAttemptActive ? "button" : "button button-secondary"}
            onClick={activateLatestAttemptFilter}
            disabled={!latestAttemptId}
          >
            {isLatestAttemptActive ? "Latest attempt active" : "Latest attempt"}
          </button>
          {latestAttemptId ? (
            <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>
              Latest attempt id: {latestAttemptId}
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>
              No promote attempt id recorded yet.
            </p>
          )}
        </div>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className={isIncidentAttemptActive ? "button" : "button button-secondary"}
            onClick={activateLatestIncidentAttemptFilter}
            disabled={!latestIncidentAttemptId}
          >
            {isIncidentAttemptActive ? "Incident attempt active" : "Show failed/blocked attempt"}
          </button>
          {latestIncidentAttemptId ? (
            <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>
              Latest incident attempt id: {latestIncidentAttemptId}
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>
              No failed or blocked promote attempt detected yet.
            </p>
          )}
        </div>

        {filterMode === "attempt" && normalizedAttemptFilter ? (
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "8px",
              background: "var(--surface-alt)",
              padding: "0.6rem",
              display: "grid",
              gap: "0.45rem"
            }}
          >
            <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>
              Optional incident package metadata
            </p>
            <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
              <input
                type="text"
                value={incidentOwner}
                onChange={(event) => setIncidentOwner(event.target.value)}
                placeholder="Owner"
                style={{
                  minWidth: "140px",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  background: "var(--surface)",
                  color: "var(--text)",
                  padding: "0.4rem 0.55rem",
                  fontSize: "0.8rem"
                }}
              />
              <input
                type="text"
                value={incidentTicketId}
                onChange={(event) => setIncidentTicketId(event.target.value)}
                placeholder="Ticket id"
                style={{
                  minWidth: "140px",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  background: "var(--surface)",
                  color: "var(--text)",
                  padding: "0.4rem 0.55rem",
                  fontSize: "0.8rem"
                }}
              />
            </div>
            <input
              type="text"
              value={incidentEnvironmentNote}
              onChange={(event) => setIncidentEnvironmentNote(event.target.value)}
              placeholder="Environment note (optional)"
              style={{
                minWidth: "220px",
                border: "1px solid var(--border)",
                borderRadius: "8px",
                background: "var(--surface)",
                color: "var(--text)",
                padding: "0.4rem 0.55rem",
                fontSize: "0.8rem"
              }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <p style={{ margin: 0, fontSize: "0.74rem", color: "var(--muted)" }}>
                Metadata is saved per site and attempt in this browser.
              </p>
              <button
                type="button"
                className="button button-secondary"
                onClick={clearSavedIncidentMetadata}
              >
                Clear saved metadata
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {filteredItems.length > 0 ? (
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          {incidentHandoff ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => copyToClipboard(incidentHandoff, `Copied incident handoff for attempt ${normalizedAttemptFilter}.`)}
            >
              Copy incident handoff
            </button>
          ) : null}
          {incidentHandoffJson ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => copyToClipboard(incidentHandoffJson, `Copied incident handoff JSON for attempt ${normalizedAttemptFilter}.`)}
            >
              Copy incident handoff JSON
            </button>
          ) : null}
          {incidentHandoffJson ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => downloadContent(
                incidentHandoffJson,
                buildIncidentHandoffFilename(normalizedAttemptFilter || "unspecified"),
                "application/json;charset=utf-8"
              )}
            >
              Download incident handoff JSON
            </button>
          ) : null}
          {incidentHandoffPackageJson ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => copyToClipboard(incidentHandoffPackageJson, `Copied incident package for attempt ${normalizedAttemptFilter}.`)}
            >
              Copy incident package
            </button>
          ) : null}
          {incidentSummaryOnlyText ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => copyToClipboard(incidentSummaryOnlyText, `Copied incident summary for attempt ${normalizedAttemptFilter}.`)}
            >
              Copy summary only
            </button>
          ) : null}
          {incidentHandoffPackageJson ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => downloadContent(
                incidentHandoffPackageJson,
                buildIncidentPackageFilename(normalizedAttemptFilter || "unspecified"),
                "application/json;charset=utf-8"
              )}
            >
              Download incident package
            </button>
          ) : null}
          <button
            type="button"
            className="button button-secondary"
            onClick={copyAsText}
          >
            Copy text
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={copyAsJson}
          >
            Copy JSON
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={downloadAsText}
          >
            Download text
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={downloadAsJson}
          >
            Download JSON
          </button>
        </div>
      ) : null}

      {copyStatus !== "idle" ? (
        <p
          style={{
            margin: "0 0 0.75rem",
            fontSize: "0.8rem",
            color: copyStatus === "error" ? "var(--error, #c0392b)" : "var(--muted)"
          }}
        >
          {copyMessage}
        </p>
      ) : null}

      {promoteStatusSummary.total > 0 ? (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: "8px",
            background: "var(--surface-alt)",
            padding: "0.6rem",
            marginBottom: "0.75rem",
            display: "flex",
            gap: "0.45rem",
            flexWrap: "wrap",
            alignItems: "center"
          }}
        >
          <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Attempt states:</span>
          {promoteStatusSummary.triggered > 0 ? (
            <span className="status-chip degraded">Triggered {promoteStatusSummary.triggered}</span>
          ) : null}
          {promoteStatusSummary.in_progress > 0 ? (
            <span className="status-chip degraded">In progress {promoteStatusSummary.in_progress}</span>
          ) : null}
          {promoteStatusSummary.succeeded > 0 ? (
            <span className="status-chip healthy">Succeeded {promoteStatusSummary.succeeded}</span>
          ) : null}
          {promoteStatusSummary.failed > 0 ? (
            <span className="status-chip error">Failed {promoteStatusSummary.failed}</span>
          ) : null}
          {promoteStatusSummary.blocked > 0 ? (
            <span className="status-chip error">Blocked {promoteStatusSummary.blocked}</span>
          ) : null}
        </div>
      ) : null}

      {filteredItems.length === 0 ? (
        <p className="card-muted" style={{ marginBottom: 0 }}>
          {filterMode === "domain-sync"
            ? "No domain sync events recorded yet."
            : "No staging audit events recorded yet."}
        </p>
      ) : (
        <>
          <div style={{ display: "grid", gap: "0.6rem" }}>
            {visibleItems.map((item) => (
              <div key={item.id} style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.75rem" }}>
                {(() => {
                  const endpointStatus = item.promoteAttemptId ? attemptStatusById[item.promoteAttemptId] : undefined;
                  const fallbackStatusInfo = fallbackAttemptStatus(item.actionType);
                  const attemptStatus = endpointStatus ?? fallbackStatusInfo;

                  return (
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ display: "flex", gap: "0.45rem", alignItems: "center", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "0.9rem" }}>{formatActionLabel(item.actionType)}</strong>
                      {attemptStatus && isPromoteAction(item.actionType) ? (
                        <span className={`status-chip ${attemptStatus.tone}`}>{attemptStatus.label}</span>
                      ) : null}
                    </div>
                    <p style={{ margin: "0.25rem 0 0", fontSize: "0.84rem", color: "var(--muted)" }}>{item.message}</p>
                  </div>
                  <span style={{ fontSize: "0.76rem", color: "var(--muted)" }}>{formatAuditAgo(item.createdAt)}</span>
                </div>
                  );
                })()}
                {item.domains.length > 0 ? (
                  <p style={{ margin: "0.45rem 0 0", fontSize: "0.82rem" }}>
                    Domains: {item.domains.join(", ")}
                  </p>
                ) : null}
                {item.promoteAttemptId ? (
                  <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem" }}>
                    Attempt id: {item.promoteAttemptId}
                  </p>
                ) : null}
                {item.preferredStagingDomain ? (
                  <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem" }}>
                    Preferred staging domain: {item.preferredStagingDomain}
                  </p>
                ) : null}
              </div>
            ))}
          </div>

          {canShowMore || canShowLess ? (
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "0.75rem" }}>
              {canShowLess ? (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setVisibleCount(INITIAL_VISIBLE_COUNT)}
                >
                  Show less
                </button>
              ) : null}
              {canShowMore ? (
                <button
                  type="button"
                  className="button"
                  onClick={() => setVisibleCount((current) => Math.min(current + SHOW_MORE_STEP, filteredItems.length))}
                >
                  Show more
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}
