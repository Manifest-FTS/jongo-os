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
