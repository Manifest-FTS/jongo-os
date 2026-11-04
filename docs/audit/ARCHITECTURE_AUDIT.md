# Architecture Audit — Jongo (Phase 1)

Date: 2026-11-04 · Branch audited: `stage` @ `d8381ba` · Scope: `jongo-os/` (the product), with `coolify/` (upstream Coolify source, 4.2.0) and `coolify-infrastructure/` (ops scripts) as context.

## 1. What this codebase actually is

Jongo today is a **managed-WordPress agency portal sitting on top of one existing Coolify instance**. It is not yet a self-serve deployment platform.

- Platform admins connect Jongo to a Coolify server, then **import** Coolify projects as "clients" (`Organization`) and Coolify resources as "apps" (`Site`).
- Clients get a polished, Coolify-free view of their apps: backups, staging, domains, team, usage, plugins.
- Most of the hard engineering went into WordPress operations (staging copy/sync/promote, restic backups to B2, URL rewrite, privacy mode, SFTP) and into making Coolify's API quirks reliable.

That foundation is real and mostly solid. The gap to the product vision is in **self-serve provisioning, the job system, the data model and a few serious security holes**, not in the choice of stack.

## 2. Stack

| Layer | Technology | Notes |
|---|---|---|
| Monorepo | npm workspaces + Turborepo | One app (`apps/web`); `packages/*` is empty |
| Web + API | Next.js 15 App Router, React 18, TypeScript | 107 API route handlers, 62 pages |
| Styling | Tailwind 3 + custom CSS tokens | No component library; ~75 hand-built components |
| DB | PostgreSQL 16 + Prisma 5 | 1,602-line schema, 54 migrations, 52 models |
| Auth | NextAuth v4, credentials provider, JWT sessions, bcrypt | No OAuth sign-in, no 2FA |
| Payments | Stripe (subscriptions + domain checkout) | Billing is per **User**, not per organization |
| Email | nodemailer / SMTP | |
| Infra engine | Coolify REST API (single global token) **plus SSH to the Coolify host as root** | See §5 |
| Backups | restic → Backblaze B2, run over SSH on the host | |
| DNS / registrar | Cloudflare API, Namecheap XML API | |
| Tests | Vitest — 138 files, 2,191 tests | 2 failing (CMS import CLI test, `MODULE_NOT_FOUND`); `tsc --noEmit` clean |
| Deploy | Dockerfile (node:20-alpine + openssh-client), deployed via Coolify | |

## 3. Code layout

```
apps/web/src/
  app/(platform)/       authenticated dashboard (sites/*, apps/* re-exports sites/*)
  app/api/              route handlers (sites, organizations, domains, ops, webhooks, cms…)
  app/{hosting,pricing,domains,…}  public marketing pages
  lib/                  ~270 files, ~41k lines — ALL business logic lives here, flat
    coolify.ts (1,833)  coolify-core.ts (529)  coolify-*.ts  — Coolify integration
    repositories.ts (2,275) — page data loaders + access checks
    backup-*, staging-*, wordpress-*, domain-*, github-*, usage-*, cms/*
  components/           UI
  worker/               SecuritySchedulerWorker.ts — placeholder, never runs
  orchestration/staging StagingProvisioningPipeline
scripts/                ~60 .mjs ops scripts: schedulers, backup/restore runners, remediation
coolify/                bash reconcilers + systemd units that run on the Coolify host
```

## 4. Architecture strengths (keep)

