# TSK-01088 — Namecheap inventory synchronization

## Integration prerequisites (integrated on TSK-01088)

- Apply the included migration before deploying code: nullable `organizationId`, `autoRenew` default false, `isBillable` default true, `billingOverride` default false, nullable `registrarSyncedAt`, and explicit `dnsManagementEnabled` default false. Regenerate Prisma.
- The included `@/lib/rbac` helper resolves super authority from the database. Platform-admin/bootstrap-email access is deliberately insufficient.
- Middleware lets only the exact sync pathname reach its own authentication handler. The handler validates the dedicated token in constant time or requires a super-admin session.
- Included package scripts: `domains:sync-namecheap` for one pass; `domains:sync-namecheap:scheduler` for daily scheduling. Startup invokes Node directly when enabled.

## Configuration / scheduling

- Existing live `NAMECHEAP_API_USER`, `NAMECHEAP_API_KEY`, `NAMECHEAP_CLIENT_IP` (and optional `NAMECHEAP_USERNAME`) are required; only the allowlisted server can contact the API. `NAMECHEAP_SANDBOX=true` is rejected before inventory writes or network calls. No sandbox imports into live inventory.
- Set a strong dedicated `NAMECHEAP_SYNC_TOKEN` on the app and scheduler. It has no fallback to other ops tokens. Send only as `Authorization: Bearer …`, never as a query parameter.
- Set `NAMECHEAP_SYNC_SCHEDULE_ENABLED=true` to start the scheduler with the existing production startup script. Off by default until migrations, credentials and initial inventory are reviewed.
- Default endpoint: loopback using `PORT` (3000 by default). Optional `NAMECHEAP_SYNC_URL` must target the exact endpoint over HTTPS, or HTTP on loopback; URL credentials, queries and fragments are rejected. Redirects are not followed.
- CLI supports `--once`. Scheduled mode performs an initial sync (five startup attempts, 15-second backoff), then another pass 24 hours after each previous pass finishes. Replicas may schedule simultaneously; the DB lease excludes overlapping syncs. Process restart causes another initial pass; writes are idempotent.

## API / inventory semantics

`POST /api/ops/domains-sync-namecheap` accepts a super-admin session or the dedicated machine token. No request body controls registrar configuration or pagination. Responses have explicit `Cache-Control: no-store`; unauthorized/forbidden are 401/403, operational failures 503, completed/already-running 200.

Results include `ok`, `reason`, `pages`, `fetched`, `imported`, `updated`, `skipped`, and local error codes/page numbers. Counts describe committed pages; failed-page writes roll back. Partial progress is intentional and safe to retry. Upstream exception text/XML, database errors and credentials are never returned or logged by the sync service/endpoint/scheduler.

The list request includes `ListType=ALL` (active and expired), 100 rows/page, maximum 100 pages/10,000 domains and a ten-minute between-page deadline. Each request retains the shared rate gate and 30-second network timeout; there are no per-domain detail requests. Invalid/missing pagination, duplicate domains, changing totals, page mismatch and invalid dates/flags abort safely. A failure can leave earlier pages refreshed; no absent inventory is deleted or marked expired.

New records are unassigned and active/expired as reported by the registrar. Inserts rely on schema billing defaults. Existing records receive **only** `registrarDomainId`, `expiresAt`, `autoRenew`, `registrarSyncedAt`. Existing status is intentionally untouched, including pending/failed orders and settled status; order reconciliation remains its owner's responsibility. Assignment, billing overrides/flags, charge history, DNS/nameservers, errors, soft deletions and other registrars are preserved. A concurrent checkout insert wins via `createMany(skipDuplicates)` followed by a narrow conditional update.

Importing or assigning a domain never enrolls it in DNS management. Both direct DNS provisioning and the hourly repair query require `dnsManagementEnabled`; imported records retain false. Existing purchased/Cloudflare-managed domains are backfilled to preserve their workflow. This prevents ingestion from silently changing registrar nameservers.

## Concurrency without network transactions

No new table/migration is needed: the existing `WebhookEvent` table holds one reserved internal ops-run marker, delivery ID `ops:namecheap-domain-sync:lease:v1`, source `namecheap-domain-sync`. This is not an external webhook delivery. Its `detail` is a random owner UUID (never a secret), `receivedAt` is the database-clock heartbeat, and `outcome` is running/applied/failed. Successful release clears ownership. Do not remove this running marker as part of webhook cleanup; source-filter external delivery maintenance.

Short transactions take advisory transaction lock 4711302 (distinct from usage collection), claim/reclaim a five-minute lease, renew it before each network page, and fence every page write by ownership **and** expiry. No transaction spans a Namecheap call. Crashed workers expire; a stale worker cannot write or release a successor's lease. PostgreSQL time avoids replica-clock skew. Page counters advance only after commit. A 15-second transaction timeout bounds a stalled page; retry after DB recovery.

## Validation

Vitest suites: `namecheap-sync.test.ts`, `domain-sync.test.ts`, the new endpoint's `route.test.ts`, plus existing `domains-pure.test.ts`. Scheduler tests use Node's built-in test runner. Race tests use serialized transactional DB doubles with rollback, exercising SQL lock use, overlap exclusion, stale-worker fencing, checkout conflict preservation and crash recovery; they do not contact production or validate a live PostgreSQL instance.