# WordPress Telemetry Collector Contract

This document defines the WordPress telemetry provider contract used by Jongo to populate plugin insights.

For deployment strategy and self-hosted configuration order, see `docs/wordpress-telemetry-provider-hierarchy.md`.

## Purpose

Jongo uses a provider hierarchy and merges returned values over built-in policy fallback.

Preferred provider order:

1. Platform-level inspection (Coolify/container runtime signals when available)
2. Secure WordPress REST + application-password provider
3. Optional test/mock provider
4. Optional upstream collector passthrough

If all providers are unavailable, Jongo falls back automatically.

## Environment Variables

- `WORDPRESS_TELEMETRY_COLLECTOR_URL`: Jongo telemetry endpoint used by app pages.
- `WORDPRESS_TELEMETRY_COLLECTOR_TOKEN`: Bearer token for the internal bridge endpoint.
- `WORDPRESS_TELEMETRY_COLLECTOR_TIMEOUT_MS`: Optional timeout in milliseconds (default `5000`).
- `WORDPRESS_TELEMETRY_ENCRYPTION_SECRET`: Optional secret used to encrypt saved app-level WordPress credentials (falls back to `NEXTAUTH_SECRET`).
- `WORDPRESS_TELEMETRY_REST_SITE_MAP`: Optional dev/testing REST auth fallback map keyed by site slug/id.
- `WORDPRESS_TELEMETRY_REST_TIMEOUT_MS`: Optional REST timeout (default `5000`).
- `WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_URL`: Optional external collector passthrough endpoint.
- `WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_TOKEN`: Optional upstream bearer token.
- `WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_TIMEOUT_MS`: Optional upstream timeout (default `5000`).

## Product Path

Primary production flow:

1. Open App > Integrations > Connect Telemetry.
2. Save site URL, telemetry username, and WordPress application password.
3. Run Test Connection.

Saved credentials are encrypted server-side and passwords are never returned to the browser after save.

## Request

Method: `POST`

Headers:

- `content-type: application/json`
- `authorization: Bearer <token>` (only when `WORDPRESS_TELEMETRY_COLLECTOR_TOKEN` is set)

Body:

```json
{
  "siteId": "waterfallkeepersofnc-org",
  "slug": "waterfallkeepersofnc-org",
  "workspaceId": "<workspace-uuid-or-id>",
  "workspaceName": "Waterfall Keepers",
  "siteType": "wordpress",
  "coolifyServiceUuid": "<coolify-service-uuid>"
}
```

## Response

Return JSON with any subset of fields below. Missing fields keep the fallback value.

```json
{
  "checkedAt": "2026-05-21T18:30:00.000Z",
  "source": "collector_v1",
  "collectorStatus": "ready_for_pull",
  "tone": "healthy",
  "label": "Live",
  "summary": "Live WordPress monitoring is active.",
  "guidance": "Review plugin and security insights below.",
  "siteUrl": "https://waterfallkeepersofnc.org",
  "needsSetup": false,
  "setupSteps": [],
  "signals": {
    "coreVersion": "6.5.4",
    "pluginStatus": "healthy",
    "themeStatus": "healthy",
    "updateAvailability": "2 updates available",
    "maintenanceMode": "off",
    "siteHealth": "good"
  },
  "pluginInsights": {
    "inventoryConnected": true,
    "activePlugins": 28,
    "inactivePlugins": 5,
    "updatesAvailable": 2,
    "securityIssues": 0
  },
  "pluginInventory": [
    {
      "name": "Advanced Custom Fields",
      "status": "Active",
      "version": "6.2.6",
      "updateStatus": "Up-to-date",
      "securityIssues": null
    },
    {
      "name": "Admin Menu Editor",
      "status": "Active",
      "version": "1.15",
      "updateStatus": "Update available",
      "securityIssues": "None"
    }
  ]
}
```

## Notes

- `pluginInsights.inventoryConnected` should be `true` only when counts are from a live source.
- Count fields accept numbers or `null`.
- `siteUrl` is optional and is shown in product header sections when present.
- `pluginInventory` is optional and powers the Plugins tabular section.
- Use non-2xx status codes for collector-side failures; Jongo will fall back.

## Internal Bridge (Optional)

For staged testing and self-hosted provider composition, Jongo includes an internal collector bridge endpoint:

- Route: `POST /api/internal/wordpress-collector`
- Enable with: `WORDPRESS_TELEMETRY_COLLECTOR_BRIDGE_ENABLED=true`
- Requires: `WORDPRESS_TELEMETRY_COLLECTOR_TOKEN`

Set the main collector URL to this route to enable the provider chain:

- `WORDPRESS_TELEMETRY_COLLECTOR_URL=https://<your-jongo-host>/api/internal/wordpress-collector`

Optional REST provider source (dev/testing fallback):

- `WORDPRESS_TELEMETRY_REST_SITE_MAP`
- JSON object keyed by site slug or site id:

```json
{
  "waterfallkeepersofnc-org": {
    "siteUrl": "https://waterfallkeepersofnc.org",
    "username": "telemetry-bot",
    "appPassword": "xxxx xxxx xxxx xxxx xxxx xxxx"
  }
}
```

Optional mock payload source:

- `WORDPRESS_TELEMETRY_COLLECTOR_MOCK_DATA`
- JSON object keyed by site slug or site id, for example:

```json
{
  "waterfallkeepersofnc-org": {
    "activePlugins": 28,
    "inactivePlugins": 5,
    "updatesAvailable": 2,
    "securityIssues": 0,
    "coreVersion": "6.5.5"
  }
}
```

Optional upstream passthrough (for custom telemetry services, plugin-assisted deep telemetry, or migration workflows):

- `WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_URL`
- `WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_TOKEN`
- `WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_TIMEOUT_MS`

When `WORDPRESS_TELEMETRY_COLLECTOR_MOCK_DATA` has no matching site key, the internal bridge will call `WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_URL` and return that response (normalized to this contract).
