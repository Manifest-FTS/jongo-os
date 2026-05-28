# Staging Remediation Delta (Latest)

Generated: 2026-05-27T12:29:14.203Z
Previous queue: docs/workflows/staging-remediation-queue-previous.md
Current queue: docs/workflows/staging-remediation-queue-latest.md

## Current Totals

- Current apps in queue: 13
- Current missing staging detection: 13
- Current backup blocker count: 13
- Preferred trigger-path smoke target: waterfallkeepersofnc-org

## Trigger-Path Policy

- Promote trigger-path checks remain anchored to waterfallkeepersofnc-org during this operational pass.
- joyfeed-app remains a non-default diagnostic target and should not drive routine strict smoke runs.

## Delta Summary

- Apps added to queue: 0
- Apps removed from queue: 0
- Staging detection improved (no -> yes): 0
- Staging detection regressed (yes -> no): 5
- Apps with blocker changes: 12

### Staging Detection Regressed

- airbb-wordpress
- fts-branding-guide
- jongo-open-source
- joyfeed-app
- waterfallkeepersofnc-org

### Blocker Changes

- a3th9r
  - previous: No staging environment/application is currently detected in Coolify.; Backups not configured.
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
- airbb-wordpress
  - previous: Staging environment exists but no staging application target is attached yet.
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
- aptennis-org
  - previous: Staging is disabled in Jongo for this app.; No staging environment/application is currently detected in Coolify.
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
- daniel-kane
  - previous: No staging environment/application is currently detected in Coolify.; Backups not configured.
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
- freebling-app
  - previous: No staging environment/application is currently detected in Coolify.; Backups not configured.
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
- fts-branding-guide
  - previous: Staging environment exists but no staging application target is attached yet.
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
- gimmepower-com
  - previous: No staging environment/application is currently detected in Coolify.
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
- jongo-open-source
  - previous: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Staging environment exists but no staging application target is attached yet.; Backup telemetry unavailable.
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
- joyfeed-app
  - previous: (none)
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
- millenion-fitness
  - previous: No staging environment/application is currently detected in Coolify.; Backups not configured.
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
- waterfallkeepersofnc-org
  - previous: (none)
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
- wptest-manifest-fts-com
  - previous: Staging is disabled in Jongo for this app.; No staging environment/application is currently detected in Coolify.
  - current: Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable.
