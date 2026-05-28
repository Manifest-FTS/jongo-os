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

## Production Revalidation Checklist

Use this checklist when executing the production immediate-next-actions block from `docs/plan.md`.

1. Deploy verification
	- [ ] Running production image/tag matches diagnostics/resources-primary build.
	- [ ] Deploy timestamp recorded.

2. API enablement and token rotation
	- [ ] `GET /api/v1/enable` confirms API enablement in production.
	- [ ] Token rotated or revalidated (record timestamp only; do not store token values).
	- [ ] Jongo production secret updated and deployment restarted.

3. Protected diagnostics probe
	- [ ] `GET /api/diagnostics/runtime?probe=1` returns 200 via machine token.
	- [ ] `coolifyEndpointCalls` include successful inventory endpoint responses.
	- [ ] `lastSuccessfulCoolifyInventoryFetchAt` is recent.

4. Inventory visibility outcome
	- [ ] Apps inventory resolves non-empty from live Coolify feed when DB Sites are zero.
	- [ ] Source/fallback attribution captured (`coolify`/`hybrid`/`db`/`mock`) with explanation.

5. Evidence capture
	- [ ] Endpoint status summary captured in this file.
	- [ ] Any blocking auth/error payloads captured with secrets redacted.
	- [ ] Follow-up action owner + due date noted for unresolved blockers.

## Blocking Issues Triage

Update this section during each production diagnostics pass. Keep one row per active blocker.

| Blocker | Signal | Impact | Owner | Due date | Next action | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Coolify API auth fails in production | `GET /api/coolify/connection` non-200 or diagnostics endpoint call failures | Apps inventory can resolve empty when DB Sites are zero | Unassigned | TBD | Revalidate API enablement, rotate token, redeploy, rerun probe | Open |

Status values:

- `Open`: blocker is active and unresolved
- `In progress`: mitigation is currently being executed
- `Blocked`: mitigation is waiting on external dependency or access
- `Resolved`: validation passed and evidence captured

## Execution Log

Append newest-first entries for traceability.

| Timestamp (UTC) | Operator | Action | Outcome | Evidence |
| --- | --- | --- | --- | --- |
| TBD | TBD | Initialize blocker triage register | Added baseline row for production auth blocker | This file |

## Related Artifacts

- `docs/workflows/coolify-api-diagnostics-runbook.md`
- `docs/workflows/staging-preflight-smoke-latest.md`
- `docs/workflows/staging-promote-smoke-latest.md`
- `docs/workflows/staging-remediation-queue-latest.md`
