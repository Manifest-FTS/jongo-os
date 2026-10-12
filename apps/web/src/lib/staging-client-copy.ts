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
    // Not "being removed": say what is true and what fixes it (the Remove old
    // staging copy button shown next to this message).
    return "An old staging copy still exists and has to be removed first. Use Remove old staging copy.";
  }

  if (
    normalized.includes("cleanup failed") ||
    normalized.includes("could not be removed") ||
    normalized.includes("unable to destroy")
  ) {
    return "Staging could not be fully removed. Use Remove old staging copy to try again.";
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
