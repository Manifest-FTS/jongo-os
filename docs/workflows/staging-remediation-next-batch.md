# Staging Remediation Next Batch

Generated: 2026-05-24T19:16:36.733Z
Source queue: docs/workflows/staging-remediation-queue-latest.md
Batch size: 3

## Current Blocker Snapshot

- Missing staging detection: 13
- Missing staging only (no backup blocker): 7
- Missing staging + backup blocker: 6

## Recommended Next Manual Batch

Selection rule: prioritize apps blocked only on staging detection to unlock trigger-path testing fastest.

- joyfeed-app (service=gyn7ag00fyb4g9fydnggxt92, project=cplzvcszywes0ayod4jk4hme)
- fts-branding-guide (service=qs8dtldmyaubydle9z34vqiq, project=ip1hwipx8sn24rd0dni67lb0)
- waterfallkeepersofnc-org (service=oqcc7xm49tb98otptx9ymtx7, project=cx7ldowl163oc24u2tqsbzuq)

## Manual Steps

1. In Coolify, create/attach staging for each app in the recommended batch.
2. If the app also has backup blocker, configure at least one automated backup schedule.
3. Run `npm run ops:refresh-staging-remediation:strict` and verify delta/smoke artifacts.
