# Marketing schema and public DTO contracts — v1

Scope: app-local schema/projection contracts only. No publish service, authoritative release store, asset storage, delivery route, migrations, packages or production changes are provided. No cryptographic verification or access authorization is claimed by the mapper or its synthetic tests.

## Persisted identities and authoring

- `agencyWork` remains the persisted Work type, now titled **Work case studies**. `workCaseStudy = agencyWork` is the exact same constant, not a registered second type. Existing IDs, references and schema version 1 remain intact.
- `partnerStories` remains the persisted story type, now titled **Testimonials & partner stories**. `testimonial = partnerStories` is the same constant. Existing consent, excerpt/omission, likeness, mark and related-work rules still apply.
- `article` is the sixth registered type: required slug, title, excerpt and Portable Text body; optional locale, author, attribution, updatedAt and SEO; publication requires publishedAt, cover media, private provenance and private approved publicationApproval with evidence/reviewer/date. Incomplete drafts remain private. Public projection additionally requires a nonempty body and canonical route slug.
- All three accept optional `author: { name, role?, url? }` and `attribution` as reviewed public content. They are not defaulted or copied from private provenance, dates or account profiles. Do not invent authors or use source location as approval. Story `personName`/`role` remain quote attribution, not an inferred article author. Story `link: { href, label }` is optional approved editorial content; no related-work route is inferred from a reference.

Source authoring envelopes and private evidence are never DTOs. Existing source dates remain unchanged; article publishedAt/updatedAt are explicit editorial values, not generated from ingestion time or proof of release.

## Parent server adapter task — deliberately blocked today

[The adapter scaffold](../apps/web/src/lib/cms/marketing-release-adapter.ts) always throws. A future server implementation must:

1. Authenticate/authorize the consumer, bind its dataset/environment/audience/locale and resolve its current authoritative public release. Enforce revocations, tombstones/takedowns, retained-release policy and schema compatibility. Never trust a request-supplied release record, `trusted: true`, `canPublish`, source `variant=published`, `_rev` or document approval status as release authority.
2. Select the exact immutable release entry/revision from server storage. Supply `PublishedReleaseContext { releaseId, datasetId, documentId, revisionId, schemaVersion }` and the matching revision envelope. `documentId`/`revisionId` are native storage selections; payload `_id`/`_rev` remain separate source identity claims. The mapper checks bindings but cannot prove a server lookup occurred or that payload bytes match a stored hash. That verification belongs here.
3. Resolve exact same-dataset reference closure and public-approved media renditions bound to that release. No draft target, raw source URL, arbitrary remote import, private original or signed private preview URL may become public media. The callback returns approved `{ url, alt, caption }` or null. URLs receive safety checks, not storage/consent verification; an HTTPS URL alone does not prove approval. Prefer immutable query-free public renditions. A malicious internal callback is outside this pure contract's trust boundary.
4. Invoke `mapApprovedRelease(envelope, resolveAsset)` only after those checks. Serialize **only its result**, not the envelope, validation result, authoring document, reference map or errors with private payloads. Projection errors are intentionally generic. There is no implemented delivery endpoint to wire today.
5. Wire consumer pages and cache only approved DTOs. Namespace cache by authorized consumer/dataset/locale/release; do not call private draft APIs as fallback. Separately implement public runtime validation using the JSON Schema plus URL/AST semantic checks. Transport authentication/signatures, if later used, are server concerns, not a boolean added to these DTOs.

`mapApprovedRelease` is a pure allowlist mapper with a mandatory release-envelope **precondition contract**, not a branded capability, access guard or actual publication-authority assertion. Any internal code can fabricate its structural input; never expose it as a request handler. The real adapter fails closed precisely because the authoritative publishing model does not yet exist.

## Consumer shapes

[TypeScript DTOs and projection](../apps/web/src/lib/cms/marketing-contracts.ts) and [JSON Schema 2020-12](../apps/web/src/lib/cms/marketing-contracts.schema.ts) define the wire shapes. Each object schema sets `additionalProperties: false`. Root union is WorkProject/Testimonial/ArticleDetail; article list DTO is separately addressable at `$defs.ArticleListItem` and produced by `toPublicArticleListItem`. Absent optional fields are omitted, never filled with fabricated identity/approval content. Public IDs retain source `_id`; native revision/release identifiers remain outside the public DTO.

