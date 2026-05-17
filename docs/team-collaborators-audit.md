# Team & Collaborators Audit Report

**Date:** May 16, 2026  
**Status:** ✅ Audit complete + honest UX updates deployed  
**Commit:** `2d6cafd` (Team UX transparency improvements)

---

## Executive Summary

The Team/Collaborators feature is **partially functional with significant gaps**:

- ✅ **App-level collaboration works**: Existing users can be added as collaborators with role control
- ❌ **Pending invites incomplete**: New users can't be invited (API returns 404); no token/acceptance flow
- ❌ **Email delivery stubbed**: No emails sent; messaginghas been updated to be honest about this
- ⚠️ **Org-level team management orphaned**: CollaboratorManager component built but never mounted
- ⚠️ **Role enforcement partial**: Binary admin/collaborator works; no granular permission matrix

The UX has been updated to **clearly communicate** what works now vs. what's pending.

---

## What's Fully Wired & Working

### 1. SiteCollaboratorManager (App-Level Team)

**Status:** 🟢 LIVE  
**Location:** `apps/web/src/components/SiteCollaboratorManager.tsx`  
**Routes:** `/apps/[siteId]/team`, `/sites/[siteId]/team`

**What works:**
- ✅ Load existing collaborators from API
- ✅ Invite users (who have accounts) to collaborate on an app
- ✅ Change collaborator roles (admin ↔ collaborator)
- ✅ Remove collaborators
- ✅ Role-based UI (collaborators can only invite collaborators, not admins)
- ✅ Permission checks (admins required for removal/role changes)

**API Endpoints:**
- `GET /api/sites/[siteId]/collaborators` — List all collaborators
- `POST /api/sites/[siteId]/collaborators` — Invite (requires existing account)
- `PUT /api/sites/[siteId]/collaborators/[id]` — Change role
- `DELETE /api/sites/[siteId]/collaborators/[id]` — Remove

### 2. Audit Logging

**Status:** 🟢 COMPLETE  
**Location:** Prisma `AuditLog` table

**What's tracked:**
- All invitation attempts (success & failure)
- Action: `collaborator_invited_pending`
- Details: email, role, status (pending), delivery (not_configured), note

