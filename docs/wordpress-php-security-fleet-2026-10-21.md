# WordPress PHP security fleet rollout — 2026-10-21

Completed October 22 UTC / October 21 US Eastern, following explicit operator authorization to update all staging and production WordPress sites.

## Result

All **16 WordPress services** in the configured Coolify inventory, matching all 16 running WordPress containers on `5.78.216.68`, now run **PHP 8.3.36** and report healthy. The known control-plane host `5.78.204.111` has no WordPress containers. No claim is made about unrelated hosts outside this inventory.

The pinned official image is `wordpress:php8.3-apache@sha256:f3e6835fa7d4a5b786615c24b67ec70816e06ebd517d31276bef423e49dfd126`. All 16 saved Coolify service application images were independently read back and matched this pin.

This operation replaces the PHP/Apache container image, not WordPress files, content, plugins or the database. Databases were not restarted. No forms, emails, payments or authenticated editorial workflows were tested by the automation. The operator successfully tested GSE staging frontend/admin beforehand.

## Backup and checks

Every newly replaced site received a files/configuration plus transaction-consistent database backup in offsite restic storage. Each database dump was read back from offsite storage and its SHA-256 compared with the local dump. Full restore rehearsals were not performed. Earlier GSE staging backup: `e98740dc`.

Protected server recovery root: `/data/coolify/backups/php-security-20261021-fleet`. Per-site subdirectories contain secret-bearing compose/inspect configuration, database dumps, resolved before/after facts, image override, offsite backup receipt and final result. Do not publish directory contents. Old exact images have `jongo-php-rollback:<resource UUID>` tags; they are vulnerable and retained only for emergency recovery.

Each replacement checked: PHP version, PHP extension parity, PHP limits, recorded version/config and plugin/theme PHP checksums, unchanged database container identity/start time, Docker health, homepage/login/REST baseline comparison, and no newly logged PHP fatal/parse errors or segmentation faults in the verification window. Checksums cover the recorded plugin/theme depth, not a full recursive forensic integrity audit.

Single-container replacements caused brief proxy transitions; zero downtime was not achieved or claimed. Two test-site attempts initially rolled back safely because curl retries writing to `/dev/null` reported unreachable after transient 503 responses. Switching to regular temporary output files enabled bounded retry verification; both sites subsequently passed. No new routing configuration was required.

## Sites and offsite snapshots

| Site/service | Snapshot | Final PHP |
|---|---|---|
| GSE active staging | e98740dc (prior pass) | 8.3.36 |
| gardenstateequality.staging.mfts.link | 490741d0 | 8.3.36 |
| testing.stage.mfts.link | a5b3ef3e | 8.3.36 |
| ttttttttt.manifest-fts.com | e5f9cddd | 8.3.36 |
| sushiapi.mfts.link | 95aae17e | 8.3.36 |
| www.gardenstateequality.org | 2a18bfb6 | 8.3.36 |
| Fucarino.com / fuscarino.manifest-fts.com | 72da4f5a | 8.3.36 |
| tomtomhomeimprovements.com | a9ae3f4a | 8.3.36 |
| sohps.org | f6287130 | 8.3.36 |
| gimmeepower.com | 5c5eb406 | 8.3.36 |
| aptennis.org | 0a8d0412 | 8.3.36 |
| waterfallkeepersofnc.org | 16976733 | 8.3.36 |
| Waterfall Keepers staging | f7fc91dd | 8.3.36 |
| teach.lgbt | 8c3bf189 | 8.3.36 |
| aptennis staging | 01a2ffb7 | 8.3.36 |
| gardenstateequality.education | 38c0e677 | 8.3.36 |

## Existing issues, not fixed by this operation

- `gardenstateequality.education/` returned **503 both before and after** its update, while login and REST returned 200. Healthy container status is not proof that this homepage works; investigate separately.
- `testing.stage.mfts.link/wp-login.php` has a pre-existing redirect loop; homepage and REST return 200.
- `gimmeepower.com/wp-login.php` returned 404 both before and after; may be intentional login hiding, not investigated here.
- GSE password-reset/transactional email transport is still unresolved. PHP patching does not configure SMTP.
- GSE initial CLI maintenance bootstrap encountered a MapSVG missing-schema error; full authenticated plugin workflows were not proven by this rollout. Operator frontend/admin smoke checks passed on staging.

GSE production final expanded check: homepage, About, Contact, Donate, Events, Assistance, login and REST all returned HTTP 200.

## Future deployment caution

The approved image is saved in Coolify, but the existing generated on-disk compose files can still reference the old image until Coolify regenerates them. Manual compose commands must include the protected image override; never run old generated compose alone. The scripts do not change the global `wordpress:latest` tag or future-site provisioning defaults. Newly created WordPress sites still require a verified patched runtime; that platform-default policy is separate work.

Operational helpers are under `operations/wordpress-php-security-20261021.py` and `operations/wordpress-php-security-20261021-api.cjs`. They are bounded maintenance artifacts, not a general automatic updater.