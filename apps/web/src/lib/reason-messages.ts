/**
 * Centralized reason-code-to-message mapping for operational status messages.
 * Keeps phrasing consistent across Backups, Staging, Apps, and diagnostics.
 * Client-friendly by default; technical detail reserved for Developer Details.
 */

/**
 * Maps backup inventory unavailable reason codes to client-friendly messages.
 */
export function getBackupUnavailableMessage(note?: string): string {
  switch (note) {
    case "missing_credentials":
      return "Coolify API is not configured on this server. Contact your platform administrator.";
    case "no_databases_in_environment":
      return "No databases were detected in this application's Coolify environment. If databases exist, check that the app UUID is correctly mapped.";
    case "fetch_error":
      return "Could not retrieve backup data from Coolify. The API may be temporarily unreachable.";
    default:
      return "Could not retrieve backup information from Coolify. The API may be unreachable or this resource type may not support backup inspection.";
  }
}

/**
 * Maps staging detection failure reason codes to client-friendly messages.
 */
export function getStagingDetectionMessage(note?: string): string {
  switch (note) {
    case "no_staging_environment_in_project":
      return "No environment named 'staging' or 'preview' was found in the Coolify project.";
    case "application_not_found":
      return "Application UUID not found in Coolify — check the UUID in Settings.";
    case "no_project_resolved":
      return "No Coolify project is mapped to this app. Set a Coolify Project ID in Settings.";
    case "missing_credentials":
      return "Coolify API is not configured on this server. Contact your platform administrator.";
    case "fetch_error":
      return "Could not reach the Coolify API. Check connectivity and try again.";
    default:
      return "Contact your platform administrator to set up a staging environment.";
  }
}

/**
 * Maps Coolify API mode and error state to a client-friendly status line.
 * Returns a human-readable description of data freshness and availability.
 */
export function getCoolifyStatusMessage(
  mode: "live" | "mock",
  fetchError?: string
): { text: string; hasError: boolean } {
  if (mode === "mock") {
    return {
      text: "Coolify not configured — demo mode",
      hasError: false
    };
  }

  if (fetchError) {
    return {
      text: "Coolify API unavailable",
      hasError: true
    };
  }

  return {
    text: "Coolify connected",
    hasError: false
  };
}

/**
 * Maps app inventory empty state reason codes to explanatory text.
 */
export function getAppsEmptyStateMessage(
  reason:
    | "mock_fallback_active"
    | "coolify_api_unavailable"
    | "no_resources_found"
    | "no_db_mappings_yet"
    | "viewer_not_authorized"
    | "none"
): { heading: string; description: string } {
  if (reason === "mock_fallback_active") {
    return {
      heading: "Coolify is not configured — operating in demo mode",
      description: "Set COOLIFY_API_BASE_URL and COOLIFY_API_TOKEN in your environment to load live app inventory."
    };
  }

  if (reason === "coolify_api_unavailable") {
    return {
      heading: "Coolify API unavailable — could not load app inventory",
      description: "Check API configuration in Platform Settings. No apps are visible until connectivity is restored."
    };
  }

  if (reason === "viewer_not_authorized") {
    return {
      heading: "No authorized apps",
      description: "Your account can only view mapped apps where you are a client or app collaborator."
    };
  }

  if (reason === "no_resources_found") {
    return {
      heading: "No live resources found",
      description: "Coolify is reachable, but no applications/services/databases were returned for inventory."
    };
  }

  if (reason === "no_db_mappings_yet") {
    return {
      heading: "Live resources found, but no mapped apps are visible",
      description: "Create or sync Site mappings to associate resources with clients while keeping tenant scoping intact."
    };
  }

  return {
    heading: "No apps yet",
    description: "Start by creating a client, then add their first app."
  };
}

/**
 * Maps activity feed empty state reason codes to explanatory text.
 */
export function getActivityFeedEmptyMessage(
  siteFound: boolean,
  hasApiError: boolean
): string {
  if (!siteFound) {
    return "App not found in Coolify inventory — check the UUID in Settings.";
  }
  if (hasApiError) {
    return "Coolify API unavailable — could not load activity. Data will appear once connectivity is restored.";
  }
  return "No deployment events yet for this app.";
}
