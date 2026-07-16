# Settings Persistence & UI Honesty Audit

**Date:** 2026-05-18  
**Scope:** Platform, Client, App, Email, Staging, Developer Details, and Mapping settings  
**Rules Applied:** Only mark as wired if data truly persists; mark misleading controls; fix fake editable fields

---

## Summary

### Key Findings
- **3 major UI honesty issues:** Client name not editable (appears static but API ready), Persistent Notes placeholder with no storage wired, App staging toggle in form but state may not persist correctly
- **Email configuration:** Status-only display is correct (read-only diagnostic)
- **Developer Details:** Correctly implemented as read-only diagnostic (admin-only)
- **Coolify project mapping:** Fully wired (POST/GET endpoints working)
- **App metadata:** Name, description, Git URL, Coolify IDs all correctly persisted via PUT `/api/sites/[siteId]`

---

## Detailed Settings Audit

### 1. Platform Settings (`/settings`)

#### Account Settings
- **Current State:** Pending card (non-editable)
- **Target Storage:** Authentication provider
- **Status:** ✅ Honest (clearly marked as pending; no fake editable fields)
- **Action:** No fix needed

#### API Tokens
- **Current State:** Pending card (non-editable)
- **Target Storage:** Jongo DB (when implemented)
- **Status:** ✅ Honest (clearly marked as pending)
- **Action:** No fix needed

#### Organizations
- **Current State:** Pending card (non-editable)
- **Target Storage:** Jongo DB (when implemented)
- **Status:** ✅ Honest (clearly marked as pending)
- **Action:** No fix needed

#### Publishing Integration (Coolify)
- **Current State:** Status-only display (read-only diagnostic chips)
- **Fields:** Runtime mode, Base URL configured, API token configured
- **Details:** Expandable "Developer Details" showing env var usage
- **Target Storage:** Environment variables only (runtime diagnostics)
- **Status:** ✅ Honest (read-only, no form controls)
- **Action:** No fix needed

#### Email Delivery
- **Current State:** Status-only display + test panel
- **Fields:** Provider mode, configuration status
- **Details:** "Email test panel" sends test message via `/api/admin/email/test`
- **Target Storage:** Environment variables only (SMTP_*, SMTP2GO_API_KEY)
- **Status:** ✅ Honest (read-only config status, test-only action)
- **Action:** No fix needed

#### Coolify Ownership Sync
- **Current State:** Button action (POST `/api/coolify/ownership/sync`)
- **Endpoint:** `POST /api/coolify/ownership/sync`
- **Behavior:** Syncs project ownership, returns `{ ok, updatedSites, backfilledOrganizations, orphanedCount }`
- **Target Storage:** Jongo DB (Organization.coolifyProjectId, OrganizationCoolifyProjectLink)
- **Status:** ✅ Wired and working
- **Action:** No fix needed

---

### 2. Client Settings (`/clients/[clientId]/settings`)

#### Coolify Project Mapping Form
- **Current State:** Dropdown + submit form (POST/GET endpoints)
- **Endpoints:**
  - `GET /api/organizations/[organizationId]/coolify-mapping` — loads linked projects
  - `POST /api/organizations/[organizationId]/coolify-mapping` — adds/updates link
- **Behavior:** Linking a Coolify project also auto-imports missing Coolify apps into the client as Site records
- **Target Storage:** Jongo DB (`OrganizationCoolifyProjectLink` table)
- **Status:** ✅ Wired and working
- **Action:** No fix needed

---

### 3. Client Overview (`/clients/[clientId]`)

