export type StagingCapabilityRecordLike = {
  detected: boolean;
  applicationUuid?: string;
  note?: string;
  status?: string;
};

/**
 * Poll until a just-deleted staging target disappears from Coolify.
 *
 * This prevents the common disable/re-enable race where the old target is still
 * visible for a few seconds after deletion, temporarily blocking a legitimate
 * re-enable even though the resource is already gone.
 */
export async function waitForStagingCapabilityToClear<T extends StagingCapabilityRecordLike>(
  probe: () => Promise<T>,
  maxAttempts = 6,
  delayMs = 1500
): Promise<T> {
  let last = await probe();

  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    if (!last.detected || !last.applicationUuid) {
      return last;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    last = await probe();
  }

  return last;
}
