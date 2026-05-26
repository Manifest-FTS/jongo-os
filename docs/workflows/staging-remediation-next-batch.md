# Staging Remediation Next Batch

Generated: 2026-05-26T15:54:59.353Z
Source queue: docs/workflows/staging-remediation-queue-latest.md
Batch size: 3

## Current Blocker Snapshot

- Missing staging detection: 8
- Application targets missing staging: 4
- Missing staging only (no backup blocker): 3
- Missing staging + backup blocker: 5
- Preferred trigger-path smoke target: waterfallkeepersofnc-org

## Trigger-Path Policy

- Keep trigger-path promote validation on waterfallkeepersofnc-org for this pass.
- joyfeed-app remains non-default for trigger-path smoke and should only be used as an explicit override.

## Recommended Next Manual Batch

Selection rule: prioritize application resources first, even when backup blockers remain, because service-linked targets are less likely to support direct staging promotion.
Preferred trigger target included in this batch: no

- millenion-fitness (application; service=c2mqv1xjksrkg2wn6eglw3u6, project=sndclvrx7rwe3zii9sm1fdt2, envs=production)
- daniel-kane (application; service=f12mcnqyxf3gtlb04zjsil0u, project=ank4te9xzy8nz96ivyot1aoj, envs=production)
- a3th9r (application; service=dbv03lhfksfllfs2vk62p1dt, project=ank4te9xzy8nz96ivyot1aoj, envs=production)

## Manual Steps

1. In Coolify, create/attach staging for each app in the recommended batch.
2. If the app also has backup blockers, resolve telemetry access and/or backup schedule/readiness gaps.
3. Run `npm run ops:refresh-staging-remediation:strict` and verify delta/smoke artifacts.
