# Production Stability + Insert-Only Sync Pass (2026-05-17)

Scope:
- Confirm production inventory stability from a stable env checkpoint.
- Execute insert-only Site sync.
- Do not overwrite existing mappings.
- Produce ambiguity review list when ownership is unclear.
- Re-run access-control matrix checks.

## 1) Stability confirmation (source-level)

Environment/runtime checkpoint:
- BOOTSTRAP_ADMIN_EMAIL=devkev@manifestfts.com
- COOLIFY_OVERVIEW_TTL_MS=5000
- COOLIFY_DEPLOYMENT_SAMPLE_LIMIT=6
- Deployed image: da2c3a92b72b87f486ac991a3d791755f2d6f3f5

Repeated inventory checks from app container:
- /api/v1/resources run 10 times: all responses 200 with count 37
- /api/v1/applications: 200 count 29
- /api/v1/services: 200 count 3
- /api/v1/databases: 200 count 5

Interpretation:
- Inventory source is stable at the API layer during repeated checks.

## 2) Why 28 total but 27 healthy

Status classification probe result:
- healthy=36
- degraded=0
- error=0
- unknown=1
- total=37

Unknown item sample:
- type=application
- name=Reviiba
- raw_status=restarting:unknown

Interpretation:
- The missing app from healthy/degraded/error is in unknown state, not currently mapped to degraded/error buckets.
- This behaves like restarting/offline-or-transient status.

## 3) Insert-only Site sync outcome

Process:
- Built deterministic ownership matches from Coolify app -> project mapping.
- Matched only when project UUID/name aligns to existing Organization project mapping metadata.
- Insert-only behavior: never update or delete existing Site mappings.

Results:
- apps_total=29
- insert_candidates=0
- ambiguous_or_unmapped=29
- inserted=0
- skipped_existing=0
- post-sync Site count remains 0

No data was overwritten. No records were deleted.

## 4) Ownership ambiguity review

Bucket summary:
- 13: mjynfwh1sdxqciadxglgfr9o / FTS Ventures
- 4: aekzcd1j05ww7k2x9jflz2md / Uncategorized
- 2: or5w30fmspea7tmc4t7zs813 / Umar Farooq
- 2: hf52bk9lwmy0usbys9s10pbf / Rudy Zeigler
- 2: ank4te9xzy8nz96ivyot1aoj / Daniel Kane
- 2: ip1hwipx8sn24rd0dni67lb0 / Manifest FTS
- 1: ubw2fq966nic1bm0uwhq2bv5 / Emile De Meyer
- 1: cplzvcszywes0ayod4jk4hme / JoyFeed
- 1: sndclvrx7rwe3zii9sm1fdt2 / Millenion Fitness
- 1: kan91vl6yh1h3uoqeboy607f / Community Catalyst

Full raw review source exported during run:
- /tmp/jongo-sync/review_ambiguous.tsv (production host)

## 5) Access-control matrix rerun after sync attempt

Evidence snapshot:
- BOOTSTRAP_ADMIN_EMAIL is set to devkev@manifestfts.com.
- org_count=2, site_count=0, site_collab_count=0.
- lot6six member visibility remains scoped to one org (Kevin Adams).
- unrelated org remains not visible to lot6six (Christian Fuscarino).
- accepted invitations remain organization/collaborator scope.

Pass/fail summary (post-sync attempt):
- Platform admin detection: PASS
- Client member org scoping: PASS
- Direct unauthorized visibility prevention: PASS (no regressions observed)
- Platform admin all apps visible: BLOCKED by zero Site mappings + unresolved ownership assignments
- App-collaborator matrix items: BLOCKED by zero Site/SiteCollaborator fixtures

## Notes

- This pass intentionally performed no ownership guesses.
- Sync remained insert-only and non-destructive.
- Next required input: explicit project->organization mapping decisions for the ambiguous buckets.
