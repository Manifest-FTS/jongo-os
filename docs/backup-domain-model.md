# Backup Domain Model

## Purpose

Define the backup layers Jongo must distinguish before any WordPress file/media backup or restore UX is added.

The operator-facing presentation contract lives in [backup-read-model.md](backup-read-model.md).

## Backup Layers

### 1. Database Backup

- Database dump, schedule, and execution history
- Current Jongo telemetry already covers supported Coolify database resources
- For WordPress, this covers content, settings, users, and plugin data stored in the database

### 2. WordPress Files/Media Backup

- `wp-content/uploads`
- site-specific `wp-content` files
- optional themes/plugins if they are not Git-managed
- separate from database backup
- required for full WordPress site restore or staging clone workflows

### 3. Code/Source Backup

- Git-based apps already have source backup in GitHub or another Git provider
- Jongo should not duplicate this in the backup UX

### 4. Server Snapshot / Disaster Recovery

- Hetzner snapshots, server images, or restic-based whole-server recovery
- useful for infrastructure recovery
- not the same as app-level restore

### 5. Offsite Replication

- Backblaze B2 or compatible S3 storage
- local backup existence alone is not enough for disaster recovery
- backup is not fully protected until offsite copy/replication succeeds

## Intended Offsite Policy

- All production database backups should be replicated offsite to Backblaze B2 or compatible S3 storage.
- Future WordPress file/media backups should also replicate offsite.
- Jongo should eventually surface both local backup status and offsite replication status.

## Naming Direction for Offsite Backups

Prefer human-identifiable object prefixes where possible:

```text
backups/{environment}/{clientSlug}/{appSlug}/{backupType}/{YYYY}/{MM}/{DD}/
```

Examples:

```text
backups/production/manifest-fts/jongo-open-source/database/2026/05/22/
backups/production/community-catalyst/cc-empowermaps/database/2026/05/22/
backups/production/kevin-adams/waterfallkeepersofnc-org/wp-uploads/2026/05/22/
```

If the underlying technology uses opaque restic or deduplicated object names, Jongo must maintain metadata mapping:

- opaque backup ID
- client/app/type/timestamp/status/provider

## Questions Jongo Should Answer

- What is backed up?
- Is it local only or offsite replicated?
- What app/client does this backup belong to?
- Can it restore app-level data, files, or whole-server state?
- Is it safe to create staging from this backup?

For the UI-facing answer structure, see [backup-read-model.md](backup-read-model.md).

## Scope Boundary For This Pass

This document is descriptive only.

- No runtime behavior changes
- No backup execution changes
- No restore execution changes
- No schedule mutation changes