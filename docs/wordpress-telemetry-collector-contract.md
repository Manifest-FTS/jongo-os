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
  }
}
```

## Notes

- `pluginInsights.inventoryConnected` should be `true` only when counts are from a live source.
- Count fields accept numbers or `null`.
- Use non-2xx status codes for collector-side failures; Jongo will fall back.
