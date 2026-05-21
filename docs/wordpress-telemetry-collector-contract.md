# WordPress Telemetry Collector Contract

This document defines the optional collector endpoint used by Jongo to populate live WordPress plugin insights.

## Purpose

When `WORDPRESS_TELEMETRY_COLLECTOR_URL` is configured, the route `GET /api/sites/[siteId]/wordpress-telemetry` will call the external collector and merge returned values over the built-in policy fallback.

If the collector is unavailable, returns non-2xx, or returns invalid JSON, Jongo falls back automatically.

## Environment Variables

- `WORDPRESS_TELEMETRY_COLLECTOR_URL`: Collector endpoint URL (required to enable collector mode).
- `WORDPRESS_TELEMETRY_COLLECTOR_TOKEN`: Optional bearer token.
- `WORDPRESS_TELEMETRY_COLLECTOR_TIMEOUT_MS`: Optional timeout in milliseconds (default `5000`).

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

For staged testing, Jongo includes an internal collector bridge endpoint:

- Route: `POST /api/internal/wordpress-collector`
- Enable with: `WORDPRESS_TELEMETRY_COLLECTOR_BRIDGE_ENABLED=true`
- Requires: `WORDPRESS_TELEMETRY_COLLECTOR_TOKEN`

Set the main collector URL to this route to test end-to-end rendering without an external collector:

- `WORDPRESS_TELEMETRY_COLLECTOR_URL=https://<your-jongo-host>/api/internal/wordpress-collector`

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

Optional upstream passthrough (real data mode without changing UI wiring):

- `WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_URL`
- `WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_TOKEN`
- `WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_TIMEOUT_MS`

When `WORDPRESS_TELEMETRY_COLLECTOR_MOCK_DATA` has no matching site key, the internal bridge will call `WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_URL` and return that response (normalized to this contract).
