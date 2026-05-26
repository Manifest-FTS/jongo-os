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
- Blocked: 0
- Failed: 1
- Promote trigger endpoint returned HTTP `502`
- Promote runtime error: `Coolify deploy failed (403)`

## Blocker Matrix

### `waterfallkeepersofnc-org`

- Blockers:
  - Promote trigger failed upstream: Coolify deploy authorization returned HTTP 403.
- Suggested actions:
  - Validate Coolify API token deploy permission (`api.ability:deploy`) for the team/resource.
  - Re-run strict promote smoke after token/permission update.

## Next Core Actions

1. Keep current staging target in place (`stagingConfigured=true` is already verified).
2. Update Coolify token/permissions so promote deploy actions are authorized.
3. Re-run strict smoke after each remediation change:
   - `npm run ops:refresh-staging-remediation:strict`
4. Run trigger-path success validation once deploy authorization 403 is cleared.

## Related Artifacts

- `docs/workflows/staging-remediation-queue-latest.md`
- `docs/workflows/staging-remediation-tracker-latest.md`
- `docs/workflows/staging-remediation-delta-latest.md`
- `docs/workflows/staging-remediation-next-batch.md`
