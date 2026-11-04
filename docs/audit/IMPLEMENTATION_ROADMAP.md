# Implementation Roadmap (Phase 1 output)

Principle: **evolve, don't rewrite.** Keep Next.js + Prisma/Postgres + NextAuth + Coolify. Add the missing foundation underneath the existing UI, then build features on it. Every phase ships behind the current app without breaking existing clients on jongo.app.

## 0. Decisions (made 2026-11-04)

1. **Who provisions:** agency-managed now; self-serve later behind plan limits.
2. **Queue:** pg-boss on the existing Postgres. No Redis or other paid service.
3. **CMS:** stays in place.
4. **Servers:** one shared Coolify server for all customers.

Constraint: use only existing resources — nothing new to buy or host.

## Phase 2 — Security fixes & foundation (first)

**2a. Critical fixes (do immediately, small PRs)**
- S-01 tenant check on deploy; sweep all routes for client-supplied Coolify ids.
- S-02 remove fail-open auth; boot-time env validation (zod) that refuses weak/missing secrets in production.
- S-07 remove mock mode.
- S-04 dedicated encryption key with key id.
- S-06 auth rate limiting; S-09 constant-time compares.
- Fix the 2 failing CMS import tests.

**2b. Foundation**
- `Operation` model: `id, orgId, projectId?, resourceType, resourceId, kind, status (queued|running|succeeded|failed|cancelled), steps JSON, idempotencyKey @unique, attempts, error, actorId, timestamps`.
- *Done:* pg-boss worker (`scripts/worker.mjs`, queue in schema `pgboss`), started inside the web container by default (`JONGO_WORKER_MODE`). The 4 schedulers now run as cron jobs on it, one run at a time across restarts and containers.
- *Done:* `Operation` model and `lib/operations.ts` (idempotent create, forward-only status).
- *Done:* deploys run as operations (`lib/deploy-operation.ts`): one at a time per app and environment, start retried only when hosting refused it, build followed to the end via Coolify's `GET /deployments/{uuid}`, progress on the deploy button.
- SSE endpoint `/api/events?scope=…` backed by Postgres `LISTEN/NOTIFY`; replace `setInterval` polling component by component.
- Typed Prisma client (drop the `any` wrapper).
- Env/config module (one place that reads `process.env`).

## Phase 3 — Tenancy, orgs, teams
- Add `Project` between `Organization` and resources; backfill one default project per org mapped to its existing Coolify project.
- Roles: owner, admin, developer, viewer, billing (map current admin→admin, collaborator→developer). Central `can(principal, action, resource)`; retire ad-hoc checks in `repositories.ts`.
- Audit log on every mutation (via Operation), org-visible audit page.
- Move subscription from `User` to `Organization` (migration keeps existing user subscriptions attached to their owned orgs).
- 2FA (TOTP), session revocation.

## Phase 4 — Coolify integration layer
- `InfrastructureProvider` interface: `projects`, `apps`, `services`, `databases`, `servers`, `deployments`, `domains`, `envs`, `logs`, `backups`.
- `CoolifyProvider`: one request function (timeouts, rate-limit cooldown, typed errors, structured logging, no boolean results). Port `coolify.ts` functions one by one; keep exported names as thin wrappers until callers move.
- Capability detection from `/api/v1/version`; record unsupported operations explicitly.
- Idempotency: tag every Coolify resource with the Jongo resource id (Coolify tags API); before create, look up by tag.
- Webhook + periodic reconciler update `Operation` and resource status.
- `HostOps` interface with a fixed command catalogue (backup, restore, wp-cli subset, file ops in volume, privacy-mode file, metrics). Runs in worker only. Non-root user + sudo-restricted wrappers; pinned host key.

## Phase 5 — Application deployment
- New `Application` (or reshape `Site` with a `kind`), `BuildConfig`, `EnvironmentVariable` (encrypted), `Deployment` v2 (`status, commitSha, message, author, branch, startedAt, finishedAt, durationMs, coolifyDeploymentUuid, logsCursor, trigger`).
- Framework detection from repo contents → defaults for build pack, install/build/start/output, port, Node version; user overrides.
- Deploy / redeploy / cancel / restart / rollback (pinned commit redeploy), history, live build logs via SSE, runtime logs.
- GitLab + Bitbucket: OAuth on our side, deploy-key into Coolify, our own webhooks.
- Preview deployments (after verifying Coolify preview behaviour with our GitHub App; fallback = ephemeral app per PR with TTL).
- Production custom domains (generalise staging DNS/TLS checks).

