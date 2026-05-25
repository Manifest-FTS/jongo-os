# Staging Promote Smoke Runbook

This runbook validates the core staging-to-production promote trigger path for a site.

## Purpose

Use this when you need deterministic proof that:

- promote preflight is healthy,
- promote trigger works,
- idempotency replay works,
- promote-attempt status endpoint resolves.

## Test Scope Guidance

- Use `waterfallkeepersofnc-org` (and similar WordPress/service-backed sites) for staging lifecycle tests (toggle OFF with cleanup, toggle ON, environment create/delete behavior).
- Use `joyfeed-app` for promote trigger-path smoke because it has a known staging application target and predictable idempotency/attempt-state behavior.
- Do not assume non-WordPress apps with external dependencies (env-var heavy services, Sanity-backed apps, etc.) are good candidates for staging clone validation.

## Prerequisites

- Web app running locally (`npm run dev:web`) with required env.
- Local app API reachable at `http://localhost:3000`.
- `OWNERSHIP_SYNC_TOKEN` valid for API access.
- Coolify API tunnel healthy for the app runtime.
- DB tunnel healthy for Prisma access.

## New Stability Guardrails

The smoke script now checks staging readiness before each promote attempt and retries.

- `SMOKE_HEALTHCHECK_RETRIES` (default `4`)
- `SMOKE_HEALTHCHECK_DELAY_MS` (default `1500`)

If readiness never returns HTTP 200, smoke fails early with a clear health-check error.

## Single Smoke Command

From repo root:

```powershell
Set-Location "c:/Users/kevin/devkev/projects/manifestfts/fts-operations/jongo-os"
$env:APP_BASE_URL='http://localhost:3000'
$env:OWNERSHIP_SYNC_TOKEN='<token>'
$env:STAGING_SITE_IDS='joyfeed-app'
$env:ALLOW_PRODUCTION_TRIGGER='true'
$env:SMOKE_HEALTHCHECK_RETRIES='5'
$env:SMOKE_HEALTHCHECK_DELAY_MS='1500'
npm run smoke:staging-promote
```

Expected success pattern:

- `first promote HTTP: 200`
- `replay promote HTTP: 200`
- `attempt endpoint HTTP: 200`
- `Summary: triggered=1, blocked=0, failed=0`

## Consecutive Confidence Pass

```powershell
for ($i = 1; $i -le 5; $i++) {
  Write-Host "`n=== Smoke run $i/5 ==="
  npm run smoke:staging-promote
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Use this to validate stability across repeated runs, not only a single pass.

## Fast Triage

If smoke fails:

1. Check readiness endpoint directly:

```powershell
$headers = @{ Authorization = 'Bearer <token>' }
Invoke-WebRequest -UseBasicParsing -Headers $headers 'http://localhost:3000/api/sites/joyfeed-app/staging' | Select-Object -ExpandProperty Content
```

2. Confirm DB tunnel:

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 5433 | Select-Object ComputerName,RemotePort,TcpTestSucceeded
```

3. Confirm Coolify API tunnel:

```powershell
Invoke-WebRequest -UseBasicParsing -Headers @{ Authorization = 'Bearer <coolify-token>' } 'http://127.0.0.1:18000/api/v1/applications?limit=1' | Select-Object -ExpandProperty StatusCode
```

4. Check web server logs for `PrismaClientInitializationError` or repeated long-latency responses.

## Interpretation

- `blocked` response with preflight errors: functional gate worked and prevented trigger.
- `failed` with readiness health-check error: infra path unstable before promote.
- `triggered=1` and replay/attempt checks pass: core promote flow is healthy.
