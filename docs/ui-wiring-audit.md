# Jongo OS UI Wiring Audit

**Date:** 2026-05-16  
**Scope:** All primary routes and app-detail sub-routes  
**Purpose:** Map every surface to its data source, CTA wiring status, and production readiness.

---

## Legend

| Symbol | Meaning |
|--------|---------|
| 🟢 LIVE | Wired to real data; reads/writes work in production |
| 🔵 READ-ONLY | Wired to live data, no mutations |
| 🟡 DRY-RUN | Shows a safe preview plan; does not execute |
| 🟠 MOCK | Uses fallback mock data when live source unavailable |
| 🔴 STATIC | Hardcoded placeholder text; no data connection at all |
| ⬛ REDIRECT | Route redirects elsewhere |

---

## 1. Dashboard — `/dashboard`

**Production Readiness:** 🟢 LIVE

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Metrics strip (Apps, Clients, Deployments, Healthy) | Coolify API + DB | 🟢 LIVE | Falls back to mock if Coolify not configured |
| Operational health bars | Coolify API | 🟢 LIVE | mode=live returns real data |
| WordPress footprint count | Coolify API | 🟢 LIVE | Detected from resource type |
| Latest deployments feed | Coolify API + DB (auditLog) | 🟢 LIVE | Coolify deployments merged with DB audit events |

**CTAs:** None. Dashboard is read-only.

**Risks/Gaps:**
- Activity feed timestamp formatting can show "unknown time" if `finishedAt` is null (Coolify may omit this for in-progress deployments)
- No last-refreshed timestamp shown to user; data is up-to-date only on page load
- If DB unavailable, falls back to Coolify deployments only (no audit log items)

---

## 2. Clients — `/clients`

**Production Readiness:** 🟢 LIVE (with mock banner fallback)

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Client list | DB (organizations + sites) | 🟢 LIVE | Falls to mock with explicit banner if DB fails |
| Mock data banner | Automatic | 🟠 MOCK | Shows only when `dataSource === "mock"` |

**CTAs:**

| CTA | Wiring | Status |
|-----|--------|--------|
| **New Client** (CreateOrganizationForm) | POST `/api/organizations` → DB write | 🟢 LIVE |

**Risks/Gaps:**
- Mock client data is hardcoded in `clients.ts` and could mislead if shown without the banner
- No pagination; large client lists load all at once

---

## 3. Apps Directory — `/apps` (alias: `/sites`)

**Production Readiness:** 🟢 LIVE

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| App list with status chips | DB + Coolify API | 🟢 LIVE | `listSiteDirectory()` merges DB records with Coolify status |
| Status/ownership chips | Coolify API | 🟢 LIVE | `unknown` shown when Coolify can't resolve |
| Filter/search UI | Client-side (`SiteDirectoryView`) | 🟢 LIVE | Local filter over fetched data |

**CTAs:**

| CTA | Wiring | Status |
|-----|--------|--------|
| **New Client** (shown when no apps) | POST `/api/organizations` | 🟢 LIVE |
| App card links → `/apps/[id]` | Navigation | 🟢 LIVE |

**Risks/Gaps:**
- Creating a site requires creating a client first; no "New App" shortcut at directory level (by design)

---

## 4. Client Detail — `/clients/[clientId]`

**Production Readiness:** 🟡 PARTIALLY LIVE

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Profile & Contact name/summary | DB (organization) | 🟢 LIVE | |
| **Persistent Notes card** | — | 🔴 STATIC | Renders "No stored notes yet." with no input, no API |
| App Summary count + link | DB (sites) | 🟢 LIVE | |
| Recent Activity | `client.recentActivity` array | 🟢 LIVE | Sourced from DB (org-level; may be empty for new orgs) |

**CTAs:**

| CTA | Wiring | Status |
|-----|--------|--------|
| "Open app directory" link | Navigation | 🟢 LIVE |

**Risks/Gaps:**
- **Persistent Notes** section is 100% static — no write path exists. Misleads users into thinking notes functionality is available.
- `recentActivity` array populated from Coolify project deployments; may be empty if no ownership mapping

---

## 5. Client Apps — `/clients/[clientId]/apps`

**Production Readiness:** 🟢 LIVE

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| App list | DB + Coolify | 🟢 LIVE | Scoped to client's organization |

**CTAs:**

| CTA | Wiring | Status |
|-----|--------|--------|
| **New App** (CreateSiteForm) | POST `/api/organizations/[id]/sites` → DB | 🟢 LIVE |

