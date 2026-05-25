# Staging Remediation Queue (Latest)

Generated: 2026-05-25T23:53:03.815Z
Base URL: http://localhost:3000

## Summary

- Linked apps scanned: 13
- Missing staging detection: 13
- Backup blocker present: 13

## Queue

| App | Resource Kind | Coolify Service UUID | Coolify Project ID | Project Environments | Staging detected | Staging App UUID | Capability Note | Blockers | Suggested actions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jongo-open-source | unknown | dt0v391xre5rgtp50062tunm | ip1hwipx8sn24rd0dni67lb0 | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| millenion-fitness | unknown | c2mqv1xjksrkg2wn6eglw3u6 | sndclvrx7rwe3zii9sm1fdt2 | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| daniel-kane | unknown | f12mcnqyxf3gtlb04zjsil0u | ank4te9xzy8nz96ivyot1aoj | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| a3th9r | unknown | dbv03lhfksfllfs2vk62p1dt | ank4te9xzy8nz96ivyot1aoj | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| freebling-app | unknown | cgp8wmgqvzwc7nehjli9s0tj | ubw2fq966nic1bm0uwhq2bv5 | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| fts-branding-guide | unknown | qs8dtldmyaubydle9z34vqiq | ip1hwipx8sn24rd0dni67lb0 | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| joyfeed-app | unknown | gyn7ag00fyb4g9fydnggxt92 | cplzvcszywes0ayod4jk4hme | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| cc-empowermaps | unknown | ohvcryeup93rm9xqr9g3nhhw | kan91vl6yh1h3uoqeboy607f | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| waterfallkeepersofnc-org | unknown | oqcc7xm49tb98otptx9ymtx7 | cx7ldowl163oc24u2tqsbzuq | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| airbb-wordpress | unknown | lammq9t83cwkiyjei935dq70 | mjynfwh1sdxqciadxglgfr9o | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| aptennis-org | unknown | m7qt76qb6d34oenuxota22gd | k7u18iei0b0eins87vanw2la | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| wptest-manifest-fts-com | unknown | dohwcjwofkptbb0vh805pts7 | o13kbzvaogmna0xsiyc0lsgx | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |
| gimmepower-com | unknown | aifttansk4u44zt9skk27z95 | r2xilwqzu783mielcngrm0tb | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backups not configured. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Configure at least one automated backup schedule in Coolify. |

## Immediate Ops Steps

1. For rows with `Staging detected = no`, create or attach staging in Coolify using the listed service/project identifiers.
2. For rows with `Backups not configured`, add at least one automated backup schedule in Coolify.
3. Re-run strict smoke and regenerate this queue after each remediation batch.