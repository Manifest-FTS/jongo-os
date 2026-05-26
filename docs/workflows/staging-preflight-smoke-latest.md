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
  - Staging environment exists but no staging service target is attached yet.
- Backup readiness: `ready`

## Suggested Actions Returned By API

- Provision or attach a staging service in Coolify so sync and promote checks can target a concrete staging service.

## Operational Decision

- Promote trigger-path smoke remains blocked for Waterfall Keepers until a staging service target is attached in Coolify.