### WorkProject (`kind: workCaseStudy`)

Required: `id, slug, name, category, headline, summary, services[], tone, cardImage, gallery[], technicalSpecs[]`. Optional: `projectUrl, caseStudyUrl, author, attribution`. `clientName -> name`, `detailSummary -> summary`; media become `{ src, alt, caption }` with resolved URLs. Every gallery item is retained in order, rather than exposing asset references. Missing optional gallery/specs become empty arrays; the consuming card/detail needs an explicit empty-gallery policy and can use the separately approved cardImage. It must not assume gallery[0] exists.

### Testimonial (`kind: testimonial`)

Required: `id, slug, name, role, company, quote, portrait, portraitAlt, tone, companyBadge`. Optional: `portraitFocalPoint { x,y }, logo { src,alt,caption }, badge { kind,label,period? }, partnershipBeganAt, link { href,label }, author, attribution`. `personName -> name`; `excerpt ?? quote` preserves the approved omission-marked text. Portrait is a resolved URL string matching the site's prop. Company badge is always truthful typeset text; optional verified approved logo is separate. Tone includes neutral; badge kinds include measured, whose evidence remains private and must be approved by the future release service. No current-tenure calculation or automatic related-work expansion occurs.

### Articles

List: `kind: article, id, slug, title, excerpt, publishedAt, cover { src,alt,caption }`, optional `updatedAt, author, attribution`. Detail adds nonempty `body` and optional `seo { title,description }`. List projection explicitly excludes detail body/SEO.

The public AST supports text blocks with stable `_key`, `style` normal/h2/h3/h4/blockquote, optional bullet/number listItem and level 1–10, ordered span children (`_type, _key, text, marks`) and link markDefs (`_type, _key, href`); decorators strong/em/code only. Block images contain `_type: image, _key, src, alt, caption`. Unsupported authoring styles, annotations, embeds, groups, reference nodes, caption AST or image crop/hotspot fail closed rather than silently flattening content. Each mark must resolve to an approved decorator or link definition. Render text through escaped text nodes and a finite component registry, never raw HTML, MDX or dangerouslySetInnerHTML. HTML-looking span text stays literal text.

## Aligning Manifest pages

Inspected the current Manifest fixture adapter and its `WorkProject`, `GalleryImage` and `PartnerStory` props. This contract deliberately uses their `name`, `summary`, gallery `src/alt/caption`, portrait URL, text companyBadge and link names. It is **not** a direct replacement for fixture-preview types:

- Remove fixture-only required `sourcePath`, `portraitSourcePath` and `badge.sourcePath` from live page props. None may be reconstructed from private provenance.
- Work's fixture `sourceUrl` is not public provenance. Use optional reviewed `projectUrl`/`caseStudyUrl` for navigation only; do not copy provenance.sourceUrl or invent a source link.
- Handle optional story badge/link, neutral tone, measured badge kind and optional approved logo deliberately. Do not map neutral to another editorial tone or fabricate CTA text.
- Preserve `cardImage`, all gallery URLs and optional credit fields through the parent server/page adapter. Route slugs are canonical lowercase kebab-case. Detect route collisions at the future authoritative release boundary; this single-document mapper does not establish collection uniqueness.
- Consumer article pages must implement only `PUBLIC_ARTICLE_TOKENS`; no renderer is installed in Jongo OS by this task. Fixture-preview content must remain visibly separate from live publication.

No sibling frontend, package manifest, Prisma model or migration is changed by this implementation. Unit tests use synthetic trusted-internal release fixtures to exercise mapping, not to demonstrate access authorization, real storage approval or cryptographic release verification.

## Local verification

2026-10-20: web TypeScript check passed; broader CMS library/editor/content-route regression run passed **564 tests across 13 suites**, including 41 new marketing contract cases. Test execution set DATABASE_URL to unreachable loopback and restored it afterward. No configured database, migration, browser, build, delivery endpoint, commit or production operation was used. This is local schema/projection regression evidence, not full-site or publishing authorization acceptance.