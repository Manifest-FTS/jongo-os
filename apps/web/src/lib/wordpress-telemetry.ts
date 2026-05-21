export type WordPressTelemetryPolicy = {
  enabledByDefault: boolean;
  tone: "healthy" | "degraded" | "unknown";
  label: string;
  summary: string;
  guidance: string;
};

export function getWordPressTelemetryPolicy(params: {
  isWordPress: boolean;
  hasCoolifyServiceUuid: boolean;
}): WordPressTelemetryPolicy {
  if (!params.isWordPress) {
    return {
      enabledByDefault: false,
      tone: "unknown",
      label: "Not applicable",
      summary: "WordPress telemetry policy only applies to WordPress resources.",
      guidance: ""
    };
  }

  if (!params.hasCoolifyServiceUuid) {
    return {
      enabledByDefault: true,
      tone: "degraded",
      label: "Needs mapping",
      summary: "WordPress REST telemetry is enabled by default, but this app is not linked to a Coolify service UUID.",
      guidance: "Link this app to its Coolify service in Settings so Jongo can attach telemetry endpoints and readiness checks."
    };
  }

  return {
    enabledByDefault: true,
    tone: "healthy",
    label: "Auto-enabled",
    summary: "WordPress REST telemetry is enabled by default for WordPress apps.",
    guidance: "Detailed plugin/theme/update signals will populate as telemetry collectors are rolled out."
  };
}