# Staging Sync Readiness Latest Run

Date: 2026-05-28
Mode: local smoke + remote apply against `http://localhost:3000` with ops token auth and Coolify host SSH
Site: `wptest-manifest-fts-com`
Command:

```bash
npm run ops:remediate-staging-content-sync:apply -- --site-id wptest-manifest-fts-com --prod-service-uuid dohwcjwofkptbb0vh805pts7 --staging-service-uuid jrpr2cnlwd1jeeian3oqfrux --staging-url https://wordpress-jrpr2cnlwd1jeeian3oqfrux.manifest-fts.com
npm run smoke:staging-sync-readiness -- wptest-manifest-fts-com
```

## Result Summary

- Decision: `GO`
- HTTP status: `200`
- `readyForSyncTesting`: `true`
- `actualSyncTestReadiness.ready`: `true`
- `actualSyncTestReadiness.blockers`: `0`
- `preflight.productionToStaging.tone`: `healthy`

HTTPS verification after retry:

- `GET /` on staging URL returned `200`
- `GET /wp-admin/install.php` returned `200` with `Already Installed` message
- Browser loads staging root over HTTPS successfully (homepage content renders)

Latest recreate recovery (new staging target):

- Source production service: `dohwcjwofkptbb0vh805pts7`
- New staging service: `jrpr2cnlwd1jeeian3oqfrux`
- New staging URL: `https://wordpress-jrpr2cnlwd1jeeian3oqfrux.manifest-fts.com`
- Apply summary: eligible=1 succeeded=1 failed=0 skipped=0
- Smoke outcome: `GO` with `readyForSyncTesting=true`, `actualSyncTestReadiness.blockers=0`, `preflight.productionToStaging.tone=healthy`
- Install classifier: `INSTALL_ENDPOINT:Already Installed`

Runtime mitigation applied:

- Added `WP_MEMORY_LIMIT=256M` and `WP_MAX_MEMORY_LIMIT=512M` in staging `wp-config.php`
- Restarted staging WordPress container

Additional operational smoke checks in this run:

- `npm run smoke:staging-preflight -- waterfallkeepersofnc-org` => `READY` (passed)
- `npm run smoke:staging-promote -- waterfallkeepersofnc-org` reached trigger path (attempt id `16d5d7fa-abc8-4dcb-a4b9-bfab31086c38`)
- Promote semantics confirmed in UI audit: promote triggers production deploy; it does not copy staging DB/files into production.

Latest stabilization delta:

- Staging plugin warning noise from `constant-contact-forms` was mitigated by disabling that plugin directory on staging (`constant-contact-forms.disabled-`).
- No new `constant-contact`/memory-fatal warnings detected in post-restart log window.
- Re-check: `npm run smoke:staging-sync-readiness -- waterfallkeepersofnc-org` => `GO`.

Destructive toggle/reapply rehearsal (same operational window):

- Executed staging disable with destroy (`enabled=false`, `burnExisting=true`) and re-enabled staging.
- Re-enable path intermittently oscillated (`healthy -> degraded/error -> fetch_error`) before converging to a new staging target.
- New target came up as a fresh install (`/wp-admin/install.php`), which caused `NO-GO` until real production content sync was executed.
- Performed direct production->staging DB+files copy for the recreated staging target and re-applied staging `home/siteurl`.
- Re-applied runtime hardening (`WP_MEMORY_LIMIT`/`WP_MAX_MEMORY_LIMIT`) and disabled `constant-contact-forms` on staging.
- Final validation after recovery: staging root `200`, install endpoint shows `Already Installed`, readiness smoke back to `GO`.

## Active Blocker

- None.

## Remediation Attempts In This Run

1. Executed real production-to-staging copy directly on Coolify host:
   - MariaDB dump/import from production service DB container into staging DB container
   - Files copy from production WordPress container `/var/www/html` into staging WordPress container
2. Updated staging WordPress `home` and `siteurl` options to the staging domain after DB clone.
3. Re-ran readiness smoke:
   - `npm run smoke:staging-sync-readiness -- waterfallkeepersofnc-org` => `GO`

## Operational Decision

- Real production-to-staging content copy completed and sync-readiness contract is `GO`.
- Staging homepage is now loading after memory mitigation; continue with normal app-level verification.

Scope note:

- This repository currently provides readiness/preflight/promote smoke coverage, but no first-party scripted executor here for full production file+DB copy. Execute the copy in the external operations plane only under approved change controls.

## Related Artifacts

- `docs/workflows/staging-sync-prod-readiness.md`
- `docs/workflows/staging-preflight-smoke-latest.md`
- `docs/workflows/staging-promote-smoke-latest.md`