---

## 6. Client Settings — `/clients/[clientId]/settings`

**Production Readiness:** 🟢 LIVE (admin-gated)

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Coolify Project Mapping form | Coolify API + DB | 🟢 LIVE | Selects from live Coolify projects |

**CTAs:**

| CTA | Wiring | Status |
|-----|--------|--------|
| **Map Project** (CoolifyProjectMappingForm) | POST `/api/organizations/[id]/coolify-mapping` → DB | 🟢 LIVE |

**Risks/Gaps:**
- Form hidden for non-admins; non-admins see only a placeholder card

---

## 7. Client Team — `/clients/[clientId]/team`

**Production Readiness:** 🔵 READ-ONLY

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Member list | DB (org collaborators) | 🔵 READ-ONLY | Display only; invites happen per-app |

**CTAs:** None. Explicitly read-only by design.

**Risks/Gaps:**
- No invite CTA at org level could confuse users who want to add team members to a client workspace. Current UX guidance: "invitations are managed per app."

---

## 8. App Overview — `/apps/[siteId]`

**Production Readiness:** 🟡 PARTIALLY LIVE

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Site Health chips (prod/staging/overall) | Coolify API | 🟢 LIVE | |
| Activity Feed | Coolify API (deployments filtered by site) | 🟢 LIVE | Empty if site not matched in Coolify |
| Publishing card (link only) | Navigation | 🟢 LIVE | |
| Team card (link only) | Navigation | 🟢 LIVE | |
| **WordPress Overview section** | — | 🔴 STATIC | Shows when `siteType === "wordpress"`. All fields are hardcoded placeholder text; no WP REST API connected |

**CTAs:**

| CTA | Wiring | Status | Notes |
|-----|--------|--------|-------|
| **Deploy to Production** (DeployButton) | POST `/api/coolify/deploy` → Coolify API | 🟢 LIVE | |
| **Deploy to Staging** (DeployButton) | POST `/api/coolify/deploy` → Coolify API | 🟢 LIVE | ⚠️ Shown unconditionally; misleading when staging not enabled |
| "Open publishing workflow" link | Navigation | 🟢 LIVE | |
| "Open app team" link | Navigation | 🟢 LIVE | |

**Risks/Gaps:**
- **"Deploy to Staging" button shown regardless of `stagingEnabled`** — calls Coolify deploy with `environment: "staging"` even when no staging env exists. Should be conditioned or hidden.
- **WordPress Overview** is entirely static. "Connect WordPress REST API to show version" is displayed but there's no mechanism to do so. Should carry a pending indicator.
- No last-refresh timestamp for health data

---

## 9. App Deployments — `/apps/[siteId]/deployments`

**Production Readiness:** 🟢 LIVE

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Metrics strip (total, prod, staging, last success) | DB → Coolify fallback | 🟢 LIVE | |
| Deployment history timeline | DB `deployment` table → Coolify fallback | 🟢 LIVE | DB is primary; Coolify overview is fallback |
| Current Status chips | Coolify API | 🟢 LIVE | |

**CTAs:**

| CTA | Wiring | Status | Notes |
|-----|--------|--------|-------|
| **Deploy to Production** | POST `/api/coolify/deploy` | 🟢 LIVE | |
| **Sync to Staging** | POST `/api/coolify/deploy` (staging) | 🟢 LIVE | ⚠️ Shown unconditionally; misleading when staging disabled |

**Risks/Gaps:**
- **"Sync to Staging" button** shown even when `stagingEnabled` is false. Should be conditional.
- No "Rollback" or "Redeploy" from a specific commit. Deploy always redeploys HEAD.
- History shows at most 50 records; no pagination

---

## 10. App Analytics — `/apps/[siteId]/analytics`

**Production Readiness:** 🔴 STATIC STUB

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Metrics (deploy counts) | DB → Coolify fallback | 🟠 MOCK | These are **deployment counts**, not analytics metrics |
| Current Status chips | Coolify API | 🟢 LIVE | |
| Deployment Timeline | DB → Coolify fallback | 🟠 MOCK | Deployment history re-used as fake "analytics timeline" |

**CTAs:**

| CTA | Wiring | Status | Notes |
|-----|--------|--------|-------|
| **Deploy to Production** | POST `/api/coolify/deploy` | 🟢 LIVE | ⚠️ Misleading: deploy buttons on an analytics page |
| **Sync to Staging** | POST `/api/coolify/deploy` (staging) | 🟢 LIVE | ⚠️ Same issue |

