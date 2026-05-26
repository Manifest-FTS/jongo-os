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
  - Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.
  - Backup telemetry unavailable.
- Suggested actions:
  - Verify COOLIFY_API_TOKEN scope, COOLIFY_API_BASE_URL reachability, and any Coolify allowlist/edge restrictions; then re-run staging preflight.
  - Verify Coolify API token scope, endpoint reachability/allowlist policy, and service-database backup endpoint access.

## Next Core Actions

1. Fix Coolify API access first (token scope/base URL/allowlist) and re-run preflight.
2. After API access is restored, verify whether staging truly exists for `waterfallkeepersofnc-org`; provision only if still missing.
3. If backup telemetry remains empty after access is restored, validate database backup schedule configuration.
4. Re-run strict smoke after each remediation change:
   - `npm run ops:refresh-staging-remediation:strict`
5. Only run trigger-path success validation when preflight blockers clear.

## Related Artifacts

- `docs/workflows/staging-remediation-queue-latest.md`
- `docs/workflows/staging-remediation-tracker-latest.md`
- `docs/workflows/staging-remediation-delta-latest.md`
- `docs/workflows/staging-remediation-next-batch.md`
