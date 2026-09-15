export function toClientFacingStagingMessage(value?: string | null): string | null {
  const message = value?.trim();
  if (!message) {
    return null;
  }

  const normalized = message.toLowerCase();

  if (
    normalized.includes("re-enable") ||
    normalized.includes("existing staging") ||
    normalized.includes("fully removed") ||
    normalized.includes("unprovision")
  ) {
    // Not "being removed": nothing removes a copy on its own, so that promise
    // left people refreshing for days. Say what is true and who can fix it.
    return "An old staging copy still exists and has to be removed first. If this doesn't clear in a few minutes, contact support.";
  }

  if (
    normalized.includes("cleanup failed") ||
    normalized.includes("could not be removed") ||
    normalized.includes("unable to destroy")
  ) {
    return "Staging could not be fully removed. Try again later or contact support.";
  }

  if (
    normalized.includes("coolify") ||
    normalized.includes("infrastructure panel") ||
    normalized.includes("manual provision") ||
    normalized.includes("provision staging")
  ) {
    return "Staging setup is still finishing. Wait a few minutes and refresh.";
  }

  return message;
}
