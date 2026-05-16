# Coolify API Diagnostics Runbook

## Purpose

Provide a repeatable, non-destructive validation flow for explaining empty Client/App states and verifying API alignment behavior in jongo-os.

## Scope

This runbook validates:

- Coolify endpoint reachability and auth
- inventory source attribution (`db`, `coolify`, `hybrid`, `mock`)
- session scoping effects on result visibility
- fallback activation conditions
- timestamp of last successful inventory fetch

## Safety Rules

- Never print or store raw API tokens in logs/docs.
- Use token-presence checks only.
- Keep diagnostics in protected endpoint or admin/dev settings surface.

## Prerequisites

- jongo-os deployed and reachable
- `COOLIFY_API_BASE_URL` configured
- `COOLIFY_API_TOKEN` configured
- `OWNERSHIP_SYNC_TOKEN` configured for machine diagnostics access

## Local Validation

1. Start app with diagnostics token present.
2. Probe diagnostics endpoint:

```bash
curl -sS -H "Authorization: Bearer $OWNERSHIP_SYNC_TOKEN" "http://localhost:3000/api/diagnostics/runtime?probe=1"
```

3. Confirm payload includes:
   - `envPresence` booleans
   - `coolifyEndpointCalls[]` with status/success/count
   - `coolifyInventoryHistory[]` with mode/source/counts
   - `repositoryCalls[]` with source/scope/fallback metadata

4. Confirm Settings -> Developer Details shows runtime diagnostics panel for admin/dev only.

## Production Validation

### A. Public health signals

1. Check provider connectivity surface:

```bash
curl -i "https://<jongo-host>/api/coolify/connection"
```

2. If non-200, capture JSON error message only (no secrets).

### B. Protected diagnostics probe

1. Probe runtime diagnostics endpoint with token:

```bash
curl -sS -H "Authorization: Bearer $OWNERSHIP_SYNC_TOKEN" "https://<jongo-host>/api/diagnostics/runtime?probe=1"
```

2. Validate:
   - `lastSuccessfulCoolifyInventoryFetchAt` is recent
   - `coolifyEndpointCalls` include inventory endpoints
   - endpoint calls are successful (2xx) with non-zero counts where expected
   - `repositoryCalls` explain source decisions and fallback usage

### C. In-container provider auth check (read-only)

Run from host:

```bash
ssh root@<host> docker exec <jongo-container> sh -lc 'AUTH_HEADER=$(printf "Authorization: Bearer %s" "$COOLIFY_API_TOKEN"); curl -sS -D - -o /tmp/apps.json -H "$AUTH_HEADER" "$COOLIFY_API_BASE_URL/api/v1/applications"; head -c 200 /tmp/apps.json; echo'
```

Expected:

- 200 response for valid token/scope
- 401/403 indicates token/API-enable/permission issue

## Interpreting Common Outcomes

1. `source = mock` in `listClientWorkspaces` with `DATABASE_URL` present:
   - DB connection/query failed; inspect DB reachability/migrations/session UUID context.

2. `source = coolify` with `fallbackUsed = true` in `listSiteDirectory`:
   - DB Site records unavailable or query path failed; visibility depends on Coolify inventory.

3. `coolify/connection` returns non-reachable with auth error:
   - Coolify token invalid/expired/wrong scope or API disabled.

4. Inventory history shows success but zero sites:
   - upstream inventory is empty or filtered; inspect endpoint counts and project/resource ownership mapping.

## Remediation Sequence (Production)

1. Ensure Coolify API is enabled (`GET /api/v1/enable` root context).
2. Rotate/create API token with required read capabilities.
3. Update deployment secret for `COOLIFY_API_TOKEN`.
4. Redeploy jongo-os.
5. Re-run diagnostics probe and verify successful inventory endpoints.
6. Confirm Apps page count aligns with diagnostics inventory count.

## Completion Criteria

- Type-check passes.
- Production build passes.
- Diagnostics endpoint/view clearly reports source, fallback, scope, and endpoint outcomes.
- Empty App state (if present) is explainable by diagnostics evidence.
