# Coolify vs Jongo Project Remediation

This script reconciles Jongo DB site rows against live Coolify project resources over SSH.

## What it does

- soft-deletes stale Jongo rows whose `coolifyServiceUuid` no longer exists in the mapped Coolify project
- collapses duplicate Jongo rows that share one Coolify UUID
- refreshes matched rows with the mapped Coolify project metadata
- imports missing live Coolify resources into Jongo
- skips staging-like resources from import so they do not reappear as standalone directory entries

## Dry-run

```bash
npm run ops:remediate-projects -- --client "Garden State Equality"
```

## Apply

```bash
npm run ops:remediate-projects -- --client "Garden State Equality" --apply
```

## Notes

- The script uses SSH access to the Coolify host and reads Coolify metadata from `coolify-db`.
- It is intended for project-by-project cleanup before broader automation.
- Staging-like resources are intentionally skipped from import because Jongo should expose staging through the production app workflow, not as standalone apps.
