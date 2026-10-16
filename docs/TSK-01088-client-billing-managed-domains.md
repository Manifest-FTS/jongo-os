# TSK-01088: client billing and managed-domain inventory

## Boundary and integration prerequisites

- Client bookkeeping lives on `Organization`. The existing per-`User` Stripe subscription, account checkout, domain purchase charges, registrar auto-renew and Namecheap sync are untouched.
- Apply the separately owned schema/migration and regenerate Prisma before integration: `Organization.billingMode` (`manual_override`, `bonsai`, `native_stripe`, `exempt`; default `manual_override`), `billingStatus` (`active_paid`, `past_due`, `pending_setup`, `comped`; default `pending_setup`), nullable `billingNotes`, `bonsaiClientId`, `externalInvoiceUrl`.
- Domain inventory requires nullable `organizationId` and its optional organization relation, `autoRenew`, `isBillable`, `billingOverride`, nullable `registrarSyncedAt`, and existing technical fields. AuditLog requires its existing organization/actor/action/resource/details columns.
- The separately owned fresh DB RBAC must be installed. Session roles/emails and technical platform grants never authorize client finances. No bootstrap billing fallback is used.
- No package, middleware, auth, RBAC, schema or migration changes are included here. No production calls or deployments are needed to run the focused tests.

## Drivers

`BillingDriverInterface` defines asynchronous `getClientStatus(client)` and `syncClient(client)`. Callers supply a freshly selected persisted organization row. `getBillingDriver(mode)` exhaustively selects a driver and throws for unknown/missing modes (no fallback).

| Mode | Effective status | Sync behavior |
| --- | --- | --- |
| manual_override | Actual persisted billingStatus | Read-only, reports no mutation; overrides are persisted only through the audited API |
| bonsai | null / unknown; explicitly unsupported | No network, credentials, SDK or mutation |
| native_stripe | null / unknown; explicitly unsupported | No network, credentials, SDK or mutation; never consults User subscriptions |
| exempt | Derived comped, regardless of stored status | No mutation; never writes a payment/comped status |

Changing modes clears the stored status to `pending_setup` unless switching to manual with an explicit valid status. Non-manual modes reject direct status overrides. Manual `comped` is allowed as an explicit operator bookkeeping override; it is distinct from derived exempt status. Notes are limited to 4,000 characters; Bonsai IDs to 200 identifier characters; invoice links to 2,048 characters and HTTPS without credentials, whitespace or backslashes. DTOs revalidate invoice links before rendering. Bonsai URLs are built on a fixed HTTPS origin with an encoded ID path segment. No link is fetched by the server.

## API contract

All handler responses, including denials and errors, use `Cache-Control: no-store` and `Vary: Cookie`; handlers/pages are dynamic. Authentication and fresh principal resolution precede application data queries and body parsing. Unauthorized handler calls return 401, non-super financial calls 403. Existing middleware may redirect anonymous requests to sign-in before these handlers; middleware is intentionally unchanged. Missing active resources return 404; validation 400; oversized body 413; wrong content type 415. DB/audit/serialization failures return a generic 503 with no raw Prisma or provider error.

Pagination: `page=1..10000`, `pageSize=1..100` (default 50). Stable name/id ordering; responses contain at most pageSize rows plus `hasMore` calculated using one lookahead row. There is no unbounded client picker or inventory query.

### Client bookkeeping (super only)

- `GET /api/client-billing?page=&pageSize=` returns `{ clients, page, pageSize, hasMore }` for non-deleted clients.
- `GET /api/client-billing/[clientId]` returns `{ client }` for an active UUID client.
- `PATCH /api/client-billing/[clientId]` accepts only `billingMode`, `billingStatus`, `billingNotes`, `bonsaiClientId`, `externalInvoiceUrl`. Empty/unknown fields and invalid types/enums are rejected; nullable references/notes may be cleared using null. Max JSON body: 16 KiB (stream bounded, not just Content-Length).
- Financial DTO: `id`, `name`, `billingMode`, effective nullable `billingStatus`, `supported`, `message`, `billingNotes`, `bonsaiClientId`, safe generated `bonsaiUrl`, safe nullable `externalInvoiceUrl`. No per-account Stripe fields or raw record spread.
- The update and `client_billing_updated` audit are one serializable transaction. Audit details contain changed field **names only**: no notes, link values/tokens, external identifiers, secrets or old financial values. A failed audit rolls the update back. Serialization conflicts return 503; retry explicitly rather than assuming success.

