# Staging Promote Smoke Latest Run

Date: 2026-05-24
Mode: local smoke against `http://localhost:3000` with `ALLOW_NO_AUTH_LOCAL=true`, `FAIL_ON_BLOCKED=true`
Command: `npm run smoke:staging-promote`

## Result Summary

- Triggered: 0
- Blocked: 13
- Failed: 13 (expected with `FAIL_ON_BLOCKED=true`)
- Promote-attempt endpoint checks: 13/13 returned HTTP 200
- Promote blocking reason: `staging_to_production_preflight_blocked` for all tested sites

## Blocker Matrix

### Common blockers observed

- Staging is disabled in Jongo for this app.
- No staging environment/application is currently detected in Coolify.
- Backups not configured. (for a subset of apps)

### Site-specific breakdown

1. `cc-empowermaps`
- Blockers:
  - Staging is disabled in Jongo for this app.
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Enable staging in app settings.
  - Configure at least one automated backup schedule in Coolify.

2. `joyfeed-app`
- Blockers:
  - Staging is disabled in Jongo for this app.
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Enable staging in app settings.

3. `millenion-fitness`
- Blockers:
  - Staging is disabled in Jongo for this app.
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Enable staging in app settings.
  - Configure at least one automated backup schedule in Coolify.

4. `daniel-kane`
- Blockers:
  - Staging is disabled in Jongo for this app.
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Enable staging in app settings.
  - Configure at least one automated backup schedule in Coolify.

5. `a3th9r`
- Blockers:
  - Staging is disabled in Jongo for this app.
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Enable staging in app settings.
  - Configure at least one automated backup schedule in Coolify.

6. `freebling-app`
- Blockers:
  - Staging is disabled in Jongo for this app.
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Enable staging in app settings.
  - Configure at least one automated backup schedule in Coolify.

7. `jongo-open-source`
- Blockers:
  - Staging is disabled in Jongo for this app.
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Enable staging in app settings.
  - Configure at least one automated backup schedule in Coolify.

8. `fts-branding-guide`
- Blockers:
  - Staging is disabled in Jongo for this app.
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Enable staging in app settings.
  - Configure at least one automated backup schedule in Coolify.

9. `waterfallkeepersofnc-org`
- Blockers:
  - Staging is disabled in Jongo for this app.
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Enable staging in app settings.

10. `airbb-wordpress`
- Blockers:
  - Staging is disabled in Jongo for this app.
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Enable staging in app settings.

11. `aptennis-org`
- Blockers:
  - Staging is disabled in Jongo for this app.
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Enable staging in app settings.

12. `wptest-manifest-fts-com`
- Blockers:
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.

13. `gimmepower-com`
- Blockers:
  - Staging is disabled in Jongo for this app.
  - No staging environment/application is currently detected in Coolify.
- Suggested actions:
  - Enable staging in app settings.

## Next Core Actions

1. Enable staging in Jongo for all blocked apps where disabled.
2. Confirm/create staging environment in Coolify for each app.
3. Configure backup schedule for apps showing backup blocker.
4. Re-run strict promote smoke (`FAIL_ON_BLOCKED=true`) until blocked count reaches zero.
5. Then run trigger-path validation intentionally (`ALLOW_PRODUCTION_TRIGGER=true`) on one controlled app.
