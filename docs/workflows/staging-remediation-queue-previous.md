# Staging Remediation Queue (Latest)

Generated: 2026-05-25T02:43:20.622Z
Base URL: http://localhost:3000

## Summary

- Linked apps scanned: 13
- Missing staging detection: 13
- Backup blocker present: 6

## Queue

| App | Resource Kind | Coolify Service UUID | Coolify Project ID | Project Environments | Staging detected | Staging App UUID | Capability Note | Blockers | Suggested actions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jongo-open-source | unknown | dt0v391xre5rgtp50062tunm | ip1hwipx8sn24rd0dni67lb0 | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| daniel-kane | application | f12mcnqyxf3gtlb04zjsil0u | ank4te9xzy8nz96ivyot1aoj | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| a3th9r | application | dbv03lhfksfllfs2vk62p1dt | ank4te9xzy8nz96ivyot1aoj | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| freebling-app | application | cgp8wmgqvzwc7nehjli9s0tj | ubw2fq966nic1bm0uwhq2bv5 | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| joyfeed-app | application | gyn7ag00fyb4g9fydnggxt92 | cplzvcszywes0ayod4jk4hme | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| fts-branding-guide | application | qs8dtldmyaubydle9z34vqiq | ip1hwipx8sn24rd0dni67lb0 | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| cc-empowermaps | unknown | ohvcryeup93rm9xqr9g3nhhw | kan91vl6yh1h3uoqeboy607f | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| millenion-fitness | application | c2mqv1xjksrkg2wn6eglw3u6 | sndclvrx7rwe3zii9sm1fdt2 | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| waterfallkeepersofnc-org | service | oqcc7xm49tb98otptx9ymtx7 | cx7ldowl163oc24u2tqsbzuq | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| airbb-wordpress | application | lammq9t83cwkiyjei935dq70 | mjynfwh1sdxqciadxglgfr9o | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| aptennis-org | service | m7qt76qb6d34oenuxota22gd | k7u18iei0b0eins87vanw2la | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| wptest-manifest-fts-com | service | dohwcjwofkptbb0vh805pts7 | o13kbzvaogmna0xsiyc0lsgx | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| gimmepower-com | service | aifttansk4u44zt9skk27z95 | r2xilwqzu783mielcngrm0tb | production | no | - | project_only_has_production_environment | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |

## Immediate Ops Steps

1. For rows with `Staging detected = no`, create or attach staging in Coolify using the listed service/project identifiers.
2. For rows with `Backups not configured`, add at least one automated backup schedule in Coolify.
3. Re-run strict smoke and regenerate this queue after each remediation batch.