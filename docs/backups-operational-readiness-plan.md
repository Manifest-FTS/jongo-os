# Backups + Operational Readiness UX - Implementation Plan

**Date:** 2026-05-18  
**Status:** IN PROGRESS (dry-run UX active; execution still disabled)  
**Scope:** Improve backup visibility and operational confidence for deploy/sync/promote actions

## Production Validation Note (2026-05-21)

- Backup readiness guard UX validated in production for live apps.
- Observed lock state in current production data: `Backups not configured` and `No successful backup found` diagnostics.
- Implemented but not currently observable in production data:
  - `Backup telemetry unavailable`
  - `Backup stale`
- Keep these variants implemented and covered by local/controlled test scenarios until production data surfaces them naturally.
- Deployments page resource workflow model card validated in production:
  - Web App copy confirmed on `/apps/jongo-open-source/deployments`
  - WordPress copy confirmed on `/apps/airbb-wordpress/deployments`
  - Card stays informational only; execution controls remain dry-run/disabled
- Follow-up fix shipped for resource-type mapping:
  - `fix(site-type): classify database and service resources in workspace` (`e593c77`)
  - This resolves Database/Service workspaces falling back to Web App copy due legacy `siteType` narrowing.
  - Authenticated production browser validation confirms Database mapping now resolves correctly (e.g. `/apps/pdb-jongo-saas-prod/deployments` shows Database workflow model copy).
  - Authenticated `/api/coolify/overview` currently reports `siteType=database` for database resources and no `siteType=service` resources in live inventory (service matrix check pending when one is present).

---

## Goals

1. **Make backup state feel operationally trustworthy** — clear protection status, last success timestamp, failure visibility
2. **Improve backup visibility before enabling destructive actions** — stronger pre-flight checks for deploy/sync/promote
3. **Dry-run operational UX** — previews of what will happen without execution
4. **No execution** — this pass is observation & preview only; no actual restore/promote/sync yet

---

## Resource-Type Staging Model Direction

Jongo should not treat all resource types as the same staging workflow.

### WordPress staging model (future)

- Should feel similar to Flywheel clone-style staging.
- Primary workflow: clone production WordPress site to staging.
- Use cases:
  - plugin testing
  - theme testing
  - WordPress/core updates
  - content/layout checks
  - maintenance workflows
- Future actions:
  - Create Staging from Production
  - Sync Production to Staging
  - Push Staging to Production
  - Selective DB/media pull (later)
- Execution requirements:
  - backup readiness required before execution
  - admin/operator control required initially

### Next.js / Nixpacks / web app staging model (future)

- Should feel more like Vercel preview deployments.
- Primary workflow should be branch/PR/environment based.
- Use cases:
  - preview a branch
  - test before merging to main
  - temporary preview URL
- Do not model this as WordPress clone staging.
- Prefer preview/staging environments created from git branches when Coolify supports it.

### Database resource model

- Do not show website-style staging UX.
- Prioritize backup/restore/readiness UX.

### Service resource model

- Do not default to website-style staging UX.
- Prioritize service health, restart readiness, and log-readiness UX.

### Staging visibility rule (current)

- If staging is not enabled/configured, do not show staging-heavy sync/promote CTAs across primary app pages.
- Keep staging discoverable via Settings and lightweight Overview messaging.
- Staging page should show `Staging not configured` explanation and setup path.
- Do not show production/staging sync/promote controls unless staging exists.
- Keep execution dry-run/disabled only; do not create resources or trigger sync/promote from UI in this phase.

---

## Current State Assessment

### What Currently Works ✅
- Backup inventory fetch from Coolify (schedules, execution history)
- Protection status display (protected/unprotected/unknown)
- Recent execution history display (success/failed status)
- Schedule visibility (frequency, retention)
- Diagnostic panel (admin-only detail)
- Staging sync dry-run plan display (already built)
- Deploy button with mock-safe checks

### What Needs Improvement ⚠️

#### 1. Backup Visibility Polish
- [ ] **Backup status hierarchy:** Should clearly indicate:
  - Last successful backup timestamp (prominent)
  - Time since last backup (human-readable: "5d ago", "never")
  - Next scheduled backup (when available)
  - Failure chain visibility (if last 3 are failed, show warning)
- [ ] **Retention visibility:** 
  - Show "keeping X of Y backups" instead of just config values
  - Indicate if retention policy is strict enough for disaster recovery (< 7 days?)
- [ ] **Protected/Unprotected clarity:**
  - Distinguish between "configured but no recent success" vs "configured and healthy"
  - Add sub-state: Protected (recent), Protected (stale), Unprotected
- [ ] **Database + App backup grouping:**
  - If app has multiple databases, group by database with individual health per DB
  - Show: database name, last backup, retention policy, status
- [ ] **Backup failure visibility:**
  - If recent backup failed, highlight with actionable message
  - Show error reason (from Coolify) if available

