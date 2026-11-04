import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createDataset, saveDraft } from '../../dist/server/index.js';
import { freshDb, key, makeCtx, makeRole, page, registry } from './helpers.mjs';

let db, dsA, dsB, docA, docB, revA, revB, role;
const sha = 'a'.repeat(64);
before(async () => {
  db = await freshDb('schema');
  dsA = (await createDataset(makeCtx(db), { name: 'a' })).id;
  dsB = (await createDataset(makeCtx(db), { name: 'b' })).id;
  const ctx = makeCtx(db);
  const a = await saveDraft(ctx, { dataset: 'a', registry, input: page('p1'), mutationKey: key() });
  const b = await saveDraft(ctx, { dataset: 'b', registry, input: page('p1'), mutationKey: key() });
  docA = (await db.sql(`SELECT id, current_revision_id FROM craft.documents WHERE dataset_id = $1`, [dsA])).rows[0];
  docB = (await db.sql(`SELECT id, current_revision_id FROM craft.documents WHERE dataset_id = $1`, [dsB])).rows[0];
  revA = docA.current_revision_id; revB = docB.current_revision_id;
  assert.ok(a.nativeRev && b.nativeRev);
  // Ordinary runtime role: every write privilege, so only the triggers stand in the way.
  role = await makeRole(db, ['GRANT USAGE ON SCHEMA craft TO $ROLE', 'GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA craft TO $ROLE']);
});
after(() => db.close());

const sqlState = async (run, state, pattern) => {
  try { await run(); } catch (error) {
    assert.equal(error.code, state, `expected SQLSTATE ${state}, got ${error.code}: ${error.message}`);
    if (pattern) assert.match(`${error.constraint ?? ''} ${error.message}`, pattern);
    return;
  }
  assert.fail(`expected SQLSTATE ${state}`);
};
const insertRevision = (pool, ds, doc, sequence = 99, overrides = {}) => pool.query(
  `INSERT INTO craft.revisions (dataset_id, document_id, sequence, schema_version, payload, payload_sha256, actor_id) VALUES ($1, $2, $3, 1, $4::jsonb, $5, 'x')`,
  [ds, doc, sequence, overrides.payload ?? '{"title":"t"}', overrides.sha ?? sha]);

for (const [label, statements] of [
  ['revisions', [`UPDATE craft.revisions SET schema_version = 1`, `DELETE FROM craft.revisions`, `TRUNCATE craft.revisions CASCADE`]],
  ['mutations', [`UPDATE craft.mutations SET operation = 'x'`, `DELETE FROM craft.mutations`, `TRUNCATE craft.mutations CASCADE`]],
  ['audit_log', [`UPDATE craft.audit_log SET action = 'x'`, `DELETE FROM craft.audit_log`, `TRUNCATE craft.audit_log CASCADE`]],
  ['documents delete/truncate', [`DELETE FROM craft.documents`, `TRUNCATE craft.documents CASCADE`]]
]) {
  test(`${label} are append-only for a superuser and for an ordinary role with full table privileges`, async () => {
    for (const statement of statements) {
      await sqlState(() => db.sql(statement), '23514', /append-only/);
      await sqlState(() => role.pool.query(statement), '23514', /append-only/);
    }
  });
}
test('references are append-only too', async () => {
  const refs = await db.sql(`SELECT count(*)::int AS n FROM craft."references"`);
  await db.sql(`INSERT INTO craft."references" (dataset_id, revision_id, path, target_native_id) VALUES ($1, $2, 'author', 'x')`, [dsA, revA]);
  for (const statement of [`UPDATE craft."references" SET weak = true`, `DELETE FROM craft."references"`, `TRUNCATE craft."references"`]) {
    await sqlState(() => role.pool.query(statement), '23514', /append-only/);
  }
  assert.equal((await db.sql(`SELECT count(*)::int AS n FROM craft."references"`)).rows[0].n, refs.rows[0].n + 1);
});

