# Staging Promote Smoke Latest Run

Date: 2026-05-26
Mode: local strict smoke against `http://localhost:3000`
Command:

```powershell
$env:APP_BASE_URL='http://localhost:3000'
$env:OWNERSHIP_SYNC_TOKEN='<token>'
$env:STAGING_SITE_IDS='waterfallkeepersofnc-org'
$env:FAIL_ON_BLOCKED='true'
$env:ALLOW_PRODUCTION_TRIGGER='true'
npm run smoke:staging-promote
```

## Trigger-Path Policy

- Approved target for this pass: `waterfallkeepersofnc-org`
- `joyfeed-app` is non-default and diagnostic-only unless explicitly overridden.

## Result Summary

- Triggered: 0
- Blocked: 1
- Failed: 1 (expected with `FAIL_ON_BLOCKED=true`)
- Promote-attempt endpoint checks: 1/1 returned HTTP 200
- Promote blocking reason: `staging_to_production_preflight_blocked`

## Blocker Matrix

### `waterfallkeepersofnc-org`

- Blockers:
  - No staging environment/application is currently detected in Coolify.
  - Backups not configured.
- Suggested actions:
  - Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.
  - Configure at least one automated backup schedule in Coolify.

## Next Core Actions

1. In Coolify, create or attach staging for `waterfallkeepersofnc-org`.
2. Configure at least one automated backup schedule for `waterfallkeepersofnc-org`.
3. Re-run strict smoke after each remediation change:
   - `npm run ops:refresh-staging-remediation:strict`
4. Only run trigger-path success validation when preflight blockers clear.

## Related Artifacts

- `docs/workflows/staging-remediation-queue-latest.md`
- `docs/workflows/staging-remediation-tracker-latest.md`
- `docs/workflows/staging-remediation-delta-latest.md`
- `docs/workflows/staging-remediation-next-batch.md`