**Risks/Gaps:**
- **Entire page is misleadingly named "Analytics."** It shows deployment history and deploy buttons — not pageviews, users, bounce rates, or any real analytics.
- **Deploy buttons are wrong UX placement** for an Analytics page. Users expect observability data, not actions.
- Should either be renamed to something honest (e.g., "Deployment Log") or replaced with a pending state pointing toward a future analytics integration (Plausible, PostHog, etc.)

---

## 11. App Backups — `/apps/[siteId]/backups`

**Production Readiness:** 🔵 READ-ONLY LIVE

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Protection status chip | Coolify API (`/api/v1/databases/{uuid}/backups`) | 🔵 READ-ONLY | Falls to "unavailable" if Coolify doesn't return backup data |
| Active backup schedules | Coolify API | 🔵 READ-ONLY | Empty section hidden if no schedules |
| Recent backup executions | Coolify API | 🔵 READ-ONLY | Hidden if no executions |
| "Not configured" state | Coolify API result | 🔵 READ-ONLY | Shown when schedules array is empty |
| "No Coolify resource linked" | Workspace DB | 🔵 READ-ONLY | Shown when `coolifyServiceUuid` is null |

**CTAs:** None. Entirely read-only by design.

**Risks/Gaps:**
- Coolify backup API (`/api/v1/databases/{uuid}/backups`) may not be reachable from the app container if the database UUID is not directly accessible (requires traversing project → environment → databases chain)
- If no databases are in the Coolify environment, shows "not configured" — which is correct but could be confusing if databases exist elsewhere
- No link to Coolify dashboard for operators to create schedules

---

## 12. App Staging — `/apps/[siteId]/staging`

**Production Readiness:** 🔵 READ-ONLY + 🟡 DRY-RUN

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Staging enabled/disabled chip | DB workspace | 🔵 READ-ONLY | |
| Staging Capability detection | Coolify API (`/api/v1/projects/{id}`) | 🔵 READ-ONLY | Detects staging environments in Coolify project |
| Sync Plan (Dry Run) | Computed locally | 🟡 DRY-RUN | Shows plan; does not execute |
| Environment Status chips | DB workspace | 🔵 READ-ONLY | |

**CTAs:**

| CTA | Wiring | Status | Notes |
|-----|--------|--------|-------|
| **Deploy to Production** | POST `/api/coolify/deploy` | 🟢 LIVE | Only shown when staging is enabled |
| "Enable staging via Settings" link | Navigation | 🟢 LIVE | Shown when staging disabled |

**Risks/Gaps:**
- Staging capability detection requires `coolifyProjectId` or `coolifyServiceUuid` to be set. Falls to "detected: false" gracefully if missing.
- Sync Plan is read-only; no execute button (by design)
- "staging_environment_exists_no_application" note is shown but there's no CTA to create a staging app

---

## 13. App Settings — `/apps/[siteId]/settings`

**Production Readiness:** 🟢 LIVE

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Site Information form | DB | 🟢 LIVE | PUT `/api/sites/[siteId]` |
| Staging section (display) | DB workspace | 🔵 READ-ONLY | Toggle shown, not editable here; edit in form above |
| Publishing Actions (deploy btns) | Coolify API | 🟢 LIVE | Staging deploy shown only if `stagingEnabled` |
| App Health chips | DB + Coolify | 🔵 READ-ONLY | |
| Developer Details (`<details>`) | DB workspace | 🔵 READ-ONLY | Coolify UUID, project, env, git repo |

**CTAs:**

| CTA | Wiring | Status | Notes |
|-----|--------|--------|-------|
| **Save** (SiteInfoForm) | PUT `/api/sites/[siteId]` → DB | 🟢 LIVE | |
| **Deploy to Production** | POST `/api/coolify/deploy` | 🟢 LIVE | |
| **Sync to Staging** | POST `/api/coolify/deploy` | 🟢 LIVE | Conditional on `stagingEnabled` |

**Risks/Gaps:**
- No confirmation dialog before saving; quick accidental UUID changes could break Coolify resolution
- `coolifyEnvironmentName` is shown in Developer Details but is not a writable field in `SiteInfoForm` — no way to set it through UI

---

## 14. App Integrations — `/apps/[siteId]/integrations`

