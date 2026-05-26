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

- Triggered: 1
- Blocked: 0
- Failed: 0
- First promote endpoint returned HTTP `200`
- Idempotency replay endpoint returned HTTP `200` with replay confirmation
- Promote-attempt endpoint checks: 1/1 returned HTTP `200`

## Blocker Matrix

### `waterfallkeepersofnc-org`

- Blockers:
  - none
- Suggested actions:
  - Review deployment lifecycle in staging audit and confirm downstream deployment completion status.

## Next Core Actions

1. Keep current staging target and token posture in place while promoting remaining blocked sites.
2. Re-run strict smoke after each remediation change:
  - `npm run ops:refresh-staging-remediation:strict`
3. Capture deployment completion outcomes for the triggered attempt in staging audit artifacts.

## Related Artifacts

- `docs/workflows/staging-remediation-queue-latest.md`
- `docs/workflows/staging-remediation-tracker-latest.md`
- `docs/workflows/staging-remediation-delta-latest.md`
- `docs/workflows/staging-remediation-next-batch.md`
