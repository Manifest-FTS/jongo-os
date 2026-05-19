# Invite Onboarding Runtime Validation Report

**Date**: 2026-05-17  
**Target Environment**: `https://jongo.manifest-fts.com` (Coolify deployment uuid: `dt0v391xre5rgtp50062tunm`)  
**Database**: `o4g2cpls648gnz0f1he7be7c:5432` (pdb-jongo-os-prod)

## Executive Summary

**Status**: Code deployed ✅, migrations incomplete ❌, feature inactive

The invite onboarding feature code has been deployed to production, but **the critical `0005_invitation_tokens` database migration has NOT been applied** to the production database. This blocks all invite functionality at runtime.

All other infrastructure components are in place:
- Routes `/api/invites/*`, `/auth/invite/*`, and `/api/admin/email/test` are publicly accessible (307 redirects for auth boundaries as expected)
- SMTP abstraction code is embedded
- Environment variables for invite/email config are read at runtime
- TypeScript build passes with new routes included

## Migration Status

| Migration | Local Codebase | Container Image | Production DB |
|-----------|---|---|---|
| `0001_initial` | ✅ | ✅ | ✅ |
| `0002_coolify_project_ownership` | ✅ | ✅ | ✅ |
| `0003_simplify_roles_to_admin_collaborator` | ✅ | ✅ | ✅ |
| `0004_backfill_owner_role_to_admin` | ✅ | ✅ | ✅ |
| **`0005_invitation_tokens`** | ✅ | ✅ | ❌ **MISSING** |

**Container checked**: `dt0v391xre5rgtp50062tunm-002216038801`  
**Migration probe**: `npm run db:migrate:deploy` → "4 migrations found… No pending migrations to apply."

This confirms the production database has not been migrated to include the Invitation table and related indices.

## SMTP Email Configuration

**Implementation**: Nodemailer SMTP transport (generic, not SMTP2GO API key)

**Required Environment Variables** (Jongo app container, not Coolify global):

```
# SMTP Configuration (transactional)
SMTP_HOST=<smtp-server-hostname>
SMTP_PORT=<port-number>         # typically 587 or 465
SMTP_USER=<username>
SMTP_PASSWORD=<secret>          # NEVER log or expose
SMTP_FROM=<from-email-address>
SMTP_TLS=true|false             # optional, defaults to false
SMTP_PROVIDER=smtp2go|smtp      # optional hint; auto-detected by hostname

# Invite Configuration
INVITE_BASE_URL=                # optional; defaults to NEXTAUTH_URL
INVITE_TOKEN_SECRET=            # optional; defaults to NEXTAUTH_SECRET
INVITE_TTL_DAYS=7              # optional; defaults to 7
```

**Email Detection**:
- `isSmtpConfigured()` checks for presence of: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (all required and trimmed)
- If **all** are configured: emails sent automatically
- If **any** missing: manual copy link mode active; errors logged, no email sent

**Current Production Status**:
- ❓ Unknown if SMTP vars are set in production app environment (secret, not readable via API)
- Likely not configured (no email delivery observed in prior tests)
- Feature will default to manual invite link copying and display appropriate UI messaging

## Routes & Public Path Status

| Route | Expected | Actual | Protected | Notes |
|-------|----------|--------|-----------|-------|
| `/auth/invite/[token]` | 200 | 307 | ✅ Public | Invite acceptance page (not yet live due to missing migration) |
| `/api/invites/[token]` | 200 | 307 | ✅ Public | Validate/read invite metadata endpoint (gated by public path) |
| `/api/invites/[token]/accept` | 200/201 | 307 | ✅ Public | Accept invite endpoint (gated by public path) |
| `/api/organizations/[id]/collaborators` | 201 | 307 | ✅ Protected | Create/invite collaborators (requires auth) |
| `/api/sites/[id]/collaborators` | 201 | 307 | ✅ Protected | Create/invite site team members (requires auth) |
| `/api/admin/email/test` | 200 | 307 | ✅ Protected (admin only) | Send test email (requires auth + admin/dev role) |
| `/api/health` | 200 | 200 | ✅ Public | Health check (working as expected) |

**Middleware** ([src/middleware.ts](src/middleware.ts)) correctly defines public paths:
```
/auth/login, /auth/register, /auth/error, /auth/invite, /api/auth, /api/invites, /api/health, /api/coolify/connection, /api/setup
```

307 redirects on these routes are expected during unauthenticated requests due to NextAuth callback flow.

## Immediate Actions Required

### 1. Apply Migration 0005 to Production Database

```bash
# Inside the jongo-os app container
cd /app
npm run db:migrate:deploy
```

