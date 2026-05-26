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
- Inventory history: success=true, sitesCount=30, projectsCount=15, environmentsCount=19

## Interpretation

- Coolify API auth/reachability is currently healthy in local runtime.
- Current Waterfall blocker is structural: staging environment exists, but no staging service target is attached.

## Immediate Remediation Path

1. In Coolify project `cx7ldowl163oc24u2tqsbzuq`, attach/provision a staging service target for `waterfallkeepersofnc-org`.
2. Re-run `npm run smoke:staging-preflight -- waterfallkeepersofnc-org` and confirm no staging-target blocker remains.
3. Re-run strict promote smoke and verify trigger-path success once preflight clears.

## Related Artifacts

- `docs/workflows/coolify-api-diagnostics-runbook.md`
- `docs/workflows/staging-preflight-smoke-latest.md`
- `docs/workflows/staging-promote-smoke-latest.md`
- `docs/workflows/staging-remediation-queue-latest.md`
