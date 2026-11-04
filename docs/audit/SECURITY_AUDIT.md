# Security Audit (Phase 1)

Static review of `jongo-os` on branch `stage` @ `d8381ba`. Nothing was exploited against production. Severity is for a multi-tenant SaaS where tenants are mutually untrusted.

## Summary

| ID | Severity | Finding |
|---|---|---|
| S-01 | **Critical** | `/api/coolify/deploy` has no tenant authorization — any signed-in user can deploy/restart any Coolify resource by UUID |
| S-02 | **Critical** | Authentication fails **open** when `NEXTAUTH_SECRET` is missing or the default string |
| S-03 | **High** | Web container holds a **root** SSH key to the Coolify host; host-key checking `accept-new` |
| S-04 | **High** | Encryption key for stored secrets falls back to `NEXTAUTH_SECRET`, then to a hard-coded string; no key id/rotation |
| S-05 | **High** | Single static ops token grants cross-tenant machine access (backup callbacks, every site's staging routes, diagnostics) |
| S-06 | **High** | No rate limiting on sign-in, registration or password reset |
| S-07 | Medium | Mock deploy results recorded as real deployments when Coolify creds are missing |
| S-08 | Medium | Privacy-mode passwords stored in plaintext |
| S-09 | Medium | Ops tokens compared with `===` (not constant-time) in middleware and routes |
| S-10 | Medium | Shell scripts built by string interpolation and run as root over SSH |
| S-11 | Medium | In-memory, per-process rate limiting (`rate-gate.ts`) |
| S-12 | Medium | WordPress containers share one host with no malware scanning; evidence of a past code-injection incident |
| S-13 | Low | `db` typed as `any` — Prisma can't catch wrong field/where shapes that affect scoping |
| S-14 | Low | No 2FA, no session revocation (JWT sessions) |
| S-15 | Info | Real Coolify token and other secrets live in `.env` / `.env.local` on this machine (gitignored, not tracked — good) |

## Details

### S-01 — Missing tenant check on deploy (Critical)
`apps/web/src/app/api/coolify/deploy/route.ts` accepts `{ serviceUuid | siteId, environment }`, checks only that a session exists, then calls `triggerCoolifyDeploy(targetUuid)`. It never resolves the site through `resolveSiteAccess`, so a user of organization A can POST organization B's Coolify UUID (or any UUID in the Coolify team, including Jongo itself or databases) and trigger a deploy/restart. UUIDs are not secrets — they appear in page data.
**Fix:** resolve `siteId` → site via `resolveSiteAccess(siteId, userId)`, require deploy permission, use the site's stored Coolify UUID, never a client-supplied one. Add a route test to `tenant-route-security.test.ts`. Sweep every route for client-supplied Coolify ids.

### S-02 — Fail-open auth (Critical)
`middleware.ts`: `if (!process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET === "dev-secret-change-in-production") return NextResponse.next();` — every route becomes public. Same pattern in the deploy route.
**Fix:** in production, refuse to boot without a strong secret (length check at startup); remove the bypass entirely; use `DEV_AUTH_*` for local dev only.

### S-03 — Root SSH from the web tier (High)
`lib/ssh-exec.ts` defaults `STAGING_SYNC_SSH_USER` to `root`, writes the key to a temp file, `StrictHostKeyChecking=accept-new`. Any RCE/SSRF-to-RCE in Next.js = root on the host running every customer's containers and Coolify itself.
**Fix (staged):** (1) pin host key (`known_hosts` baked in, `yes`); (2) move all host ops to the worker process only — web never holds the key; (3) dedicated non-root user with `sudo` limited to a fixed set of wrapper scripts that take validated arguments; (4) later, a small host agent with mTLS and a typed command catalogue (no shell).

### S-04 — Weak secret key management (High)
`lib/secret-box.ts`: key = `sha256(WORDPRESS_TELEMETRY_ENCRYPTION_SECRET || NEXTAUTH_SECRET || "dev-only-wordpress-telemetry-secret")`. Rotating `NEXTAUTH_SECRET` silently makes stored secrets undecryptable; a missing env var in prod encrypts with a public constant. AES-256-GCM itself is used correctly.
**Fix:** dedicated `SECRETS_ENCRYPTION_KEY` (32 random bytes, required in prod), key id in the payload format (`v2:<kid>:…`), re-encryption job for rotation.

### S-05 — Shared ops token (High)
`OWNERSHIP_SYNC_TOKEN` / `BACKUP_RECONCILE_TOKEN` bypass middleware for `/api/ops/*`, `/api/diagnostics/runtime` and **every** `/api/sites/*/staging/*` route. One leaked token (they're in host scripts and env files) = cross-tenant staging operations.
**Fix:** per-job signed callbacks (HMAC over `{jobId, backupId, status}` with a per-job nonce), or a worker that writes results directly to the DB so no inbound callback exists.

### S-06 — No auth rate limiting (High)
`authorize()` in `lib/auth.config.ts`, `api/auth/register`, `api/auth/forgot-password` have no throttling → credential stuffing, account enumeration via timing, reset-email flooding.
**Fix:** Postgres- or Redis-backed limiter by IP + account; generic responses on forgot-password.

### S-07 — Mock results (Medium)
`triggerCoolifyDeploy` returns `mode: "mock"` / `mock-dep-<ts>` when creds are absent; the route stores a `Deployment` row. Misconfiguration presents as success.
**Fix:** remove mock mode; return a 503 "hosting unavailable".

### S-08 — Plaintext privacy passwords (Medium)
`Site.privacyModePassword` is plaintext by design so admins can show it. Display does not require plaintext-at-rest — encrypt with secret-box and decrypt on authorised read.

### S-09 — Non-constant-time token compare (Medium)
`middleware.ts` and `api/ops/*` use `providedToken === token`. Use the `safeEqual` helper already in `coolify-webhook.ts`.

### S-10 — Shell construction (Medium)
Backup/restore/privacy/SFTP scripts are bash strings with `shQuote` escaping, executed as root. I found no direct user input flowing unquoted, and resource identifiers are mostly Coolify UUIDs, but the pattern is fragile. Container names are derived from directory listings (`/data/coolify/services/*`).
**Fix:** treat every value as untrusted: validate against strict regexes (`^[a-z0-9]{20,40}$` for UUIDs) *before* quoting; pass data via env/stdin, not interpolation; keep scripts as static files with positional args.

### S-11 — In-memory rate limits (Medium)
`rate-gate.ts` and Coolify cooldown state are per-process; a second replica or a restart resets them. Fine for registrar lookups; insufficient for security limits.

### S-12 — WordPress isolation & malware (Medium)
All WordPress containers run on one host on Coolify's network. `coolify-infrastructure/tmp_sweep_injected_signature.sh` and `tmp_quarantine_sohps_theme.sh` show a real injection incident handled by hand. `SecuritySchedulerWorker` is a stub.
**Fix:** per-site Docker network, read-only core where possible, `DISALLOW_FILE_EDIT`, scheduled signature/ClamAV scan job, upload scanning, alerting.

### S-13/S-14 — Hardening
Type the Prisma client; add TOTP 2FA and a session-version column to revoke JWTs.

## What's already done well
- HMAC webhook verification with timestamp, constant-time compare, replay protection (Coolify); GitHub and Stripe signatures verified on raw body.
- Tenant access helpers with dedicated security tests; site grants explicitly never escalate to org grants.
- `hasOnlyFields` allow-listing of request bodies on tenant mutations.
- bcrypt password hashing; AES-256-GCM for stored secrets.
- Coolify token stays server-side; no Coolify UI exposure to clients.
- Error messages avoid leaking infrastructure details.
- `.env` files are gitignored and not tracked.

## Required controls not yet present
CSRF review for non-NextAuth POST routes (cookies are SameSite=Lax by default — acceptable for JSON APIs that require `Content-Type: application/json`, but should be enforced), SSRF allow-listing for outbound fetches to user-supplied URLs, upload limits/scanning, container resource limits per plan, centralised audit of every infrastructure mutation.