### Managed inventory

- `GET /api/managed-domains?page=&pageSize=&q=&clientId=&assignment=all|assigned|unassigned`.
- Collaborator scope uses existing `getVisibleOrganizationIds(userId, isPlatformAdmin)`. An empty scope returns zero rows; null/unassigned domains never enter collaborator scope. Arbitrary client filters intersect with visible client IDs. A technical platform grant intentionally grants global **technical** inventory access, including assigned domains, but no financial DTOs or mutations.
- The explicit `unassigned` screen/filter is super-only, including direct URL/API requests; technical admins cannot enter the mapping queue. Global technical inventory may contain unassigned rows but not financial information.
- Technical allowlist: `id`, `name`, `organizationId`, minimal `client { id, name }`, `status`, `registrar`, `expiresAt`, `autoRenew`, `dnsStatus`, `nameservers`, `cloudflareZoneId`, `registrarSyncedAt`.
- Super only: `financial { isBillable, billingOverride, clientBilling }`, where clientBilling is the explicit financial DTO above or null for unmapped rows. Never includes charges, contacts, EPP codes, registrar errors, account Stripe IDs or provider credentials.
- `GET /api/managed-domains/clients?q=&page=&pageSize=` is a super-only active-client picker returning minimal ID/name DTOs. Search is capped at 200 characters.
- `PATCH /api/managed-domains` accepts `domainId` (required), `organizationId` (UUID or null), `isBillable` (boolean), `billingOverride` (boolean). At least one update field is required. Unknown fields, including `autoRenew`/name/notes, are rejected.
- Mapping/flag writes are super-only and validate the target non-deleted client **inside** the serializable transaction. Domain writes and `managed_domain_updated` audits are atomic. Reassignment audits both old and new clients; unassignment audits the previous client. Audit details contain field names and mapping IDs only.
- **Audit constraint:** AuditLog.organizationId is required. To change flags on an unassigned domain, assign it to an active client in the same PATCH. Changing flags while leaving it unmapped returns 409; a redundant unassign of an already unmapped domain also returns 409. Unassigning a previously mapped domain without flag changes is supported and audited.
- Bookkeeping flags never trigger purchases, renewals, registrar changes, charges, provider sync or User subscription writes.

## UI

- `/managed-domains`: technical inventory table with domain, client, expiry, auto-renew and DNS, domain search, assignment filters and pagination. Super receives billing links, a paginated/searchable client mapping form and domain billable/override flags. Unassigned filter can also be reached via `?assignment=unassigned`.
- `/client-billing`: explicit server-rendered Access denied message for non-super users, plus independently protected APIs. Super receives paginated client modes/statuses and an override form with manual/comped status, notes, Bonsai ID/link and safe invoice link. Open a client directly with `?clientId=<UUID>`.
- Uses existing card, table, form and button styles. Navigation adds both routes and retains the existing technical Domains destination `/my-domains`. No existing my-domains pages are changed.
- Read-only inventory comes from the DB; no provider network calls occur on these pages. External billing synchronization is intentionally not exposed as a working UI action.

## Validation

Focused Vitest files under `apps/web/src/lib`: `client-billing.test.ts`, `managed-domains.test.ts`, `client-billing-api.test.ts`.

Coverage includes all drivers and persisted/manual statuses, unsupported/no-network behavior, exempt derivation, invalid enums, safe links, mass assignment, body/pagination bounds, fresh-role denials, missing/deleted identities, explicit admin UI denial, collaborator scope/empty scope/unassigned isolation, DTO redaction, active-client mapping, two-sided audits and rollback on audit failure.

Run the web workspace test script with those three file paths, then its `type-check` script. Tests use mock persistence and real RBAC resolution; no live DB/providers are accessed. A migration-backed transaction/RBAC integration test and browser acceptance against an isolated non-production DB remain integration checks after the schema lands.

### Local validation result (2026-10-16)

- 94 tests passed across the three new suites plus existing `rbac`, `financial-routes`, and `domain-financial-exposure` suites.
- Source-only TypeScript validation passed with zero diagnostics.
- Standard web type-check is blocked by six stale generated Next declarations referencing removed platform-root and domain-order routes. The generated artifacts were not deleted or changed. Refresh them in the owning local build workflow before expecting the standard check to pass.
- `git diff --check` passed. No production access, migrations, commits, deployment or provider calls performed.