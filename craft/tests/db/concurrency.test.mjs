import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createDataset, getDocument, publishDocument, saveDraft } from '../../dist/server/index.js';
import { count, freshDb, key, makeCtx, page, registry } from './helpers.mjs';

let db, ctx;
before(async () => { db = await freshDb('conc'); ctx = makeCtx(db); await createDataset(ctx, { name: 'production' }); });
after(() => db.close());

const save = (input, extra = {}) => saveDraft(ctx, { dataset: 'production', registry, input, mutationKey: key(), ...extra });
const settle = results => ({ ok: results.filter(r => r.status === 'fulfilled').map(r => r.value), failed: results.filter(r => r.status === 'rejected').map(r => r.reason) });

async function assertInvariants(logical) {
  const docs = (await db.sql(`SELECT id, variant, current_revision_id, lock_version FROM craft.documents WHERE logical_id = $1`, [logical])).rows;
  for (const doc of docs) {
    const revs = (await db.sql(`SELECT id, sequence FROM craft.revisions WHERE document_id = $1 ORDER BY sequence`, [doc.id])).rows;
    assert.deepEqual(revs.map(r => r.sequence), revs.map((_, i) => i + 1), 'sequences are contiguous');
    assert.equal(revs.at(-1).id, doc.current_revision_id, 'pointer is the newest revision');
    assert.ok(doc.lock_version >= revs.length);
  }
}

test('two connections, one base revision: exactly one winner, no lost update, consistent receipts', async () => {
  for (let round = 0; round < 6; round++) {
    const id = `race-${round}`;
    const base = await save(page(id));
    const settled = await Promise.allSettled([
      save(page(id, { title: 'writer A' }), { expectedNativeRev: base.nativeRev }),
      save(page(id, { title: 'writer B' }), { expectedNativeRev: base.nativeRev })
    ]);
    const results = settle(settled);
    assert.equal(results.ok.length, 1, 'one winner');
    assert.equal(results.failed.length, 1);
    assert.equal(results.failed[0].code, 'conflict');
    const doc = await getDocument(ctx, { dataset: 'production', registry, documentId: id, perspective: 'previewDrafts', consumer: 'editor' });
    assert.equal(doc.nativeRev, results.ok[0].nativeRev);
    assert.equal(doc.document.title, settled[0].status === 'fulfilled' ? 'writer A' : 'writer B', 'the winner\'s content is the stored content');
    assert.equal(await count(db, 'revisions', `document_id = (SELECT id FROM craft.documents WHERE native_id = $1)`, [`drafts.${id}`]), 2);
    await assertInvariants(id);
  }
  const saves = await count(db, 'audit_log', `action = 'document.save'`);
  const receipts = await count(db, 'mutations', `operation = 'saveDraft'`);
  assert.equal(saves, receipts, 'every committed save has exactly one receipt and one audit row');
});

test('many workers incrementing one document with retry-on-conflict lose no update', async () => {
  const id = 'counter';
  await save(page(id, { title: 'n=0' }));
  const WORKERS = 6, EACH = 4;
  const worker = async w => {
    for (let i = 0; i < EACH; i++) {
      for (;;) {
        const current = await getDocument(ctx, { dataset: 'production', registry, documentId: id, perspective: 'previewDrafts', consumer: 'editor' });
        try {
          await save(page(id, { title: `w${w}-i${i}` }), { expectedNativeRev: current.nativeRev });
          break;
        } catch (error) { assert.equal(error.code, 'conflict'); }
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));
  const revisions = (await db.sql(`SELECT payload->>'title' AS title FROM craft.revisions WHERE document_id = (SELECT id FROM craft.documents WHERE native_id = $1) ORDER BY sequence`, [`drafts.${id}`])).rows.map(r => r.title);
  assert.equal(revisions.length, 1 + WORKERS * EACH);
  assert.equal(new Set(revisions).size, revisions.length, 'every successful write is in the history exactly once');
  await assertInvariants(id);
});

test('concurrent identical requests with the same mutation key: one execution, the rest replay it', async () => {
  const k = key('same');
  const results = settle(await Promise.allSettled(Array.from({ length: 5 }, () => save(page('dupe'), { mutationKey: k }))));
  assert.equal(results.failed.length, 0, 'duplicates replay instead of failing');
  assert.equal(results.ok.filter(r => !r.replayed).length, 1);
  assert.equal(new Set(results.ok.map(r => r.nativeRev)).size, 1);
  assert.equal(await count(db, 'mutations', `key = $1`, [k]), 1);
  assert.equal(await count(db, 'revisions', `document_id = (SELECT id FROM craft.documents WHERE native_id = 'drafts.dupe')`), 1);
});

test('concurrent creation of the same id: one document, losers get a typed conflict', async () => {
  const results = settle(await Promise.allSettled(Array.from({ length: 4 }, (_, i) => save(page('born', { title: `creator ${i}` })))));
  assert.equal(results.ok.length, 1);
  for (const error of results.failed) assert.ok(['conflict', 'precondition_required'].includes(error.code), error.code);
  assert.equal(await count(db, 'documents', `logical_id = 'born'`), 1);
  assert.equal(await count(db, 'revisions', `document_id = (SELECT id FROM craft.documents WHERE native_id = 'drafts.born')`), 1);
  await assertInvariants('born');
});

test('publish racing a save on the same draft leaves a consistent document', async () => {
  for (let round = 0; round < 4; round++) {
    const id = `pubrace-${round}`;
    const base = await save(page(id));
    const results = await Promise.allSettled([
      publishDocument(ctx, { dataset: 'production', registry, documentId: id, mutationKey: key(), expectedNativeRev: base.nativeRev }),
      save(page(id, { title: 'edit during publish' }), { expectedNativeRev: base.nativeRev })
    ]);
    const { ok, failed } = settle(results);
    assert.equal(ok.length, 1, 'both used the same base: only one can win');
    assert.equal(failed[0].code === 'conflict' || failed[0].code === 'not_found', true, failed[0].code);
    await assertInvariants(id);
    const live = (await db.sql(`SELECT variant FROM craft.documents WHERE logical_id = $1 AND archived_at IS NULL ORDER BY variant`, [id])).rows.map(r => r.variant);
    assert.ok(live.length >= 1);
  }
});
