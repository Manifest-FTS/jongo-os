# Staging Sync Preflight Smoke

Use this runbook to verify app-level staging sync readiness without running a sync.

## What It Checks

The smoke script calls `GET /api/sites/{siteId}/staging` and reports:

- `readyForSyncTesting`
- preflight tone and label for production-to-staging
- blockers list
- dry-run target detection

This endpoint is read-only and does not execute sync actions.

The staging workspace itself now includes a confirmation step before enable/disable actions and supports comma-separated staging-domain sync to Coolify for admins.

## Prerequisites

- Deployment includes `feat: add staging sync preflight testing endpoint` or newer.
- `OWNERSHIP_SYNC_TOKEN` is set in the target environment.
- By default, site IDs are discovered dynamically from `GET /api/sites/staging-targets`.

## Run

```bash
APP_BASE_URL="https://jongo.example.com" \
OWNERSHIP_SYNC_TOKEN="<token>" \
npm run smoke:staging-preflight
```

Default dynamic discovery scope is `linked` (apps with a Coolify UUID).

Optional scope override:

```bash
APP_BASE_URL="https://jongo.example.com" \
OWNERSHIP_SYNC_TOKEN="<token>" \
STAGING_SITE_DISCOVERY_SCOPE="all" \
npm run smoke:staging-preflight
```

Accepted scope values:

- `linked` (default)
- `staging-enabled`
- `all`

Or pass IDs directly:

```bash
APP_BASE_URL="https://jongo.example.com" \
OWNERSHIP_SYNC_TOKEN="<token>" \
npm run smoke:staging-preflight -- waterfallkeepersofnc-org joyfeed-web
```

Optional explicit env list override:

```bash
APP_BASE_URL="https://jongo.example.com" \
OWNERSHIP_SYNC_TOKEN="<token>" \
STAGING_SITE_IDS="waterfallkeepersofnc-org,joyfeed-web" \
npm run smoke:staging-preflight
```

## Exit Behavior

- Exit `0`: all checked apps are ready (or not blocked when `FAIL_ON_BLOCKED=false`).
- Exit `1`: at least one app failed HTTP checks, parsing, or readiness checks.

Set `FAIL_ON_BLOCKED=false` to run informational checks without failing on blockers.

## Typical Blockers

- Staging is disabled in Jongo for the app.
- Coolify service UUID is not linked.
- Staging environment/application is not detected in Coolify.
- Backup readiness is locked (telemetry unavailable, no successful backup, stale backup).
- Coolify staging domain update routes are unavailable or rejected by the current API version.
