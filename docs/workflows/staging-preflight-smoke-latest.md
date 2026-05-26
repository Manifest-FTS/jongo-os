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
- Readiness: `READY`
- Preflight label/tone: `Ready` / `healthy`
- Blockers: none
- Backup readiness: `ready`

## Suggested Actions Returned By API

- Run dry-run preflight checks and validate staging content before any manual promote/sync action in Coolify.

## Operational Decision

- Preflight gate is clear; remaining work has moved to promote-trigger execution authorization.