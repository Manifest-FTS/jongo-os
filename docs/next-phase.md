# Next Phase: Coolify ⟷ Jongo OS Sync Hardening

Handoff doc for whoever (GitHub Copilot or otherwise) picks this up next.
Written 2026-08-19 after a live incident-response pass. Read this top to
bottom before touching code — it explains what was already fixed, what was
verified working, and what is still genuinely open.

## 0. Context: the Coolify migration

Coolify was migrated from a single combined server (5.78.216.68) to its own
dedicated control-plane server (5.78.204.111, `devops.manifest-fts.com`).
5.78.216.68 remains the production worker that actually runs client sites
(WordPress containers, Jongo OS itself, etc.) and is now managed remotely by
the new control plane over SSH. This migration was already tested/verified
working and is NOT the subject of this document — see
`docs/coolify-server-ssh-key.md` for that setup. Everything below concerns
keeping Coolify (the worker at .68) and Jongo OS's database in sync now that
they're split across two servers.

## 1. What was already fixed (done, deployed, verified live)

Two commits, pushed directly to `main` (no PR — this was an active outage
fix, not a review-cycle change):

### Commit `2968705` — fix(build): remove duplicate root `next` dependency
Root `package.json` had `"next": "^15.5.23"` alongside `apps/web`'s pinned
`"next": "15.5.9"`. A clean `npm ci` (what Coolify's build always does)
installed two incompatible copies of Next.js, breaking the `NextRequest` type
in `src/app/api/coolify/deploy/route.ts` and failing every deploy since
2026-08-12. Removed the redundant root dependency, regenerated
`package-lock.json`. Never reproduced locally because local `node_modules`
had already deduped from an earlier install — always reproduced in Coolify's
clean-room build.

### Commit `318bc1d` — fix(sync): stop self-fetch "fetch failed" errors in the deletion watcher
Once the build was fixed and redeployed, the Coolify deletion watcher
(`/api/ops/coolify-deletion-watch`, ticked every 60s by
`scripts/coolify-deletion-watcher.mjs`) still failed on every confirmed
deletion. Root cause: it applied a deletion by having the route handler
`fetch()` its own server's `/api/webhooks/coolify` endpoint over HTTP — a
known source of intermittent failures in Next.js route handlers. Fixed by
extracting the shared apply logic into `lib/coolify-webhook.ts` as
`applyCoolifyDeletion(db, ...)`, called in-process by both
`/api/webhooks/coolify` and the deletion watcher instead of one calling the
other over the network. Added `coolify-webhook-apply.test.ts` (5 tests).

Both commits are on `origin/main` — verify with:
```
git log --oneline -5
git ls-remote origin main   # confirms GitHub's actual ref, not just local cache
```

### Also done in this pass (no code change)
- Restored `gardenstateequality.org` (Jongo site `gardenstateequality-org`),
  which had been incorrectly soft-deleted with no audit-log entry — almost
  certainly a side effect of the two bugs above interfering with
  reconciliation over several days while it was live and healthy in Coolify.
  Audit log entry added explaining the restore.
- Added a 2GB swapfile + `vm.swappiness=10` on the control-plane server
  (5.78.204.111), persisted via `/etc/fstab`. That box is a 2 vCPU / 1.9GB RAM
  VPS with no swap that had been running Coolify builds; this targets the
  reported "Coolify UI sometimes takes 10-15s, occasionally over a minute"
  symptom. No confirmed OOM kills were found in logs, so treat this as a
  plausible mitigation, not a proven root-cause fix — keep an eye on it.

### Verified live, after both fixes deployed
- Full audit of Jongo → Coolify direction (44 non-deleted Jongo sites with a
  Coolify UUID, checked against the live 62-resource Coolify index with
  correct project/environment resolution): **0 ghosts, 0 project mismatches.**
  Deletions genuinely sync now.
- The deletion watcher and backup-reconcile scheduler are both running in the
  live container and ticking correctly.

**Do not re-litigate #1 above or the ghost-record question — it's confirmed
clean as of this writing.** The open work below is genuinely new, not a
re-check of what's already fixed.

## 2. Open item A: destroying staging may leave a paired resource orphaned in Coolify

**Not confirmed as a live bug** — this came up because a site
(`staging-wptest`) was misread during this pass as an orphan; it turned out
to be a real, live, correctly-mapped production resource, so that specific
case was a false alarm. But investigating it surfaced a real design gap worth
checking before it causes an actual orphan:

`destroyCoolifyApplication(uuid, resourceKind)` in `lib/coolify.ts` deletes
exactly one Coolify resource by UUID (trying `/api/v1/applications/{uuid}`,
`/api/v1/services/{uuid}`, or `/api/v1/databases/{uuid}` depending on
`resourceKind`, falling back to `/api/v1/resources/{uuid}`). It is called
from the staging-disable path in `app/api/sites/[siteId]/staging/route.ts`
(`shouldDestroy` / `destroyCoolifyApplication(capability.applicationUuid,
capability.resourceKind)` around line 1768) with only the single
`applicationUuid` Jongo detected as "the staging target."

The concern: some staging targets are provisioned as a Coolify **service**
with multiple sub-resources (e.g. a WordPress app + its own MariaDB), and
`platform-reconcile.ts` / `backup-reconcile`'s "nest database resources"
logic (see `resolveCoolifyDatabaseUuids` and the `databasesNested` counter in
`/api/ops/backup-reconcile/route.ts`) already assumes standalone databases
can be registered as *separate* Coolify resource UUIDs linked to an owning
app. If a staging target's database is one of these separately-registered
resources rather than a sub-container of the same `service` UUID,
`destroyCoolifyApplication` would only delete the app-level resource and
leave the paired database resource running (and billing/consuming disk) in
Coolify, undetected by Jongo until/unless something else notices it.

**Task for next phase:**
1. Confirm whether Coolify's `DELETE /api/v1/services/{uuid}` already cascades
   to sub-containers within that same service (likely yes — verify against a
   real staging teardown, not just docs) vs. only affecting resources that
   are genuinely separate top-level Coolify resources (per
   `resolveCoolifyDatabaseUuids`).
2. If separate linked-database resources exist for a staging target, extend
   the staging-disable destroy path to also destroy those, mirroring the
   nesting logic already in `backup-reconcile`'s `resolveCoolifyDatabaseUuids`
   walk.
3. Add a post-destroy verification step (similar to the existing
   `afterDestroyProbe` in `staging/route.ts`) that checks for orphaned linked
   database resources specifically, not just the primary target.
4. Regression-test against a real staging enable → disable cycle on a
   WordPress+DB staging target, confirming zero resources remain in Coolify
   afterward.

## 3. Open item B: Coolify → Jongo is one-way (deletions only), not bidirectional

This is the real, confirmed gap — not a false alarm.

**What already works (verified):** Coolify deletions sync to Jongo
automatically within minutes (the deletion watcher fixed in commit `318bc1d`
above), with a 7-day grace-period archive as a slower backstop
(`backup-reconcile`'s `decideSiteArchive`).

**What does NOT exist:** any automatic sync of *new* Coolify resources into
Jongo, or of resource *changes* (renames, domain changes, project
reassignment) from Coolify back into Jongo.

Confirmed by a live audit at the time of writing: **21 of 62 live Coolify
resources have no Jongo record at all**, including resources that look like
real client apps — `Aaron & Christian`, `PitsFinder`,
`Gimmee Power Guitar Cables`, `South Orange Historical Preservation Society`,
`Tom Tom Home Improvement`, `LB Car Service` (x2), `MFTS Link`, `Optum` /
`Optum Pricer` / `Account Optum`, `Spin Clip`, `FB App`, `Game Dev`, a
standalone Postgres database, plus some staging/test apps
(`manifestfts staging`, `joyfeed.app staging`, `Barclayrex Staging`,
`staging-fdsfdsfdsfdsfsfsdfdsf`, `empires:main-...`, `sanity-expo-native-app`).

The code to do this partially exists but is disconnected:
`importLinkedCoolifyProjectSites(organizationId)` in
`lib/coolify-project-import.ts` already does org-scoped import (matches
Coolify apps in an org's linked project(s) against existing Jongo sites by
name/UUID, creates missing ones, reconciles backup schedules) — it has a full
test suite (`coolify-project-import.test.ts`) — but **nothing calls it**. It
is not wired to any route or scheduled job.

**Task for next phase:**
1. Decide the ownership-assignment policy for a Coolify resource that has no
   existing org/project mapping at all (several of the 21 above don't
   obviously belong to any currently-linked Jongo organization). Options:
   - Auto-create an "Unmapped"/orphaned bucket per the existing
     `ownershipState: "orphaned"` concept already in `repositories.ts`, and
     surface it in the UI for a human to assign, OR
   - Require an explicit org↔Coolify-project link
     (`OrganizationCoolifyProjectLink`) before import runs for that project,
     and simply report unmapped-and-unimportable resources as a diagnostic
     count somewhere visible (dashboard, ops report), OR
   - Some hybrid. This is a product decision, not just an engineering one —
     get sign-off before building.
2. Wire `importLinkedCoolifyProjectSites` (or a generalized version of it
   that also covers project-level auto-detection, not just orgs with an
   existing link) into the hourly reconcile pass in
   `/api/ops/backup-reconcile/route.ts`, following the same pattern already
   used there: budget-limited per pass, rate-limit aware
   (`isRateLimited`/`isRateLimitError`), and reported in the JSON response
   under a new section (mirroring `lifecycle`, `scheduledBackups`, etc.).
3. Decide and implement sync for resource *edits* from Coolify (renamed app,
   domain change, moved to a different project/environment) — currently
   Jongo's `coolifyProjectId`/`coolifyProjectName`/`name` fields are set once
   at creation/import and never refreshed from Coolify afterward except via
   the stale-mapping repair in `platform-reconcile.ts` (which only fires when
   a UUID goes stale, not on a same-UUID rename/move). Decide which fields
   should be Coolify-authoritative-always vs. Jongo-editable-and-sticky, then
   implement a periodic refresh for the authoritative ones.
4. Add tests following the existing patterns (`coolify-project-import.test.ts`
   for the importer, `platform-reconcile.test.ts` for the reconciler-style
   pure-logic split) and verify against a real reconcile pass before
   deploying.

## 4. How to verify anything in this doc yourself

Coolify API base URL, token, and Jongo's DB creds are all available as env
vars inside the running Jongo container — see `scripts/db-tunnel.sh` and
`.env.local` for the pattern. The live Jongo OS container runs on
5.78.216.68; Coolify's control plane API is at `devops.manifest-fts.com`
(5.78.204.111). Both are reachable via passwordless root SSH already set up
for this project (see `docs/coolify-server-ssh-key.md`).
