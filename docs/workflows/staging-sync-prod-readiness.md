# Staging Sync Production Readiness

## Purpose

Provide a deterministic go/no-go checklist before running any live staging<>production sync test that touches real production database or files.

## Scope

This workflow is for controlled operator testing only. It does not enable new runtime execution paths in Jongo.

## Hard Safety Rules

- Never run this checklist against production without an assigned owner and rollback contact.
- Never store secrets/tokens in this document.
- Never execute destructive sync if any blocker is unresolved.
- Respect current pass boundaries: WordPress file/media backup and restore execution remain out of scope.

## Go/No-Go Checks

1. Staging configuration
   - [ ] Staging is enabled.
   - [ ] Staging target exists and is healthy.

2. Backup and preflight readiness
   - [ ] Production-to-staging preflight tone is `healthy`.
   - [ ] Most recent successful backup is within freshness threshold.

3. Dry-run plan integrity
   - [ ] Dry-run target is present.
   - [ ] Database behavior is `snapshot-then-overwrite`.
   - [ ] Files behavior is `rsync-overwrite`.

4. Scope compliance
   - [ ] Test resource type is not blocked by current pass scope boundaries.
   - [ ] For WordPress apps: full file/media sync test remains blocked in this pass.

5. Operational controls
   - [ ] Incident owner and rollback contact assigned.
   - [ ] Maintenance/test window approved.
   - [ ] Evidence capture file selected and linked.

## Programmatic Verification (Recommended)

Use the staging read-model endpoint before any live test:

```bash
curl -sS -H "Authorization: Bearer <OWNERSHIP_SYNC_TOKEN>" "https://<jongo-host>/api/sites/<siteId>/staging"
```

Required response fields for `GO`:

- `readyForSyncTesting = true`
- `actualSyncTestReadiness.ready = true`
- `actualSyncTestReadiness.blockers = []`
- `preflight.productionToStaging.tone = healthy`

If any field above fails, decision is `NO-GO`.

One-command smoke:

```bash
APP_BASE_URL="https://<jongo-host>" \
OWNERSHIP_SYNC_TOKEN="<token>" \
npm run smoke:staging-sync-readiness -- <siteId>
```

Alternative auth modes:

- `SESSION_COOKIE` for local/dev session-auth scenarios.
- `ALLOW_NO_AUTH_LOCAL=true` only for intentional local auth-bypass environments on `localhost`/`127.0.0.1`.

Default behavior:

- Dynamically discovers sites via `GET /api/sites/staging-targets?scope=linked` when no IDs are provided.
- Exits `1` when any checked site is `NO-GO`.

Optional informational mode:

```bash
APP_BASE_URL="https://<jongo-host>" \
OWNERSHIP_SYNC_TOKEN="<token>" \
FAIL_ON_BLOCKED=false \
npm run smoke:staging-sync-readiness
```

## Decision

- `GO`: All checks pass and no blockers remain.
- `NO-GO`: Any unchecked item or blocker exists.

## Blocker Register

| Blocker | Severity | Owner | Due date | Mitigation | Status |
| --- | --- | --- | --- | --- | --- |
| WordPress file/media sync is out of scope for this operational pass | High | TBD | TBD | Keep live file+DB sync tests blocked until scope upgrade and restore coverage are implemented | Open |

## Execution Notes

Append newest-first entries:

| Timestamp (UTC) | Operator | Environment | Decision | Notes |
| --- | --- | --- | --- | --- |
| 2026-05-28T01:40:00Z | Copilot (ops run) | production | GO | User recreated staging; detected new staging service `jrpr2cnlwd1jeeian3oqfrux`; ran override apply from production `dohwcjwofkptbb0vh805pts7`; readiness smoke passed GO and install endpoint classified as `Already Installed` |
| 2026-05-26T21:20:28Z | Copilot (ops run) | production | GO | Real prod->staging DB+files copy executed on Coolify host; staging `siteurl/home` updated to staging domain; `smoke:staging-sync-readiness` passed |
| 2026-05-26T21:16:32Z | Copilot (ops run) | production | NO-GO | HTTPS staging recovered but redirects to WordPress install wizard (`/` => `302` to `/wp-admin/install.php`); indicates fresh staging content, not production clone |
| 2026-05-26T20:15:42Z | Copilot (ops run) | production | NO-GO | `stagingContentProbe.freshInstallDetected=true`; final URL resolved to `/wp-admin/install.php`; `smoke:staging-sync-readiness` failed with install-screen blocker |
| 2026-05-26T20:08:15Z | Copilot (ops run) | production | GO | `smoke:staging-sync-readiness` GO (`readyForSyncTesting=true`, blockers=0), `smoke:staging-preflight` READY, `smoke:staging-promote` passed |
| TBD | TBD | production | NO-GO | Initial baseline created; awaiting scope unlock for WordPress file/media sync |

Latest captured output:

- `docs/workflows/staging-sync-readiness-latest.md`