**Production Readiness:** 🔴 STATIC (mostly)

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Provider Connectivity section | DB + Coolify | 🟢 LIVE | Shows coolifyServiceUuid, project, environment |
| **WordPress Signals (if WP)** | — | 🔴 STATIC | "plugin updates: not connected" × 3; hardcoded |
| **"No active integrations" (if non-WP)** | — | 🔴 STATIC | Placeholder card; no integration data |
| Recent Integration Events | Coolify API (deployments) | 🟢 LIVE | Uses `getSiteActivityFeed()` |
| Link to Advanced | Navigation | ⚠️ BROKEN LINK | Links to `/apps/${siteId}/advanced` which now redirects to Settings |

**CTAs:**

| CTA | Wiring | Status |
|-----|--------|--------|
| "Open advanced diagnostics" link | Navigation → (redirects to Settings) | ⚠️ BROKEN INTENT |

**Risks/Gaps:**
- **WordPress Signals** section looks functional but is 100% static. Should carry pending indicator.
- **Link to "advanced diagnostics"** now points to Settings due to the redirect. Should be updated to point to diagnostics API endpoint or removed.
- Integrations page has no actual integration functionality. Appears to offer plugin/provider connections that don't exist yet.

---

## 15. App Team — `/apps/[siteId]/team`

**Production Readiness:** 🟢 LIVE

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Collaborator list | DB (site collaborators via API) | 🟢 LIVE | Fetched via `/api/sites/[siteId]/collaborators` |
| Invite form | DB | 🟢 LIVE | POST to collaborators endpoint |

**CTAs:**

| CTA | Wiring | Status |
|-----|--------|--------|
| **Invite collaborator** | POST `/api/sites/[siteId]/collaborators` → DB | 🟢 LIVE |
| **Remove collaborator** | DELETE `/api/sites/[siteId]/collaborators` → DB | 🟢 LIVE |

**Risks/Gaps:**
- No email notification when a collaborator is invited
- Role escalation: collaborators cannot invite admins (enforced in component)

---

## 16. App Advanced — `/apps/[siteId]/advanced`

**Production Readiness:** ⬛ REDIRECT

Redirects to `/apps/[siteId]/settings`. The "Developer Details" collapsible section in Settings contains the content that was here.

---

## 17. Platform Settings — `/settings`

**Production Readiness:** 🟡 PARTIALLY LIVE

| Element | Source | Status | Notes |
|---------|--------|--------|-------|
| Mode chip, DB status chip | `getRuntimeConfigStatus()` (env vars) | 🔵 READ-ONLY | Accurate at page load |
| Diagnostics panel | In-memory diagnostics + probe | 🔵 READ-ONLY | Admin/bootstrap email gated |
| Coolify endpoint call history | In-memory | 🔵 READ-ONLY | |
| Ownership Sync Panel | Coolify API + DB | 🟢 LIVE | Admin-only; POST to ownership/sync |
| **Account card** | — | 🔴 STATIC | "Profile, email, 2FA" — no form, no API |
| **API Tokens card** | — | 🔴 STATIC | "Generate tokens" — no form, no API |
| **Organizations card** | — | 🔴 STATIC | "Manage clients" — links nowhere |
| **Publishing Integration card** | Partially env | 🟠 MOCK | Shows runtime mode; body text is static description |

**CTAs:**

| CTA | Wiring | Status |
|-----|--------|--------|
| **Run Ownership Sync** (admin only) | POST `/api/coolify/ownership/sync` | 🟢 LIVE |

**Risks/Gaps:**
- Account, API Tokens, Organizations cards are fully static placeholder sections. Users may expect to click into them.
- No navigation to create a new org from this page (only from Clients)

---

## Summary Table

| Route | Live Data | Static Sections | Misleading CTAs | Priority |
|-------|-----------|-----------------|-----------------|----------|
| `/dashboard` | ✅ Full | None | None | ✅ Ready |
| `/clients` | ✅ Full | None | None | ✅ Ready |
| `/apps` | ✅ Full | None | None | ✅ Ready |
| `/clients/[id]` | ⚠️ Partial | Persistent Notes | None | 🟡 Medium |
| `/clients/[id]/settings` | ✅ Full | None | None | ✅ Ready |
| `/clients/[id]/team` | ✅ Read-only | None | None | ✅ Ready |
| `/apps/[id]` (Overview) | ⚠️ Partial | WordPress section | Staging deploy btn (unconditional) | 🔴 High |
| `/apps/[id]/deployments` | ✅ Full | None | Staging deploy btn (unconditional) | 🟡 Medium |
| `/apps/[id]/analytics` | ❌ Stub | Entire page | Deploy btns on analytics page | 🔴 High |
| `/apps/[id]/backups` | ✅ Read-only | None | None | ✅ Ready |
| `/apps/[id]/staging` | ✅ Read-only+DryRun | None | None | ✅ Ready |
| `/apps/[id]/settings` | ✅ Full | None | None | ✅ Ready |
| `/apps/[id]/integrations` | ⚠️ Partial | WP Signals, placeholder | Dead link to advanced | 🟡 Medium |
| `/apps/[id]/team` | ✅ Full | None | None | ✅ Ready |
| `/settings` | ⚠️ Partial | Account, Tokens, Orgs | None | 🟡 Medium |

