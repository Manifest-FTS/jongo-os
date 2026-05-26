# Coolify API Diagnostics Latest Probe

Date: 2026-05-26
Mode: local diagnostics probe via machine token
Command:

```powershell
$headers=@{Authorization="Bearer <OWNERSHIP_SYNC_TOKEN>"}
Invoke-RestMethod -Headers $headers -Uri "http://localhost:3000/api/diagnostics/runtime?probe=1" -Method Get
```

## Result Summary

- Probe status: ok
- Environment secrets present: yes (`DATABASE_URL`, `NEXTAUTH_SECRET`, `COOLIFY_API_BASE_URL`, `COOLIFY_API_TOKEN`, `OWNERSHIP_SYNC_TOKEN`)
- Coolify endpoint status: all tested inventory endpoints returned HTTP 403 in this local runtime
- Inventory result: empty live inventory after endpoint failures (`live_inventory_empty_after_endpoint_failure`)

## Endpoint Evidence

- `GET /api/v1/projects` -> 403
- `GET /api/v1/resources` -> 403
- `GET /api/v1/applications` -> 403
- `GET /api/v1/services` -> 403
- `GET /api/v1/databases` -> 403

## Interpretation

- Current local blocker state is consistent with broad Coolify API authorization/reachability failure, not a verified absence of staging environments.
- Backup telemetry unavailability is expected while these 403 responses persist.

## Immediate Remediation Path

1. Validate `COOLIFY_API_BASE_URL` target and ingress path from the app runtime.
2. Validate `COOLIFY_API_TOKEN` scope/capabilities for project/resource/database inventory and database-backup endpoints.
3. Validate instance/IP allowlist or edge restrictions that can return 403 before route-level auth checks.
4. Re-run this diagnostics probe and confirm 2xx responses on inventory endpoints before interpreting staging/backup blockers as configuration drift.

## Related Artifacts

- `docs/workflows/coolify-api-diagnostics-runbook.md`
- `docs/workflows/staging-preflight-smoke-latest.md`
- `docs/workflows/staging-promote-smoke-latest.md`
- `docs/workflows/staging-remediation-queue-latest.md`
