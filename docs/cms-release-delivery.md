# CMS Phase 3 — bounded marketing delivery

## Outbox dispatcher — 2026-10-20 (supersedes "no outbox dispatcher/signing" below)

- Pending additive migration `20261020220000_cms_outbox_dispatch` (earlier pending migrations unedited): `CmsDeliveryTarget` (dataset FK, `consumerId`, `url` HTTPS-only with SQL-permitted plain HTTP only for loopback, `secretEnv` = env var **name** matching `CMS_DELIVERY_SECRET_*`, `enabled` default false); `CmsContentDelivery` per event×target receipts (`pending|delivered|dead`, attempts, status code, fixed error code); outbox `leaseUntil`/`leaseToken`/`lastAttemptAt` + `(datasetId,id)` unique.
- [`outbox-dispatcher.ts`](../apps/web/src/lib/cms/outbox-dispatcher.ts): `FOR UPDATE SKIP LOCKED` claim of due pending events or expired leases (attempts incremented per claim), POST `{"version":1,"eventId":<outbox id>,"datasetId"}` with `x-jongo-timestamp` and `x-jongo-signature: v1=HMAC-SHA256(secret, "v1.<ts>." + body)` — exactly the mfts-2026 receiver. 5 s timeout, `redirect: manual` (3xx = failure), ≤4 KiB response drained. Lease-token-fenced receipts/finish; already-delivered targets are not re-sent; backoff 30 s doubling to 1 h; `failed` + `dead` receipts after 8 attempts. Logs only event ID, consumer ID, status and fixed codes.
- Worker: `npm run cms:outbox:dispatch` (`--once`) / `npm run cms:outbox:dispatcher` (loop). No-op unless `CMS_OUTBOX_DISPATCH_ENABLED=true`. Not wired into `start-production.mjs`. Uses the process environment only and the installed `typescript` to load the module.
- Tests: `outbox-dispatcher.test.ts` (shared vector `revalidation-signing-vector.json`, byte-identical to `mfts-2026/tests/fixtures/`), and the disposable harness (18 dispatch SQL checks + real publish events → loopback HMAC receiver → delivered receipts, reclaim, dead-letter). No configured migration, target or secret was created.

## Current publication lifecycle — 2026-10-21

The dataset editor now provides saved-draft selection, current release status, confirmation-gated publish/unpublish, and manage-gated dataset credential list/mint/revoke. Server Actions reauthenticate and bind to the route's dataset and organization; minted bearer tokens return once, while the database retains only the token hash. No public HTTP publishing endpoint accepts caller DTOs. The six additive migrations were applied to production after a verified backup; the app was then deployed from merged main commit `6c16103`. CMS writes and workers remain off; no production dataset, credential, content release, B2/CDN configuration or provider operation was created. [Current verification and local setup gaps](../../../mfts-2026/plan.md#continuation-verification--2026-10-21).

## Publication lifecycle — 2026-10-20 (historical implementation snapshot; see current continuation above)

Successful publish, unpublish and rollback are implemented as internal server services plus a local-only CLI. There is **no HTTP publishing endpoint and no editor server action**; no endpoint accepts DTOs. Verification: root `npm run type-check` passed; CMS suites **646 tests / 11 files** passed (new `marketing-publication.test.ts` 59) with an unreachable `DATABASE_URL`; `node scripts/test-cms-marketing-delivery.mjs` passed on its own disposable PostgreSQL 17 cluster (22 release SQL + 28 media SQL checks, credential/media services, and the real lifecycle below), cleanup passed. No configured migration, production call, token issuance outside the disposable cluster, or commit.

### Exact API (`apps/web/src/lib/cms/marketing-publication.ts`, server-only)

- `createMarketingRelease(actorId, datasetId, revisionIds: string[], expectedPublicationRevision: number, { publicOrigins: string[] }): Promise<{ datasetId, releaseId, sequence, publicationRevision, checksum, documentCount }>`
- `unpublishMarketing(actorId, datasetId, expectedRevision: number): Promise<{ datasetId, releaseId, publicationRevision }>` — `releaseId` is the removed release.
- `rollbackMarketingRelease(actorId, datasetId, releaseId, expectedRevision: number): Promise<{ datasetId, releaseId, publicationRevision }>`
- `marketingAssetRefs(payload)` — exported helper listing the image `_ref`s the projection consumes.

