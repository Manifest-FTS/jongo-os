# @jongo/craft — preview 0.1

Independent ESM React 19 package: generic typed Craft shell, shared UI and a fictional Golf Lab extension. **Not a production backend.** No Jongo admin/auth/billing dependencies.

Exports: `@jongo/craft`, `@jongo/craft/content` (pure schema/Portable Text/validation logic, no React), `@jongo/craft/golf-lab`, `@jongo/craft/logic`, `@jongo/craft/server` (server-only PostgreSQL persistence, see below), `@jongo/craft/styles.css`, `@jongo/craft/studio.css`. Import CSS explicitly. `npm ci --ignore-scripts`, `npm test`, `npm pack` build JavaScript, declarations and scoped CSS using the locked toolchain. Peer dependencies: React and React DOM 19; `pg` and `groq-js` are optional peers needed only by `@jongo/craft/server`.

Preview.7 turns `ContentStudio` into a neutral Sanity-style content editor: documents are `{ _id, _type, ...fields }` (the flat `{id,type,title,values}` shape and `validateContent` are gone), with string/text/number/boolean/date/datetime/url/slug/enum/object/array/reference/image/Portable Text fields, per-field validation and a bounded Portable Text editor that preserves unknown blocks, marks and annotations. Drafts live in page memory only; persistence, publishing, uploads and authentication are not connected, and this is not Sanity Studio parity.

Preview.9 adds an optional `store` prop to `ContentStudio` (type `StudioStore`, UI only: it never imports `@jongo/craft/server`, `pg` or `groq-js`, and a test keeps the client entries clear of them). Without `store` nothing changes (local drafts in page memory). With a store the Studio lists/loads/saves/publishes/unpublishes/discards through the host's adapter and shows per-document state (saved, unsaved changes, saving, conflict, error), a visible Published or Draft status, and disables Save while saving. Contract:

```ts
store.list():                         Promise<{ ok: true, documents: StudioDocSummary[] } | StudioFailure>
store.load(id):                       Promise<{ ok: true, doc, nativeRev, lockVersion, variant, published?, publishedDiffers? } | StudioFailure>
store.saveDraft(doc, expect):         same record shape   // expect = { nativeRev, lockVersion, mutationKey }
store.publish(id, expect) / unpublish(id, expect) / discardDraft(id, expect)
StudioFailure = { ok: false, code: 'conflict' | 'invalid' | 'denied' | 'unavailable', message, fieldErrors? }
```

Concurrency is optimistic: every mutation carries the revision the editor loaded. On `conflict` the Studio keeps the editor's text, says so and offers **Reload latest** (which discards the unsaved edits); it never retries with a newer revision on its own. `mutationKey` is generated per attempt and is identical for an immediate retry of the same request (same operation, document, precondition and body), so a lost response can be retried safely; any change makes a new key. Publish is enabled whenever the document passes the checks and there is something to publish: a draft (saved or with unsaved edits), or a published document with unsaved edits. With unsaved edits one click saves first (same compare-and-set and mutation key as Save draft), stops on any failure or conflict without publishing, then publishes the new revision with its own key ("Saved and published."); a retry after a network failure re-uses the keys of the step that failed. When Publish is disabled the reason is visible text next to the buttons ("Published, up to date", "Fix N issues to publish", which jumps to the first issue, or "Reload latest to continue" after a conflict), not only a tooltip. Unpublish needs `published` (its own revision) on the record. `initial` lets a server component prefetch the list and the open record (or a failure, shown as an unavailable state), `notice` shows one honest line above the editor in either mode, `topbarSlot` adds e.g. a sign-out form, and `signInHref` is offered on `denied`. The store is the only trust boundary the browser sees: the server must authenticate every call, re-validate and enforce the compare-and-set itself.

**Preview.11: document panel, Duplicate and Delete.** The editor column has a sticky header (type, title, Published/Draft and save-state pills, a live validation chip that jumps to the first issue, and a tools menu with History, Inspect and Copy document) and a sticky bottom action bar (who/when status, Save draft, Publish, and a "More actions" menu with Unpublish, Discard draft, Duplicate and Delete; in local-draft mode Reset changes and Revert to original snapshot, plus a visible but disabled Publish ("Publishing needs the Jongo Craft database") and disabled Duplicate and Delete ("Needs the Jongo Craft database"). Fixed (singleton) documents list neither and say so in the header tools menu). Menus are accessible popovers (`role=menu`, arrow keys, Home/End, Escape returns focus, outside click closes). Unpublish, Discard and Delete ask for confirmation with the consequences spelled out. The "Content workspace" label and the bottom schema block are gone (schema information lives in Inspect). Optional contract additions, all rendered only when the store provides them:

```ts
StudioRecord.lastPublished?: { at, by?: { id, name?, avatarUrl? } }   StudioRecord.lastEdited?: same
store.history?(id):                  { ok: true, entries: { at, action: 'save'|'publish'|'unpublish'|'discard'|'delete', by? }[] }
store.duplicate?(id, expect?):       new draft record   // the host generates the id and copies; use duplicateDocument() from @jongo/craft/content for the body
store.delete?(id, expect):           { ok: true, id }
TypeDefinition.singleton?: boolean   // hides Duplicate and Delete; the host must also refuse both server-side
```

