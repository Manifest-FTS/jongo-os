# Privacy Mode End-to-End Plan

## Current State

- The Overview Privacy Mode card now has a UI toggle for interaction testing.
- The toggle does not yet persist state or enforce access/content behavior.
- Collaborator view must avoid internal implementation status text or engineering notes.

## Desired Product Behavior

- Privacy Mode can be toggled by authorized users.
- When enabled, site visibility is restricted from public visitors/search crawlers.
- When disabled, normal public discovery resumes.
- UX should communicate visitor/search engine visibility in plain language.

## Jongo Backend Work Required

1. Data model and migration
- Add privacy mode fields to Site (example: `privacyModeEnabled`, `privacyModeUpdatedAt`, `privacyModeUpdatedByUserId`, `privacyModeProviderState`).
- Create Prisma migration and regenerate Prisma client.

2. API endpoints
- Add route: `GET/POST /api/sites/[siteId]/privacy-mode`.
- GET returns current persisted state + provider reconciliation state.
- POST/PATCH toggles persisted state and triggers provider update.
- Enforce authorization using existing site permission snapshot.

3. Audit and diagnostics
- Write audit log entries on toggle attempts and results.
- Surface reconciliation errors if provider state fails to apply.

4. UI wiring
- Replace local-only toggle state with API-backed state.
- Add loading, success, and error handling via global toasts.
- Keep collaborator-visible copy free of internal implementation notes.

## Coolify / Provider Enforcement Options

Privacy mode needs actual runtime enforcement beyond Jongo DB state.

1. WordPress-native visibility mode
- Use WordPress REST/CLI integration to change site visibility/search behavior.
- Best for search indexing control; may not block direct visitors by itself.

2. Upstream access gate (Flywheel-like)
- Apply edge/proxy auth or access restrictions in front of site traffic.
- Requires provider-level routing/reverse proxy configuration updates.
- Must support enable/disable rollout and rollback safely.

3. Recommended approach
- Persist privacy state in Jongo first.
- Implement provider adapter abstraction to support both:
  - WordPress visibility toggles
  - Proxy-level gating for stronger private-site behavior

## Rollout Phases

1. Phase 1: Persistence + API + UI wiring
- DB fields, API route, audit logs, and API-driven toggle UX.

2. Phase 2: Enforcement adapter
- Implement provider operations with retry and reconciliation state.

3. Phase 3: Operational hardening
- Background reconciliation jobs, alerting, and diagnostics panel entries.

## Environment/Config Inputs Likely Needed

- Provider API credentials or SSH access for runtime config changes.
- Optional per-environment enforcement mode flags.
- Optional default mode for newly created WordPress sites.

## Acceptance Checklist

- Toggle state persists and reloads correctly.
- Authorized users can toggle; unauthorized users cannot.
- Collaborator view contains no internal implementation status notes.
- Provider enforcement success/failure is visible in diagnostics/audit logs.
- Search/discovery behavior changes are validated after toggle operations.
