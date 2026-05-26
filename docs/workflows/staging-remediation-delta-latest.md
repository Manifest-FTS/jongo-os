# Staging Remediation Delta (Latest)

Generated: 2026-05-26T15:54:58.778Z
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
- Staging detection improved (no -> yes): 0
- Staging detection regressed (yes -> no): 0
- Apps with blocker changes: 3

### Blocker Changes

- aptennis-org
  - previous: No staging environment/application is currently detected in Coolify.
  - current: Staging is disabled in Jongo for this app.; No staging environment/application is currently detected in Coolify.
- waterfallkeepersofnc-org
  - previous: Staging environment exists but no staging service target is attached yet.
  - current: (none)
- wptest-manifest-fts-com
  - previous: No staging environment/application is currently detected in Coolify.
  - current: Staging is disabled in Jongo for this app.; No staging environment/application is currently detected in Coolify.
