# Staging Sync Preflight Smoke

Use this runbook to verify app-level staging sync readiness without running a sync.

## What It Checks

The smoke script calls `GET /api/sites/{siteId}/staging` and reports:

- `readyForSyncTesting`
- preflight tone and label for production-to-staging
- blockers list
- dry-run target detection

This endpoint is read-only and does not execute sync actions.

## Prerequisites

- Deployment includes `feat: add staging sync preflight testing endpoint` or newer.
- `OWNERSHIP_SYNC_TOKEN` is set in the target environment.
- App IDs or slugs to check are known.

## Run

```bash
APP_BASE_URL="https://jongo.example.com" \
OWNERSHIP_SYNC_TOKEN="<token>" \
STAGING_SITE_IDS="waterfallkeepersofnc-org,joyfeed-web" \
npm run smoke:staging-preflight
```

Or pass IDs directly:

```bash
APP_BASE_URL="https://jongo.example.com" \
OWNERSHIP_SYNC_TOKEN="<token>" \
npm run smoke:staging-preflight -- waterfallkeepersofnc-org joyfeed-web
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
