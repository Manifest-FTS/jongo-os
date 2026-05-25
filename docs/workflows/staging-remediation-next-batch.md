# Staging Remediation Next Batch

Generated: 2026-05-25T23:53:05.752Z
Source queue: docs/workflows/staging-remediation-queue-latest.md
Batch size: 3

## Current Blocker Snapshot

- Missing staging detection: 13
- Application targets missing staging: 0
- Missing staging only (no backup blocker): 0
- Missing staging + backup blocker: 13

## Recommended Next Manual Batch

Selection rule: all remaining apps include backup blockers, so this batch minimizes count only.

- jongo-open-source (unknown; service=dt0v391xre5rgtp50062tunm, project=ip1hwipx8sn24rd0dni67lb0, envs=-)
- millenion-fitness (unknown; service=c2mqv1xjksrkg2wn6eglw3u6, project=sndclvrx7rwe3zii9sm1fdt2, envs=-)
- daniel-kane (unknown; service=f12mcnqyxf3gtlb04zjsil0u, project=ank4te9xzy8nz96ivyot1aoj, envs=-)

## Manual Steps

1. In Coolify, create/attach staging for each app in the recommended batch.
2. If the app also has backup blocker, configure at least one automated backup schedule.
3. Run `npm run ops:refresh-staging-remediation:strict` and verify delta/smoke artifacts.