#### 2. Operational Readiness Indicators
- [ ] **Pre-deploy/sync/promote readiness checks:**
  - Backup configured? ✓
  - Recent successful backup? ✓
  - Staging environment configured? ✓
  - Domain health OK? ✓
  - SSL certificate healthy? ✓
  - No ongoing deployment? ✓
- [ ] **Readiness status display:**
  - Add "Operational Status" card to app overview/settings
  - Show each check as: ✓ OK | ⚠ Warning | ✗ Blocker
  - UI should communicate: "not ready to deploy" clearly if any blockers
- [ ] **When to gate deploy/sync/promote:**
  - Block execution if: no backup configured OR last backup failed
  - Warn (but allow) if: backup older than N days (configurable per policy)
  - Allow with info if: all checks pass

#### 3. Dry-Run Operational UX
- [ ] **Staging sync preview** (already exists, needs polish):
  - File changes summary
  - Database behavior (snapshot/skip)
  - Domain routing (staging/temp domain)
  - Risk/warning list
  - Button: "This is a preview. No changes will be made."
- [ ] **Promote preview** (NEW):
  - Show what staging→production would do
  - DB snapshot + overwrite preview
  - Domain routing changes (staging→production)
  - Risk assessment
  - Button: "This is a preview. No changes will be made."
- [ ] **Restore preview** (FUTURE SCOPE):
  - Pick a backup, show what restore would do
  - Backup age, retention policy compliance
  - Data loss timeline
  - But: don't enable actual restore yet
- [ ] **Dry-run UX pattern:**
  - Consistent banner: "Preview mode — no changes will be made"
  - Disabled action buttons
  - Clear "Next steps" messaging: "When ready, use Coolify console to execute"

#### 4. Constraints to Keep ✅
- [ ] Fail-closed access: Non-admin cannot see deploy/sync buttons
- [ ] Admin-only diagnostics: Raw JSON, timestamps, debug info in collapsed details
- [ ] No destructive actions: Block execute, show preview only
- [ ] No server-side exceptions: All Coolify fetch errors caught, shown to user
- [ ] No unauthenticated mutations: All actions require session + role check

---

## Implementation Roadmap

### Phase 1: Backup Visibility Polish (HIGH PRIORITY)
**Files to modify:**
- `apps/web/src/app/(platform)/sites/[siteId]/backups/page.tsx`
- `apps/web/src/lib/coolify.ts` (if needed for new data extraction)
- `apps/web/src/lib/reason-messages.ts` (backup status messaging)

**Tasks:**
1. Extract "last successful backup" timestamp from recentExecutions
2. Calculate "time since last backup" display
3. Add "next scheduled backup" calculation (from schedule + last execution)
4. Detect "failure chain" (last 3 executions all failed?)
5. Group multiple databases with individual health display
6. Add retention adequacy check (7 day minimum? configurable)
7. Update protection status to include (recent/stale) substates
8. Create visual hierarchy: Protection status → Recent backup → Schedule → Executions

**Validation:**
- Type-check passes ✓
- Build passes ✓
- Backup states accurate (no fabricated timestamps) ✓
- No fake controls ✓

### Phase 2: Operational Readiness Indicators (MEDIUM PRIORITY)
**Files to create/modify:**
- Create: `apps/web/src/components/OperationalReadinessPanel.tsx`
- Modify: `apps/web/src/app/(platform)/sites/[siteId]/page.tsx` (app overview)
- Modify: `apps/web/src/app/(platform)/sites/[siteId]/settings/page.tsx` (settings)
- Modify: `apps/web/src/lib/coolify.ts` (add health probe for SSL, domain)

**Tasks:**
1. Define readiness check interface:
   ```typescript
   type ReadinessCheck = {
     id: string;
     label: string;
     status: "ok" | "warning" | "blocker";
     message?: string;
     docLink?: string;
   };
   ```
2. Implement checks:
   - Backup configured (from AppBackupInventory.configured)
   - Recent successful backup (from recentExecutions, < 7 days?)
   - Staging configured (from getStagingCapability)
   - Domain healthy (new: attempt DNS resolve)
   - SSL certificate healthy (new: fetch cert expiry)
3. Create OperationalReadinessPanel component
4. Add to app overview (info card)
5. Add to settings (gating info before deploy/sync buttons)

**Validation:**
- Type-check passes ✓
- Build passes ✓
- Health probes don't hang or throw ✓
- No unauthenticated health checks ✓

### Phase 3: Dry-Run Operational UX (LOW PRIORITY)
**Files to modify:**
- `apps/web/src/components/DeployButton.tsx` (add preview mode)
- `apps/web/src/app/(platform)/sites/[siteId]/staging/page.tsx` (improve preview)
- Potentially create: `apps/web/src/components/OperationalPreviewPanel.tsx`

