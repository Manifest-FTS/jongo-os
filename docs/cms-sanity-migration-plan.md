# Phase 1 — Sanity migration technical execution plan

Status, 2026-10-19: **a bounded registered-draft importer is implemented; the full legacy/NCW migration pipeline below remains a target, not completed work.** CMS persistence, dataset draft UI/actions and Stripe reconciliation also exist in source. No configured application DB has received the new CMS/Stripe migrations; no NCW rehearsal, restored asset store, production import or compatible delivery API is claimed. See [actual local commands and safety gates](cms-local-verification.md).
Parent roadmap: [Manifest ecosystem and Jongo CMS](../../../mfts-2026/plan.md). This plan adds gates **M3-S-envelope** and **M4-S-dryrun** to its Phase 1; it does not authorize production execution.

## 1. Scope and evidence boundary

- This update changes only the requested roadmap/CMS documentation and adds the local verification guide. No runtime code changes, migration execution, source NCW changes, installs, imports, commits, credentials reads, deployment or production access. Existing implementation is described, not executed by this task.
- Future implementation belongs in Jongo OS. NCW source and backup remain read-only; leave legacy Jongo and other applications untouched.
- Read-only inspected external inputs (outside this workspace; not repository fixtures):
  - Source root: C:/Users/kevin/devkev/projects/north-carolina-waterfalls/ncw-web
  - Backup root: C:/Users/kevin/devkev/projects/north-carolina-waterfalls/Backups/650zc9k7-production-backup-2026-02-19t14-42-37-441z
  - NDJSON input: data.ndjson within that backup root; asset files beneath its assets directory.
- Snapshot: **9,967,815 bytes**, SHA-256 **989f294854d1334bc01b6dc46c15e0e82bc152bf0b2a5780b6b3d742ada01dac**. Pin exact bytes, not reserialized JSON.
- Counts below are supplied verified inspection facts, not results from an importer implemented by this task. Reproduce them in the future private dry-run report before accepting this snapshot.
- Goal: native, independently operable Jongo document/schema/content migration. **No Sanity query API, GROQ, SDK, Studio plugin, patch protocol, or hosted image/CDN compatibility promise.** NCW frontend query/render adaptation is a separate approved workstream.

### Implemented slice versus full pipeline

The actual [CLI](../scripts/import-sanity-ndjson.ts) runs through the existing TypeScript launcher and `npm run cms:import:sanity`. Its [reader](../apps/web/src/lib/cms/import/reader.ts), [planner](../apps/web/src/lib/cms/import/planner.ts) and [apply service](../apps/web/src/lib/cms/import/service.ts) implement fixed mapping `registered-drafts-v1`:

- Default/explicit dry-run requires file/dataset/actor arguments but **does not initialize Prisma or connect to a DB**; UUID syntax is not authentication or proof of live dataset access. It reads source and prints redacted counts/reasons/hash, always `publishable: false`.
- Strict incremental UTF-8, duplicate-key/ID and unsafe-key rejection, source-change checks, physical offsets, 32 MiB file/512 KiB line/10,000 record reader bounds. Eligible raw data is capped at **8 MiB**; apply allows **1–100 eligible drafts atomically**, not arbitrary batch/resume processing.
- Only the five current registered types and supported **draft** envelopes are candidates. No full NCW/legacy static schema converter, all-77 registry coverage or full path-aware gallery/table adapters exist. Source-published variants are not applied. Exact identities, raw source/hash and AST are retained for eligible drafts.
- Two-pass candidate identities/references handle forward edges/cycles; strong closure must be within eligible input records, unavailable/excluded strong targets quarantine owners, weak missing references may remain diagnostics. This is not resolution against all existing DB records or full media readiness.
- Quarantine/assets/unresolved blocked records are **report-only**: original private source stays in place, no persistent quarantine/asset manifest or byte recovery. Secret/operational types are excluded. No fetching, media upload or public exposure.
- Explicit apply checks a named disposable loopback DB, matching dataset confirmation, both flags and fresh persisted actor/tenant/owner entitlement through native scoped write locks. Receipt/revisions/edges/CAS/audit commit together; existing IDs conflict rather than overwrite. Deterministic receipt replay is not import jobs/checkpoints/resume/promotion/rollback.

