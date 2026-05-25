# Staging Remediation Tracker (Latest)

Generated: 2026-05-25T02:43:50.602Z
Source queue: docs/workflows/staging-remediation-queue-latest.md

## Scope Summary

- Total apps in queue: 13
- Apps missing staging detection: 13
- Apps missing backups: 6

## Batch A: Staging Creation/Attach in Coolify

- [ ] jongo-open-source (unknown; service=dt0v391xre5rgtp50062tunm, project=ip1hwipx8sn24rd0dni67lb0)
- [ ] daniel-kane (application; service=f12mcnqyxf3gtlb04zjsil0u, project=ank4te9xzy8nz96ivyot1aoj)
- [ ] a3th9r (application; service=dbv03lhfksfllfs2vk62p1dt, project=ank4te9xzy8nz96ivyot1aoj)
- [ ] freebling-app (application; service=cgp8wmgqvzwc7nehjli9s0tj, project=ubw2fq966nic1bm0uwhq2bv5)
- [ ] joyfeed-app (application; service=gyn7ag00fyb4g9fydnggxt92, project=cplzvcszywes0ayod4jk4hme)
- [ ] fts-branding-guide (application; service=qs8dtldmyaubydle9z34vqiq, project=ip1hwipx8sn24rd0dni67lb0)
- [ ] cc-empowermaps (unknown; service=ohvcryeup93rm9xqr9g3nhhw, project=kan91vl6yh1h3uoqeboy607f)
- [ ] millenion-fitness (application; service=c2mqv1xjksrkg2wn6eglw3u6, project=sndclvrx7rwe3zii9sm1fdt2)
- [ ] waterfallkeepersofnc-org (service; service=oqcc7xm49tb98otptx9ymtx7, project=cx7ldowl163oc24u2tqsbzuq)
- [ ] airbb-wordpress (application; service=lammq9t83cwkiyjei935dq70, project=mjynfwh1sdxqciadxglgfr9o)
- [ ] aptennis-org (service; service=m7qt76qb6d34oenuxota22gd, project=k7u18iei0b0eins87vanw2la)
- [ ] wptest-manifest-fts-com (service; service=dohwcjwofkptbb0vh805pts7, project=o13kbzvaogmna0xsiyc0lsgx)
- [ ] gimmepower-com (service; service=aifttansk4u44zt9skk27z95, project=r2xilwqzu783mielcngrm0tb)

## Batch B: Backup Schedule Configuration in Coolify

- [ ] jongo-open-source (unknown; service=dt0v391xre5rgtp50062tunm, project=ip1hwipx8sn24rd0dni67lb0)
- [ ] daniel-kane (application; service=f12mcnqyxf3gtlb04zjsil0u, project=ank4te9xzy8nz96ivyot1aoj)
- [ ] a3th9r (application; service=dbv03lhfksfllfs2vk62p1dt, project=ank4te9xzy8nz96ivyot1aoj)
- [ ] freebling-app (application; service=cgp8wmgqvzwc7nehjli9s0tj, project=ubw2fq966nic1bm0uwhq2bv5)
- [ ] cc-empowermaps (unknown; service=ohvcryeup93rm9xqr9g3nhhw, project=kan91vl6yh1h3uoqeboy607f)
- [ ] millenion-fitness (application; service=c2mqv1xjksrkg2wn6eglw3u6, project=sndclvrx7rwe3zii9sm1fdt2)

## Notes

- Mark each item as completed in this tracker as Coolify changes are applied.
- After each batch, regenerate queue and smoke results:
  - npm run ops:export-staging-remediation-queue
  - npm run smoke:staging-promote
- Keep this tracker and the queue artifact in sync.