1. **Coolify integration is defensive and honest.** Rate-limit cooldown (Coolify's 200 req/min), typed `CoolifyHttpError`/`CoolifyRateLimitError`, "re-read and confirm convergence" after domain PATCHes, explicit "server_choice_needed" instead of guessing. Comments document real Coolify behaviour (405 on GET deploy, missing `server_uuid`, etc.).
2. **Tenant access helpers exist and are mostly used.** `resolveSiteAccess`, `resolveOrganizationAccess`, `requireOrgMember`, `getDomainViewer`, `resolveStagingDomainAccess`, plus `tenant-route-security.test.ts`.
3. **Webhook verification is correct.** Coolify webhook uses HMAC over timestamp+raw body with constant-time compare; GitHub uses signature verification; Stripe uses raw-body signature.
4. **Strong test culture** for pure logic (plans, matchers, parsers, guards).
5. **Client-facing copy discipline** — errors are written for clients and avoid Coolify terminology.
6. **Backups are genuinely restorable** (one restic snapshot per backup containing files + DB dumps, restore rehearsal, verification records).

## 5. Architectural problems

### 5.1 Two execution paths into infrastructure, one of them unconstrained
Jongo reaches infrastructure through **(a)** the Coolify API and **(b)** `ssh root@coolify-host` running generated shell scripts (`lib/ssh-exec.ts`, `scripts/site-backup.mjs`, privacy mode, SFTP, usage, WP plugin probe, cache flush, URL rewrite, staging DB copy).

Path (b) exists for good reasons — Coolify's API has no container exec, no file access, no host metrics — but it means the web container holds a **root SSH key to the production host**. Any RCE or SSRF in the web app becomes full host compromise across every tenant. It also bypasses Coolify entirely, so Coolify's view of the world and Jongo's can drift.

**Direction:** keep the capability, shrink the blast radius: move host operations out of the web process into a worker with a fixed, parameterised command catalogue, then (later) a small authenticated host agent with no shell passthrough.

### 5.2 No real job system
Long-running work is done by:
- `start-production.mjs` spawning 4 `setInterval` scheduler child processes inside the web container;
- fire-and-forget detached scripts that POST results back to `/api/ops/*-record`;
- in-request work in route handlers (deploys, staging provisioning).

There is no durable job table, no retry policy, no dead-letter visibility, no idempotency key on provisioning (except staging's `stagingTargetUuid` pin). A container restart silently drops in-flight work. Scaling to >1 web replica would run every scheduler N times.

**Direction:** Postgres-backed queue (pg-boss or graphile-worker — no new infra) in a separate `worker` process, plus an `Operation` table that the UI reads for status.

### 5.3 Data model is shaped for "imported WordPress sites"
- `Site` carries ~70 columns spanning WordPress, staging, git, privacy, backups, reconciliation. Every new resource type would add more.
- Missing first-class entities: **Project** (between org and resource), **Server**, **Database**, **AppDomain/Certificate** (`Domain` is the *registrar* domain), **BuildConfig**, **EnvironmentVariable**, **Operation/Job**, **Upload**, **BackupPolicy**.
- `Deployment` exists but has no logs, no duration, no source/commit linkage to rollback targets, and is only partially written.
- `Organization` ↔ Coolify project is 1:1 (`coolifyProjectId @unique`) plus a link table — two sources of truth.
- Billing lives on `User`, so an agency with multiple orgs and team members can't have org-level plans.

### 5.4 Coolify client is a 2,400-line module, not a service
`coolify.ts` + `coolify-core.ts` mix HTTP transport, payload normalisation, business decisions (staging, backups, WordPress detection) and three separate `fetch` implementations (`coolifyFetch` GET-only, `coolifyMutate` returning `boolean` and discarding the error, `triggerCoolifyDeploy` with its own loop). Env vars are read per call; there's a per-org `coolifyApiUrl` column nothing uses.

**Direction:** one typed `CoolifyClient` (single request function, error-preserving, retry/idempotency aware) behind an `InfrastructureProvider` interface; business logic moves to services that call the interface.

### 5.5 Mock fallbacks in production code paths
`triggerCoolifyDeploy` returns `mode: "mock"` with a fake deployment id when credentials are missing, and the deploy route then records it as a real Deployment. `CoolifyActionResult.mode` includes `"mock"`. The README still advertises "read-only Coolify API service with mock fallback". This directly contradicts rule 3/4 of the brief.

### 5.6 Fail-open auth configuration
Middleware and the deploy route **disable authentication entirely** if `NEXTAUTH_SECRET` is unset or equals `"dev-secret-change-in-production"`. A single mis-set env var publishes every tenant. See SECURITY_AUDIT S-02.

### 5.7 Real-time is polling
Deployment status, backups, notifications and usage all use `setInterval` (8–20 s) or `router.refresh()`. No SSE/WebSocket, no build log streaming.

### 5.8 Product-scope sprawl inside one app
The CMS subsystem (Sanity replacement, ~34 files, 14 models), marketing broadcasts and Namecheap resale share the same app, schema and deploy as the hosting control plane. Not wrong, but it is ~25% of the schema and unrelated to the platform vision.

### 5.9 Duplication / debt
- `app/(platform)/apps/*` are one-line re-exports of `sites/*` (cheap, but two URL trees for one thing).
- `repositories.ts` (2,275 lines) is a grab-bag of loaders and permission checks.
- ~60 one-off ops/remediation scripts in `scripts/` and ~40 `tmp_*.sh` fix-ups in `coolify-infrastructure/` show production state being repaired by hand.
- `db` is typed `any` (`require("@prisma/client")`), so Prisma's type safety is largely lost.
- `docs/jongo-managed-platform-plan.md` describes splitting into `os.jongo.app` + `jongo.app`; current direction is **one app at jongo.app**, so that plan is stale.

## 6. Is a complete redesign necessary?

**No.** The stack (Next.js + Prisma/Postgres + Coolify API) fits the vision, and the hard-won Coolify and WordPress operational logic is worth more than a clean slate. What's needed is a set of **targeted structural changes**, done incrementally behind the existing UI:

1. Fix the critical security issues (days).
2. Add the job/operation foundation and a separate worker process.
3. Extract the Coolify client into a provider interface.
4. Introduce new entities (Project, Server, Database, AppDomain, Deployment v2, Operation) alongside `Site`, migrate data, then slim `Site`.
5. Move host-level operations from in-request SSH into worker jobs with a fixed command catalogue.

Everything else in the roadmap builds on those five.

The one **product decision** that changes architecture, and needs your call, is in IMPLEMENTATION_ROADMAP §0: self-serve SaaS (anyone signs up and provisions on shared servers) vs. agency-managed (you provision, clients self-manage). It decides how far tenant isolation has to go at the infrastructure layer.

## 7. Coolify integration — recommended shape

```
UI ──► Next.js route (auth + tenant check + validation)
         └─► Service layer (AppService, WordPressService, DatabaseService…)
               ├─► writes Operation row (idempotency key)
               └─► enqueues job ──► Worker
                                     └─► InfrastructureProvider (interface)
                                           ├─ CoolifyProvider  → Coolify REST API
                                           └─ HostOps          → fixed command catalogue (SSH now, agent later)
Coolify webhook / poll ──► reconciler ──► updates Operation + resource status ──► SSE to UI
```

Rules: browser never sees Coolify ids as authority (always resolve via our DB + tenant check); every mutation goes through an Operation; provider calls are idempotent by looking up an existing resource tagged with our id before creating.

Tenancy at the Coolify layer: Coolify's API cannot create teams (`/teams` is read-only), so the practical model is **one Coolify team, one Coolify project per Jongo project, resources tagged with Jongo ids**, with app-layer enforcement as the isolation boundary and dedicated servers as an upsell for stronger isolation.

## 8. Coolify API capability vs. vision (from upstream `openapi.json`, 4.2.0 source)

| Need | Coolify API | Gap / alternative |
|---|---|---|
| Create app from Git (public / GitHub App / deploy key), Dockerfile, image | ✅ | GitLab/Bitbucket only via **deploy key** (no OAuth app API) |
| Deploy, restart, stop, start | ✅ `/deploy`, `/applications/{uuid}/*` | |
| Cancel deployment | ✅ `/deployments/{uuid}/cancel` | Not used by Jongo yet |
| Deployment history + logs | ✅ `/deployments/applications/{uuid}`, `/deployments/{uuid}` (logs field) | No streaming — poll server-side, stream to browser via SSE |
| Runtime logs | ✅ `/applications/{uuid}/logs`, `/services/{uuid}/logs`, `/databases/{uuid}/logs` | Snapshot only |
| Rollback | ⚠️ no endpoint | Pin commit SHA (PATCH app) then deploy; verify on live version |
| Env vars | ✅ incl. bulk | |
| Databases (pg, mysql, mariadb, mongo, redis, …) | ✅ create/start/stop/backups/executions | |
| DB backups to S3 | ✅ scheduled backups API | S3 destination config itself must be verified |
| Volume backups | ⚠️ `/storages/{uuid}/backups` exists in 4.2 source | Verify on the live version; keep restic path |
| Domains | ✅ via app/service `fqdn`/`domains` PATCH | No cert status endpoint — probe TLS ourselves (already done for staging) |
| Server metrics (CPU/RAM/disk) | ❌ not in API | Sentinel metrics or host `docker stats` (current approach) |
| Container exec / files | ❌ | Host ops catalogue (WP-CLI, imports, file manager) |
| Create servers | ✅ incl. Hetzner/DO/Vultr provisioning | |
| Preview deployments | ⚠️ only delete-preview endpoint | Coolify drives previews from its own GitHub App; Jongo uses its own app → implement previews as separate app per PR or verify |

The live Coolify version must be read from `GET /api/v1/version` before each integration is built; code comments reference 4.3 behaviour while the local source checkout is 4.2.0.