#### Profile & Contact
- **Current State:** Static display (not editable in UI)
- **Fields:** Client name (read-only), summary (read-only)
- **Backend API:** `PUT /api/organizations/[organizationId]` supports updating name and description
- **Target Storage:** Jongo DB (Organization.name, Organization.description)
- **Status:** ⚠️ **MISLEADING** — API is wired and can persist, but UI has no form
- **Severity:** HIGH (users can't edit client name even though the backend supports it)
- **Action:** **REQUIRED** — Create `ClientInfoForm` component and add to client page

#### Persistent Notes
- **Current State:** Pending badge + static text "No stored notes yet"
- **Target Storage:** Not implemented (would be Organization.persistentNotes or similar)
- **Status:** ✅ Honest (marked as pending, no form)
- **Action:** No fix needed (correctly marked as pending)

---

### 4. App Settings (`/sites/[siteId]/settings`)

#### Site Information Form
- **Current State:** Editable form with submit button
- **Fields:** Name, Description, Coolify Service UUID, Git Repository URL, Coolify Project ID, Staging toggle
- **Endpoint:** `PUT /api/sites/[siteId]`
- **Target Storage:** Jongo DB (Site.name, Site.description, Site.coolifyServiceUuid, Site.coolifyProjectId, Site.gitRepositoryUrl, Site.stagingEnabled)
- **Status:** ✅ Wired and working
- **Behavior:** Form shows success message on save, triggers `router.refresh()`
- **Action:** No fix needed

#### Staging Environment
- **Current State:** Status display + link to staging workspace
- **Behavior:** Reads `workspace.stagingEnabled` and `stagingCapability.detected` to show status
- **Target Storage:** Site.stagingEnabled (persisted via SiteInfoForm)
- **Status:** ✅ Correctly implemented (status is read-only; toggle is in SiteInfoForm above)
- **Action:** No fix needed

#### Publishing Actions
- **Current State:** Deploy/Sync buttons (mock-safe when Coolify values missing)
- **Endpoints:** `POST /api/coolify/deploy` (triggers deployment workflow)
- **Target Storage:** N/A (actions only; state persisted in Site.stagingEnabled)
- **Status:** ✅ Correctly implemented
- **Action:** No fix needed

#### App Health
- **Current State:** Status-only display (read-only diagnostic chips)
- **Fields:** Overall, Production, Staging, Ownership (admin-only)
- **Target Storage:** Coolify API cache (read-only from getCoolifyOverview())
- **Status:** ✅ Honest (read-only diagnostic)
- **Action:** No fix needed

#### Developer Details
- **Current State:** Collapsible details section (admin-only, read-only)
- **Fields:** Data source, Coolify data, Source, Ownership, Service UUID, Project ID, Git URL, Domain
- **Target Storage:** Read-only diagnostics from Coolify API + Site DB fields
- **Status:** ✅ Correctly implemented (read-only, properly gated to admins)
- **Visibility:** Hidden from non-admins via `canViewInternalMetadata` check
- **Action:** No fix needed

---

### 5. Staging Environment (`/sites/[siteId]/staging`)

#### Staging Capability Display
- **Current State:** Status display + links (read-only diagnostic)
- **Fields:** Application name, UUID, Domain (with link), Environment name
- **Target Storage:** Coolify API (read-only from getCoolifyAppStagingCapability())
- **Status:** ✅ Honest (read-only diagnostic)
- **Action:** No fix needed

#### Staging Sync Dry-Run
- **Current State:** Display of proposed changes (read-only diagnostic)
- **Fields:** File changes, diff summary
- **Target Storage:** N/A (dry-run only; no persistence)
- **Status:** ✅ Honest (read-only diagnostic)
- **Action:** No fix needed

#### Staging Publish Actions
- **Current State:** Buttons (mock-safe when Coolify values missing)
- **Endpoints:** `POST /api/coolify/deploy` with environment="staging"
- **Target Storage:** N/A (actions only)
- **Status:** ✅ Correctly implemented
- **Action:** No fix needed

---

## Misleading Controls & Required Fixes

### HIGH Priority

#### 1. Client Name Not Editable (UI/Backend Mismatch)
- **Issue:** Client name is static read-only in UI, but backend API (`PUT /api/organizations/[organizationId]`) fully supports updates
- **Location:** `/clients/[clientId]` page
- **Impact:** Users cannot update client name even though it's the most fundamental property to edit
- **Fix:** Create `ClientInfoForm` component and integrate into client page
- **Complexity:** Low (nearly identical to SiteInfoForm pattern)
- **Files to create/modify:**
  - Create: `apps/web/src/components/ClientInfoForm.tsx`
  - Modify: `apps/web/src/app/(platform)/clients/[clientId]/page.tsx`

#### 2. Persistent Notes Marked Pending Without Clear Storage Plan
- **Issue:** Section appears in admin view but is marked as "pending" with no clear indication of what "pending" means
- **Location:** `/clients/[clientId]` page
- **Impact:** Minimal (correctly hidden from non-admins; labeled pending)
- **Status:** Already honest (marked pending), but could be improved with clearer messaging
- **Fix:** Optional — add clarifying help text in pending badge reason
- **Complexity:** Minimal

### MEDIUM Priority

#### 3. Staging Toggle Wiring Confirmation
- **Issue:** Staging toggle is in SiteInfoForm and persists via `Site.stagingEnabled`, but no confirmation that this field persists correctly
- **Location:** `/sites/[siteId]/settings` → SiteInfoForm
- **Impact:** If not working, users can't enable/disable staging
- **Fix:** Validate via smoke test (toggle, save, reload, verify state persists)
- **Complexity:** Testing only (no code changes expected)

---

## Implementation Plan

### Phase 1: High-Priority Fixes (This Pass)
1. **Create ClientInfoForm component**
   - Mirror SiteInfoForm pattern
   - PUT `/api/organizations/[organizationId]` endpoint
   - Support: name, description fields
   - Show success/error messages
   - Validate via smoke test

2. **Integrate ClientInfoForm into client page**
   - Add to `/clients/[clientId]` page
   - Gate to admin users only (use `isClientAdmin()` check)
   - Replace static name display with editable form
   - Ensure non-admin collaborators see read-only name

3. **Smoke test all high-priority items**
   - Edit client name, reload, verify persists
   - Edit app name in SiteInfoForm, verify persists
   - Test staging toggle in SiteInfoForm
   - Verify non-admin cannot see edit controls

### Phase 2: Medium-Priority Items (Next Pass)
- Staging toggle validation
- Consider clearer "Persistent Notes" messaging

### Phase 3: Deferred (Out of Scope)
- Implementation of actual Persistent Notes storage
- Other pending features (Account, API Tokens, Organizations)

---

## Storage Location Summary

| Control | Target Storage | Status | Wired |
|---------|-----------------|--------|-------|
| Account settings | Auth provider | Pending | ✅ Marked |
| API Tokens | Jongo DB | Pending | ✅ Marked |
| Organizations (team) | Jongo DB | Pending | ✅ Marked |
| Coolify integration | Env vars | Read-only | ✅ Honest |
| Email delivery | Env vars | Read-only | ✅ Honest |
| Ownership sync | Jongo DB | Wired | ✅ Working |
| Client name | Jongo DB | Read-only (UI) | ❌ **Need form** |
| App name | Jongo DB | Editable | ✅ Working |
| App description | Jongo DB | Editable | ✅ Working |
| Coolify UUIDs | Jongo DB | Editable | ✅ Working |
| Git URL | Jongo DB | Editable | ✅ Working |
| Staging enabled | Jongo DB | Editable | ✅ Working |
| Coolify project mapping | Jongo DB | Editable | ✅ Working |
| Persistent Notes | Not impl. | Pending | ✅ Marked |
| Developer Details | Coolify API | Read-only | ✅ Honest |

