import assert from 'node:assert/strict';
import test from 'node:test';
import { denySession, getActors, isSessionRevoked, revokeSubject, upsertActor } from '../../dist/server/index.js';
import { expectError, freshDb, makeRole } from './helpers.mjs';

const SID = 'A'.repeat(32);
const OTHER_SID = 'B'.repeat(32);

test('actors: upsert writes and updates one row per person; only https avatars are kept', async () => {
  const db = await freshDb('sso1');
  try {
    await upsertActor(db.executor, { actorId: 'jongo:u1', displayName: 'Ada Editor', email: 'ada@example.test', avatarUrl: 'https://cdn.example.test/a.png' });
    await upsertActor(db.executor, { actorId: 'jongo:u2', displayName: 'Bo', email: 'bo@example.test', avatarUrl: 'http://cdn.example.test/b.png' });
    await upsertActor(db.executor, { actorId: 'jongo:u3', displayName: '  ', email: null, avatarUrl: 'javascript:alert(1)' });
    let found = await getActors(db.executor, ['jongo:u1', 'jongo:u2', 'jongo:u3', 'jongo:none']);
    assert.deepEqual([...found.keys()].sort(), ['jongo:u1', 'jongo:u2', 'jongo:u3']);
    assert.deepEqual(found.get('jongo:u1'), { actorId: 'jongo:u1', displayName: 'Ada Editor', email: 'ada@example.test', avatarUrl: 'https://cdn.example.test/a.png' });
    assert.equal(found.get('jongo:u2').avatarUrl, null, 'http avatar dropped');
    assert.deepEqual([found.get('jongo:u3').displayName, found.get('jongo:u3').avatarUrl], [null, null]);
    await upsertActor(db.executor, { actorId: 'jongo:u1', displayName: 'Ada Renamed', email: 'ada@example.test' });
    found = await getActors(db.executor, ['jongo:u1']);
    assert.deepEqual([found.get('jongo:u1').displayName, found.get('jongo:u1').avatarUrl], ['Ada Renamed', null]);
    assert.equal((await db.sql('SELECT count(*)::int AS n FROM craft.actors')).rows[0].n, 3);
    assert.equal((await getActors(db.executor, [])).size, 0);
    await expectError(upsertActor(db.executor, { actorId: '' }), 'invalid_input');
    await expectError(upsertActor(db.executor, { actorId: 'jongo:\nbad' }), 'invalid_input');
    await expectError(upsertActor(db.executor, { actorId: 'x'.repeat(129) }), 'invalid_input');
  } finally { await db.close(); }
});

test('actors: the table itself refuses non-https avatars, empty ids and oversized names', async () => {
  const db = await freshDb('sso2');
  try {
    for (const [column, value] of [['avatar_url', 'http://x.test/a.png'], ['avatar_url', 'https://x.test/a b.png'], ['display_name', 'x'.repeat(201)], ['email', 'a']]) {
      await assert.rejects(db.sql(`INSERT INTO craft.actors (actor_id, ${column}) VALUES ('jongo:c', $1)`, [value]), error => error.code === '23514', `${column}`);
    }
    await assert.rejects(db.sql(`INSERT INTO craft.actors (actor_id) VALUES ('')`), error => error.code === '23514');
  } finally { await db.close(); }
});

test('revocations: not_before only moves forward and rejects sessions issued before it', async () => {
  const db = await freshDb('sso3');
  try {
    const issued = Math.floor(Date.now() / 1000) - 30;
    const probe = (sub = 'u1', sid = SID, at = issued) => isSessionRevoked(db.executor, { sub, sid, issuedAtSeconds: at });
    assert.equal(await probe(), false, 'nobody is revoked by default');
    await revokeSubject(db.executor, 'u1', new Date());
    assert.equal(await probe(), true, 'issued before the cut-off');
    assert.equal(await probe('u2'), false, 'other people are unaffected');
    assert.equal(await probe('u1', SID, Math.floor(Date.now() / 1000) + 5), false, 'issued after the cut-off');
    const before = (await db.sql(`SELECT not_before FROM craft.sso_revocations WHERE sub = 'u1'`)).rows[0].not_before;
    await revokeSubject(db.executor, 'u1', new Date(Date.now() - 3_600_000));
    assert.deepEqual((await db.sql(`SELECT not_before FROM craft.sso_revocations WHERE sub = 'u1'`)).rows[0].not_before, before, 'never moves backwards');
    await revokeSubject(db.executor, 'u1', new Date(Date.now() + 3_600_000));
    assert.equal(await probe('u1', SID, Math.floor(Date.now() / 1000) + 5), true, 'moves forward');
    assert.equal((await db.sql('SELECT count(*)::int AS n FROM craft.sso_revocations')).rows[0].n, 1);
    await expectError(revokeSubject(db.executor, '', new Date()), 'invalid_input');
    await expectError(revokeSubject(db.executor, 'u1', new Date('nope')), 'invalid_input');
    await expectError(isSessionRevoked(db.executor, { sub: 'u1', sid: 'short', issuedAtSeconds: 1 }), 'invalid_input');
  } finally { await db.close(); }
});

