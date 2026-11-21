# GSE staging PHP security update — 2026-10-21

> **Superseded deployment status:** the subsequent authorized fleet rollout also
> patched GSE production and all other 15 WordPress services. See
> [fleet rollout report](wordpress-php-security-fleet-2026-10-21.md).
> Statements below that production is unchanged describe the initial staging pass only.

## Scope and outcome

- Authorized scope: existing GSE staging runtime only; no content sync or production deployment.
- Verified production site's `stagingTargetUuid`: `iodhibjd37x9rox2phx54g9f`.
- Staging: https://gse.staging.mfts.link/ on worker `5.78.216.68`.
- PHP changed from **8.3.33 to 8.3.36**; WordPress remains **7.1.3**.
- Official image pinned in Coolify to `wordpress:php8.3-apache@sha256:f3e6835fa7d4a5b786615c24b67ec70816e06ebd517d31276bef423e49dfd126`.
- Only the staging WordPress container was recreated. Brief staging interruption was possible and was not continuously measured. No production downtime was induced.
- Production container identity/start time and staging database container identity/start time matched their recorded pre-update values.
- Production still runs **8.3.33** and remains affected. Other staging sites and the education site were not changed.

## Recovery point

- Offsite restic snapshot: **e98740dc**, host `gse-staging`, tag `php-security-20261021`.
- Captured 34,145 files / 1.809 GiB including staging WordPress files and a 90,091,202-byte database dump.
- Offsite dump was read back and its SHA-256 matched the local dump: `9684fb1d3fe71085ccfde3a8d425c47c5c4597a659e0284fe65189cad3f7f564`.
- Protected server recovery directory: `/data/coolify/backups/php-security-20261021/iodhibjd37x9rox2phx54g9f`.
- Directory contains pre-update compose/configuration, container inspection, database dump and checksums; treat it as secret-bearing. Do not publish its contents.
- Full restore rehearsal was not performed. No Hetzner snapshot was taken.

## Deployment method

The guarded helper in `operations/gse-staging-php-security-20261021.cjs` saved an image-only change through the installed Coolify API with `instant_deploy: false`. Staging identity, domain and exact raw compose round-trip were checked.

The matching `operations/gse-staging-php-security-20261021.override.yml` was copied into the protected recovery directory. The existing generated service compose plus this override was resolved and compared programmatically; the only difference was the WordPress image. Deployment used `docker compose up -d --no-deps --pull never wordpress` scoped explicitly to staging's compose project.

Important: the current on-disk generated compose still requires that override until Coolify regenerates it from the saved, pinned configuration. Do not run the old generated compose alone. Normal future Coolify deployments should use the pinned image stored in Coolify; verify before deploying. Database image was not pulled or recreated.

Rollback is a last-resort staging recovery, not a security fix: use the protected pre-update configuration and exact old image ID from the saved inspection, scoped to WordPress only. The old image is vulnerable. Do not restore the database/files merely to reverse a runtime image change.

## Completed automated checks

- Before and after HTTP 200: `/`, `/about/`, `/contact/`, `/ways-to-give/donate/`, `/events/`, `/assistance/`, `/wp-login.php`, `/wp-json/`.
- Running container PHP is 8.3.36; Docker health is healthy.
- PHP extension list exactly matches baseline.
- WordPress version file and wp-config checksums match; PHP files at the recorded plugin/theme depth match. This is not a full recursive code integrity audit.
- Existing limits retained: memory 1024M, post/upload 4G. Shared configuration was not changed.
- No PHP fatal/parse errors, warnings, uncaught errors or segmentation faults matched in the new container's logs during verification. This is not exhaustive incident detection.
- Browser homepage title is `Home | Garden State Equality`; no visible WordPress critical/database/fatal error message. Not every image, interaction or layout was validated.
- Production homepage returned HTTP 200; production runtime/container unchanged.

## Human acceptance checklist (staging now; repeat after production patch)

1. Hard-refresh the homepage on desktop and mobile. Check header/footer, navigation, dropdowns, carousel, images and styling.
2. Open About, Contact, Events, Assistance and Donate. Check real content and any embedded forms/maps/widgets.
3. Sign into wp-admin. Under Tools → Site Health → Info → Server, confirm PHP **8.3.36** (or a later patched 8.3 release).
4. Open an existing page in its normal editor/Elementor and preview it. If saving is needed, use an explicitly disposable staging draft; do not alter production content.
5. Upload a disposable small image and verify it renders. Remove the test image/draft afterward if unused.
6. Check search and any site-specific interactive features.
7. Coordinate form/email testing: verify recipient routing first, then use clearly marked test data. Do not send real constituent data, create live subscriptions or make real donations. Test payments only through confirmed sandbox integration.
8. Report any regression with the URL, action and screenshot. Compare with production for reference, recognizing staging content can differ.

Production is complete only after its own fresh backup, verified runtime deployment, repeat technical checks and acceptance checks. Staging success alone does not patch production or prove a zero-downtime production cutover is ready.