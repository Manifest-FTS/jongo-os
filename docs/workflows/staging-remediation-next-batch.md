# Staging Remediation Next Batch

Generated: 2026-05-26T01:13:47.908Z
Source queue: docs/workflows/staging-remediation-queue-latest.md
Batch size: 3

## Current Blocker Snapshot

- Missing staging detection: 13
- Application targets missing staging: 0
- Missing staging only (no backup blocker): 0
- Missing staging + backup blocker: 13
- Preferred trigger-path smoke target: waterfallkeepersofnc-org

## Trigger-Path Policy

- Keep trigger-path promote validation on waterfallkeepersofnc-org for this pass.
- joyfeed-app remains non-default for trigger-path smoke and should only be used as an explicit override.

## Recommended Next Manual Batch

Selection rule: all remaining apps include backup blockers, so this batch minimizes count only.
Preferred trigger target included in this batch: yes

- waterfallkeepersofnc-org (unknown; service=oqcc7xm49tb98otptx9ymtx7, project=cx7ldowl163oc24u2tqsbzuq, envs=-)
- jongo-open-source (unknown; service=dt0v391xre5rgtp50062tunm, project=ip1hwipx8sn24rd0dni67lb0, envs=-)
- millenion-fitness (unknown; service=c2mqv1xjksrkg2wn6eglw3u6, project=sndclvrx7rwe3zii9sm1fdt2, envs=-)

## Manual Steps

1. In Coolify, create/attach staging for each app in the recommended batch.
2. If the app also has backup blocker, configure at least one automated backup schedule.
3. Run `npm run ops:refresh-staging-remediation:strict` and verify delta/smoke artifacts.