`by.name` is a display label chosen by the host (the Studio never prints `by.id`); the avatar is an initials chip, and an `<img>` is rendered only for a plain `https:` URL. Timestamps render in UTC (labelled) until the browser mounts, then in the viewer's time zone.

Preview.6 retains role-scoped RFC 5545 Golf calendar downloads and restores labeled native date inputs using the existing scoped form styles. Schedule day, booking/edit, inclusive recurrence end, reports, admin resume review and style-guide dates use browser-native controls; the custom picker, its export, standalone CSS and theme tokens have been removed. Booking day/week grids and normal week/Today buttons are preserved. Downloads are snapshots, not calendar sync, OAuth integration or provider invitations.

Full boundary, review scenarios, limitations and vendor-artifact deployment instructions: `jongo/docs/craft-preview.md` in the source repository. Browser demo changes are fictional and in-memory. Never use the role switch as real authorization.

## Server persistence (preview.8, `@jongo/craft/server`)

A standalone, single-tenant PostgreSQL store for Craft documents. It is a **server-only subpath of this package**: never import it from client code or Studio components (a test checks that the client entries do not reach it). It has no Organization, User, Stripe, subscription or entitlement concepts; the host application supplies identity and authorization through callbacks. **Preview, not production-ready**: see "Not included" and "Known limits".

**Install.** `npm i @jongo/craft pg groq-js`. UI-only consumers need neither (`pg` and `groq-js` are optional peer dependencies; Craft itself never imports `pg`, and loads `groq-js` lazily, only when a query runs). `groq-js` ^2 requires **Node >= 22.12**. PostgreSQL 16 and 17 on Windows are the only versions the DB tests have run against.

