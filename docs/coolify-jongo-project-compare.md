# Coolify vs Jongo Project Compare

This compares Jongo DB site rows against live Coolify resources by mapped Coolify project.

## Run all mapped projects

```bash
npm run ops:compare-projects
```

## Run one client/project

```bash
npm run ops:compare-projects -- --client "Garden State Equality"
npm run ops:compare-projects -- --client cnlnv9gsriufoh4i4mtknlez
```

## JSON output

```bash
npm run ops:compare-projects -- --client "Garden State Equality" --json
```

## What it reports

- `matched`: same Coolify UUID exists in both Jongo and Coolify
- `staleJongoOnly`: Jongo row points at a UUID not present in the mapped Coolify project
- `missingFromJongo`: live Coolify resource exists in the project but has no Jongo row
- `duplicateJongoRows`: multiple Jongo rows share the same Coolify UUID

## Current use

Use this before deleting stale rows or importing missing ones. It is meant to surface sync drift clearly enough to remediate project by project.