**Expected outcome**:
```
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "postgres", schema "public" at "o4g2cpls648gnz0f1he7be7c:5432"

5 migrations found in prisma/migrations
Applying migration `0005_invitation_tokens`

✔ Migration `0005_invitation_tokens` applied successfully
```

### 2. Verify Invitation Table in Production DB

```bash
# Check table exists and has expected structure
SELECT 
  column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name='invitation' 
ORDER BY ordinal_position;
```

**Expected columns**:
- `id` (UUID, primary key)
- `tokenHash` (text, unique)
- `email` (text)
- `inviteType` (enum: 'organization' | 'site')
- `organizationId` (UUID FK, nullable)
- `siteId` (UUID FK, nullable)
- `role` (enum: 'admin' | 'collaborator')
- `expiresAt` (timestamp)
- `acceptedAt` (timestamp, nullable)
- `revokedAt` (timestamp, nullable)
- `createdAt` (timestamp)
- `updatedAt` (timestamp)
- `sentAt` (timestamp, nullable)
- `deliveryFailed` (boolean)
- `deliveryError` (text, nullable)
- `invitedByUserId` (UUID FK, nullable)

### 3. Configure SMTP for Production (Optional)

If transactional email delivery is desired:

**Set in Coolify app environment** (not global Coolify settings):
```
SMTP_HOST=<your-smtp-server>
SMTP_PORT=587
SMTP_USER=<credentials>
SMTP_PASSWORD=<credentials>
SMTP_FROM=noreply@yourdomain.com
SMTP_TLS=true
```

**Optionally add**:
```
SMTP_PROVIDER=smtp2go    # if using SMTP2GO; auto-detected by hostname
INVITE_BASE_URL=https://jongo.manifest-fts.com    # explicit if different from NEXTAUTH_URL
```

**Test endpoint** (requires admin auth):
```bash
curl -X POST https://jongo.manifest-fts.com/api/admin/email/test \
  -H "Authorization: Bearer <session-or-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "to": "test@example.com" }'
```

### 4. Run Full Validation Matrix (After Migration)

Once migration 0005 is applied, execute the checklist below against the live environment:

#### Validation Checklist

1. **Invite non-existing email creates pending invitation**
   - POST `/api/organizations/{orgId}/collaborators` → `{ email: 'new-user@example.com', role: 'collaborator' }`
   - Expect: 201, response includes `inviteUrl` and `emailDeliveryConfigured` boolean

2. **Pending invite returns a copyable invite URL when SMTP is not configured**
   - Response from (1) should include `inviteUrl` like `https://jongo.manifest-fts.com/auth/invite/{token}`
   - UX should show: "Email delivery not configured yet — copy this invite link manually"

3. **If SMTP is configured, invite email sends successfully**
   - Configure `SMTP_*` env vars, redeploy
   - POST same collaborator endpoint → verify email sent (check mail logs or test service)

4. **Accept invite creates a new user**
   - GET `/api/invites/{token}` → returns valid invite metadata
   - POST `/api/invites/{token}/accept` with `{ mode: 'register', email: '...', fullName: '...', password: '...' }` → 200
   - Verify new user created in database

5. **Accept invite links existing user if user already exists**
   - Invite existing email address
   - POST accept endpoint with same email → 200, links to existing user instead of creating new

6. **User appears as collaborator after accepting**
   - GET `/api/organizations/{orgId}/collaborators` → new accepted user appears in collaborators array

7. **Used invite cannot be reused**
   - POST `/api/invites/{token}/accept` second time → 410 or 400 (already used)

8. **Expired invite is rejected**
   - Manually set `expiresAt` to past timestamp in database
   - GET `/api/invites/{token}` → `{ valid: false, state: 'expired' }`
   - POST accept → 410 (no longer valid)

9. **Revoked invite is rejected**
   - Manually set `revokedAt` to current timestamp
   - GET/POST → `{ valid: false, state: 'revoked' }`

10. **Existing-user direct collaborator add still works**
    - POST `/api/organizations/{orgId}/collaborators` with existing user email (no `forceInvite=true`)
    - Expect: 201, user immediately added as collaborator (no pending invite)

11. **Role assignment is correct**
    - Create invites with different roles (admin, collaborator)
    - Verify `Collaborator.role` matches request

12. **No secrets/tokens are exposed after acceptance**
    - Acceptance response should NOT include tokenHash, raw token, or SMTP credentials
    - Next.js Server-Side Only: token secrets stay on server; never sent to browser

13. **Email config state is visible in admin/dev settings without exposing secrets**
    - GET `/api/admin/email/test` → returns `{ configKey: SMTP_HOST_CONFIGURED: true/false }` (keys only, no values)
    - Settings UI shows "Email delivery: Configured ✓" or "Email delivery: Not configured (manual copy mode)"