Sections 2–9 retain the **full migration target/acceptance requirements**; their future features must not be inferred from this limited implementation. M3-S/M4-S and full pipeline completion remain open. Historical full-web evidence is **1,657 passed + 1 failed**; the Windows path failure has a source fix, while **current root full test / parent `verify:local` remains pending until reported**. Separate prior 17 PostgreSQL checks concern foundation SQL, not complete importer/Stripe integration. No fresh green result is claimed here.

## 2. Verified NCW baseline and implications

| Observation | Verified baseline | Required handling |
| --- | --- | --- |
| Export records | 3,811 records; 80 observed types | Reconcile every record with an exclusive outcome; observed types are not registry count |
| Registered schema | 77 types: 75 document, 1 object, 1 array | Preserve registration and actual embedding context separately |
| Drafts | 63: 28 paired with published IDs, 35 draft-only | Never invent published counterparts or collapse variants |
| References | 4,032 resolve; 1 additional empty typed reference | Preserve valid identities; diagnose empty reference, never invent its target |
| Rich text | 8,504 blocks; 12,838 spans | Preserve full AST and editorial semantics |
| Embedded structures | 1,284 then_now_gallery occurrences; nested info_block variants | then_now_gallery is declared document but embedded; support contextual adapters |
| Galleries/tables | image_gallery top-level and inline; 411 rows, 1,069 cells | Parent-path dispatch for tables and untyped objects; retain order and keys |
| Geopoints | 533; 3 invalid | Validate finite coordinate ranges; quarantine invalid values/owners pending repair |
| Locale/system | No locales; 390 occurrences of _system.base | Do not infer language; preserve opaque system metadata privately |
| Private operational data | pageNotFound: 179; notificationRequest: 1 | Exclude from editorial/public dataset; restricted operational disposition |
| Secrets | mux.apiKey present | **EXCLUDE** record payloads and secrets from target content, reports, logs, fixtures |
| Assets | 2,004 image + 3 file records = 2,007; 1,773 local files | Record/file totals are not a proved one-to-one completeness map |
| Asset filenames | 225 collision groups; 234 extra colliding records | Filename matching alone cannot establish asset identity |
| Asset checks | Only 28 / 2,007 record-size comparisons match; only 19 / 2,007 SHA-1 comparisons match | Remaining comparisons do not establish byte integrity; filenames alone are insufficient |
| Video | No Mux video bytes in backup | Provider metadata is not a recoverable video backup |

Custom block styles include `blockquote2`, `standout`, `centered`; marks/annotations include `superscript`, `center`, `link`, `buttonStyle1`, `textColor`. Inventory their actual decorator/annotation shapes, not just names.
Distinct legacy families `county` / `county_`, `landowner` / `landowner_`, `hike_difficulty` / `hikedifficulty`, `river_basin` / `riverbasin`, and `usgs_map` / `usgsmap` are **not auto-merged**. Retain original type IDs and field names until an explicitly reviewed mapping says otherwise.

## 3. Native document envelope and relational integrity