test('table owners and superusers CAN bypass the triggers (documented limitation); a plain role cannot', async () => {
  await db.sql('ALTER TABLE craft.audit_log DISABLE TRIGGER audit_log_immutable');
  try {
    await db.sql(`UPDATE craft.audit_log SET action = action WHERE false`); // no rows: just proves no error path
    const before = await db.sql(`SELECT action FROM craft.audit_log LIMIT 1`);
    await db.sql(`UPDATE craft.audit_log SET action = 'tampered' WHERE id = (SELECT min(id) FROM craft.audit_log)`);
    assert.equal((await db.sql(`SELECT action FROM craft.audit_log ORDER BY id LIMIT 1`)).rows[0].action, 'tampered');
    assert.notEqual(before.rows[0].action, 'tampered');
    await db.sql(`UPDATE craft.audit_log SET action = $1 WHERE id = (SELECT min(id) FROM craft.audit_log)`, [before.rows[0].action]);
  } finally { await db.sql('ALTER TABLE craft.audit_log ENABLE TRIGGER audit_log_immutable'); }
  await sqlState(() => role.pool.query('ALTER TABLE craft.audit_log DISABLE TRIGGER audit_log_immutable'), '42501');
  await sqlState(() => role.pool.query(`SET session_replication_role = replica`), '42501');
});

test('same-dataset foreign keys: revisions, current pointer and audit rows cannot cross datasets', async () => {
  await sqlState(() => insertRevision(db.pool, dsA, docB.id), '23503', /revisions_document_fkey/);
  await sqlState(() => db.sql(`UPDATE craft.documents SET current_revision_id = $1 WHERE id = $2`, [revB, docA.id]), '23503', /documents_current_revision_fkey/);
  await sqlState(() => db.sql(`INSERT INTO craft.audit_log (actor_id, action, dataset_id, document_id) VALUES ('x', 'x', $1, $2)`, [dsA, docB.id]), '23503', /audit_log_document_fkey/);
  await sqlState(() => db.sql(`INSERT INTO craft."references" (dataset_id, revision_id, path, target_native_id) VALUES ($1, $2, 'p', 't')`, [dsA, revB]), '23503', /references_revision_fkey/);
  // The pointer cannot name another document's revision even in the same dataset.
  await db.sql(`INSERT INTO craft.documents (dataset_id, native_id, type, logical_id, variant) VALUES ($1, 'other', 'page', 'other', 'published')`, [dsA]);
  const other = (await db.sql(`SELECT id FROM craft.documents WHERE native_id = 'other'`)).rows[0].id;
  await sqlState(() => db.sql(`UPDATE craft.documents SET current_revision_id = $1 WHERE id = $2`, [revA, other]), '23503', /documents_current_revision_fkey/);
});

test('document constraints: variant, identity shape, uniqueness, immutability, pair type', async () => {
  const insert = (native, type, logical, variant, ds = dsA) => db.sql(
    `INSERT INTO craft.documents (dataset_id, native_id, type, logical_id, variant) VALUES ($1, $2, $3, $4, $5)`, [ds, native, type, logical, variant]);
  await sqlState(() => insert('z1', 'page', 'z1', 'archived'), '23514', /identity|variant/);
  await sqlState(() => insert('z1', 'page', 'z1', 'draft'), '23514', /identity/);
  await sqlState(() => insert('drafts.z2', 'page', 'z2', 'published'), '23514', /identity/);
  await sqlState(() => insert('drafts.drafts.z3', 'page', 'drafts.z3', 'draft'), '23514', /identity/);
  await sqlState(() => insert('z4', 'bad type', 'z4', 'published'), '23514', /identity/);
  await sqlState(() => insert('drafts.p1', 'page', 'p1', 'draft'), '23505', /_key/);
  await sqlState(() => insert('p1', 'person', 'p1', 'published'), '23514', /share a type/);
  await sqlState(() => db.sql(`UPDATE craft.documents SET type = 'person' WHERE id = $1`, [docA.id]), '23514', /immutable/);
  await sqlState(() => db.sql(`UPDATE craft.documents SET native_id = 'renamed' WHERE id = $1`, [docA.id]), '23514', /immutable/);
  await sqlState(() => db.sql(`UPDATE craft.documents SET lock_version = -1 WHERE id = $1`, [docA.id]), '23514', /lock_version/);
  // Same ids in another dataset are fine (uniqueness is per dataset).
  await insert('only-in-b', 'page', 'only-in-b', 'published', dsB);
});

