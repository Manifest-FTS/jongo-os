# Staging Remediation Queue (Latest)

Generated: 2026-05-24T18:13:20.571Z
Base URL: http://localhost:3000

## Summary

- Linked apps scanned: 13
- Missing staging detection: 13
- Backup blocker present: 6

## Queue

| App | Coolify Service UUID | Coolify Project ID | Staging detected | Staging App UUID | Blockers | Suggested actions |
| --- | --- | --- | --- | --- | --- | --- |
| freebling-app | cgp8wmgqvzwc7nehjli9s0tj | ubw2fq966nic1bm0uwhq2bv5 | no | - | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| joyfeed-app | gyn7ag00fyb4g9fydnggxt92 | cplzvcszywes0ayod4jk4hme | no | - | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| millenion-fitness | c2mqv1xjksrkg2wn6eglw3u6 | sndclvrx7rwe3zii9sm1fdt2 | no | - | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| daniel-kane | f12mcnqyxf3gtlb04zjsil0u | ank4te9xzy8nz96ivyot1aoj | no | - | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| a3th9r | dbv03lhfksfllfs2vk62p1dt | ank4te9xzy8nz96ivyot1aoj | no | - | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| jongo-open-source | dt0v391xre5rgtp50062tunm | ip1hwipx8sn24rd0dni67lb0 | no | - | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| fts-branding-guide | qs8dtldmyaubydle9z34vqiq | ip1hwipx8sn24rd0dni67lb0 | no | - | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| cc-empowermaps | ohvcryeup93rm9xqr9g3nhhw | kan91vl6yh1h3uoqeboy607f | no | - | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| waterfallkeepersofnc-org | oqcc7xm49tb98otptx9ymtx7 | cx7ldowl163oc24u2tqsbzuq | no | - | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| airbb-wordpress | lammq9t83cwkiyjei935dq70 | mjynfwh1sdxqciadxglgfr9o | no | - | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| aptennis-org | m7qt76qb6d34oenuxota22gd | k7u18iei0b0eins87vanw2la | no | - | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| wptest-manifest-fts-com | dohwcjwofkptbb0vh805pts7 | o13kbzvaogmna0xsiyc0lsgx | no | - | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |
| gimmepower-com | aifttansk4u44zt9skk27z95 | r2xilwqzu783mielcngrm0tb | no | - | No staging environment/application is currently detected in Coolify. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported. |

## Immediate Ops Steps

1. For rows with `Staging detected = no`, create or attach staging in Coolify using the listed service/project identifiers.
2. For rows with `Backups not configured`, add at least one automated backup schedule in Coolify.
3. Re-run strict smoke and regenerate this queue after each remediation batch.