All three run inside `executeCmsWriteTransaction(..., "publish", ...)`: both CMS flags, fresh locked publisher-rank (2) policy intersected with the sponsor's authoring entitlement, Serializable with the existing retry boundary. Errors are `CmsDocumentError` codes only: `invalid` (input/eligibility/validation/media), `conflict` (CAS/stale/no-op), `denied`, `unavailable`. `publicOrigins` is server configuration (1–8 exact HTTPS origins, same rule as media); invalid config refuses before any DB access.

### Publish algorithm

1. Input: 1–100 unique UUID revision IDs; **empty releases are refused** before DB access. Expected revision is an integer ≥ 0 (absent publication row = 0).
2. CAS precheck on `CmsMarketingPublication.revision` before reading revisions.
3. Each selected revision must be the `currentRevisionId` of a live (non-archived) same-dataset document, type `agencyWork` | `partnerStories` | `article`, and its `schemaVersion` must equal the current registry version. The stored payload must validate in draft mode with `_id === nativeId` and `_type === type`; `nativeId`/`logicalId`/`variant` must agree.
4. **Explicit promotion:** a detached JSON copy gets `_id = logicalId` (`drafts.X` → `X`). The stored draft revision is never written.
5. Media: `cardAsset`, `gallery[].asset`, `portrait.asset`, `logo`, `cover.asset` and body `image.asset` refs (≤200 unique) go to `loadApprovedMedia(tx, datasetId, ids, publicOrigins)` in the same transaction. Any missing/pending/revoked/malformed row refuses the release.
6. Other references resolve only to live same-dataset documents by **logical** ID with a single unambiguous type. `drafts.`-prefixed or unknown targets stay unresolved, so strong references refuse; weak references remain non-blocking per the validator.
7. `validateDocument(promoted, { mode: "publish", records })` must be valid with `canPublish` (pending/missing `publicationApproval`, missing consent/likeness/status, quarantine/unknown fields, unresolved strong refs, illustrative evidence and wrong reference types all block). Then `mapApprovedRelease` projects with `resolveAsset`; projection failure refuses.
8. Documents keep **caller order**. `validateMarketingDocuments` (strict DTO + duplicate id/route checks) runs before insert. `snapshotText = JSON.stringify(documents)` (≤1 MiB), `checksum = sha256(snapshotText)`, mirror `payload = { documents }`.
9. One transaction writes: `CmsMarketingRelease` (next dataset `sequence`, version 1, actor); pointer create (expected 0, no row) or `updateMany where { datasetId, revision: expected }` → `revision + 1`, `status: active`; `CmsContentOutbox` `release_publish` with `{ schemaVersion, eventType, datasetId, releaseId, publicationRevision, checksum }`; `AuditLog` `cms.marketing.release.publish` (organization-bound; release/sequence/revision/checksum/count/revision IDs).

### Unpublish and rollback

- Unpublish requires an **active** pointer at exactly `expectedRevision` (≥1). It sets `releaseId = NULL`, `status = revoked`, `revision + 1`, emits `release_unpublish` naming the removed release, and audits `cms.marketing.release.unpublish`. Releases are never deleted. Delivery then returns 404 (existing route behavior; no fallback).
- Rollback requires the pointer at `expectedRevision` and a retained same-dataset release that is not already the active pointer. It re-parses the snapshot (`parseMarketingSnapshot`: stable text, checksum, strict DTOs) and requires every served image URL to still belong to an **approved** `CmsApprovedMedia` row of that dataset — revoked media cannot return through history. It re-points (`active`, `revision + 1`), emits `release_publish` with `rollback: true`, and audits `cms.marketing.release.rollback`. No new release row is written. Rollback does **not** re-read authoring revisions: a withdrawn quote/likeness consent after a release must be handled by unpublish + a fresh publish, not rollback.

### Local CLI (no HTTP)

