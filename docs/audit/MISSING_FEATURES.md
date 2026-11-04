# Missing Features — Gap Analysis (Phase 1)

Ordered by section of the product brief. "Coolify support" says whether the engine can do it via API (✅), partially (⚠️), or not at all (❌ → we need host ops or our own service).

## Foundation (blocks everything else)
| Missing | Notes |
|---|---|
| Durable job queue + separate worker process | pg-boss / graphile-worker on existing Postgres |
| `Operation` model (status, steps, idempotency key, error, actor, resource) | Single source of truth for "is it done?" in UI |
| Provider interface over Coolify | Allows future engines; isolates Coolify quirks |
| Real-time channel (SSE) | Replace `setInterval` polling |
| Typed DB access | `db` is `any` today |

## 3. Coolify integration
- Single typed client; error-preserving mutations; retry with idempotency (lookup-before-create by tag/name). ✅
- Version detection (`/api/v1/version`) and capability flags per version. ✅
- Deployment cancel. ✅ (`/deployments/{uuid}/cancel`)
- Webhook → Operation/Deployment state sync (receiver exists, consumers don't). ✅

## 4. Application deployment
| Missing | Coolify | Notes |
|---|---|---|
| GitLab, Bitbucket connections | ⚠️ deploy-key only | OAuth on our side + deploy key into Coolify; webhooks handled by us |
| Install / build / start / output-dir overrides | ✅ app fields | |
| Node.js version selection | ⚠️ nixpacks env (`NIXPACKS_NODE_VERSION`) | |
| Framework auto-detection | ❌ (ours) | Read repo `package.json`/lockfiles/`requirements.txt`/`composer.json`/`go.mod`/`Gemfile`/`Dockerfile` via GitHub API before create; map to build pack + defaults |
| Static site (output dir) build pack | ✅ `static` build pack / `is_static` | |
| Cancel deployment | ✅ | |
| Rollback | ⚠️ no endpoint | Re-deploy pinned commit; or Docker image tag if Coolify keeps it — verify |
| Real-time build logs | ⚠️ poll `/deployments/{uuid}` | Server polls, browser gets SSE |
| Runtime logs | ✅ snapshot | |
| Preview deployments per PR | ⚠️ | Coolify previews depend on its own GitHub App; we use ours → model previews as short-lived apps, or verify Coolify preview API |
| Env var UI with secret masking, per-environment | ✅ | |
| Production vs preview environments | ✅ Coolify environments | |

## 5. WordPress
| Missing | Coolify | Notes |
|---|---|---|
| Automated install (site title, admin user/password, locale) | ❌ | WP-CLI `core install` via host ops after container healthy; or env-driven bootstrap mu-plugin |
| PHP version / `php.ini` settings | ⚠️ image tag + mounted ini | Template variants per PHP version; upload limits already handled manually in infra |
| Migration wizard (ZIP, files, SQL, backup packages, SFTP) | ❌ | See IMPLEMENTATION_ROADMAP Phase 6 |
| Chunked/resumable uploads | ❌ | tus or S3 multipart presigned uploads direct to object storage |
| File manager | ❌ | Host ops, read/write within volume root only |
| Database manager | ❌ | Adminer-style tool behind our auth, or scoped SQL import/export only |
| Redirects | ❌ (Traefik middleware) | Same mechanism as privacy mode |
| WP cron management | ⚠️ scheduled tasks API | Disable WP pseudo-cron, run `wp cron event run --due-now` via Coolify scheduled task |
| Core/plugin/theme updates | ❌ | WP-CLI via host ops, with pre-update backup (guard exists) |
| Malware scanning | ❌ | Placeholder worker only; there is evidence of a past injection incident |
| Resource monitoring per site | ⚠️ | Usage collector exists; surface it per site |

## 6. Databases
| Missing | Coolify | Notes |
|---|---|---|
| Standalone database product (create PG/MySQL/MariaDB/Mongo/Redis) | ✅ | Today DBs only appear as imported resources or WP sidecars |
| Credentials + connection strings (masked, reveal with audit) | ✅ | |
| Public access toggle + IP allowlist | ⚠️ `is_public`, port | Allowlist needs Traefik TCP/firewall work |
| Backups/restore to S3 | ✅ scheduled backups | |
| Logs, restart, metrics, delete with typed confirmation | ✅ / ⚠️ metrics | |

## 7. Domains (connect to app)
- Production custom-domain flow: add → DNS instructions (Cloudflare/GoDaddy/Namecheap/other) → verify (A/CNAME/TXT) → attach to Coolify → TLS probe → status. Pieces exist for **staging** domains only (`staging-dns-check`, `staging-ssl-probe`); generalise them.
- Apex vs www redirect, multiple domains per app, removal with Coolify convergence check.
- Certificate status: ❌ no Coolify API — probe TLS ourselves and record expiry.

## 8. Servers
- Server list/status, add server (SSH key via `/security/keys` + `/servers` + `/validate`) ✅
- Cloud provisioning (Hetzner/DO/Vultr) ✅
- CPU/RAM/disk/network ❌ via API → Sentinel or host collector
- Admin-only area separate from client dashboard.

## 9. Monitoring
- Health checks per app ✅ (Coolify health check config); uptime history ❌ (infra runs Uptime Kuma separately — integrate or replace).
- Failed-deployment diagnostics (parse log tail, map known errors to guidance).

## 10. Backups
- Unified backup model across WP / app volumes / databases with policy (schedule, retention, destination).
- Customer-configurable S3-compatible destination.
- Restore history UI (verification records exist; surface them).

## 11. UI
- Design system as code (tokens exist in CSS; components are bespoke). Missing: shared Table, Dialog, Dropdown, Toast (react-hot-toast used), Skeleton, EmptyState primitives with consistent API. `design/dashboard/*.html` mocks exist and should be the reference.
- Sections missing entirely: Databases, Servers (client-facing), Deployments (global), Backups (global), Team at org level is present, Billing at org level.

## 12. Multi-tenancy
- **Project** level between Organization and resources.
- Finer roles: owner, admin, developer, viewer, billing.
- Resource-level permissions beyond site collaborators.
- Complete audit logging + UI.
- Org-level usage tracking.

## 13. Billing
- Org-level subscriptions; plan limits enforced at create time (apps, DBs, storage, members).
- Metering only from measurable sources: container CPU/RAM samples (have), volume/backup bytes (restic stats — have partially), deployment count/minutes (Coolify deployments), members (DB). Bandwidth: not measurable today → don't bill it until Traefik access-log metering exists.

## 14. Security
- Rate limiting on auth + mutation routes (shared store, not in-memory).
- 2FA, session revocation.
- Key management: dedicated encryption key, key ids, rotation.
- SSRF guard for any user-supplied URL fetch (git URLs, webhooks, telemetry endpoints).
- Upload scanning (ClamAV) and archive safety (zip-slip, size bombs).
- Least-privilege host access (non-root, command catalogue).

## 15. Testing
- Integration tests against a real Postgres (some CMS tests do this) and a disposable Coolify.
- E2E (Playwright) for sign-in, create app, deploy, add domain, backup/restore.