- Store source `_id` as **TEXT**, not UUID; native internal UUID is a separate surrogate. Preserve exact IDs including `drafts.` prefix and any punctuation. Enforce `UNIQUE(datasetId, _id)`.
- Store `_type`, opaque source `_rev`, `_createdAt`, `_updatedAt`, schema version, validated payload, provenance, and source checksum. Never derive type from an ID prefix.
- Derive `logicalId` by removing exactly the recognized leading `drafts.` prefix, and `variant = draft | published`; retain a bijective exact-source-ID map and uniqueness on `(datasetId, logicalId, variant)` for this import format.
- Paired variants share logical identity but retain separate envelopes/revisions; draft-only remains draft-only. Source published status is provenance, **not permission to expose imported content publicly**.
- Actual storage uses `CmsDocument.nativeId` (SQL `native_id`) for exact TEXT identity; imported `_rev` becomes nullable `CmsRevision.sourceRev`, opaque and immutable, not a numeric sequence or CAS token. Native edits generate `nativeRev`/`lockVersion` and revision sequence. Earlier design labels `source_rev`/`jongo_rev` are not current columns; see [actual storage contract](cms-persistence.md).
- Preserve source creation/update timestamps separately from `ingestedAt`, native revision time, actor and job time. Invalid timestamps require diagnostics; do not silently replace source times with now.
- `slug` is nullable. Preserve original slug object and current value when present; no generated slugs, required slug for every type, implicit locale, or claimed localization. Use nullable locale with explicit future policy; design slug uniqueness deliberately for null/variant semantics.
- Keep `_system.base` opaque in restricted provenance; never dereference it as an implicit fetch instruction or treat it as revision authority.
- Preserve reference JSON `_type: reference`, `_ref`, optional `_weak`, and `_key` exactly; extract a relational reference index with source revision, JSON path, target source ID and resolution status.
- Composite relational FKs must bind source revision and target document/asset to the **same dataset**. Validate tenant/dataset ownership independently of supplied payload IDs; prohibit cross-dataset links at database level.
- Two passes: allocate eligible identity envelopes first, then load payload revisions and resolve reference edges. Cycles and forward references are valid; do not require topological ordering.
- Resolve exact `_ref` before any approved draft/published selection policy; no prefix stripping to make a broken reference appear resolved. Preserve weak semantics and unresolved diagnostics; strong missing/excluded targets block affected publication.
- Empty typed reference is an explicit validation finding, not a valid resolved edge. Record-level quarantine and reference-level diagnostics are separate so totals do not double-count records.
- Existing foundation models: `CmsDataset`, `CmsDatasetGrant`, `CmsDocument`, `CmsRevision`, `CmsReference`, `CmsMutation`, with additive migration present but not applied to a configured DB. **Still proposed:** `CmsAsset`, `CmsImportJob`, `CmsImportEntry`, `CmsImportCheckpoint`, `CmsAssetManifestEntry`, `CmsQuarantineEntry`, `CmsRelease`, `CmsReleaseEntry` and outbox. A `CmsMutation` receipt is not a job/checkpoint or release. One exact variant has one `currentRevisionId`; no published release pointer exists.

## 4. Portable Text and schema conversion

- Store the **full validated Portable Text JSON AST**, not HTML, Markdown, plain-text extraction, or a lossy editor-specific rewrite. Keep block/span `_key`, `_type`, text, marks, mark definitions, style, list item, level and array order.
- Preserve decorators, annotation keys/payloads, inline objects, nested references, image crop/hotspot/alt/caption, custom blocks and embedded arrays. AST round-trip tests must prove editing does not regenerate stable keys or flatten marks/lists.
- Map supported styles/marks to reviewed native editor and renderer adapters; escape text, allowlist URL protocols and styling tokens, prohibit executable HTML/CSS/JS. `textColor` is validated data, not unrestricted CSS injection.
- Dispatch `info_block` variants and galleries by registered type **plus parent schema/field path**. Handle embedded document-declared `then_now_gallery` without minting standalone documents or losing its source shape.
- Table adapters use parent path and validated structural context to interpret untyped row/cell objects; preserve 411 rows/1,069 cells and empty values. Do not globally infer types from property names.
- Preserve unknown safe fields/blocks in **private quarantine**, with source ID/path/reason and recoverable original JSON under restricted storage. Unknown executable/security-unsafe data is rejected, never rendered. Any quarantined subtree blocks its owning document from publication until resolved.
- Static converter parses TypeScript/JavaScript AST only. Resolve allowlisted local imports, literal exports, spreads, constants and recognized definition helpers with cycle/depth/node limits; never execute third-party schemas, modules, plugins, getters, imports or functions.
- Classify callback-driven `Rule`, conditional fields, slug sources, previews and custom validation explicitly. Translate only approved declarative patterns; require reviewed adapters for unsupported callbacks. Never `eval`, import/require source modules, or claim a skipped rule was enforced.
- Converter output: versioned native descriptors, source file/type/field-path provenance, supported/adapter-required/unsupported classification, renderer requirements, validation diffs and a **no-silent-loss report**. Preserve registry count separately from embedded data shape coverage.
- Register NCW mappings as reviewed code-owned schemas. Studio may import into those schemas; it may not use import to register arbitrary new schema extensions. Advanced schema customization remains Scale-only.

