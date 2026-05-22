# Backup Read Model

## Purpose

Define the operator-facing fields Jongo should use when presenting backup state.

This is a display contract, not an execution contract.

## What Jongo Should Answer

- What is backed up?
- Is it local only or offsite replicated?
- What app/client does this backup belong to?
- Can it restore app-level data, files, or whole-server state?
- Is it safe to create staging from this backup?

## Display Dimensions

### Layer Type

Show the backup layer first:

- database
- files/media
- source
- snapshot
- offsite replica

### Ownership Context

Show stable resource labels next to the backup row:

- client
- app
- database or service resource name

### Locality

Show local and offsite as separate states:

- local scheduled
- local successful
- local failed
- offsite pending
- offsite replicated
- offsite unknown
- offsite failed

### Restore Scope

Show the highest restore scope the backup can support:

- database data
- files/media
- app-level state
- whole-server recovery

### Staging Safety

Show staging safety only when the restore scope is sufficient for the intended workflow.

- database-only backups are not full WordPress clone-safe
- files/media coverage is required for full site restore readiness
- offsite replication is required before calling a backup fully protected

## Source-of-Truth Rules

- Database telemetry is authoritative for database backup state.
- Offsite status is a distinct status dimension, not a hidden property of local backup success.
- Do not infer files/media coverage from database coverage.
- Do not infer whole-server recovery from app-level backup state.

## Scope Boundary

This document is descriptive only.

- No runtime behavior changes
- No backup execution changes
- No restore execution changes
- No schedule mutation changes