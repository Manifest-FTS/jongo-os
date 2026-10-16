# TSK-01088 — RBAC, client billing and registrar inventory

## Branch and scope

Created `TSK-01088` after fetching/fast-forwarding main to `a5e0172`. Existing untracked incident documentation was preserved and excluded from this task's commit. Production migration was subsequently approved and applied as recorded below; application merge/deployment remains an operator action.

Implementation follows Next.js App Router, Prisma/PostgreSQL, existing Organization-as-Client and Domain models. It does not introduce parallel client/domain tables or repurpose per-user Stripe subscriptions.

## Architecture and security decisions

- `User.role` is global authority: `super_admin`, `admin`, `collaborator`. Membership roles remain two-tier. Invitations, client ownership and technical grants cannot assign global super authority.
- Financial authorization resolves the active user from the database on each request, not a role in a JWT. Missing/deleted users, missing schema and database errors fail closed. Bootstrap identity and revocable `PlatformAdmin` grants retain technical access but never confer finances.
- Existing technical grants are not copied into permanent global roles; deleting a grant must actually revoke that authority.
- Included migration promotes active `devkev@manifestfts.com` case-insensitively. The explicit `db:seed-super-admin` maintenance command can apply the promotion after provisioning the account. Neither creates a passwordless identity.
- Client bookkeeping lives on Organization, separately from account subscriptions and domain charges. Manual driver reads persisted flags; exempt derives comped. Bonsai/native client Stripe drivers explicitly report unsupported and do not call providers, mark paid or silently fall back. Future Bonsai adapter can implement invoice reads via `/public-api/v1/invoices?client_id=...` behind the same contract.
- Super-only billing APIs validate bounded JSON and strict field allowlists, sanitize external HTTPS invoice links, and write audits atomically. Financial notes are not copied into audit details. UI destinations and APIs independently enforce authorization. Existing signed Stripe webhook processing remains operational.
- Domain inventory APIs select/serialize technical-only fields for non-super users. Collaborators require existing organization scope; site-only membership does not imply ownership of every domain in that client. No inferred ownership based on domain text or email is attempted.
- Namecheap inventory uses existing credential handling, XML parser and rate gate, bounded pagination, no destructive missing-record deletion and a fenced PostgreSQL-backed lease. Sync preserves client assignment, billing overrides, DNS and in-flight purchases. Sandbox imports into live inventory are denied.
- Domain assignment/import does not authorize DNS migration. `dnsManagementEnabled` defaults false; existing purchased/Cloudflare-managed domains are backfilled. Both direct provisioning and repair jobs require enrollment before changing registrar nameservers.
- Technical route review additionally closes cross-site collaborator deletion and tenant resource-rebinding/destruction paths, honors global technical authority, and rejects invalid membership/global-role/billing mutation fields.

## User surfaces

- `/managed-domains`: paginated technical inventory, expiry, auto-renew and DNS; super-only billing/mapping controls and unassigned filter.
- `/client-billing`: super-only client mode/status/notes/provider references and manual overrides.
- Existing `/my-domains`: technical domain operations remain scoped; private balances, margins, charges and purchase/remedy controls are super-only.
- `/usage`: technical telemetry remains available by existing scope; monetary allocation is super-only.
- Public marketing/retail pricing remains public. Private financial authority is not inferred from access to public prices.

## Rollout

1. Review the additive migration, then deploy it before the new application code. Back up the database using the normal deployment process. Generate Prisma for the new schema.
2. Verify the target super-admin identity exists and was promoted. If the account was absent during migration, create it through the normal secure account flow, then run `db:seed-super-admin`. Technical admins must not be used as a billing fallback.
3. Validate admin/collaborator technical access and billing denials in staging, including direct requests and serialized payloads. Validate grant revocation, site-only access and domain mapping without nameserver changes.
4. Set Namecheap credentials and the actual whitelisted public egress IP. Configure a dedicated `NAMECHEAP_SYNC_TOKEN` in app/scheduler, then invoke `domains:sync-namecheap` for a reviewed first pass.
5. Review unassigned domains and map them explicitly. Enable `NAMECHEAP_SYNC_SCHEDULE_ENABLED=true` only after that review. The existing production supervisor starts the daily scheduler; it is off by default.

The scheduler and any live provider credentials were not activated by this implementation. Bonsai/native client billing remain future phases. Unassigned domains must be mapped before changing billing flags, because current audits require a client; assignment and flags may be saved atomically together.

## Validation (2026-10-16)

- Prisma generation and normal monorepo type-check: passed.
- Web regression suite: **1,142 passed; one pre-existing copy-guard failure**. The failure flags three unchanged strings in usage, the unmapped-project banner and staging copy. No assertions were weakened or exceptions added.
- Daily scheduler: five Node tests passed.
- Real isolated PostgreSQL 17 migration harness: ten integration checks passed, including role promotion, defaults, nullable FK, preservation of charges/inventory and DNS enrollment. Temporary cluster was stopped/removed; existing services and application databases were untouched.
- `git diff --check`: passed.

Generated Next declarations referenced routes deleted on main. The old ignored build cache was preserved outside the repository and route types regenerated; normal type-check now passes. No production build, live registrar sync, live billing-provider call or browser acceptance against a migrated application database was performed. Mock-backed authorization/scope/serialization/concurrency tests are not a substitute for that staging acceptance.

Migration regression command: `node scripts/test-rbac-migration.mjs`. Requires PostgreSQL 17 binaries (`PG_BIN` can select their directory) and installed dependencies. It pins the pre-task schema commit so it remains repeatable after commits. It ignores inherited database credentials and uses only a temporary loopback cluster.

See also [core policies](TSK-01088-core-rbac.md), [billing/inventory details](TSK-01088-client-billing-managed-domains.md) and [Namecheap operations](namecheap-domain-sync.md). Integration prerequisites described as separately owned in the earlier component notes are now implemented on this branch; this document records the combined status.

## Approved production migration — 2026-10-16

- Operator requested production schema migration and branch commit/push instead of further local end-to-end setup.
- Verified the running `jongo.app` container targets database resource `o4g2cpls648gnz0f1he7be7c` on the production worker. Earlier committed migrations were complete; the target active identity count was exactly one.
- Created a protected custom-format backup at `/data/coolify/backups/databases/jongo-os/TSK-01088-before-20261016T142820Z.dump` (4,094,891 bytes). `pg_restore --list` successfully verified its archive catalog; a full restore was not performed during this rollout.
- Re-ran all ten isolated PostgreSQL migration checks after adding an explicit transaction and bounded lock/statement timeouts.
- Applied only `20261016090000_super_admin_client_billing` through the running app's normal `prisma migrate deploy` workflow. Prisma recorded successful completion. The exact migration bytes are included in this branch; deployment must not edit an already applied migration.
- Confirmed the target identity has `super_admin`; all 31 existing clients received safe `manual_override` / `pending_setup` defaults. Production login still returned HTTP 200.
- No application container restart, merge, code deployment, billing-provider operation or registrar synchronization was triggered. `NAMECHEAP_SYNC_SCHEDULE_ENABLED` remains false. New RBAC behavior and screens take effect after merging and deploying this branch, not from the schema change alone.
- Local sign-in credentials are separate from the production password; no production password or account credentials were changed.