# Database Backup Baseline Policy

## Purpose

Define the intended baseline for database backup coverage across Coolify resources and document current coverage gaps discovered in production.

## Baseline Policy

All production databases must have automatic scheduled backups enabled by default.

This includes:
- Standalone PostgreSQL databases
- Standalone MariaDB databases
- Standalone MySQL databases
- WordPress-related MariaDB databases used by WordPress stacks

Jongo behavior for this phase is read-only telemetry and discovery:
- Detect databases with schedules
- Detect databases missing schedules
- Surface coverage honestly in the Backups page
- Do not create/modify schedules automatically
- Do not trigger backup execution, restore, or download actions

## Provisioning Audit (Current State)

Audit source: Coolify metadata database on host 5.78.216.68 (read-only SQL), May 22, 2026.

### Standalone Database Resources

- `standalone_postgresqls`: 5 resources
- `standalone_mariadbs`: 0 resources
- `standalone_mysqls`: 0 resources

### Scheduled Backup Records

- `scheduled_database_backups`: 4 rows
- `database_type` values found: `App\\Models\\StandalonePostgresql` only
- Frequency in all rows: `0 2 * * *` (nightly)
- Recent `scheduled_database_backup_executions`: successful runs at ~02:00 UTC

### PostgreSQL Coverage

Scheduled:
- Jongo Database (`o4g2cpls648gnz0f1he7be7c`)
- pdb_empowermaps_prod (`ydnuc6ifqktex1ynhcj68ekl`)
- pdb-joyfeed-web-prod (`bqijvhpgw7oyffopprd2lgri`)
- pdb-jongo-saas-prod (`zryvz7rg5bf0yqpwn9rata3d`)

Missing schedule:
- postgresql-database-cscci97wrijxgjcfs1gyvm75 (`cscci97wrijxgjcfs1gyvm75`)

### WordPress Stack Provisioning

WordPress sites are provisioned as `services` rows with `service_type=wordpress-with-mariadb`, not as `standalone_mariadbs` rows.

Examples:
- GimmePower.com
- aptennis.org
- waterfallkeepersofnc-org
- wptest.manifest-fts.com

Because these are embedded MariaDB containers inside a service stack (not standalone database resources), they do not receive entries in `scheduled_database_backups` by default.

## Why PostgreSQL Gets Schedules But WordPress MariaDB Does Not

- Scheduled backup records currently target standalone DB model types.
- Existing schedule rows target `App\\Models\\StandalonePostgresql`.
- WordPress MariaDB in this environment is provisioned through `services` (`wordpress-with-mariadb`) rather than standalone MariaDB resources.
- Therefore there is no automatic per-database schedule row created for those WordPress MariaDB instances.

## Jongo Telemetry Outcome In This Pass

Backups page now reports:
- Database coverage list with explicit `scheduled` vs `missing schedule`
- Engine/source context (`standalone` vs `embedded service`)
- Honest missing-schedule visibility for WordPress embedded MariaDB services

No schedule mutation or restore/download execution is performed by Jongo in this pass.

## Remediation Applied May 22, 2026

WordPress MariaDB service databases now have nightly backup schedules configured in Coolify for:

- `wptest.manifest-fts.com` database `d2943omhh8gifkyzkkgiob72`
- `GimmePower.com` database `gjfq7vaits5nftb6e62pgp33`
- `aptennis.org` database `kelari7f3wo2v9pgsosdomky`
- `waterfallkeepersofnc-org` database `wk9x29gknkj27wpebvo1y2yo`

Applied baseline:

- frequency: `0 2 * * *`
- local retention days: `7`
- local retention amount: `7`
- database selection: `wordpress`
- local backup only (`save_s3=false`)

## Coolify Hotfix Notes

The running Coolify instance required two server-side hotfixes before service-database backups could be managed and read correctly:

1. `queryDatabaseByUuidWithinTeam()` did not resolve `ServiceDatabase` UUIDs for API routes.
2. backup lookup queries in `DatabasesController` filtered only by `database_id`, which caused collisions between `ServiceDatabase` IDs and standalone database IDs.

These hotfixes were applied directly on the Coolify server so that:

- `GET /api/v1/databases/{uuid}/backups` works for service databases
- Jongo can inspect service-database backup telemetry through the normal Coolify API path
- backup lookups are scoped by both `database_id` and `database_type`

Because these are server-side hotfixes outside the repository, they must be preserved or upstreamed before the next Coolify image replacement or upgrade.

## Follow-Up (Out of Scope For This Pass)

- Decide operational standard for WordPress MariaDB backup coverage:
  - Option A: Provision WordPress DB as standalone MariaDB resources and enforce schedule creation
  - Option B: Keep embedded service model and add explicit schedule creation workflow in Coolify for each WordPress service
- Add an operator runbook for creating/enforcing MariaDB schedules during WordPress onboarding
- Add automated drift checks that flag any production DB without an active schedule