test('signed-out sessions stay denied until their expiry and are then pruned', async () => {
  const db = await freshDb('sso4');
  try {
    const at = Math.floor(Date.now() / 1000);
    await denySession(db.executor, SID, new Date(Date.now() + 3_600_000));
    assert.equal(await isSessionRevoked(db.executor, { sub: 'u1', sid: SID, issuedAtSeconds: at }), true);
    assert.equal(await isSessionRevoked(db.executor, { sub: 'u1', sid: OTHER_SID, issuedAtSeconds: at }), false);
    await denySession(db.executor, SID, new Date(Date.now() + 7_200_000));
    assert.equal((await db.sql('SELECT count(*)::int AS n FROM craft.sso_denied_sessions')).rows[0].n, 1, 'idempotent');
    // An entry whose expiry has passed no longer denies anything and is removed by the next sign-out.
    await db.sql(`INSERT INTO craft.sso_denied_sessions (sid, expires_at) VALUES ($1, now() - interval '1 minute')`, [OTHER_SID]);
    assert.equal(await isSessionRevoked(db.executor, { sub: 'u1', sid: OTHER_SID, issuedAtSeconds: at }), false);
    await denySession(db.executor, 'C'.repeat(32), new Date(Date.now() + 60_000));
    assert.equal((await db.sql('SELECT count(*)::int AS n FROM craft.sso_denied_sessions WHERE sid = $1', [OTHER_SID])).rows[0].n, 0);
    await expectError(denySession(db.executor, 'short', new Date()), 'invalid_input');
    await expectError(denySession(db.executor, 'has space has space has space', new Date()), 'invalid_input');
  } finally { await db.close(); }
});

test('the least-privilege application role can run every SSO operation with only the documented grants', async () => {
  const db = await freshDb('sso5');
  try {
    const app = await makeRole(db, [
      'GRANT USAGE ON SCHEMA craft TO $ROLE',
      'GRANT SELECT, INSERT, UPDATE ON craft.actors, craft.sso_revocations TO $ROLE',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON craft.sso_denied_sessions TO $ROLE'
    ]);
    await upsertActor(app.executor, { actorId: 'jongo:u9', displayName: 'Nine', email: 'nine@example.test' });
    assert.equal((await getActors(app.executor, ['jongo:u9'])).get('jongo:u9').displayName, 'Nine');
    await revokeSubject(app.executor, 'u9', new Date());
    await denySession(app.executor, SID, new Date(Date.now() + 60_000));
    assert.equal(await isSessionRevoked(app.executor, { sub: 'u9', sid: OTHER_SID, issuedAtSeconds: 1 }), true);
    // The migration adds nothing that lets the application change history.
    await assert.rejects(app.executor.query('DELETE FROM craft.audit_log'), error => error.code === '42501');
  } finally { await db.close(); }
});

test('migration 0002 is purely additive: the 0001 tables and their data are unchanged', async () => {
  const db = await freshDb('sso6', { migrate: false });
  try {
    const { loadMigrations, runMigrations } = await import('../../dist/server/index.js');
    const [first] = await loadMigrations();
    await runMigrations(db.executor, { migrations: [first] });
    const before = (await db.sql(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'craft' ORDER BY 1, 2`)).rows;
    const report = await runMigrations(db.executor);
    assert.deepEqual(report.alreadyApplied, [first.name]);
    assert.deepEqual(report.applied, ['0002_sso_actors_revocations.sql']);
    const after = (await db.sql(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'craft' ORDER BY 1, 2`)).rows;
    assert.deepEqual(after.filter(row => before.some(old => old.table_name === row.table_name)), before, 'existing tables keep exactly their columns');
    assert.deepEqual([...new Set(after.map(row => row.table_name))].filter(name => !before.some(old => old.table_name === name)).sort(), ['actors', 'sso_denied_sessions', 'sso_revocations']);
  } finally { await db.close(); }
});
