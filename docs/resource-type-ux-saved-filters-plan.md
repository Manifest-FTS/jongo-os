# Resource Type UX + Saved Filters (Queued)

Status: Queued only. Do not start implementation until authenticated route validation is closed.

## Current Blocker (Crash-Fix Pass)

The crash fix is deployed and production logs show no new Prisma P2023 UUID parsing errors after deployment.

Remaining blocker for full crash-fix closure:
- Authenticated production route checks are still incomplete because there is no valid authenticated browser session available in this run.
- Unauthenticated checks are complete and clean (app URLs redirect to login with callback).

What is still required to close authenticated validation:
- Authenticated GET /apps/millenion-fitness loads without server exception.
- Authenticated GET /apps/jongo-webapp loads without server exception.
- Authenticated GET /apps/bgn-games loads as live-only/unmapped or a clean incomplete-mapping state.
- Mapping settings page smoke check under an authenticated production session.
- Apps visibility and dashboard/apps consistency check under an authenticated production session.

Manual browser validation can close this blocker quickly once a valid production login session is available.

## Next Planned Slice (Not Part of Crash-Fix Pass)

Title: Resource Type UX + Saved Filters

Goal:
Make Apps/Resources feel like a polished operations portal rather than a raw Coolify resource list.

Direction:
Use Coolify API metadata first to classify resource type. Do not guess when confidence is low.

Target type filters:
- WordPress
- Web App
- Database
- Service
- Mobile App (if detectable)
- Unknown/Other

Metadata priority for type detection:
- resource type
- image name
- build pack
- docker image
- git repo
- service/database/app endpoint category
- labels/tags (if available)

Classification rule:
- If type cannot be confidently detected, set Unknown/Other.
- Detection must be non-destructive and must not mutate source records.

UI/UX requirements:
- Add compact resource-type filter chips near status filters.
- Show resource type label/icon on cards and rows.
- WordPress should be visually recognizable with a WordPress-style mark when available.
- Database resources should have DB visual treatment and backup-oriented emphasis.
- Web app resources should surface domain, deployment status, and SSL/domain health where available.
- Keep presentation friendly and product-like; retain raw provider metadata under Developer Details.

Saved preferences:
- Persist per-user filter preferences and layout choice.
- Example preference payload to remember:
  - resource type filter
  - status filter
  - layout preference (grid/list)

Guardrails:
- Do not weaken tenancy/access scoping.
- Do not expose inaccessible resources.
- Do not overfit exclusively to WordPress.
- Keep type detection read-only.

Suggested implementation order:
1. Audit current Coolify metadata available for resource typing.
2. Add normalized resourceType in Jongo view model.
3. Add type labels/icons to cards/rows.
4. Add resource-type filter chips.
5. Add per-user saved view preferences.
6. Later: specialized WordPress/database workflows.

Validation criteria for this queued slice:
- Type-check passes.
- Build passes.
- Type filters work with mapped and live resources.
- Preferences persist per user.
- Admin sees all allowed resource types.
- Scoped users only see resources they can access.
