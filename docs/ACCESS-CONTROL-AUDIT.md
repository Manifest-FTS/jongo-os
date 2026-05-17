# Access Control Audit

Date: 2026-05-17
Scope: tenant isolation for clients/apps, direct URL access, and repository/query fallback behavior.

## Summary

Critical issue confirmed and fixed: scoped users could receive global tenant data when repository queries fell back to mock/Coolify paths, and app detail helpers did not consistently enforce viewer-based access checks.

Key outcomes:
- Client/app listings are now tenant-scoped for non-platform-admin users.
- App collaborators can see only their assigned app(s) even without client-level membership.
- Direct URL access to unrelated app pages now returns not found.
- Platform settings page is now restricted to platform admin.
- Fallback behavior for scoped users now fails closed (empty/not found), not open.

## Data Model Audit

Entities reviewed:
- User: identity and credentials (`User`)
- Client account: organization (`Organization`)
- App: site (`Site`)
- Client membership: organization collaborator (`Collaborator`)
- App membership: site collaborator (`SiteCollaborator`)
- Invitation scope: organization/site invite type (`Invitation.inviteType`)

Membership semantics:
- Client-level membership (`Collaborator`) grants access to that client and all apps under it.
- App-level membership (`SiteCollaborator`) grants access only to that app.
- Platform admin is represented by `BOOTSTRAP_ADMIN_EMAIL` matching the session email.

## Role/Access Matrix

| Viewer Type | Clients List | Apps List | Client Detail | App Detail | Platform Settings |
|---|---|---|---|---|---|
| Platform admin | All | All | Any | Any | Allowed |
| Client admin/member | Owned/member clients only | All apps under owned/member clients | Owned/member client only | Apps under owned/member clients | Denied |
| App collaborator | None (unless also client member) | Assigned app(s) only | Denied (unless also client member) | Assigned app(s) only | Denied |

## Findings and Fixes

### 1) Repository fail-open fallback (critical)

Finding:
- Scoped viewers could receive global mock/Coolify records when DB/scoped query paths failed.

Fix:
- For scoped viewers, fallback now returns empty collections or not found.
- Global fallback is only retained for non-scoped/system contexts.

Updated area:
- `apps/web/src/lib/repositories.ts`

### 2) App-level collaborator visibility gap

Finding:
- App directory filtering used only organization ownership/collaboration; site collaborators were excluded.

Fix:
- Site directory filters now include:
  - org ownership/collaboration OR
  - site collaborator membership

Updated area:
- `apps/web/src/lib/repositories.ts`

### 3) Direct app URL access not consistently scoped

Finding:
- App workspace/deploy/activity helpers did not consistently accept viewer context.

Fix:
- Added viewer-aware scoping to:
  - `getSiteWorkspace(siteId, viewer?)`
  - `listSiteDeployments(siteId, viewer?)`
  - `getSiteActivityFeed(siteId, limit, viewer?)`
- Wired viewer context from authenticated session in app/client pages.
- Unauthorized app access now resolves to not found.

Updated areas:
- `apps/web/src/lib/repositories.ts`
- `apps/web/src/app/(platform)/sites/[siteId]/*`
- `apps/web/src/app/(platform)/clients/[clientId]/*`

### 4) Site API access for app collaborators

Finding:
- Some site API routes only considered organization membership.

Fix:
- Added site-collaborator access in relevant site routes for read/access context loading.

Updated areas:
- `apps/web/src/app/api/sites/[siteId]/route.ts`
- `apps/web/src/app/api/sites/[siteId]/collaborators/route.ts`
- `apps/web/src/app/api/sites/[siteId]/collaborators/invitations/[invitationId]/route.ts`

### 5) Platform settings visibility

Finding:
- Platform settings page was visible to non-platform-admin users.

Fix:
- Page now returns not found unless current session email matches `BOOTSTRAP_ADMIN_EMAIL`.

Updated area:
- `apps/web/src/app/(platform)/settings/page.tsx`

## Local Dev Fallback Behavior

Current hardened behavior:
- For scoped viewers, repository fallback paths are fail-closed.
- Dev convenience/global fallback paths remain available only where scope is not being applied.
- Production behavior remains unaffected by dev auth bypass logic in `auth.config.ts` (`NODE_ENV !== production` guard).

## Runtime Validation Matrix

| Scenario | Expected Result | Status |
|---|---|---|
| Invited app collaborator views app list | Only assigned app(s) visible | Implemented |
| Invited app collaborator opens unrelated app URL | Not found | Implemented |
| Invited client member views clients list | Only member/owned client(s) visible | Implemented |
| Invited client member views apps list | Only apps under member/owned client(s) visible | Implemented |
| Platform admin views clients/apps | Full visibility | Implemented |
| Non-admin opens platform settings | Not found | Implemented |
| Scoped query failure fallback | Empty/not found (no global data leak) | Implemented |

## Notes

- This pass intentionally focuses on authorization scoping and tenant isolation only.
- No unrelated feature work was added.