`npm run cms:release:marketing -- <publish|unpublish|rollback> --dataset-id <uuid> --actor-id <uuid> --confirm-dataset <same uuid> --expected-revision <n>` plus, for publish, repeated `--revision-id <uuid>` (order preserved) and `--public-origin <https origin>`; for rollback `--release-id <uuid>`. Runs [scripts/publish-marketing-release.ts](../scripts/publish-marketing-release.ts) via the existing `run-typescript.cjs` launcher (now allowlisting exactly the importer and this entry). Before importing DB modules it applies the importer's guard (`assertLocalDatabase` now takes an optional prefix list; the importer default is unchanged): non-production, `DATABASE_NAME` matching `cms_import_test_*` or `cms_release_test_*`, loopback host, path equal to the name, only `schema=public`. It then checks `current_database()` and loopback `inet_server_addr()` on the silent delivery client. No dotenv. Output: JSON receipt, or `CMS release <code>.` with exit 1. The CMS flags must be set in the operator's environment.

### Verified lifecycle (disposable cluster, synthetic data)

Fresh dataset; owner Studio (`core-sla`, active); five PNGs staged via the test-only local store and approved through `approveMedia`; Work, Testimonial (with a strong `relatedWork` to the Work's logical ID) and Article saved via `saveCmsDraft` as `drafts.*`. Refusals with zero release/pointer rows: media not yet approved, pending consent document added, empty selection, editor-only collaborator (`denied`). Publish (Article, Work, Testimonial order) → revision 1, sequence 1. Repeat with stale revision → `conflict`. Actual GET route with a freshly minted credential: five root fields, caller order, logical IDs, approved URLs for every image position, no private/draft fields, checksum = SHA-256 of `JSON.stringify(documents)` = stored `snapshotText`. Stored draft `_id` unchanged. Unpublish (stale → conflict) → 404, release retained; rollback → 200 with the same release/checksum; rollback to the active release → conflict. Outbox `publish:1`, `unpublish:2`, `publish:3`; three audits. After revoking one used image: rollback and republish both `invalid`, delivery stays 404.

### Historical incomplete-state note (pre-dispatcher and editor UI)

No outbox dispatcher/signing/consumer revalidation, no mutation-ID idempotency receipts for publish (CAS only; a blind retry after a lost response returns `conflict`), no editor UI/server action, no review queue beyond persisted approval fields, no S3 adapter or public media serving, no takedown purge of cached copies, and no multi-session concurrency proof beyond Serializable + CAS. Configured migrations remain unapplied.

## Historical record (pre-lifecycle)
## Latest integrated verification — 2026-10-20

Full `verify:local` now includes the persisted marketing harness: **2,014 tests / 126 files**, TypeScript, **17 foundation checks**, **22 release SQL rejection checks**, actual snapshot GET and bounded real Prisma credential services all passed. Custom-output temporary client generation and failure cleanup passed; configured runtime client untouched. Only disposable test credentials minted. Provider GET exists and the independent site's configured transport is wired; **no actual client publication end-to-end**. Jongo production build not run. See [exact results, preview/browser evidence and remaining gates](integrated-delivery-verification-2026-10-20.md). Historical focused counts below are not additive.

## Implemented boundary, not complete publishing

The authenticated snapshot GET, strict transport validation, internal credential mint/revoke functions and **deliberately non-publishing** revision-selection scaffold are implemented. No authoring HTTP publisher, SDK, media store, approval workflow, revision promotion, worker, signing, consumer integration or deployment credential is supplied. No configured migration, seed, production operation or commit is authorized.

The pending [migration](../prisma/migrations/20261020180000_cms_marketing_release_delivery/migration.sql) was edited **before application**, adding required `snapshotText TEXT` and changing the JSONB mirror to `{ documents: [...] }`. It depends on the existing pending CMS foundation migration; preserve migration order and obtain separate target/backup/operator approval. Existing rows/tables are not rewritten. Applying only Prisma schema push would omit SQL checks and immutable triggers.

## Exact v1 transport and hash

GET `/api/content/v1/datasets/{datasetId}/marketing` returns exactly these five root fields:

- `schemaVersion`: literal `1`.
- `datasetId`: the credential-bound dataset UUID.
- `releaseId`: the current pointer's immutable release UUID.
- `checksum`: lowercase SHA-256 of UTF-8 `JSON.stringify(documents)`.
- `documents`: ordered public work/testimonial/article-detail DTOs, at most 100 total.

`snapshotText` stores the **exact** `JSON.stringify(documents)` string, not the five-field response. Readers parse it, require `JSON.stringify(JSON.parse(snapshotText)) === snapshotText`, verify SHA, and strictly validate every DTO before returning it. This preserves object-key order across PostgreSQL JSONB round trips. JSONB `payload` is a metadata mirror only, never the hash source or response. SQL requires it to equal `{ documents: JSON.parse(snapshotText) }` by JSONB semantics. The old three-array envelope and `jongo-json-sorted-v1` release hashing are superseded; private authoring revision hashing is unchanged.

Both text and JSONB mirror have independent 1 MiB database bounds. The reader enforces the text bound before parse and shared structural budgets after parse. Nested properties are allowlisted by the existing code-owned [DTO JSON Schema](../apps/web/src/lib/cms/marketing-contracts.schema.ts), interpreted by [strict snapshot validation](../apps/web/src/lib/cms/marketing-snapshot.ts). Unknown fields, private properties, draft IDs, duplicate identities/routes, unsafe URLs, invalid timestamps, unknown rich-text tokens/marks, unsupported versions and bad checksums fail closed. SQL alone does not validate DTOs, approvals, checksum truth or media readiness.

## Persistence and read flow

- `CmsMarketingRelease`: immutable dataset-bound UUID, positive sequence, version 1, mirror payload, exact text, checksum, optional actor and timestamp. UPDATE (including no-op), DELETE and TRUNCATE are guarded. Runtime roles must not have privilege to disable triggers.
- `CmsMarketingPublication`: one row per dataset; active requires a non-null same-dataset release and positive revision; revoked requires null pointer. Missing/revoked/null never means “latest release.” There is no duplicate dataset scalar pointer.
- `CmsDeliveryCredential`: exact `marketing.read` scope, globally unique SHA-256 hash, non-secret display identifier, expiry/revocation and actor. Dataset binding cannot be changed by the request.
- `CmsContentOutbox`: logical release event ledger only. No targets, receipts, dispatcher, signed delivery or publishing success is implied.

[The read adapter](../apps/web/src/lib/cms/marketing-release-adapter.ts) resolves credential + dataset/organization/owner/site liveness + active pointer + immutable release in a RepeatableRead transaction. It reads **no CmsDocument/CmsRevision payload** and never falls back to drafts, fixtures or older releases. No sponsor plan/authoring-feature gate is used for reads, so downgrades retain existing published delivery. Deleted/archived scopes and revoked publication remain denied.

[Middleware](../apps/web/src/middleware.ts) exempts only GET with an anchored UUID marketing-route regex. It does not exempt a content namespace, child path, suffix or write method. The Node [handler](../apps/web/src/app/api/content/v1/datasets/[datasetId]/marketing/route.ts) always independently authenticates; existing dev/session/ops bypasses cannot authorize delivery.

Responses, including errors/304, use `Cache-Control: private, no-store`, `Vary: Authorization` and nosniff. ETag binds release ID and checksum. A conditional request still checks credentials, current pointer and checksum first. Missing/malformed/unknown/revoked/expired/wrong-scope/cross-dataset token all return the same 401; only an authenticated matching token can receive 404 for absent/inactive content scope. Corruption/outage returns redacted 503. No raw SDK errors are logged by these paths: a separate lazy Prisma client uses `log: []`.

## Internal credentials and publication gate

[Credential functions](../apps/web/src/lib/cms/deliverycredentials.ts) use 32 random bytes (`jcms_` plus 43 base64url characters), hash exact token bytes with SHA-256, return raw token once and persist only hash plus an independent display identifier. Exact hash-index lookup is sufficient: no recoverable secret or prefix is compared, and token validity is not disclosed across dataset scope. Revocation is immediate on subsequent reads; expiry is checked each read. Tokens belong only in the consumer's server secret channel, never browser bundles, URLs, logs, audit or outbox. No token has been minted by this implementation task.

Mint/revoke require both feature/write flags and fresh **manage** permission intersected with the current owner's authoring tier. They use the existing dataset/policy lock order and Serializable retry boundary, then reauthorize inside the locked transaction. Audit is organization-bound and contains only credential identity, not token/hash. Audit failure rolls back issuance/revocation. Scope permissions are not inferred from a delivery token or platform/global identity.

[`createMarketingRelease(actorId, datasetId, revisionIds, expectedPublicationRevision)`](../apps/web/src/lib/cms/marketing-publication.ts) *(historical; superseded by the lifecycle section above)* accepts no public DTO, callback, approval boolean, resolver or snapshot text. Under the same locked transaction it requires fresh **publish** permission, checks expected pointer revision, loads at most 100 same-dataset current native revisions, validates their authoring schema/identity/version, and queries private reference edges. **It always fails closed before release/pointer/audit/outbox writes.** All currently supported marketing documents require approved media and there is no authoritative approved immutable-media store/resolver. Native drafts also require explicit detached identity promotion and exact-revision approval review; stripping `drafts.` is not approval. Neither mechanism is invented here. Empty releases are refused; no implied “owner confirmed empty” path exists.

The legacy source-envelope `loadApprovedMarketingRelease` remains unavailable. Public delivery does not pretend that persisted DTOs reconstruct an approved authoring envelope. No complete publish/unpublish service or successful editor-to-consumer publishing workflow is claimed.

## Remaining publish protocol (historical; see lifecycle section above for what is now implemented)

Before enabling publication, implement exact-revision review/promotion, fresh same-dataset reference and immutable approved-media closure, strict public allowlist projection and final DTO validation. Under the existing dataset lock, allocate sequence, append the exact text/mirror/checksum, CAS pointer revision, append minimal organization audit and one logical outbox event atomically. Define mutation receipts/idempotency before exposing a write transport. Rollback needs fresh review and a new release, never activation of arbitrary history. Whole-snapshot unpublish must atomically clear the pointer, increment revision and audit/event the removed release. Add real PostgreSQL rollback/concurrency acceptance before claiming these properties.

## Validation and operator gates

Focused tests exercise synthetic public fixtures and mocked transactions: strict shapes/hash/order, draft isolation, token failures, deleted scope, retained downgrade read, ETags, redacted failures, fresh locked issuance policy and exact middleware exemptions. These are not PostgreSQL execution, concurrency or approval proofs. A direct-SQL synthetic snapshot in an **isolated disposable DB** may prove authenticated reads; it must be labeled test-only, never a real approval or publish success.

Prisma validation/client generation and disposable SQL tests are separate checks. Use unreachable dummy DB URLs and no production wrappers; do not apply configured migrations. Prior normal client generation encountered Windows EPERM on a shared native engine; do not kill shared servers/remove locked engines. Deployment requires compatible generated client, reviewed migration application, operator-managed secret issuance and consumer configuration later.

2026-10-20 verification for this boundary:

- Root `npm run type-check`: passed.
- All CMS suites: **536 tests / 9 suites passed**, including 68 new delivery tests.
- [Disposable delivery smoke](../scripts/test-cms-delivery.mjs): full working schema validated; Prisma client generated into a temporary directory (not the shared runtime client); baseline plus pending foundation/release migrations applied only to the script's new loopback PostgreSQL cluster. Direct-SQL synthetic snapshot then actual GET handler + isolated Prisma verified exact five-field response/checksum, JSONB normalization independence, private headers, 304, missing/revoked token 401, and revoked pointer 404 with no fallback. Temporary cluster stopped, listener closed, directory removed.
- `--fail-after-start`: intentional nonzero exit with successful own-cluster/directory cleanup.
- Whitespace checks passed. No configured migration or runtime client regeneration, deployment token issuance, production data, commit or deployment occurred. These checks do **not** prove publishing, approval, atomic publish/audit/outbox, or real transaction races.