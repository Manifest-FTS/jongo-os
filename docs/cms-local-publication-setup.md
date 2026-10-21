# Local CMS publication, delivery and media setup

This is an operator checklist for the local Jongo → Manifest site loop. Keep actual values in ignored local environment files or a secret manager; never add tokens, signing secrets or B2 credentials to this document, source control, browser variables or chat.

## Current local boundary

- Jongo's isolated PostgreSQL is expected at `127.0.0.1:15433`; confirm with `npm run db:local:status` from the Jongo OS root. Do not use the production-oriented root `.env`/migration wrappers for local work.
- The site dev server must run at `http://localhost:3026`; Jongo's content API runs at `http://localhost:3000`.
- The site loader permits `http://localhost:3000` only while Next is in local development. Production/build configuration must use HTTPS.
- Local CMS tables are introduced by pending migrations. Do not apply them to any configured database until the user explicitly approves the target, backup and migration operation. `npm run verify:local` and `node scripts/test-cms-marketing-delivery.mjs` use isolated disposable PostgreSQL clusters and do not migrate the configured local DB.
- CMS operations require `JONGO_CMS_ENABLED=true`; mutations also require `JONGO_CMS_WRITES_ENABLED=true`. Both are default-off. The user/session needs fresh dataset publish or manage permissions and an eligible sponsor plan. No bootstrap bypass is provided.

## Manifest site: `mfts-2026/.env.local`

Create this ignored local file after a dataset and read credential have been provisioned:

```dotenv
MARKETING_CONTENT_SOURCE=jongo
CMSDELIVERY_ENABLED=true
JONGO_CONTENT_URL=http://localhost:3000
JONGO_CONTENT_TOKEN=<one-time-minted-marketing.read-token>
JONGO_CONTENT_DATASET_ID=<dataset-id>
REVALIDATION_SECRET=<unique-random-ASCII-secret-at-least-32-characters>
```

The `JONGO_CONTENT_TOKEN` is returned once by the dataset's Delivery credentials panel. Put it in the site server environment only; the saved database row contains only a hash. Keep it different from `REVALIDATION_SECRET`.

The `REVALIDATION_SECRET` must be 32–4096 printable non-whitespace ASCII characters. Configure the exact same secret in Jongo under a variable name that starts with `CMS_DELIVERY_SECRET_`, for example `CMS_DELIVERY_SECRET_MFTS_LOCAL`. The outbox sender signs with that value; the site validates it. Do not use a `NEXT_PUBLIC_` prefix.

## Jongo local runtime

Set the following in `apps/web/.env.local` (or the server process environment loaded by the local start script):

```dotenv
JONGO_CMS_ENABLED=true
JONGO_CMS_WRITES_ENABLED=true
CMS_PUBLIC_MEDIA_ORIGINS=https://<your-cloudflare-media-host>
CMS_DELIVERY_SECRET_MFTS_LOCAL=<same-value-as-site-REVALIDATION_SECRET>
CMS_OUTBOX_DISPATCH_ENABLED=true
```

The target must be explicitly registered for the dataset and enabled, with URL `http://localhost:3026/api/content/revalidate` and `secretEnv=CMS_DELIVERY_SECRET_MFTS_LOCAL`. Plain HTTP is accepted only for loopback. Register/configure it only after migrations are approved and applied locally and the local CMS dataset exists. The dispatcher is an opt-in worker and is not automatically started by `npm run dev` or the production launcher; run it as a separate local process with the target secret available in that process environment.

## Backblaze B2 and Cloudflare

The production media adapter speaks the S3 API and is configured with server-side values:

```dotenv
CMS_MEDIA_S3_ENDPOINT=https://s3.<B2-region>.backblazeb2.com
CMS_MEDIA_S3_REGION=<B2-region>
CMS_MEDIA_S3_PRIVATE_BUCKET=<private-quarantine-bucket>
CMS_MEDIA_S3_PUBLIC_BUCKET=<public-assets-bucket>
CMS_MEDIA_S3_ACCESS_KEY_ID=<B2-application-key-id>
CMS_MEDIA_S3_SECRET_ACCESS_KEY=<B2-application-key-secret>
CMS_MEDIA_CDN_ORIGIN=https://<Cloudflare-CDN-host>
CLOUDFLARE_ZONE_ID=<Cloudflare-zone-id>
CLOUDFLARE_API_TOKEN=<zone-scoped-token-with-cache-purge-permission>
CMS_MEDIA_CLEANUP_ENABLED=true
```

Use distinct private/public buckets and a B2 application key scoped to only those buckets and required object/version operations. Configure the Cloudflare custom hostname/origin to serve the public bucket at `/assets/<dataset>/<media>/<sha256>.webp`; the adapter refuses other URL shapes. The cleanup worker deletes all public/private object versions, purges the exact Cloudflare URL, verifies the CDN responds 404/410, and retries durable cleanup jobs on failure. Run `npm run cms:media:cleanup:worker` separately; it is opt-in and not automatically scheduled. Approval, storage, CDN and cleanup credentials are intentionally absent from the repository.

## Safe activation sequence

1. Confirm local DB status and obtain explicit approval before applying the pending migrations, in order. Do not use `db push`; SQL checks/triggers are required.
2. Provision an organization-owned or linked dataset through an authorized path and confirm its UUID. The dataset provisioning UI is not implemented yet.
3. Open `/clients/<client-id>/content/<dataset-id>` in Jongo. The current page includes publication state, selected saved drafts, publish/unpublish confirmation and delivery credential list/mint/revoke controls. Publishing requires eligible approved content and approved media; it fails closed otherwise.
4. Mint a dataset `marketing.read` credential; copy it once into the site local file. Never paste it into chat or commit the file.
5. Register and enable the local delivery target with the exact site revalidation route and shared HMAC secret. Start the outbox dispatcher in a separate local process.
6. Configure B2/CDN only when those operator-managed credentials and bucket/CDN behavior are ready. Start the cleanup worker separately and verify revocation removes all versions and the CDN URL returns 404/410.
7. With the site on port 3026, publish a reviewed test release and confirm a successful outbox delivery and site revalidation. Unpublish should make the content API return 404; revocation should immediately block delivery and leave cleanup retryable until verified complete.

## Implemented code vs. remaining UI/integration work

The current tree contains the server-bound publication and credential actions and the `MarketingAdminControls` panel; credential tokens are returned once and never stored in plaintext. B2-compatible upload, private/public promotion, CDN purge and durable cleanup services/workers are implemented. No CMS media upload/review UI, dataset provisioning UI, delivery-target management UI, credential expiration control, automatic worker supervision, configured migration or live B2 credentials are supplied. The local site environment also cannot be wired to a real dataset until a local dataset/token/signing secret exist.