## 5. Entitlement and isolation gate (before staging writes)

- An authenticated run owner explicitly selects target tenant/dataset. Bind that scope server-side to job, storage prefix, manifests, every query, transaction and audit event; source project/dataset never selects a tenant automatically.
- Require fresh principal/member scope, owner/sponsor subscription entitlement, CMS rollout flag and explicit import permission. Recheck on resume, mutation batches, promotion and publication; stop safely on revocation/downgrade.
- **Starter/Pro: no imports or import writes. Studio: imports into registered schemas. Scale: same plus separately authorized advanced declarative schema customization.** Reads/exports and last approved published release survive downgrade.
- Fail closed on unknown plan, missing owner, inactive subscription, DB failure, invalid tenant or stale identity. CLI/service execution must use the same policy service as UI/API, not a direct database bypass.
- Technical bootstrap/PlatformAdmin grants are not content or financial authority. Explicit audited tenant-targeted support access does not silently grant entitlements; financial super-admin remains a distinct capability. Never synthesize financial grants to run an import.
- Pin source project/dataset from operator-confirmed metadata; do not guess from backup directory names. Use an isolated non-production target DB/dataset and private asset namespace with no production environment inheritance.

Current local apply requires exact server-only **`JONGO_CMS_ENABLED=true` and `JONGO_CMS_WRITES_ENABLED=true`**, live editor+ tenant authority and actual persisted active/unexpired Studio/Scale owner. Dataset provisioning UI is not implemented; approved isolated setup must already supply real DB tables/client/user/organization/dataset/entitlement. Dry-run checks none of those live policy facts. No production migration or entitlement-bypass command is provided. The [two-table Stripe migration](../prisma/migrations/20261019160000_stripe_subscription_events/migration.sql) must precede deployment of the changed webhook code; reconciliation/dedup/canonical identity fencing now exist, but lockout follows accepted application-DB state, not instantaneous Stripe state during provider/delivery outage. See [billing limits](cms-persistence.md#stripe-subscription-events--implemented-not-deployed). No draft delete exists.

## 6. Staged importer execution contract

**Future full-pipeline requirements below, not a description of current atomic apply.** Current code has bounded read/plan, one guarded transaction and deterministic receipt replay; it has no durable private staging jobs, resume/checkpoints, promotion, release/outbox or rollback service.

1. **Preflight:** validate authorization, isolation, free space, retention, snapshot size/hash, source identity and mapping/converter versions. Open pinned immutable input; detect replacement/mutation before resume and completion. Default is dry-run, with no canonical-content/public-storage writes.
2. **Bounded parse:** stream bytes with strict incremental UTF-8 decoding; never parse the entire NDJSON file at once. Enforce file/line/record/depth/string/array/property limits before unbounded allocations. Reject invalid encoding and oversize input explicitly.
3. **Line policy:** allow one UTF-8 BOM only at file start, count and skip blank lines with physical line/byte offsets; reject misplaced BOMs, malformed JSON, duplicate object keys and duplicate source IDs. Use a duplicate-key-aware parser, not plain `JSON.parse` alone.
4. **Security:** construct safe maps/null-prototype objects; reject prototype-pollution keys at every depth and avoid unsafe merges. Validate IDs/types/references as bounded strings; parameterize SQL. Never execute embedded content, fetch source URLs or log record bodies on errors.
5. **Classify first:** exclude `mux.apiKey` before any payload persistence/logging; count it with a non-sensitive reason only. Route operational/unknown data to restricted dispositions. Only eligible editorial/asset records enter the import identity map.
6. **Plan:** static schema mapping, AST/path validation, variant mapping, reference graph, asset manifest and conflicts yield deterministic plans/checksums. Report deviations from baseline before target mutation. Dry-run uses bounded memory or approved private ephemeral staging, never a public dataset.
7. **Stage:** after separate execution approval, create job-owned private staging envelopes/revisions/asset objects, then reference edges. Each bounded batch commits entries, audit metadata and checkpoint transactionally; failures remain isolated and unpublished.
8. **Resume:** key entries by source project + source dataset + exact source ID + snapshot hash + mapping version (also pin converter/schema versions). Store raw-record and normalized-output checksums. Same identity/checksums is a no-op; changed checksums are conflicts, not overwrite permission.
9. **Checkpoint:** manifest records immutable input hash, byte/line cursor, committed entry identities/checksums, assets, findings, policy versions and job state. Worker lease plus compare-and-swap job/checkpoint version prevents concurrent resumes; reclaim only verified committed work.
10. **Validate:** reconcile all records/types/variants/references/assets, quarantine reasons and staged checksums. Build a candidate immutable release only from approved publishable variants and ready media; drafts and private data remain private.
11. **Promote:** authorized reviewed future promotion uses audited transaction, expected target `nativeRev`/future release pointer CAS, identity constraints and deterministic entries. Atomically activate approved content/release pointer with audit/outbox, or activate nothing public. Pre-stage media privately; do not expose files before release authorization.
12. **Separate publishing:** importing/promoting native draft state does not publish. A separately approved release may include eligible source-published variants only; candidate closure must pass all reference/media/renderer/privacy checks. No partially public import on failed promotion.
13. **Rollback:** cancel a job or remove only its unpromoted staging artifacts after retention review. For promoted state, compare job ownership and expected current versions; never delete/overwrite later editor changes. Release rollback is an audited atomic switch to a retained approved release with expected-pointer CAS, not a broad database restore.

Persist job states such as planned, staged, validating, blocked, ready, promoted, failed, canceled and rolled_back with transition audit. Store actor/tenant, timings, versions, counts and bounded redacted reasons; private payloads stay out of general audit/log channels. A failed job never silently reports success.

## 7. Asset manifest and full-restore blocker

- Build a manifest keyed by exact source asset `_id` and dataset, with source-relative path candidates, metadata size/hash, actual bytes/checksums, MIME, collision group, match evidence and ready/missing/ambiguous/mismatch/quarantined status.
- Use safe content-addressed or random tenant-scoped destination keys; source filenames are display metadata only. Resolve 225 filename collision groups/234 extra records individually. Never overwrite by basename or arbitrarily choose the first candidate.
- Reject absolute/drive/UNC paths, traversal, null bytes and canonical paths outside the approved root. Resolve and reject escaping symlinks/junctions/reparse points; defend against path swap between check and read. Do not trust asset URL paths as filesystem paths.
- If later supporting archives, bound compressed/uncompressed bytes, expansion ratio, entries, recursion and per-file size; reject archive links/traversal. This input is already extracted; archive support is not required to import it.
- Compute actual SHA-256 for every chosen byte stream; verify source SHA-1 when available as matching evidence, not sole security identity. **Checksum mismatches block asset acceptance**; missing expected checksums remain unverified until explicitly reconciled.
- Only 28 of 2,007 record-size comparisons matched; the remaining mismatches require triage. Pure descriptive metadata differences may be tolerated only by a reviewed recorded rule with independently verified identity/integrity; a byte-integrity mismatch must never be waved through as metadata.
- The 19 observed SHA-1 matches are evidence only for those inspected matches. Missing/ambiguous assets and conflicting IDs/hashes require explicit resolution; do not infer 234 missing assets merely from record/file arithmetic.
- Validate MIME/decoded dimensions, size/pixel limits and malware policy; sanitize/reject unsafe formats. Preserve original private evidence; derived public renditions have separate checksums/provenance and approved metadata stripping.
- No implicit HTTP fetch from asset/CDN/Mux URLs, no source credentials imported, and no runtime dependency on Sanity CDN promised. Any later authorized retrieval needs its own allowlist, SSRF controls, credentials handling and byte verification.
- **Full-restore blocker already exists:** 2,007 asset records versus 1,773 local files, collisions, limited matching evidence and absent Mux video bytes prevent a verified complete local media restore today. Metadata-only import is not full restoration.
- Missing media may allow an explicitly scoped metadata/draft rehearsal, never a “zero-friction” or complete backup claim. Block affected publication; full restoration requires reconciled required bytes and a DB + object-store restore rehearsal.

## 8. Actual and proposed implementation surfaces

Actual implemented entry points: [CLI](../scripts/import-sanity-ndjson.ts), [launcher](../scripts/run-typescript.cjs), [reader](../apps/web/src/lib/cms/import/reader.ts), [planner](../apps/web/src/lib/cms/import/planner.ts), [local DB gate](../apps/web/src/lib/cms/import/local-database.ts), [apply service](../apps/web/src/lib/cms/import/service.ts), [import tests](../apps/web/src/lib/cms/import/import.test.ts) and [foundation migration](../prisma/migrations/20261019120000_cms_persistence_foundation/migration.sql).

The following tree remains the **proposed full pipeline**, relative to Jongo OS. It is not a claim that similarly named existing reader/planner modules implement every target. The speculative CLI path in the original design is superseded by the actual linked CLI above.

```text
packages/cms-schema/src/sanity/{static-converter,rule-adapters,path-registry}.ts
packages/content-contracts/src/{document-envelope,portable-text,import-report}.ts
apps/web/src/lib/cms/import/{policy,reader,classifier,planner,stager,resume,promote,rollback}.ts
apps/web/src/lib/cms/assets/{manifest,path-safety,integrity}.ts
apps/web/src/lib/cms/schemas/ncw/{registry,blocks,tables}.ts
tests/cms/sanity/{envelope,converter,portable-text,reader,assets,policy}.test.ts
tests/cms/sanity/{postgres,resume,promotion,rollback}.integration.test.ts
prisma/migrations/<reviewed_timestamp>_cms_import_envelope/migration.sql
```

Foundation model/constraint source exists and bounded importer writes reuse native fresh policy. Full pipeline still needs additional reviewed models/constraints/services and dedicated isolated acceptance. Migration **application** requires separate target approval; no configured DB was migrated by this work. Do not bypass RBAC/entitlements with migration scripts.

## 9. Milestones, acceptance evidence and future validation

**Order:** roadmap M1 → M2 + M3 → **M3-S-envelope** → isolated M4 implementation → **M4-S-dryrun**. These supplement, not replace, roadmap schema, media, entitlement and restore gates. Production cutover still requires separate later approval.

### M3-S-envelope — contract and converter gate

- Prove TEXT source IDs, internal UUID separation, exact draft map, nullable slugs/locales, opaque source revisions, distinct timestamps and monotonic native CAS revisions.
- PostgreSQL tests reject cross-dataset references, duplicate exact IDs/variants and stale CAS; accept cycles, forward references and draft-only identities. Document nullable slug index behavior explicitly.
- Sanitized generated fixtures round-trip every listed style/mark/list/key, nested gallery/info block/table shape and reference; unknowns survive privately but block publishing. No HTML round-trip substitution.
- Static conversion inventories all 77 registrations and reports every unsupported callback/import/spread/helper/rule; fixtures prove source functions are never executed and no field silently disappears.
- Reader tests cover BOM/blanks/UTF-8 chunk boundaries, malformed/oversize/deep input, duplicate keys/IDs, prototype pollution, hostile paths and redacted failures. Assert bounded resource use.

### M4-S-dryrun — private NCW rehearsal gate

- Reproduce **3,811 records, 80 observed types, 2,004 image/3 file assets, 63 drafts = 28 paired + 35 draft-only**, and registry **77 = 75 + 1 + 1** against the pinned snapshot.
- Reproduce **4,032 resolving references + 1 empty typed reference**, **8,504 blocks/12,838 spans**, **1,284 then_now_gallery**, **411 rows/1,069 cells**, **533 geopoints/3 invalid**, **390 _system.base**; no implicit locales or type merges.
- Report mutually exclusive record outcomes: accepted editorial + accepted asset + quarantined + excluded-secret + excluded-private-operational + other explicitly classified exclusions = **3,811**. Each record has one outcome; subtree/edge findings are separate totals, never double-counted as records.
- Reconcile **179 pageNotFound + 1 notificationRequest** privately and the exact secret-exclusion count from inspection; do not invent a secret count from remaining types. No secret payload, private operational content, or raw NCW fixture is copied into this repository, stdout, CI artifacts or public storage.
- Reproduce manifest inventory **2,007 records/1,773 local files**, **225 collision groups/234 extras**, **28 record-size matches/19 SHA-1 matches** and absent video bytes. Account for every candidate/status; list unresolved blockers without claiming complete recovery.
- Quarantine counts/reason totals and affected owning IDs reconcile privately; expected invalid findings are visible, not silently repaired. A successful dry-run can mean accurate blocked readiness, **not** approved publication/full restore.
- Test interruption at each batch/checkpoint, duplicate resume, changed snapshot/mapping, competing worker, revocation/downgrade, cross-tenant targeting, reference exclusion, corrupt/missing bytes and promotion failure. Same input produces same plan/checksums; no partial public state.
- Inject concurrent editor changes before promotion/rollback; prove CAS conflict, preserved later edits, atomic release/audit/outbox and retained old release. Prove Starter/Pro rejection and Studio/Scale distinction through direct server/CLI entry points.
- Keep detailed reports/NDJSON/quarantine/asset manifests encrypted or access-restricted outside the repository with retention/deletion owner. Repository fixtures are **generated sanitized samples only**, never a private backup copy. Reviewer signs redacted totals, hashes, limitations and disposition decisions.

### Actual local commands, not executed here

From the Jongo OS root, the implemented no-DB command is:

```text
npm run cms:import:sanity -- --file <path> --dataset-id <uuid> --actor-id <uuid> --dry-run
```

Dry-run is the default. Only `--file`, `--dataset-id`, `--actor-id`, `--dry-run`, `--apply` and apply-only `--confirm-dataset` exist; duplicates/unknown options/missing values and both mode flags are rejected. **No mapping-version/report/resume/asset/converter flags exist.** Explicit apply requires matching confirmation plus `DATABASE_NAME` matching `^cms_import_test_[a-z0-9_]+$` and an exactly matching PostgreSQL URL path on literal `127.0.0.1` or `[::1]`, non-production `NODE_ENV`, no fragment/query overrides (only `schema=public` allowed), verified server DB/loopback identity and fresh policy/both flags. `localhost` is rejected. Independent cluster ownership verification is still necessary: loopback checks cannot prove no tunnel/proxy. Apply writes immutable private history; it is not setup or production authorization. See the [full runbook and actual apply form](cms-local-verification.md#4-explicit-apply--only-a-named-disposable-local-database).

Root `npm test` now runs the full web suite. `npm run verify:local` runs type-check → full test → isolated 17-check PostgreSQL harness, stopping on failure; Node/npm/installed dependencies and PG17 are required. It does not start dev/browser, check credentials, import, provision a dataset or migrate configured DBs. Current parent rerun is pending until reported. Full NCW tests/rehearsal and isolated build output are later requirements, not evidence produced by this docs update.

Required full-pipeline completion evidence: reviewed mapping report, sanitized contract tests, scoped private NCW reconciliation, integrity manifest, explicit blocker list, resume/CAS/rollback test results and tenant-owner approval. **Current bounded importer is not full pipeline completion, NCW schema parity, media completeness or production rollout.** No production import, NCW change or execution is delivered by this document.