**Connection.** `JONGO_CRAFT_DATABASE_URL` belongs to the host app (the Golf Lab website's name for it); Craft reads nothing from the environment. Pass a `pg.Pool` through the adapter:

```ts
import pg from 'pg';
import { createContentRegistry, defineType } from '@jongo/craft';
import { createDataset, createPgExecutor, runMigrations, saveDraft, type Authorize } from '@jongo/craft/server';

const pool = new pg.Pool({ connectionString: process.env.JONGO_CRAFT_DATABASE_URL }); // the host's own configuration
const executor = createPgExecutor(pool);
const registry = createContentRegistry([/* defineType({...}) schemas, the same descriptors the Studio uses */]);
```

**Migrations at deploy start.** `await runMigrations(executor)` creates the dedicated `craft` schema and applies the SQL files in `migrations/` (path helper: `migrationsDir`). Each migration runs in its own transaction after taking a transaction-scoped advisory lock, so concurrent deploys serialize and it is idempotent. Checksums (line endings normalized) are stored in `craft.schema_migrations`; the runner refuses, with `migration_checksum_mismatch`, when an applied migration's file changed, and with `migration_missing` when the database is ahead of the installed package. Run it with a role that may create the schema (see the role snippet in `jongo/docs/craft-preview.md`). If your bundler inlines packages, mark `@jongo/craft` external for server code so `migrationsDir` resolves next to the installed package.

**Authorization contract.** Every service function takes a context `{ executor, authorize, actorId }`. `authorize(actorId, action, datasetName)` is required, may be async and is **fail-closed**: only a resolved `true` allows; `false`, `undefined`, a thrown error or a rejection all deny (`CraftError` code `denied`, no database access happens first). `actorId` is an opaque string of 1-128 characters stored on revisions and audit rows. Actions: `read` (published perspective), `read-drafts` (previewDrafts/raw, the `editor` consumer that sees private fields, and `getDocumentHistory`), `write` (saveDraft, discardDraft), `publish` (publish, unpublish), `write` + `publish` together (deleteDocument), `export`, `export-private` (additionally required for `includePrivate`), `import` (dry-run and apply) and `admin` (createDataset, getDataset). Exports of non-published perspectives also need `read-drafts`.

```ts
const authorize: Authorize = async (actorId, action, dataset) => {
  const role = await myApp.roleFor(actorId, dataset); // your own identity and policy
  if (role === 'owner') return true;
  if (role === 'editor') return ['read', 'read-drafts', 'write', 'publish'].includes(action);
  return action === 'read';
};
const ctx = { executor, authorize, actorId: session.user.id };
await createDataset(ctx, { name: 'production' });
const saved = await saveDraft(ctx, { dataset: 'production', registry, input: { _type: 'page', title: 'Home' }, mutationKey: crypto.randomUUID() });
```

**Service API.** `createDataset`, `getDataset`; `saveDraft`, `publishDocument`, `unpublishDocument`, `discardDraft`, `deleteDocument`, `getDocument`, `getDocumentHistory`, `listDocuments`; `queryDataset` (GROQ); `exportNdjson`, `importNdjson`. All writes need a `mutationKey` (idempotency) and, for existing documents, `expectedNativeRev` and/or `expectedLockVersion` (compare-and-set). Every document is validated on the server with the same `validateDocument` the Studio uses; the server never trusts the Studio.

**Semantics worth knowing.**

- A logical id has a published row (`<id>`) and a draft row (`drafts.<id>`); revisions are append-only history, rows are never hard-deleted.
- `saveDraft` stores `drafts.<id>` as a new revision. Drafts may omit `publishRequired` fields, never `required` ones. The head you edit is the live draft, else the live published row.
- **Publish** copies the draft payload to the published variant as a new revision and **soft-archives the draft row**, so after publishing only the published variant is live and draft equals published. Saving again starts a new draft; `discardDraft` archives the draft and is refused unless a published version exists; `unpublishDocument` archives the published row and restores a draft from it (a live draft's edits are kept).
- **`deleteDocument`** (needs `write` **and** `publish`; audit `document.delete`) soft-archives the live draft and the live published row in one transaction, compare-and-set on the head like publish. Revisions, references, receipts and audit rows are untouched, so nothing is hard-deleted. A deleted id is absent from `getDocument`, `listDocuments`, `queryDataset` and `exportNdjson` in every perspective (they all read only non-archived rows). Deleting is refused with `referenced` while another **live** document holds a **strong** reference to the id (weak and self references do not block): the same rule that makes a missing target fail validation. Deleting again with the same `mutationKey` replays the first result; with a new key and nothing live it is `not_found`. The same id can be created again later with `saveDraft` and no expectation, as a fresh document of the **same type** (a different type is a `conflict`): the old rows are un-archived and the revision log continues, but none of the old content is live and a stale writer that still holds the old revision gets a `conflict`.
- `getDocumentHistory` (needs `read-drafts`) lists audit entries of one logical id, newest first: `{ at, action, actorId }`, no content. `getDocument` also returns `updatedAt` and `actorId` of the current revision.
- Retries on serialization failure/deadlock (SQLSTATE 40001/40P01) up to 3 attempts; a repeated `mutationKey` with the same request replays the stored receipt, with a different request it fails with `idempotency_conflict`.
- Documents are bounded (512 KiB canonical, depth 32, 20,000 nodes); NUL, lone surrogates and `__proto__`/`constructor`/`prototype` keys are rejected at any depth. Errors are typed `CraftError`s with fixed messages: no SQL, driver text or document content.
- `queryDataset` takes perspective `published` | `previewDrafts` | `raw` and consumer `public` (default: private and undeclared fields are removed before evaluation) | `editor`. `->` only resolves inside the perspective and privacy filtered set. Limits (query length, params size, result bytes, document count) fail with typed errors and never truncate.
- `exportNdjson` writes deterministic Sanity-format `data.ndjson` bytes plus a manifest with a SHA-256 (`_rev` is part of the bytes). Property names that look like secrets (`apiKey`, `password`, `token`, `secretCode`, ...) are dropped even with `includePrivate`.
- `importNdjson` maps `drafts.` documents to drafts and the rest to published, validates each document against your registry and reports a per-document outcome. **Apply is all-or-nothing**: if any document is `invalid` (unknown type, bad id, validation failure) or `conflict` (id exists; nothing is ever overwritten), nothing is written, no receipt is stored and the report is returned with `blocked: true`. Skips never block: asset documents (`sanity.imageAsset`/`fileAsset`, reason `asset_not_supported`), `system.*`/`sanity.*` types, `versions.*` ids, and existing ids when `onConflict: 'skip'`. Defaults: 10,000 documents / 32 MiB.

**Backups.** Back up PostgreSQL itself (for example Coolify scheduled database backups). Craft has no backup or restore feature of its own. NDJSON export is a content export, not a database backup.

**Not included.** HTTP routes or handlers, asset/media storage and binaries (asset documents are not stored; supply known assets through the `assets` option so image references validate), realtime/listeners, Sanity HTTP API or client SDK compatibility, public delivery caching, multi-tenant/SaaS entitlements, user/session management.

**Known limits.** Each GROQ query or export loads the whole live dataset into memory (guarded by 10,000 documents and 64 MiB of payload by default, failing with `dataset_too_large`). GROQ evaluation is in-process and cannot be killed; the time budget is cooperative, so do not expose `queryDataset` to anonymous traffic without isolating it. The GROQ, privacy and NDJSON code is a copy adapted from `apps/web/src/lib/cms` and duplicated until it is deduplicated. Append-only guarantees come from triggers, which a superuser or table owner can disable; run the application with a least-privilege role. Queries and dry-run imports are not audited. `references` stores outgoing references per revision but nothing enforces referential integrity on delete (nothing is deleted).

**Tests.** `npm test` (unit, no database) and `npm run test:db` (real PostgreSQL in a throwaway cluster under the OS temp directory on a random loopback port; needs the PostgreSQL 16/17 binaries, `PG_BIN` overrides the location; without them it fails unless `CRAFT_DB_TESTS_OPTIONAL=1`, which prints a SKIPPED banner and exits 0; `--fail-after-start` rehearses cleanup).