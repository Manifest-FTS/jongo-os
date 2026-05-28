# Staging Sync Automation Webhook Contract

Date: 2026-05-28
Owner: Platform Operations
Status: Active (route integrated)

## Purpose

Define the contract used by the staging enable route to trigger automatic production-to-staging content sync after a new staging service is created.

Integration point:

- API route: `POST /api/sites/[siteId]/staging` in `apps/web/src/app/api/sites/[siteId]/staging/route.ts`
- Trigger condition: provisioning reason is `service_created`
- Invocation method: outbound HTTP POST to `STAGING_SYNC_AUTOMATION_URL`
- First-party automation endpoint available: `POST /api/ops/staging-sync-automation`

## Required Environment Variables

- `STAGING_SYNC_AUTOMATION_URL`
  - Absolute URL for automation endpoint.
  - If missing, route returns `autoContentSync.reason = "missing_config"` and does not fail the staging enable request.
  - Recommended local value: `http://localhost:3000/api/ops/staging-sync-automation`
- `OWNERSHIP_SYNC_TOKEN` (recommended)
  - Added as `Authorization: Bearer <token>` when present.
  - Reuse the same shared token policy as ops scripts.
- `STAGING_SYNC_SSH_HOST` or `COOLIFY_SSH_HOST`
  - Required by `remediate-staging-content-sync.mjs` for remote execution.
  - If missing, first-party endpoint returns `412` with `reason: "missing_config"`.
- `APP_BASE_URL` (optional fallback)
  - Used when request origin cannot be derived.

## Request Contract

Method: `POST`

Headers:

- `Content-Type: application/json`
- `Authorization: Bearer <OWNERSHIP_SYNC_TOKEN>` (only if token is configured)

Body:

```json
{
  "siteId": "wptest-manifest-fts-com",
  "productionServiceUuid": "dohwcjwofkptbb0vh805pts7",
  "stagingServiceUuid": "l6174wntm9oo5rjse2ekdpna",
  "stagingUrl": "https://wordpress-l6174wntm9oo5rjse2ekdpna.manifest-fts.com",
  "appBaseUrl": "http://localhost:3000",
  "mode": "apply"
}
```

Field notes:

- `siteId`: preferred slug, falls back to site UUID if slug unavailable.
- `productionServiceUuid`: source service/app UUID in production environment.
- `stagingServiceUuid`: newly created staging service/app UUID.
- `stagingUrl`: primary staging URL used for URL rewrite verification.
- `appBaseUrl`: route request origin or `APP_BASE_URL` fallback.
- `mode`: currently fixed to `apply`.

## Response Expectations

Automation endpoint may return any body format. Route behavior:

- HTTP 2xx => `autoContentSync.ok = true`, `reason = "completed"`
- HTTP non-2xx => `autoContentSync.ok = false`, `reason = "command_failed"`
- Timeout (>45s) => `autoContentSync.ok = false`, `reason = "timed_out"`
- Missing IDs/URL => `autoContentSync.ok = false`, `reason = "missing_identifiers"`

First-party endpoint behavior (`/api/ops/staging-sync-automation`):

- Auth: bearer token must match `OWNERSHIP_SYNC_TOKEN`
- Mode: only `apply` is supported
- Executes: `scripts/remediate-staging-content-sync.mjs --apply` with explicit UUID and URL overrides
- Success: HTTP `200` with `ok: true`
- Missing required runtime config: HTTP `412` with `reason: "missing_config"`
- Failure: HTTP `502` with command tails
- Timeout: HTTP `504` after 10 minutes

The route captures the last response lines into `autoContentSync.responseTail` for diagnostics when available.

## Route Response Surface

On enable/create, the route now includes:

```json
{
  "enabled": true,
  "provisioningReason": "service_created",
  "autoContentSync": {
    "attempted": true,
    "ok": true,
    "reason": "completed",
    "message": "Automatic content sync completed.",
    "responseTail": "..."
  }
}
```

If not required (for example, no new service creation), route returns:

```json
{
  "autoContentSync": {
    "attempted": false,
    "ok": false,
    "reason": "not_required",
    "message": "Automatic content sync not required."
  }
}
```

## Failure Handling Policy

- The staging enable request should not be hard-failed solely because automation webhook fails.
- Failures must be visible through:
  - `autoContentSync` in API response
  - staging audit metadata (`autoContentSync` object)
  - UI message/action hint prompting retry from Operations
- Manual recovery path remains:
  - `npm run ops:remediate-staging-content-sync:apply -- --site-id <slug> --prod-service-uuid <prod> --staging-service-uuid <staging> --staging-url <url>`

## Security Notes

- Use a dedicated token for automation endpoint authorization.
- Validate bearer token server-side in automation endpoint.
- Restrict endpoint network exposure to trusted origins/hosts when possible.
- Avoid echoing secrets in response bodies; route stores response tail for diagnostics.

## Operational Validation Checklist

1. Set `STAGING_SYNC_AUTOMATION_URL` and restart app runtime.
2. Run staging disable+enable for a non-critical site.
3. Confirm enable response includes `autoContentSync.attempted = true`.
4. Confirm `autoContentSync.ok = true` for successful runs.
5. Verify staging install endpoint reports `Already Installed`.
6. Run readiness smoke and confirm `GO`.

## Related Artifacts

- `docs/workflows/staging-sync-readiness-latest.md`
- `docs/workflows/staging-sync-prod-readiness.md`
- `scripts/remediate-staging-content-sync.mjs`
- `scripts/smoke-staging-sync-readiness.mjs`
