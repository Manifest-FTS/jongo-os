# Staging Promote Smoke Latest Run

Date: 2026-05-24
Mode: local smoke against `http://localhost:3000` with `ALLOW_NO_AUTH_LOCAL=true`, `FAIL_ON_BLOCKED=true`
Command: `npm run smoke:staging-promote`

Batch remediation before this run:

- Enabled `stagingEnabled=true` in Jongo for 12 previously-disabled linked apps:
  - `cc-empowermaps`
  - `joyfeed-app`
  - `millenion-fitness`
  - `daniel-kane`
  - `a3th9r`
  - `freebling-app`
  - `jongo-open-source`
  - `fts-branding-guide`
  - `waterfallkeepersofnc-org`
  - `airbb-wordpress`
  - `aptennis-org`
  - `gimmepower-com`
- Attempted API-driven staging auto-provision for all 13 linked apps:
  - command: `npm run ops:remediate-staging-provision:apply`
  - success responses: 13/13
  - `stagedDetected=true`: 0/13
  - `provisioned=true`: 0/13
  - common response message: `Unable to provision staging automatically. Verify Coolify staging support for this app and provision manually if needed.`

## Result Summary

- Triggered: 0
- Blocked: 13
- Failed: 13 (expected with `FAIL_ON_BLOCKED=true`)
- Promote-attempt endpoint checks: 13/13 returned HTTP 200
- Promote blocking reason: `staging_to_production_preflight_blocked` for all tested sites

## Delta vs Previous Strict Run

- Cleared blocker class across remediation batch:
  - `Staging is disabled in Jongo for this app.`
- Remaining blocker classes:
  - `No staging environment/application is currently detected in Coolify.` (13/13)
  - `Backups not configured.` (7/13)
- Auto-provision behavior validated: staging enable/provision API path is reachable with ops-token auth but Coolify did not auto-provision any current app.

## Blocker Matrix

### Common blockers observed

- No staging environment/application is currently detected in Coolify.
- Backups not configured. (for a subset of apps)

### Site-specific breakdown

1. `cc-empowermaps`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.
  - Configure at least one automated backup schedule in Coolify.

2. `joyfeed-app`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.

3. `millenion-fitness`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.
  - Configure at least one automated backup schedule in Coolify.

4. `daniel-kane`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.
  - Configure at least one automated backup schedule in Coolify.

5. `a3th9r`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.
  - Configure at least one automated backup schedule in Coolify.

6. `freebling-app`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.
  - Configure at least one automated backup schedule in Coolify.

7. `jongo-open-source`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.
  - Configure at least one automated backup schedule in Coolify.

8. `fts-branding-guide`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.

9. `waterfallkeepersofnc-org`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.

10. `airbb-wordpress`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.

11. `aptennis-org`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.

12. `wptest-manifest-fts-com`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.

13. `gimmepower-com`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.

## Next Core Actions

1. Create/attach staging environments manually in Coolify for all 13 linked apps (auto-provision currently unsupported/unsuccessful for this set).
2. Configure backup schedules for apps still reporting backup blockers:
  - `freebling-app`, `millenion-fitness`, `daniel-kane`, `a3th9r`, `jongo-open-source`, `cc-empowermaps`, `airbb-wordpress`.
3. Re-run strict promote smoke (`FAIL_ON_BLOCKED=true`) after each remediation batch until blocked count reaches zero.
4. Run trigger-path validation intentionally (`ALLOW_PRODUCTION_TRIGGER=true`) on one controlled app after preflight blockers are cleared.

## Ops Artifact

- Latest identifier-rich manual queue: `docs/workflows/staging-remediation-queue-latest.md`
- Latest operator checklist tracker: `docs/workflows/staging-remediation-tracker-latest.md`