---

## Prioritized Fix List

### 🔴 High Priority (misleading UX, wrong behavior)

1. **`/apps/[id]` and `/apps/[id]/deployments` — Conditional "Deploy to Staging" button**  
   Both pages show a "Deploy to Staging" / "Sync to Staging" `DeployButton` unconditionally. When `stagingEnabled === false`, this button calls the Coolify deploy API with a staging target that doesn't exist, likely failing silently or creating orphaned deploy attempts.  
   **Fix:** Wrap staging `DeployButton` in a check for `workspace?.stagingEnabled`.

2. **`/apps/[id]/analytics` — Rename or replace with honest placeholder**  
   The page shows deployment counts and a deployment timeline, calling it "Analytics." There are also deploy buttons here, which is wrong UX for an analytics surface.  
   **Fix:** Replace body content with a read-only "Analytics coming soon" state (pending indicator + explanation). Remove the deploy buttons from this page. Keep the deployment count metrics as a factual summary only.

3. **`/apps/[id]/integrations` — Dead link to advanced**  
   The "Open advanced diagnostics" link goes to `/apps/${siteId}/advanced` which now redirects to Settings — losing the intent of showing diagnostics.  
   **Fix:** Update link target to `/apps/${siteId}/settings` or remove it.

### 🟡 Medium Priority (placeholder content, low harm)

4. **`/apps/[id]/integrations` — WordPress Signals placeholder**  
   All three WordPress fields show "not connected" — static strings, no API.  
   **Fix:** Add `PendingBadge` to section heading. Add note about `WP_API_URL` env var requirement.

5. **`/clients/[id]` — Persistent Notes card**  
   Renders static "No stored notes yet." with no form or write path.  
   **Fix:** Add `PendingBadge` to card heading. Keep display-only for now.

6. **`/settings` — Account, API Tokens, Organizations cards**  
   Static placeholder cards.  
   **Fix:** Add `PendingBadge` to each card heading.

7. **`/apps/[id]` — WordPress Overview section**  
   All three WP fields are static "Connect WordPress REST API to show X".  
   **Fix:** Add `PendingBadge` to section heading. Already has inline explanation.

8. **Add last-refreshed timestamps** to Coolify-sourced data on Dashboard, Overview, Deployments.  
   Users cannot tell if health data is stale.

### 🟢 Low Priority / Future

9. **Client Team — No invite CTA**  
   Read-only by design but could confuse admins. Add a note pointing to app-level team management.

10. **Backups — No link to Coolify for operators**  
    When backups are not configured, no actionable link to Coolify dashboard.

11. **Staging — No link when staging env exists but no app**  
    When `staging_environment_exists_no_application`, no actionable path for admin.

12. **Integrations — Non-WP placeholder**  
    "No active integrations" card body is vague. Should explain what will connect here.

---

## Recommended Next Safe Implementation Slice

**Slice: "Honesty pass" — Wire what's missing read-only, kill misleading CTAs**

1. **Condition staging deploy buttons** in Overview and Deployments on `stagingEnabled` (no new data fetches needed, just guard clause)  
2. **Analytics page** — Replace with honest pending state; remove deploy buttons; keep counts-only metric strip  
3. **Add `PendingBadge`** to all static sections (WordPress Overview, WordPress Signals, Persistent Notes, Account/API Tokens/Organizations settings cards)  
4. **Fix integrations dead link** — Point to `/settings` or diagnostics endpoint  
5. **Add `overview.generatedAt` timestamp** to Dashboard and Overview headers as subtle "Data as of X" line

This slice has zero new API surface area, zero new DB writes, and dramatically improves trust in what users are looking at. All changes are local to page/component files.
