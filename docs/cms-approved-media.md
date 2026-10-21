# Verified CMS image persistence — publication handoff

## Scope / status

Implemented only in jongo-os. No configured migration, shared Prisma generation, remote import, provider credentials, public upload/download route, commit or deployment. Pending migrations, in order, are `20261020200000_cms_approved_media`, `20261020220000_cms_outbox_dispatch`, and `20261020230000_cms_media_cleanup`, after the CMS foundation/release migrations. No production storage is configured. This is NOT a finished live publication/storage integration.

`CmsApprovedMedia` is a private Prisma model bound to organization exclusively through `CmsDataset`. UUID identity is separate from exact native reference identity. Unique `(datasetId,id)` and `(datasetId,nativeId)` prevent cross-dataset substitution; the globally unique object key embeds dataset UUID, media UUID and exact rendition SHA-256. No raw source asset URL or caller approval boolean is used.

SQL enforces the stored rendition MIME (`image/webp` only), image-only asset type (never `sanity.fileAsset`), 20 MiB, integer dimensions <=16384 / <=40 million pixels, lowercase SHA-256, required alt, URL exactly `https://<host>/assets/<objectKey>`, reviewer/time for approval, user/dataset FKs, and pending->approved->revoked only. Identity/byte/text metadata is immutable, revoked is terminal, DELETE/TRUNCATE refused. `(datasetId,id)` and `(datasetId,nativeId)` are the composite targets for any future dataset-bound FK. SQL constraints alone are not proof of byte verification: write access to this table must remain server-owned.

## Exact server APIs

Module: `apps/web/src/lib/cms/media.ts`.

- `createCmsMediaService(store: CmsMediaStore, { publicOrigins: string[] })` returns the methods below. `publicOrigins` is a server-configured list (1–8) of exact HTTPS origins; invalid config throws. No default storage/fallback, no HTTP-handler exposure. Compose a trusted server-owned adapter, never deserialize one from request data.
- `stageApprovedImage(actorId, datasetId, bytes: Buffer, contentType, {alt,caption?,nativeId?})` returns `{id,datasetId,nativeId,status:'pending'}`. Despite its name, staging is NOT approval. Fresh editor/read/sponsor/write-flag authorization happens before decode and again before DB persistence. PNG, JPEG, WebP and AVIF (AV1) single-frame inputs must match their decoded format. GIF, HEIC, SVG, executables, malformed/truncated raster and animation are refused. Sharp is a pinned direct web dependency. Decode/re-encode to WebP strips EXIF/GPS/XMP/ICC; decoded dimensions/size/hash describe the actual sanitized bytes. Private stored bytes are read back, hashed and fully decoded. Metadata, digest and audit are persisted together.
- `approveMedia(actorId,datasetId,id)` returns `{id,datasetId,nativeId,status:'approved'}` only after fresh transaction-locked **manage** authorization (admin role plus publisher/author capacity), exact pending scoped lookup, private-byte verification, immutable public promotion, and independent public-object read/hash/full-decode verification. URL comes only from the trusted adapter and must equal `https://<allowlisted origin>/assets/<objectKey>`; relative URLs are refused because releases are consumed on other hosts. Reviewer and timestamp are server-generated; no URL/status boolean/hash/dimensions can be submitted. DB approval and audit are atomic.
- `revokeMedia(actorId,datasetId,id)` requires the same fresh locked manage authorization. In one DB transaction it changes approved to revoked, creates a unique durable cleanup job, and audits the job identity. It then deletes all object versions/private and public keys, requests an exact-file Cloudflare purge, and probes that URL through the configured CDN origin with `HEAD`/`Cache-Control: no-cache`; only 404/410 is accepted. It returns a revoked success receipt only after origin deletion and this probe are acknowledged and audited. Missing configuration, provider errors, a live CDN response, or purge refusal returns sanitized `unavailable`; the DB remains revoked and the job remains retryable. A worker retries with a lease and backoff; there is no automatic fallback or dead-letter success.

Actor IDs must come from an authenticated server session; the service intentionally does not create a general upload route or accept anonymous actors.

## Storage contract

`CmsMediaStore` supplies `putPrivate(key,bytes)`, `getPrivate(key)`, `promotePublic(key)`, `getPublic(key)`, `publicUrl(key)`. The server-only `media-s3-store.ts` implements S3-compatible B2 calls using AWS Signature V4 with bounded reads, create-only private PUT, immutable-content promotion, and deletion of every returned object version/delete marker. The CDN origin must serve the public object key under `/assets/<key>`; B2 bucket policy/permissions and Cloudflare origin/path behavior are operator-owned.

Production composition is explicit through `createProductionCmsMediaService()` in `media-production.ts`. It has no filesystem fallback and validates all required environment values before constructing the adapter:

| Environment variable | Meaning |
| --- | --- |
| `CMS_MEDIA_S3_ENDPOINT` | Exact HTTPS S3-compatible endpoint origin; no path/query/credentials |
| `CMS_MEDIA_S3_REGION` | S3 signing region |
| `CMS_MEDIA_S3_PRIVATE_BUCKET` | Dedicated bucket configured private; stores originals and never serves public traffic |
| `CMS_MEDIA_S3_PUBLIC_BUCKET` | Different dedicated bucket configured public and fronted by the CDN; never reuse the private bucket |
| `CMS_MEDIA_S3_ACCESS_KEY_ID` | Server-only B2/S3 application-key ID |
| `CMS_MEDIA_S3_SECRET_ACCESS_KEY` | Server-only B2/S3 application-key secret |
| `CMS_MEDIA_CDN_ORIGIN` | Exact HTTPS public CDN origin; objects are referenced at `/assets/<objectKey>` |
| `CLOUDFLARE_ZONE_ID` | Zone ID used for exact-file purge |
| `CLOUDFLARE_API_TOKEN` | Server-only token with only required cache-purge permission for that zone |
| `CMS_MEDIA_CLEANUP_ENABLED` | Exact `true` to enable the independent retry worker; default off |

