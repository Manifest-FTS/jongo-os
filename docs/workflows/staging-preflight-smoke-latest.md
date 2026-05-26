# Staging Preflight Smoke Latest Run

Date: 2026-05-26
Mode: local smoke against `http://localhost:3000` with ops token auth
Command: `npm run smoke:staging-preflight -- waterfallkeepersofnc-org`

## Connectivity Notes

- Local app was started with `npm run dev`.
- DB tunnel had to target the host-local relay on port `15432` (not `5432`) for this environment:
  - `powershell -ExecutionPolicy Bypass -File .\scripts\db-tunnel.ps1 -ServerHost 5.78.216.68 -RemoteHost 127.0.0.1 -RemotePort 15432`
- Local tunnel check passed:
  - `Test-NetConnection -ComputerName 127.0.0.1 -Port 5433`

## Result Summary

- Site: `waterfallkeepersofnc-org`
- HTTP status: `200`
- Readiness: `NOT READY`
- Preflight label/tone: `Blocked` / `error`
- Blockers:
  - Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.
  - Backup telemetry unavailable.

## Suggested Actions Returned By API

- Verify COOLIFY_API_TOKEN scope, COOLIFY_API_BASE_URL reachability, and any Coolify allowlist/edge restrictions; then re-run staging preflight.
- Verify Coolify API token scope, endpoint reachability/allowlist policy, and service-database backup endpoint access.

## Operational Decision

- Promote trigger-path smoke remains blocked for Waterfall Keepers until the above preflight blockers are cleared.