## Phase 6 — WordPress hosting & migration
**New site:** Operation steps → create `wordpress-with-mariadb` service (exists) → wait healthy → `wp core install` with chosen title/admin (password generated or user-set, shown once) → apply PHP profile (upload/memory limits) → set domain → TLS probe → done. Idempotent at each step.

**Migration wizard:**
1. Upload: browser → S3/B2 multipart presigned upload (resumable, chunked, size-limited); server never proxies bytes. SFTP drop as alternative (SFTP feature exists).
2. Inspect job: scan archive (zip-slip, size bomb, ClamAV), detect layout (full WP root / wp-content only / known backup formats such as All-in-One WP Migration `.wpress`, Duplicator, UpdraftPlus — support added per format, explicitly listed), find `.sql`, read `wp-config.php` table prefix.
3. Create target site (as above, no install).
4. Import files into volume (preserve our `wp-config.php`, write DB creds from our side).
5. Import SQL via mariadb client in the DB container.
6. URL replace (`wp search-replace`, reuse `wp-url-rewrite.ts`), serialised-safe.
7. Permissions fix (owner `www-data`, 755/644).
8. Validate: HTTP check on temporary domain, PHP error log scan, admin login page reachable.
9. Review on temporary domain (privacy mode on by default).
10. Go live: DNS instructions → verify → attach domain → TLS → optional final URL replace.

**Management:** reuse staging, backups, plugins, SFTP, cache flush; add redirects (Traefik middleware like privacy mode), WP cron via Coolify scheduled tasks, core/plugin updates via wp-cli with automatic pre-update backup, file manager (volume-scoped), malware scan job.

## Phase 7 — Databases
Standalone DB product on Coolify `/databases/*`: create, credentials (encrypted, reveal audited), internal/external connection strings, public toggle, logs, restart, backups to S3, restore, typed-name delete confirmation.

## Phase 8 — Domains & SSL
Unified `AppDomain` model (apex/www/subdomain, redirect target, verification token, DNS status, TLS status/expiry, lastCheckedAt). Provider-specific DNS instructions (Cloudflare proxy caveats, GoDaddy, Namecheap, generic). Background re-verification and expiry alerts. Keep registrar domains (existing) as a separate feature that can auto-configure DNS when we control it.

## Phase 9 — Logs, monitoring, deployment management
SSE log streaming, health checks, uptime history (integrate existing Uptime Kuma or built-in prober), failed-deploy diagnostics (known error patterns → guidance), server area for admins (Coolify servers API + Sentinel/host collector metrics).

## Phase 10 — Backups & restore
Unified `BackupPolicy` (resource, schedule, retention, destination) over three executors: restic (WP/app volumes — existing), Coolify DB backups, Coolify volume backups if verified. Customer S3 destinations. Restore history and verification UI. Execution moves to worker jobs.

## Phase 11 — Billing, usage, quotas
Org plans with limits enforced on create; metering from existing usage collector (CPU/RAM samples), storage (volume + backup bytes), deployments, members. No bandwidth billing until it's measured. Stripe metered/usage records only from verified rollups.

## Phase 12 — Hardening & production readiness
Host agent replacing SSH, per-site Docker networks + resource limits, upload scanning, SSRF guard, Playwright E2E for core flows, integration tests against a disposable Coolify, load test of worker/SSE, runbooks, archive one-off remediation scripts.

## Priority order (if you only do the top of the list)
1. S-01, S-02, S-07 (days) — production risk today.
2. Job queue + Operation model + worker.
3. Coolify provider refactor (incremental).
4. Project + roles + org billing.
5. App deploy experience (framework detection, logs, rollback, domains).
6. WordPress install automation + migration wizard.
7. Databases product.
8. Everything else.
