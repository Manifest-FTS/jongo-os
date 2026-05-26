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
- Coolify endpoint status: inventory endpoints returned HTTP 200 in local runtime
- Inventory result: non-empty live inventory (`live_inventory_non_empty_resources_primary`)

## Endpoint Evidence

- `GET /api/v1/projects` -> 200
- `GET /api/v1/resources` -> 200
- `GET /api/v1/services` -> 200
- `GET /api/v1/databases` -> 200
- Inventory history: success=true, sitesCount=31, projectsCount=15, environmentsCount=19

## Interpretation

- Coolify API auth/reachability is currently healthy in local runtime.
- Staging target is now detected for Waterfall (`stagingConfigured=true`).
- Strict promote smoke now passes trigger-path validation (HTTP 200 + idempotency replay + attempt lookup).

## Immediate Remediation Path

1. Keep runtime token and deploy permissions stable as remediation expands to remaining sites.
2. Continue strict smoke-driven remediation batch runs and monitor for regressions.
3. Capture deployment completion outcomes in promote workflow artifacts.

## Related Artifacts

- `docs/workflows/coolify-api-diagnostics-runbook.md`
- `docs/workflows/staging-preflight-smoke-latest.md`
- `docs/workflows/staging-promote-smoke-latest.md`
- `docs/workflows/staging-remediation-queue-latest.md`
