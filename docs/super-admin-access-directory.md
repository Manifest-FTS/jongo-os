# Super-admin access directory

## Purpose

`/super-admin/access` is a read-only inventory for authorized super admins to answer who can access the platform, each client and each app. Existing client/app team pages remain the workflows for changing tenant membership; this directory does not create a second grant-management surface.

## Authorization and data boundary

- The page and queries call the shared fresh-DB `isSuperAdminUser(userId)` check. Global admin, legacy `PlatformAdmin`, bootstrap technical access, tenant admin and collaborator roles are denied.
- User listing excludes soft-deleted accounts. Role counts include active accounts only.
- Global role and platform authority are separate fields. Platform authority explains whether it comes from `User.role` admin/super-admin, a revocable `PlatformAdmin` grant or `BOOTSTRAP_ADMIN_EMAIL`. The badge distinguishes super-admin billing authority from technical-only authority.
- Tenant access includes directly owned clients, active `Collaborator` memberships, and active `SiteCollaborator` grants. Client access states that it reaches all active apps in that client and gives the client app count. Direct app grants show their own scoped role and parent client.
- The second list shows only unaccepted, unrevoked, unexpired invitations to active clients; organization/site scope and scoped membership role are shown. Invite links, delivery errors, token hashes and secrets are omitted.
- Every user/invite query is paginated at 50 rows. Each user's client/app relations are capped at 20 each and visibly marked when truncated. Search is bounded to 200 characters. There are no raw Prisma object spreads.
- Password hashes, auth-provider IDs, per-user Stripe subscriptions, client billing details, tokens and credentials are never selected.

## Validation

- `npm run type-check`: passed.
- Focused `access-directory` and `rbac-navigation` suites: 9 tests passed.
- Full web suite: 1,148 passed; one existing copy-guard test fails on three unchanged strings in existing usage, unmapped-Coolify banner and staging-client copy.
- The API/query DTO is mock-tested; browser acceptance with representative production access fixtures remains recommended after deployment.
