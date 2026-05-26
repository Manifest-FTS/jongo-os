# Staging Remediation Queue (Latest)

Generated: 2026-05-26T13:07:21.584Z
Base URL: http://localhost:3000

## Summary

- Linked apps scanned: 13
- Missing staging detection: 8
- Backup blocker present: 6
- Preferred trigger-path smoke target: waterfallkeepersofnc-org

## Trigger-Path Policy

- Use waterfallkeepersofnc-org for promote trigger-path smoke during this operational pass.
- Do not use joyfeed-app as a default trigger target. It is diagnostic-only unless explicitly overridden.

## Queue

| App | Resource Kind | Coolify Service UUID | Coolify Project ID | Project Environments | Staging detected | Staging App UUID | Capability Note | Blockers | Suggested actions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fts-branding-guide | application | qs8dtldmyaubydle9z34vqiq | ip1hwipx8sn24rd0dni67lb0 | production, staging | yes | - | staging_environment_exists_no_application | Staging environment exists but no staging application target is attached yet. | Provision or attach a staging application in Coolify so sync and promote checks can target a concrete staging application. |
| millenion-fitness | application | c2mqv1xjksrkg2wn6eglw3u6 | sndclvrx7rwe3zii9sm1fdt2 | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| daniel-kane | application | f12mcnqyxf3gtlb04zjsil0u | ank4te9xzy8nz96ivyot1aoj | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| a3th9r | application | dbv03lhfksfllfs2vk62p1dt | ank4te9xzy8nz96ivyot1aoj | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| freebling-app | application | cgp8wmgqvzwc7nehjli9s0tj | ubw2fq966nic1bm0uwhq2bv5 | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| jongo-open-source | unknown | dt0v391xre5rgtp50062tunm | ip1hwipx8sn24rd0dni67lb0 | production, staging | yes | - | staging_environment_exists_no_application | Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Staging environment exists but no staging application target is attached yet.; Backup telemetry unavailable. | Verify COOLIFY_API_TOKEN scope, COOLIFY_API_BASE_URL reachability, and any Coolify allowlist/edge restrictions; then re-run staging preflight.; Provision or attach a staging application in Coolify so sync and promote checks can target a concrete staging application.; Verify Coolify API token scope, endpoint reachability/allowlist policy, and service-database backup endpoint access. |
| joyfeed-app | application | gyn7ag00fyb4g9fydnggxt92 | cplzvcszywes0ayod4jk4hme | production, staging | yes | ug7qdt8wfr2oiix5ucug1e9b | full_staging_detected | (none) | Run dry-run preflight checks and validate staging content before any manual promote/sync action in Coolify. |
| cc-empowermaps | unknown | ohvcryeup93rm9xqr9g3nhhw | kan91vl6yh1h3uoqeboy607f | production | no | - | project_only_has_production_environment | Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.; Backup telemetry unavailable. | Verify COOLIFY_API_TOKEN scope, COOLIFY_API_BASE_URL reachability, and any Coolify allowlist/edge restrictions; then re-run staging preflight.; Verify Coolify API token scope, endpoint reachability/allowlist policy, and service-database backup endpoint access. |
| waterfallkeepersofnc-org | service | oqcc7xm49tb98otptx9ymtx7 | cx7ldowl163oc24u2tqsbzuq | production, staging | yes | - | staging_environment_exists_no_application | Staging environment exists but no staging service target is attached yet. | Provision or attach a staging service in Coolify so sync and promote checks can target a concrete staging service. |
| airbb-wordpress | application | lammq9t83cwkiyjei935dq70 | mjynfwh1sdxqciadxglgfr9o | production, staging | yes | - | staging_environment_exists_no_application | Staging environment exists but no staging application target is attached yet. | Provision or attach a staging application in Coolify so sync and promote checks can target a concrete staging application. |
| aptennis-org | service | m7qt76qb6d34oenuxota22gd | k7u18iei0b0eins87vanw2la | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| wptest-manifest-fts-com | service | dohwcjwofkptbb0vh805pts7 | o13kbzvaogmna0xsiyc0lsgx | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| gimmepower-com | service | aifttansk4u44zt9skk27z95 | r2xilwqzu783mielcngrm0tb | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |

## Immediate Ops Steps

1. For rows with `Staging detected = no`, create or attach staging in Coolify using the listed service/project identifiers.
2. For rows with backup-related blockers, resolve telemetry access or backup schedule/readiness gaps in Coolify.
3. Re-run strict smoke and regenerate this queue after each remediation batch.