**Limitations:**
- Audit logs are read-only (can't mark as "accepted" later)
- Used as ad-hoc source of truth for pending invites (inefficient)
- No cleanup of old/stale invites

### 3. Role Management

**Status:** 🟢 LIVE (SIMPLIFIED)  
**Roles:** `admin` | `collaborator` (binary, post-migration)

**What's enforced:**
- ✅ Admins can invite/remove/change roles
- ✅ Collaborators can only manage collaborator roles (not admin)
- ✅ Collaborators can invite collaborators
- ✅ Owner cannot be removed (safety check)
- ✅ Non-admins cannot escalate to admin

**What's NOT enforced:**
- ❌ No granular permissions (what can a collaborator actually do on the app?)
- ❌ No permission checks on actions (deploy, staging, backups, etc.)
- ❌ Scope boundary issues (site collaborator accessing org APIs?)

---

## What's Partially Implemented

### 1. Organization-Level Team Management

**Status:** 🟡 ORPHANED  
**Component:** `apps/web/src/components/CollaboratorManager.tsx`  
**API:** Works (see below), but no UI path to access it

**What exists:**
- CollaboratorManager component with full invite/role/remove UI
- Component shows honest messaging: "Email delivery is not configured yet"
- API endpoints work (org-level invite/manage)
- Handles pending invites via audit logs

**Why it's orphaned:**
- Never imported or mounted in any page
- Design decision moved team management to app-level only
- No UI path for org-level team management
- Users can only manage team at app granularity

**Organization-level API endpoints (unused in UI):**
- `GET /api/organizations/[organizationId]/collaborators`
- `POST /api/organizations/[organizationId]/collaborators` — Invite
- `PUT /api/organizations/[organizationId]/collaborators/[id]` — Change role
- `DELETE /api/organizations/[organizationId]/collaborators/[id]` — Remove

### 2. Pending Invitations

**Status:** 🟡 PARTIAL  
**Storage:** AuditLog table (JSON details)

**What's tracked:**
- Email of invited user
- Role offered
- Status: "pending"
- Delivery: "not_configured"
- Note: "Email delivery not configured yet."

**What's missing:**
- ❌ No `inviteToken` field in schema
- ❌ No token generation/validation
- ❌ No "accept invitation" endpoint
- ❌ No "accept invitation" UI
- ❌ No expiry/cleanup mechanism
- ❌ No acceptance state tracking
- ❌ No resend capability

---

## What's NOT Implemented

### 1. Email Delivery

**Status:** 🔴 STUBBED  
**Evidence:**
- `nodemailer@7.0.7` in `package.json` but never imported
- `emailDeliveryConfigured: false` hardcoded in API responses
- No SMTP/SendGrid configuration or integration
- No invite email templates
- No email sending on invite

**Current UX (post-update):**
- Form shows badge: "Email delivery is not yet configured"
- Success message: "Invitation created. Email delivery not yet configured... You may need to contact them separately."
- Prevents false promises of email notification

### 2. Invite Acceptance Flow

**Status:** 🔴 NOT IMPLEMENTED  
**Missing pieces:**
1. No invite tokens (field doesn't exist in schema)
2. No token generation logic
3. No `/api/invites/[token]/accept` endpoint
4. No acceptance/registration UI
5. No email link to click

**Broken flow (currently):**
```
User A invites user B (with email B@example.com)
  → Creates Collaborator record if user exists (404 if not)
  → Creates AuditLog entry (if not found)
  → No email sent (not configured)
  → User B can't see invitation anywhere
  → No way for User B to accept
  → Stuck
```

### 3. Non-Existent User Invitations

**Status:** 🔴 BLOCKING  
**Problem:** Can't invite users without accounts

**Current behavior:**
- `POST /api/sites/[siteId]/collaborators` checks if user exists
- Returns 404 if email not found in Users table
- Can't create pending record that leads to registration

**Updated UX (post-fix):**
- Clear error message: "User not found. Invite requires an existing account. User must sign up first before being added as a collaborator."
- Prevents user confusion

### 4. Granular Permission Matrix

**Status:** 🔴 NOT DESIGNED  
**What's missing:**
- What can a "collaborator" actually do?
- Can they trigger deploys? View logs? Change DNS? Backups?
- No scoping (site vs. org level permissions)
- No permission checks in app logic
- Only UI-level role checks exist

---

## Current Data Model (Prisma)

### Collaborator (Organization-level)
```prisma
model Collaborator {
  id            String
  organizationId String
  userId        String
  role          String  // "admin" | "collaborator"
  grantedById   String  // Who granted access
  grantedAt     DateTime
  deletedAt     DateTime?
  
  @@unique([organizationId, userId])
}
```

### SiteCollaborator (App-level)
```prisma
model SiteCollaborator {
  id        String
  siteId    String
  userId    String
  role      String  // "admin" | "collaborator"
  deletedAt DateTime?
  
  @@unique([siteId, userId])
}
```

### AuditLog (Pending invites)
```prisma
model AuditLog {
  action  String  // "collaborator_invited_pending"
  details Json    // { email, role, status, delivery, note }
}
```

**Schema Gaps:**
- ❌ No `Invitation` table (no dedicated schema for pending invites)
- ❌ No `inviteToken` field
- ❌ No `acceptanceStatus` tracking
- ❌ No `inviteExpiresAt` date
- ❌ No `invitedAt` timestamp

---

## Permission Enforcement Audit

### What's Checked

| Check | Enforced | Location |
|-------|----------|----------|
| Caller is org admin | ✅ Yes | `/api/organizations/[...]/collaborators/*` |
| Caller is site admin | ✅ Yes | `/api/sites/[...]/collaborators/*` |
| Non-admin can't invite admin (site-level) | ✅ Yes | `POST /api/sites/[...]/collaborators` |
| Non-admin can't change roles | ✅ Yes | `PUT /api/sites/[...]/collaborators` |
| Owner cannot be removed | ✅ Yes | `DELETE /api/sites/[...]/collaborators` |
| Non-duplicates (unique constraint) | ✅ Yes | Prisma schema |

### What's NOT Checked

| Check | Status | Impact |
|-------|--------|--------|
| Granular action permissions (deploy, backup, etc.) | ❌ No | Collaborators may have excess access in UI |
| Permission scope validation (site vs. org APIs) | ❌ No | Potential cross-scope access issues |
| Middleware/route-level permission guards | ❌ No | Reliant on component-level checks |
| Rate limiting on invites | ❌ No | Spam/abuse potential |

---

## Recent UX Improvements (Commit 2d6cafd)

### Changes Made

1. **App Team Page** (`/apps/[siteId]/team`)
   - Added `PendingBadge` to heading: "Email delivery not yet configured for invitations."
   - Updated subtitle to say: "Invitations create access records immediately, but email notification is not yet configured."

2. **SiteCollaboratorManager**
   - Added form disclaimer box: "Email delivery is not yet configured. Invitations create access immediately, but email notification is not yet sent."
   - Improved success message: "Invitation created. Note: Email delivery is not yet configured, so the user was not notified by email. You may need to contact them separately to let them know they've been added."
   - Better error handling:
     - 404: "User not found. Invite requires an existing account. User must sign up first before being added as a collaborator."
     - 409: "User is already a collaborator on this app."
     - Generic: "Failed to create collaboration invitation"

3. **Client Team Page** (`/clients/[clientId]/team`)
   - Added `PendingBadge`: "Organization-level team management pending; manage collaborators per app."
   - Clarified messaging: "This tab shows organization-level members from the system. App team management is handled per app — each app can have its own set of collaborators. To invite users, go to the Team tab within an app."

### What Was NOT Changed
- ✅ No functional changes to invite flow
- ✅ No API changes
- ✅ No schema changes
- ✅ Invite flow works exactly as before (requires existing account, no email sent)

---

## Validation Checklist

- ✅ `npx tsc --noEmit` passes (no type errors)
- ✅ `npm run build` passes (all 23 routes compile successfully)
- ✅ Team UI clearly communicates:
  - What works now (invite existing users)
  - What's pending (email delivery, non-existent user invites, acceptance flow)
  - Clear error messages for common failures (user not found)

---

## Recommended Next Steps

### Phase 1: Enable Account Registration for Non-Existent Users (Safe)
- [ ] Accept invitations to non-existent emails
- [ ] Generate secure invite tokens
- [ ] Create "Accept Invitation" UI
- [ ] Validate tokens on registration/acceptance
- [ ] Mark invitations as accepted in schema

### Phase 2: Email Delivery (Medium Effort)
- [ ] Choose SMTP provider (SendGrid, AWS SES, etc.)
- [ ] Wire nodemailer integration
- [ ] Create email templates
- [ ] Send invite emails with acceptance links
- [ ] Add email configuration UI

### Phase 3: Permission Matrix (Architectural)
- [ ] Define what each role can do
- [ ] Implement permission checking middleware
- [ ] Add scope validation (site vs. org)
- [ ] Document permission model
- [ ] Add permission tests

### Phase 4: Org-Level Team Management (UI)
- [ ] Mount orphaned CollaboratorManager component
- [ ] Create org team management page
- [ ] Link from client/org navigation
- [ ] Test invite flow at org level

### Phase 5: Invite Management (UX Polish)
- [ ] Resend invitation functionality
- [ ] Revoke pending invites
- [ ] Expiry mechanism (invites valid for 7 days)
- [ ] Pagination for large team lists

---

## Files Modified

- `apps/web/src/app/(platform)/sites/[siteId]/team/page.tsx`
- `apps/web/src/app/(platform)/clients/[clientId]/team/page.tsx`
- `apps/web/src/components/SiteCollaboratorManager.tsx`

## References

- **Data Model:** `jongo-os/prisma/schema.prisma`
- **API Routes:** `apps/web/src/app/api/sites/[siteId]/collaborators/*`
- **Audit Logs:** UI-Wiring Audit (`docs/ui-wiring-audit.json`, section: "Team")
- **Component:** `apps/web/src/components/SiteCollaboratorManager.tsx`
- **Orphaned Component:** `apps/web/src/components/CollaboratorManager.tsx`
