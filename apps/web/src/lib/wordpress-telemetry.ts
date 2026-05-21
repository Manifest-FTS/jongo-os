export type WordPressTelemetryPolicy = {
  enabledByDefault: boolean;
  needsSetup: boolean;
  tone: "healthy" | "degraded" | "unknown";
  label: string;
  summary: string;
  guidance: string;
  collectorStatus: "pipeline_pending" | "ready_for_pull";
  setupSteps: string[];
  signals: {
    coreVersion: string;
    pluginStatus: string;
    themeStatus: string;
    updateAvailability: string;
    maintenanceMode: string;
    siteHealth: string;
  };
};

export function getWordPressTelemetryPolicy(params: {
  isWordPress: boolean;
  hasCoolifyServiceUuid: boolean;
}): WordPressTelemetryPolicy {
  if (!params.isWordPress) {
    return {
      enabledByDefault: false,
      needsSetup: false,
      tone: "unknown",
      label: "Not applicable",
      summary: "WordPress telemetry policy only applies to WordPress resources.",
      guidance: "",
      collectorStatus: "pipeline_pending",
      setupSteps: [],
      signals: {
        coreVersion: "not_applicable",
        pluginStatus: "not_applicable",
        themeStatus: "not_applicable",
        updateAvailability: "not_applicable",
        maintenanceMode: "not_applicable",
        siteHealth: "not_applicable"
      }
    };
  }

  if (!params.hasCoolifyServiceUuid) {
    return {
      enabledByDefault: true,
      needsSetup: true,
      tone: "degraded",
      label: "Needs mapping",
      summary: "WordPress REST telemetry is enabled by default, but this app is not linked to a Coolify service UUID.",
      guidance: "Link this app to its Coolify service in Settings so Jongo can attach telemetry endpoints and readiness checks.",
      collectorStatus: "pipeline_pending",
      setupSteps: [
        "Open Settings and confirm the app is mapped to the correct Coolify service UUID.",
        "Verify the app is classified as WordPress in the Apps inventory.",
        "Return to Integrations to confirm telemetry policy is active."
      ],
      signals: {
        coreVersion: "pending_mapping",
        pluginStatus: "pending_mapping",
        themeStatus: "pending_mapping",
        updateAvailability: "pending_mapping",
        maintenanceMode: "pending_mapping",
        siteHealth: "pending_mapping"
      }
    };
  }

  return {
    enabledByDefault: true,
    needsSetup: false,
    tone: "healthy",
    label: "Auto-enabled",
    summary: "WordPress REST telemetry is enabled by default for WordPress apps.",
    guidance: "Detailed plugin/theme/update signals will populate as telemetry collectors are rolled out.",
    collectorStatus: "ready_for_pull",
    setupSteps: [],
    signals: {
      coreVersion: "collector_pending",
      pluginStatus: "collector_pending",
      themeStatus: "collector_pending",
      updateAvailability: "collector_pending",
      maintenanceMode: "collector_pending",
      siteHealth: "collector_pending"
    }
  };
}