test('revision constraints: sequence, hash shape, object payload, envelope keys, size, uniqueness', async () => {
  await sqlState(() => insertRevision(db.pool, dsA, docA.id, 0), '23514', /revisions_version_check/);
  await sqlState(() => insertRevision(db.pool, dsA, docA.id, 5, { sha: 'XYZ' }), '23514', /revisions_payload_check/);
  await sqlState(() => insertRevision(db.pool, dsA, docA.id, 5, { payload: '[]' }), '23514', /revisions_payload_check/);
  await sqlState(() => insertRevision(db.pool, dsA, docA.id, 5, { payload: '"text"' }), '23514', /revisions_payload_check/);
  await sqlState(() => insertRevision(db.pool, dsA, docA.id, 5, { payload: '{"_id":"smuggled"}' }), '23514', /revisions_payload_check/);
  await sqlState(() => insertRevision(db.pool, dsA, docA.id, 5, { payload: JSON.stringify({ big: 'x'.repeat(1_100_000) }) }), '23514', /revisions_payload_check/);
  await sqlState(() => insertRevision(db.pool, dsA, docA.id, 1), '23505', /sequence_key/);
  await sqlState(() => db.sql(
    `INSERT INTO craft.revisions (dataset_id, document_id, sequence, schema_version, native_rev, payload, payload_sha256, actor_id)
     SELECT dataset_id, document_id, 77, 1, native_rev, '{}', $2, 'x' FROM craft.revisions WHERE id = $1`, [revA, sha]), '23505', /native_rev_key/);
  await sqlState(() => db.sql(`INSERT INTO craft.revisions (dataset_id, document_id, sequence, schema_version, payload, payload_sha256, actor_id) VALUES ($1, $2, 78, 1, '{}', $3, '')`, [dsA, docA.id, sha]), '23514', /actor_check/);
});

test('receipt, audit and dataset constraints', async () => {
  const receipt = (k, overrides = {}) => db.sql(
    `INSERT INTO craft.mutations (dataset_id, actor_id, key, operation, request_sha256, result) VALUES ($1, 'x', $2, 'op', $3, $4::jsonb)`,
    [dsA, k, overrides.sha ?? sha, overrides.result ?? '{}']);
  await receipt('r1');
  await sqlState(() => receipt('r1'), '23505', /dataset_key_key/);
  await sqlState(() => receipt('r2', { sha: 'nothex' }), '23514', /mutations_check/);
  await sqlState(() => receipt('r3', { result: '[]' }), '23514', /mutations_check/);
  await sqlState(() => db.sql(`INSERT INTO craft.audit_log (actor_id, action, detail) VALUES ('x', 'x', $1::jsonb)`, [JSON.stringify({ blob: 'x'.repeat(5000) })]), '23514', /audit_log_check/);
  await sqlState(() => db.sql(`INSERT INTO craft.audit_log (actor_id, action, detail) VALUES ('x', 'x', '[]')`), '23514', /audit_log_check/);
  await sqlState(() => db.sql(`INSERT INTO craft.datasets (name) VALUES ('Bad Name')`), '23514', /datasets_name_check/);
  await sqlState(() => db.sql(`INSERT INTO craft.datasets (name) VALUES ('a')`), '23505', /name_key/);
  await sqlState(() => db.sql(`DELETE FROM craft.datasets WHERE id = $1`, [dsA]), '23503');
});

test('a role granted only SELECT/INSERT (and UPDATE on documents) runs the service end to end', async () => {
  const least = await makeRole(db, [
    'GRANT USAGE ON SCHEMA craft TO $ROLE',
    'GRANT SELECT, INSERT ON craft.datasets, craft.revisions, craft.mutations, craft.audit_log, craft."references" TO $ROLE',
    'GRANT SELECT, INSERT, UPDATE ON craft.documents TO $ROLE'
  ]);
  const ctx = makeCtx(db, { executor: least.executor });
  const saved = await saveDraft(ctx, { dataset: 'a', registry, input: page('least-priv'), mutationKey: key() });
  assert.equal(saved.variant, 'draft');
  await sqlState(() => least.pool.query('DELETE FROM craft.documents'), '42501');
  await sqlState(() => least.pool.query('CREATE TABLE craft.x (a int)'), '42501');
});