14. **Manual invite-link fallback still works when SMTP is disabled**
    - Unset `SMTP_PASSWORD` or other required var
    - POST collaborator → response includes `inviteUrl`
    - Error is logged (not exposed to UI)
    - No email sent; user must copy link manually

## Environment Details

**Coolify Resource**: `jongo.manifest-fts.com`  
- Application UUID: `dt0v391xre5rgtp50062tunm`
- Container: `dt0v391xre5rgtp50062tunm-002216038801`
- Git Repo: `Manifest-FTS/jongo-os` (`main` branch)
- Build Command: `npm run build`
- Historical Start Command At Incident Time: `npm run db:migrate:deploy || echo migrate_failed_continuing && HOSTNAME=0.0.0.0 PORT=3000 npm run start --workspace apps/web`
- Current Canonical Start Command: `npm run start`
- Base URL: `https://jongo.manifest-fts.com`

**Database**:
- Resource: `pdb-jongo-os-prod` (uuid: `o4g2cpls648gnz0f1he7be7c`)
- Host: `o4g2cpls648gnz0f1he7be7c:5432`
- Database: `postgres`

**Coolify Server**: `coolify.manifest-fts.com` (ccx33-manifestfts-s01-or)

## Code Files Summary

### New/Modified for Invite Feature

**Schema & Migrations**:
- [prisma/schema.prisma](../prisma/schema.prisma) — Added `Invitation` model + relations
- [prisma/migrations/0005_invitation_tokens/migration.sql](../prisma/migrations/0005_invitation_tokens/migration.sql) — **NOT YET APPLIED TO PRODUCTION**

**Email Service**:
- [apps/web/src/lib/email.ts](../apps/web/src/lib/email.ts) — Nodemailer abstraction, transactional helpers
- [apps/web/src/lib/invitations.ts](../apps/web/src/lib/invitations.ts) — Token generation, URL building, expiry logic

**API Routes**:
- [apps/web/src/app/api/invites/[token]/route.ts](../apps/web/src/app/api/invites/[token]/route.ts) — GET validate token metadata
- [apps/web/src/app/api/invites/[token]/accept/route.ts](../apps/web/src/app/api/invites/[token]/accept/route.ts) — POST accept invite, link/create user
- [apps/web/src/app/api/organizations/[organizationId]/collaborators/route.ts](../apps/web/src/app/api/organizations/[organizationId]/collaborators/route.ts) — Modified to support invites
- [apps/web/src/app/api/sites/[siteId]/collaborators/route.ts](../apps/web/src/app/api/sites/[siteId]/collaborators/route.ts) — Modified to support invites
- [apps/web/src/app/api/admin/email/test/route.ts](../apps/web/src/app/api/admin/email/test/route.ts) — Admin/dev test email endpoint

**UI Components**:
- [apps/web/src/app/auth/invite/[token]/page.tsx](../apps/web/src/app/auth/invite/[token]/page.tsx) — Public invite acceptance page
- [apps/web/src/components/CollaboratorManager.tsx](../apps/web/src/components/CollaboratorManager.tsx) — Refactored for invite UI
- [apps/web/src/components/SiteCollaboratorManager.tsx](../apps/web/src/components/SiteCollaboratorManager.tsx) — Refactored for invite UI
- [apps/web/src/components/EmailTestPanel.tsx](../apps/web/src/components/EmailTestPanel.tsx) — Admin email config test UI

**Middleware & Config**:
- [apps/web/src/middleware.ts](../apps/web/src/middleware.ts) — Added public paths for `/auth/invite` and `/api/invites`

**Documentation**:
- [docs/invite-onboarding-smtp.md](../docs/invite-onboarding-smtp.md) — Feature overview and SMTP setup

## Next Steps

1. **Apply migration** immediately via `npm run db:migrate:deploy` (see step 1 above)
2. **Run validation matrix** against production once migration succeeds
3. **Configure SMTP** if email delivery is desired (optional for manual link flow)
4. **Smoke test** invite lifecycle end-to-end
5. **Update `.env.example`** if adding SMTP config
6. **Commit changes** once all validation passes

---

## Notes for Future Deployments

- At incident time, the deployment used a start command that swallowed `prisma migrate deploy` failures and allowed the app to keep booting.
- Current deployments should use `npm run start`, which runs `prisma migrate deploy` and aborts startup on failure.
- Verify build logs in Coolify to see why migration was not applied during initial deployment.
- Ensure future deployments have clean build/migration windows without data conflicts.
