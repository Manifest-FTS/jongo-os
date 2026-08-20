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
    return "Staging is still being removed. Wait a few minutes and try again.";
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
