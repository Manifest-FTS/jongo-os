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
  pluginInsights: {
    inventoryConnected: boolean;
    activePlugins: number | null;
    inactivePlugins: number | null;
    updatesAvailable: number | null;
    securityIssues: number | null;
  };
};

export function formatWordPressTelemetryValue(value: string): string {
  if (value === "collector_pending" || value === "pending_mapping") {
    return "Monitoring setup in progress";
  }
  if (value === "not_applicable") {
    return "Not available for this app";
  }
  return value.replace(/_/g, " ");
}

export function formatWordPressCollectorStatus(status: WordPressTelemetryPolicy["collectorStatus"]): string {
  if (status === "pipeline_pending") {
    return "Setup in progress";
  }
  return "Connected for monitoring";
}

export type WordPressTelemetrySnapshot = {
  siteId: string;
  checkedAt: string;
  source: "policy_default" | "collector";
  policy: WordPressTelemetryPolicy;
};

type WordPressTelemetrySnapshotInput = {
  siteId: string;
  isWordPress: boolean;
  hasCoolifyServiceUuid: boolean;
};

export function getWordPressTelemetrySnapshot(input: WordPressTelemetrySnapshotInput): WordPressTelemetrySnapshot {
  return {
    siteId: input.siteId,
    checkedAt: new Date().toISOString(),
    source: "policy_default",
    policy: getWordPressTelemetryPolicy({
      isWordPress: input.isWordPress,
      hasCoolifyServiceUuid: input.hasCoolifyServiceUuid
    })
  };
}

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
      summary: "WordPress monitoring is available only for WordPress apps.",
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
      },
      pluginInsights: {
        inventoryConnected: false,
        activePlugins: null,
        inactivePlugins: null,
        updatesAvailable: null,
        securityIssues: null
      }
    };
  }

  if (!params.hasCoolifyServiceUuid) {
    return {
      enabledByDefault: true,
      needsSetup: true,
      tone: "degraded",
      label: "Needs mapping",
      summary: "WordPress monitoring is on by default, but this app still needs hosting mapping before signals can load.",
      guidance: "Open Settings and connect this app to the right hosting connection to finish monitoring setup.",
      collectorStatus: "pipeline_pending",
      setupSteps: [
        "Open Settings and confirm this app is connected to the correct hosting service.",
        "Verify this app is marked as WordPress in the app list.",
        "Return to Integrations to confirm monitoring is active."
      ],
      signals: {
        coreVersion: "pending_mapping",
        pluginStatus: "pending_mapping",
        themeStatus: "pending_mapping",
        updateAvailability: "pending_mapping",
        maintenanceMode: "pending_mapping",
        siteHealth: "pending_mapping"
      },
      pluginInsights: {
        inventoryConnected: false,
        activePlugins: null,
        inactivePlugins: null,
        updatesAvailable: null,
        securityIssues: null
      }
    };
  }

  return {
    enabledByDefault: true,
    needsSetup: false,
    tone: "healthy",
    label: "Auto-enabled",
    summary: "WordPress monitoring is enabled by default for WordPress apps.",
    guidance: "Detailed plugin, theme, and update insights will appear automatically as setup completes.",
    collectorStatus: "ready_for_pull",
    setupSteps: [],
    signals: {
      coreVersion: "collector_pending",
      pluginStatus: "collector_pending",
      themeStatus: "collector_pending",
      updateAvailability: "collector_pending",
      maintenanceMode: "collector_pending",
      siteHealth: "collector_pending"
    },
    pluginInsights: {
      inventoryConnected: false,
      activePlugins: null,
      inactivePlugins: null,
      updatesAvailable: null,
      securityIssues: null
    }
  };
}