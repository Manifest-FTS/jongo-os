# Existing Features — Inventory & Classification (Phase 1)

Classification key: **Keep** (works, leave alone) · **Improve** (works, extend) · **Refactor** (works, restructure internals) · **Replace** (rebuild on new foundation) · **Remove** (delete or move out).

"Working" means: implemented end-to-end against real Coolify/DB, with tests for the pure logic. I did not exercise the live production environment in this phase.

## Platform & access

| Feature | Where | State | Class | Why |
|---|---|---|---|---|
| Email/password sign-in, register, forgot/reset password | `lib/auth.config.ts`, `app/api/auth/*` | Working | **Improve** | Add rate limiting, email verification enforcement, 2FA, OAuth (GitHub/Google) |
| Invitations (org + site) with email | `lib/invitations.ts`, `app/api/invites/*` | Working, validated (`docs/INVITE-*`) | **Keep** | |
| Roles: super_admin / admin / collaborator; org collaborators; site collaborators | `lib/rbac.ts`, `permissions.ts`, `roles.ts` | Working | **Refactor** | Two-level roles are too coarse (no viewer/developer/billing); permissions scattered across `repositories.ts` |
| Tenant access helpers | `lib/tenant-route-access.ts`, `github-route-access.ts`, `domain-access.ts` | Working, tested | **Keep** | Must be applied to *every* route (see S-01) |
| Super-admin access directory | `super-admin/access` | Working | **Keep** | |
| Workspace switcher, favorites | `lib/workspace-switcher.ts` | Working | **Keep** | |
| Audit log | `AuditLog` model | Partial — written by some actions only | **Improve** | Needs to cover every mutation, be org-scoped *and* platform-scoped, and be viewable |
| API tokens | `ApiToken` model | Schema only, no UI/route found | **Improve** | |
| No-auth "dev mode" when `NEXTAUTH_SECRET` missing/default | `middleware.ts`, `api/coolify/deploy` | Dangerous | **Remove** | Fail-open (S-02) |

## Coolify integration

| Feature | Where | State | Class | Why |
|---|---|---|---|---|
| Connection status, overview, diagnostics | `api/coolify/{status,overview,connection}`, `lib/diagnostics.ts` | Working, admin-only | **Keep** | |
| Project/resource import → orgs/sites; ownership sync; hourly reconcile; deletion watcher | `coolify-project-import.ts`, `platform-reconcile*.ts`, `coolify-deletion-watch.ts` | Working | **Improve** | Keep for importing existing infra; new resources should be created *by* Jongo, not imported |
| Rate-limit handling | `coolify-rate-limit.ts`, `rate-limit-retry.ts` | Working, tested | **Keep** | |
| HTTP client | `coolify-core.ts`, `coolify.ts` | Working but 3 divergent fetch paths, boolean results lose errors | **Refactor** | Into one typed client behind a provider interface |
| Mock mode (fake deploy ids when creds missing) | `triggerCoolifyDeploy`, `CoolifyActionResult.mode` | Violates "no mock in prod" | **Remove** | |
| Coolify webhook receiver (HMAC, replay-safe) | `api/webhooks/coolify`, `lib/coolify-webhook.ts` | Working, tested | **Keep** | Feed it into the Operation/status model |
| Deploy trigger | `api/coolify/deploy` | Works, **no tenant check** | **Replace** | S-01; move to `/api/apps/:id/deployments` via Operation |

## Apps / deployments

| Feature | Where | State | Class | Why |
|---|---|---|---|---|
| Create WordPress site in Coolify (`wordpress-with-mariadb`) | `wordpress-provision.ts`, `api/organizations/:id/sites` | Working (service create only) | **Improve** | No automated WP install (admin user/site title), no PHP settings, no idempotency |
| Create app from GitHub repo (GitHub App per org, nixpacks/Dockerfile, env vars, port, base dir) | `github-deploys.ts`, `github-app*.ts` | Working | **Improve** | No install/build/output command overrides, framework detection, Node version, previews |
| Deploy on push / auto-deploy toggle / pending commit | `api/github/webhook`, `github-push-match.ts` | Working | **Keep** | |
| Git sources (multiple per org) | `git-sources.ts` | Working | **Keep** | |
| Deployment list | `sites/[id]/deployments`, `listSiteDeployments` | Partial — reads Coolify history; DB `Deployment` sparsely written | **Replace** | Needs Deployment v2 with logs, duration, commit, rollback |
| Restart | `restartCoolifyService` | Working | **Keep** | |
| Domains on app (Coolify fqdn PATCH + convergence check) | `applyCoolify*Domains` | Working | **Improve** | Needs AppDomain model, DNS verification + TLS status for production domains (exists only for staging) |
| Temporary domains (`*.mfts.link`-style) | `temporary-domains.ts`, `stage-domain.ts` | Working | **Keep** | |
| Analytics page | `sites/[id]/analytics` | Shows deployment/overview data, not traffic analytics | **Improve** | Rename or back with real metrics |
| `apps/*` route tree re-exporting `sites/*` | `app/(platform)/apps` | Duplicate URLs | **Refactor** | Pick one (`apps`) and redirect the other |