Run one cleanup pass with `npm run cms:media:cleanup` or the long-running worker with `npm run cms:media:cleanup:worker`. The production worker requires both B2/S3 and Cloudflare configuration; an absent value is recorded as a fixed `invalid_configuration` outcome and retried, never treated as success. The operation uses only server environment values and redacted audit outcomes. Do not put any of these values in `NEXT_PUBLIC_*`, CMS content, requests, logs, or this repository. Private/public separation is bucket-level, not ACL-based; configure separate B2 buckets, restrict the private bucket to its application key, and permit public reads only on the public bucket. The adapter currently implements AWS Signature V4 with Node primitives because this task is constrained to no network and the AWS SDK's offline lockfile resolution failed; no direct SDK dependency was added. This is a deliberate review gate: validate against B2's actual S3-compatible API and prefer replacing the handwritten signer with `@aws-sdk/client-s3` once dependencies can be resolved safely.

All keys are server-generated. The adapter must enforce bounded reads, create-only immutable objects, and independent private/public read credentials; the service additionally enforces the origin allowlist. The trusted adapter instance is the provider capability; do not accept a provider token/URL/adapter from callers. No remote HTTP fetch is performed by this service. Existing-object ingestion must obtain bytes from owned trusted storage then run this staging/approval path, not register metadata around a raw public URL.

`createIsolatedFileSystemMediaStore({publicBaseUrl,approvedOrigin,parentDirectory})` in `media-local-store.ts` is TEST ONLY: it refuses unless `NODE_ENV=test`, requires an explicit absolute existing `parentDirectory` (no `public` path segment, resolved via realpath), makes a fresh random namespace under it, validates exact HTTPS origin and `/assets/` base, accepts only strict UUID/UUID/sha256.webp keys (traversal rejected), uses create-only private writes, verifies conflicts during retry promotion, and exposes no deletion rights. It returns `{store,root}`; callers own cleanup. There is NO public serving integration.

Storage and PostgreSQL cannot commit atomically. Promotion happens before the approval commit, so a failed/retried transaction can leave a promoted (sanitized, manage-authorized) but unapproved public object. A failed revocation cleanup leaves the row revoked and the job pending; it never claims completion. Cloudflare purge acceptance alone is insufficient: cleanup also probes the configured CDN URL and refuses completion if that probe still receives a live status. A single probe cannot mathematically prove every Cloudflare PoP has converged, and provider-side version listing/deletion must be supported; unsupported operations keep the job pending. For a hard global erasure guarantee, serve media through an authorization layer/origin that can deny revoked keys immediately, or choose a storage/CDN architecture with verifiable synchronous purge semantics. This implementation does not claim a global edge-erasure guarantee.

## Publication agent integration

The publisher must call `loadApprovedMedia(tx,datasetId,nativeIds,publicOrigins)` **inside** its existing `executeCmsWriteTransaction(...,'publish',...)` callback, while holding the dataset lock through release/pointer/audit/outbox commit. The helper is an internal DB repository bridge, not independent authorization or a caller-approved record factory. Persisted URLs are re-checked against the current origin allowlist.

It queries `tx.cmsApprovedMedia.findMany` for exact requested native IDs, dataset and persisted approved state. It verifies scoped identity/key/digest/MIME/dimensions/size/alt, reviewer/time and canonical URL; missing, pending, revoked, malformed, duplicate and cross-dataset rows fail closed. Return value:

- `references: ReadonlyMap<nativeId,{_type:'sanity.imageAsset'}>` — merge this with the publisher's verified same-dataset document-reference closure.
- `resolveAsset: ApprovedAssetResolver` — pass to `mapApprovedRelease`; outputs only `{url,alt,caption}`, never object keys, hashes, reviewer identities or private metadata. Different dataset envelopes resolve null.

`PrismaCmsApprovedAsset` names the private typed row shape, not a public DTO or authorization proof. Never supply rows from requests, source imports, or caller booleans. No publication implementation was changed here. No runtime import of a legacy/site asset manifest.

## Verification

Focused unit tests (`media.test.ts`, 52) use real Sharp and real isolated filesystem persistence plus mocked transaction boundaries. `scripts/test-cms-marketing-delivery.mjs` (disposable PostgreSQL 17, never a configured DB) now applies this migration, runs 28 media SQL rejection checks (key binding, WebP-only, limits, URL/key binding, transitions, immutability, no delete/truncate) and a real Prisma + Sharp + isolated store lifecycle: editor stage, metadata strip/hash readback, pending unpublishable, editor and downgraded-sponsor approval denied, manage approval with verified promotion, publish-transaction loader projection, tampered-byte refusal, terminal revocation and audit counts. Successful release publication with media is now implemented and exercised in the same harness; see [cms-release-delivery.md](cms-release-delivery.md). No configured database writes, migrations or commits.

Dependency: `sharp` 0.34.5 pinned directly in `apps/web` (already resolved transitively via Next; now non-optional, so npm adds its `@img/*` platform packages). The npm install had also dropped the eight `@next/swc-*` lock entries; they were restored verbatim from HEAD.
