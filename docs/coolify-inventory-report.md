# Coolify Inventory Report

This report treats Coolify as source of truth and compares Jongo DB rows against live resources.

## Why this exists

- Show a clean list of live resources that should appear in Jongo.
- Hide staging resources from directory visibility (staging is managed from the production app).
- Flag stale DB-only entries where `coolifyServiceUuid` no longer exists in Coolify.

## Run

```bash
npm run ops:inventory-report
```

## Useful options

```bash
npm run ops:inventory-report -- --json
npm run ops:inventory-report -- --out docs/reports/inventory.json
npm run ops:inventory-report -- --stale-days 14
```

## Output sections

- `liveVisibleResources`: live non-staging Coolify resources (what directory views should show).
- `liveHiddenStagingResources`: live staging counterparts (hidden from directory list).
- `stagingSingletons`: staging resources without a clear production pair in the same project.
- `dbStaleMappings`: DB rows with `coolifyServiceUuid` not found in live Coolify.
- `reviewRemovalCandidates`: stale mappings missing for at least `--stale-days`.

## Interpretation

- If `dbStaleMappings` is non-empty, those rows should be reviewed for remap or removal.
- If `stagingSingletons` is non-empty, staging pairing logic likely needs remediation in Coolify or mapping sync.
- `coolifyVisibleTotal` should align with expected app count in Jongo directory views.
