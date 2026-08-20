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