## WordPress

| Feature | Where | State | Class | Why |
|---|---|---|---|---|
| Staging: provision copy, DB copy, content sync, promote, custom staging domains with DNS+SSL checks | `coolify-staging-provision.ts`, `staging-*.ts`, `orchestration/staging` | Working, heavily tested, many remediation scripts | **Refactor** | Logic is good; move execution to jobs/Operations so failures are visible and resumable |
| URL search-replace | `wp-url-rewrite*.ts` | Working | **Keep** | Reuse in migration wizard |
| Privacy mode (Basic Auth via Traefik dynamic file) | `privacy-mode*.ts` | Working | **Improve** | Encrypt stored password (S-08); run via job |
| SFTP accounts | `sftp-provision*.ts` | Working | **Improve** | Move off root SSH; audit |
| Plugin inventory / probe | `wordpress-plugin-*.ts` | Working | **Keep** | |
| Cache flush (incl. Cloudflare purge) | `cache-flush.ts`, `cloudflare-purge.ts` | Working | **Keep** | |
| wp-info | `api/sites/:id/wp-info` | Working | **Keep** | |
| WordPress telemetry (collector + bridge providers) | `wordpress-telemetry*.ts` | Working | **Keep** | |
| Security scanning worker | `worker/SecuritySchedulerWorker.ts` | **Placeholder**: empty query, commented dispatch, calls a Coolify endpoint (`/services/{uuid}/execute`) that doesn't exist | **Replace** | Real malware scanning is needed (see infra `tmp_sweep_injected_signature.sh`) |
| Migration / upload | — | Not built | — | See MISSING_FEATURES |

## Backups

| Feature | Where | State | Class | Why |
|---|---|---|---|---|
| Full-site backup (files + DB dumps → one restic snapshot in B2), labels, schedule, retention (`restic forget`) | `scripts/site-backup.mjs`, `backup-*.ts`, `restic-forget.ts` | Working | **Refactor** | Execution model (detached script over SSH → callback) should become a queued job |
| Restore, restore verification/rehearsal, download | `site-restore.mjs`, `backup-rehearsal*` | Working | **Keep** (logic) / **Refactor** (execution) | |
| Coolify DB backup schedule reconcile | `coolify-backups.ts` | Working | **Keep** | |
| Backup posture/readiness, Slack/email alerts with rate limit | `backup-*`, `deploy-guards.ts` | Working | **Keep** | |

## Domains (registrar)

| Feature | Where | State | Class | Why |
|---|---|---|---|---|
| Domain search, pricing, quote, checkout (Stripe), Namecheap sync, DNS records via Cloudflare, managed-domains admin | `domain-*.ts`, `namecheap*.ts`, `cloudflare.ts` | Working | **Keep** | Separate concern from "connect a domain to an app" |
| Parked domains page | `middleware.ts`, `app/parked` | Working | **Keep** | |

## Usage, billing, notifications

| Feature | Where | State | Class | Why |
|---|---|---|---|---|
| Usage collection (hourly per container + host disk) | `usage-*.ts`, `scripts/usage-collect.sh` | Working (SSH `docker stats`) | **Improve** | Correct source of measurable data; needs per-org rollups and quotas |
| Stripe subscription (per user) + webhook | `stripe.ts`, `api/billing/*` | Working | **Refactor** | Move subscription to Organization |
| Client billing (manual/Bonsai/Stripe/exempt) | `client-billing*.ts` | Working (agency receivables) | **Keep** | Agency feature; distinct from platform billing |
| Public plans | `public-plans.ts` | Static plan catalogue | **Improve** | Tie limits to enforced quotas |
| Notifications, broadcasts, templates, preferences | `notifications.ts`, `services/notifications` | Working | **Keep** | |

## Other

| Feature | Where | State | Class | Why |
|---|---|---|---|---|
| CMS (Sanity replacement: datasets, revisions, releases, outbox, media) | `lib/cms/*`, 14 models | Working, tested | **Remove (move out)** | Unrelated to hosting control plane; extract to its own service/package when convenient — no urgency |
| Public marketing site, SEO, llms.txt | `app/{hosting,pricing,…}` | Working | **Keep** | |
| One-off remediation scripts (`scripts/remediate-*`, `repair-*`, `*.sql`), infra `tmp_*.sh` | `scripts/`, `coolify-infrastructure/` | Historical fixes | **Remove** (archive) | Replace recurring ones with reconcilers/jobs |
| Host reconcilers (bash + systemd on Coolify host) | `jongo-os/coolify/` | Working | **Refactor** | Fold into worker jobs / host agent |