**Tasks:**
1. Update DeployButton to show "dry-run preview" mode
2. Improve staging sync preview styling (clear banner, disabled buttons)
3. Add promote preview (once staging capability exists)
4. Restore preview (stub only, no execution wiring)
5. Consistent messaging: "Preview mode — no changes will be made"

**Validation:**
- Type-check passes ✓
- Build passes ✓
- No server-side execute calls ✓
- All buttons properly disabled ✓

---

## Data Flow Diagram

```
App Overview Page
  ├─ getSiteWorkspace()
  │  └─ Site: name, coolifyServiceUuid, coolifyProjectId, stagingEnabled, status
  ├─ getCoolifyAppBackupInventory(uuid)
  │  └─ BackupInventory: configured, schedules[], recentExecutions[], source, note
  ├─ getStagingCapability(uuid, projectId)
  │  └─ StagingCapability: detected, environmentName, applicationName, status
  ├─ [NEW] fetchCertificateHealth(fqdn?)
  │  └─ CertificateHealth: healthy, expiresAt, daysUntilExpiry
  └─ [NEW] fetchDomainHealth(fqdn?)
     └─ DomainHealth: resolvable, recordCount, verified

OperationalReadinessPanel
  ├─ Check: Backup Configured → BackupInventory.configured
  ├─ Check: Recent Backup → recentExecutions[0].status === 'success' && age < 7d
  ├─ Check: Staging Configured → StagingCapability.detected
  ├─ Check: Domain Health → DomainHealth.resolvable
  └─ Check: SSL Health → CertificateHealth.healthy

Deploy/Sync/Promote Buttons
  ├─ Read OperationalReadiness checks
  ├─ If blocker exists: disable button, show reason
  ├─ If all pass: enable button with confirmation preview
  └─ [LATER] Show dry-run → execute flow
```

---

## UI Component Sketches

### Backup Status Panel (Enhanced)
```
┌─────────────────────────────────────────────────────┐
│ Backups                                   Protected │
│ Database + app protection status                    │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Last Successful Backup: 2d ago                      │
│   Database: maindb  |  2d ago  |  healthy          │
│   Database: cache   |  5h ago  |  healthy          │
│                                                     │
│ Next Scheduled: In 18 hours (nightly 2am)          │
│ Retention: Keeping 8 of 30 backups                 │
│                                                     │
│ Recent Executions:                                  │
│   ✓ 2d ago  | maindb_20260516.sql    | success     │
│   ✓ 2d ago  | cache_20260516.sql     | success     │
│   ✓ 3d ago  | maindb_20260515.sql    | success     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Operational Readiness Card
```
┌─────────────────────────────────────────────────────┐
│ Operational Status                                  │
├─────────────────────────────────────────────────────┤
│                                                     │
│ ✓ Backup Configured        Ready to deploy         │
│ ✓ Recent Backup            (2d ago)               │
│ ✓ Staging Environment      Detected               │
│ ✓ Domain Health            DNS resolving          │
│ ✓ SSL Certificate          Expires in 89d         │
│                                                     │
│ Status: Ready to deploy                            │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Deploy Preview Banner
```
┌─────────────────────────────────────────────────────┐
│ ⓘ  PREVIEW MODE - No changes will be made          │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Staging Sync Plan:                                 │
│   • Files: 147 files in 3 directories              │
│   • Database: Snapshot + overwrite (maindb)        │
│   • Domain: staging.example.com → staging domain  │
│                                                     │
│ ⚠ Warnings:                                         │
│   • Database operations will be blocked during sync│
│   • Staging has 3 days of stale data               │
│                                                     │
│ [Proceed to Coolify Console to Execute]  [Cancel]  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## Success Criteria

✅ **All validation checks pass:**
- TypeScript: 0 errors
- Build: Clean production build
- Production: 0 critical errors in logs
- Backup states: Accurate timestamps, no fabricated data
- UI honesty: No fake editable fields, all controls properly styled
- No regressions: Existing deploy/sync/staging features still work

✅ **Backup visibility improved:**
- Users can see last successful backup at a glance
- Failure chains are highlighted
- Database-level backup health visible
- Retention policy adequacy shown

✅ **Operational readiness visible:**
- Before deploy/sync, users see readiness checks
- Blockers prevent execution (UI disabled)
- Warnings allowed but communicated
- All checks fetch real data from Coolify

✅ **Dry-run UX consistent:**
- Staging sync, promote, restore all show "preview mode" banner
- No actual mutations
- Clear next steps communicated

---

## Future Follow-Up (Out of Current Scope)

- [ ] Actual restore execution (requires restore API wiring + confirmation UX)
- [ ] Actual promote execution (requires Coolify API sync + careful staging/prod validation)
- [ ] Backup restore scheduling (pick backup, schedule time, execute)
- [ ] Backup policy override (admin-only: force deploy despite stale backup)
- [ ] Backup retention tuning UI (per-database configuration)
- [ ] Disaster recovery runbook integration (link to docs)

