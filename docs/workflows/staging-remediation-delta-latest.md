# Staging Remediation Delta (Latest)

Generated: 2026-05-26T13:07:22.875Z
Previous queue: docs/workflows/staging-remediation-queue-previous.md
Current queue: docs/workflows/staging-remediation-queue-latest.md

## Current Totals

- Current apps in queue: 13
- Current missing staging detection: 8
- Current backup blocker count: 6
- Preferred trigger-path smoke target: waterfallkeepersofnc-org

## Trigger-Path Policy

- Promote trigger-path checks remain anchored to waterfallkeepersofnc-org during this operational pass.
- joyfeed-app remains a non-default diagnostic target and should not drive routine strict smoke runs.

## Delta Summary

- Apps added to queue: 0
- Apps removed from queue: 0
- Staging detection improved (no -> yes): 5
- Staging detection regressed (yes -> no): 0
- Apps with blocker changes: 12

### Staging Detection Improved

- airbb-wordpress
- fts-branding-guide
- jongo-open-source
- joyfeed-app
- waterfallkeepersofnc-org

### Blocker Changes

- a3th9r
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
  - current: No staging environment/application is currently detected in Coolify.; Backups not configured.
- airbb-wordpress
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
  - current: Staging environment exists but no staging application target is attached yet.
- aptennis-org
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
  - current: No staging environment/application is currently detected in Coolify.
- daniel-kane
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
  - current: No staging environment/application is currently detected in Coolify.; Backups not configured.
- freebling-app
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
  - current: No staging environment/application is currently detected in Coolify.; Backups not configured.
- fts-branding-guide
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
  - current: Staging environment exists but no staging application target is attached yet.
- gimmepower-com
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
  - current: No staging environment/application is currently detected in Coolify.
- jongo-open-source
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Staging environment exists but no staging application target is attached yet.; Backup telemetry unavailable.
- joyfeed-app
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
  - current: (none)
- millenion-fitness
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
  - current: No staging environment/application is currently detected in Coolify.; Backups not configured.
- waterfallkeepersofnc-org
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
  - current: Staging environment exists but no staging service target is attached yet.
- wptest-manifest-fts-com
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
  - current: No staging environment/application is currently detected in Coolify.
