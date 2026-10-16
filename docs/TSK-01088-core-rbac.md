# TSK-01088 — core RBAC and existing financial surfaces

## Integration contract

- Apply the separately owned `User.role` enum migration (`super_admin`, `admin`, `collaborator`, default `collaborator`) and regenerate Prisma **before** enabling this code. A missing role column/generated field fails closed, including technical admin checks. This change does not modify schema or migrations.
- Assign the first super admin explicitly through the approved DB/operational process. Neither `BOOTSTRAP_ADMIN_EMAIL`, organization ownership, invitation acceptance nor `PlatformAdmin` grants confer financial access. No HTTP global-role mutation endpoint was added.
- Server entry points use `resolvePrincipal(userId)`, `isSuperAdminUser(userId)`, `isPlatformAdminUser(userId)` and `financialAccessDenial(userId)` from `apps/web/src/lib/rbac.ts`. Do not pass a JWT role, tenant role or UI boolean as financial authority. Principals are read fresh; missing/deleted users and DB/schema failures deny access. `canViewBilling` and `canManageBilling` consume only resolved server principals.
- Tenant roles in `roles.ts` remain two-tier. `super_admin` normalizes to collaborator even if an admin fallback is requested; legacy owner remains tenant admin. Global role parsing is separate.
- New client billing and managed-domain inventory work is separately owned: use these server policies on **every** route/server action/page, and technical allowlisted DTOs for non-super users. Do not spread Prisma domain/client billing objects into responses or client props. `DOMAIN_TECHNICAL_SELECT` and `DOMAIN_CHARGE_FINANCIAL_SELECT` are available in `domain-access.ts`; the latter must only be queried after financial authorization.
- Middleware is unchanged. The separately owned Namecheap machine endpoint needs an **exact-path** `/api/ops/domains-sync-namecheap` bypass before session enforcement; its handler must continue validating its dedicated machine token. Preserve the existing exact Stripe `/api/billing/webhook` signature-authenticated bypass. Do not broadly exempt `/api/billing` or `/api/ops`.
- No package/script changes are required for core RBAC. No production execution, migration, role promotion, deployment or commit was performed.

## Existing surfaces protected

| Surface | Policy |
| --- | --- |
| Subscription checkout (`POST /api/billing/checkout`) | Fresh DB super admin before body parsing or Stripe access |
| Domain purchase quote (`GET /api/domains/quote`) | Authenticated super only, including retail purchase quote and wholesale/margin; no-store response |
| Domain checkout and `startDomainCheckout` | Fresh DB super admin; tenant/client technical checks remain distinct |
| Domain charge retry/refund | Super-only financial guard; pure remedy policy requires financial capability, not platform-admin flag |
| Existing domain list/detail | Non-super technical selects; no charge/balance queries or financial rendering/props; raw order errors withheld |
| Domain new/renew controls | Super only; client-admin DNS remains supported |
| Usage | Technical usage/host access unchanged by scope; monetary allocation and cost output super only |
| Signup/pricing | Public marketing prices remain public; signup no longer auto-starts billing; denied signed-in checkout explains super-only billing |
| Stripe webhook | Unchanged raw-body signature authentication; no user-session/RBAC requirement |

No existing account subscription portal/status/cancel/invoice API or private client billing page was present at inspection. Future additions must use the same financial guard. Current primary navigation contains technical Domains/Usage/Settings, not a private billing destination; it remains available. Separate new financial navigation must be hidden server-side for non-super users **and** backed by route guards.

Technical platform access recognizes active DB global `admin`/`super_admin`, the active bootstrap identity, and existing `PlatformAdmin` grants. Updated repository scope, site permission snapshots, inline Coolify/staging/telemetry/diagnostics checks, and settings to use DB-backed authority. Seed-only grant-management APIs still write only `PlatformAdmin`, ignore any submitted global role, and do not delegate grant management to team-granted admins. Server session identity is refreshed by user ID so stale JWT email cannot impersonate the current bootstrap identity.

## Validation and limitations

Focused Vitest coverage includes DB principal/policy resolution, immediate demotion, bootstrap/grant separation, tenant normalization, stale JWT/deleted identities, financial route denials before provider calls, technical domain select/render boundaries, tenant DNS scope, usage financial output, seed-only technical grant behavior, public retail DTOs and Stripe signature-only webhook access. Tests use mocks and server-rendered markup, not a live DB, production services or browser RSC capture.

The normal type-check currently encounters stale generated Next types for deleted platform-root and domain-order routes. Source-only TypeScript checking excludes `.next` in memory without deleting build artifacts or changing project configuration. Regenerate Next types in a clean build during integration; do not interpret stale generated files as an RBAC source failure.

Full web-suite run: 94 suites passed, one existing copy-guard suite failed (973 tests passed, one failed). Its three flagged strings were verified against HEAD and are unchanged by this work: existing usage “in Coolify”, the unmapped-project banner, and staging-client “infrastructure panel” copy. Final focused RBAC/finance/domain validation: **98 tests passed across 13 suites**, including a real subscription-state update through the signed webhook and invalid-signature denial. Source-only TypeScript diagnostics: zero; `git diff --check`: clean.

The already-created Stripe sessions and legitimate signed webhook/reconciliation work are not canceled by a role demotion; authorized machine processing continues. Authorization is fresh per request, not a transaction-wide lock against a concurrent demotion. Newly added screens/endpoints and schema deployment remain integration responsibilities.