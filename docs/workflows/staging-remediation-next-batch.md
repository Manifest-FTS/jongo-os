# Staging Remediation Next Batch

Generated: 2026-05-25T02:43:51.709Z
Source queue: docs/workflows/staging-remediation-queue-latest.md
Batch size: 3

## Current Blocker Snapshot

- Missing staging detection: 13
- Application targets missing staging: 7
- Missing staging only (no backup blocker): 7
- Missing staging + backup blocker: 6

## Recommended Next Manual Batch

Selection rule: prioritize application resources blocked only on staging detection, because they are the shortest path to first real promote validation.

- joyfeed-app (application; service=gyn7ag00fyb4g9fydnggxt92, project=cplzvcszywes0ayod4jk4hme, envs=production)
- fts-branding-guide (application; service=qs8dtldmyaubydle9z34vqiq, project=ip1hwipx8sn24rd0dni67lb0, envs=production)
- airbb-wordpress (application; service=lammq9t83cwkiyjei935dq70, project=mjynfwh1sdxqciadxglgfr9o, envs=production)

## Manual Steps

1. In Coolify, create/attach staging for each app in the recommended batch.
2. If the app also has backup blocker, configure at least one automated backup schedule.
3. Run `npm run ops:refresh-staging-remediation:strict` and verify delta/smoke artifacts.
