# Staging Remediation Queue (Latest)

Generated: 2026-05-26T01:42:49.409Z
Base URL: http://localhost:3000

## Summary

- Linked apps scanned: 13
- Missing staging detection: 13
- Backup blocker present: 0
- Preferred trigger-path smoke target: waterfallkeepersofnc-org

## Trigger-Path Policy

- Use waterfallkeepersofnc-org for promote trigger-path smoke during this operational pass.
- Do not use joyfeed-app as a default trigger target. It is diagnostic-only unless explicitly overridden.

## Queue

| App | Resource Kind | Coolify Service UUID | Coolify Project ID | Project Environments | Staging detected | Staging App UUID | Capability Note | Blockers | Suggested actions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fts-branding-guide | unknown | qs8dtldmyaubydle9z34vqiq | ip1hwipx8sn24rd0dni67lb0 | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |
| jongo-open-source | unknown | dt0v391xre5rgtp50062tunm | ip1hwipx8sn24rd0dni67lb0 | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |
| cc-empowermaps | unknown | ohvcryeup93rm9xqr9g3nhhw | kan91vl6yh1h3uoqeboy607f | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |
| millenion-fitness | unknown | c2mqv1xjksrkg2wn6eglw3u6 | sndclvrx7rwe3zii9sm1fdt2 | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |
| daniel-kane | unknown | f12mcnqyxf3gtlb04zjsil0u | ank4te9xzy8nz96ivyot1aoj | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |
| a3th9r | unknown | dbv03lhfksfllfs2vk62p1dt | ank4te9xzy8nz96ivyot1aoj | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |
| freebling-app | unknown | cgp8wmgqvzwc7nehjli9s0tj | ubw2fq966nic1bm0uwhq2bv5 | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |
| joyfeed-app | unknown | gyn7ag00fyb4g9fydnggxt92 | cplzvcszywes0ayod4jk4hme | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |
| waterfallkeepersofnc-org | unknown | oqcc7xm49tb98otptx9ymtx7 | cx7ldowl163oc24u2tqsbzuq | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |
| airbb-wordpress | unknown | lammq9t83cwkiyjei935dq70 | mjynfwh1sdxqciadxglgfr9o | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |
| aptennis-org | unknown | m7qt76qb6d34oenuxota22gd | k7u18iei0b0eins87vanw2la | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |
| wptest-manifest-fts-com | unknown | dohwcjwofkptbb0vh805pts7 | o13kbzvaogmna0xsiyc0lsgx | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |
| gimmepower-com | unknown | aifttansk4u44zt9skk27z95 | r2xilwqzu783mielcngrm0tb | - | no | - | fetch_error | No staging environment/application is currently detected in Coolify.; Backup telemetry unavailable. | Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.; Verify Coolify API permissions for database backup endpoints and confirm service-database backup lookup support. |

## Immediate Ops Steps

1. For rows with `Staging detected = no`, create or attach staging in Coolify using the listed service/project identifiers.
2. For rows with `Backups not configured`, add at least one automated backup schedule in Coolify.
3. Re-run strict smoke and regenerate this queue after each remediation batch.