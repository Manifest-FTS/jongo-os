type StagingCapabilityLike = {
  detected: boolean;
  applicationUuid?: string;
  note?: string;
};

/** Keep an already-resolved target when a post-deploy telemetry refresh fails. */
export function preserveResolvedStagingCapability<T extends StagingCapabilityLike>(
  resolved: T,
  refreshed: T
): T {
  if (resolved.applicationUuid && !refreshed.applicationUuid) {
    return resolved;
  }

  return refreshed;
}

export function resolveStagingSyncReadiness(
  requiresContentSync: boolean,
  stagingServiceUuid?: string
): "ready" | "not_required" | "missing_target" {
  if (!requiresContentSync) {
    return "not_required";
  }

  return stagingServiceUuid?.trim() ? "ready" : "missing_target";
}

export function extractCreatedResourceUuid(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const direct = typeof record.uuid === "string"
    ? record.uuid
    : typeof record.id === "string"
      ? record.id
      : undefined;
  if (direct?.trim()) {
    return direct.trim();
  }

  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const nested = data as Record<string, unknown>;
  const nestedUuid = typeof nested.uuid === "string"
    ? nested.uuid
    : typeof nested.id === "string"
      ? nested.id
      : undefined;
  return nestedUuid?.trim() || undefined;
}
