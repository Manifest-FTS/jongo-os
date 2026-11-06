import { fail } from './errors.js';
import type { Queryable } from './executor.js';

/** Sign-in sessions and the people behind them (tables from migration 0002). Host-internal: no per-dataset authorization applies. */
export type ActorProfile = { actorId: string; displayName: string | null; email: string | null; avatarUrl: string | null };

const ACTOR_ID = /^[^\u0000-\u001f\u007f]{1,128}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{22,64}$/;
const clean = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim().slice(0, max) : null;
const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 2048 || /\s/.test(value)) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
};

/** Written on each sign-in. A non-https avatar address is dropped rather than stored. */
export async function upsertActor(q: Queryable, input: { actorId: string; displayName?: string | null; email?: string | null; avatarUrl?: string | null }): Promise<void> {
  if (typeof input.actorId !== 'string' || !ACTOR_ID.test(input.actorId)) return fail('invalid_input');
  await q.query(
    `INSERT INTO craft.actors (actor_id, display_name, email, avatar_url, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (actor_id) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email, avatar_url = EXCLUDED.avatar_url, updated_at = now()`,
    [input.actorId, clean(input.displayName, 200), clean(input.email, 254), httpsUrl(input.avatarUrl)]
  );
}

export async function getActors(q: Queryable, actorIds: readonly string[]): Promise<Map<string, ActorProfile>> {
  const ids = [...new Set(actorIds.filter(id => typeof id === 'string' && ACTOR_ID.test(id)))].slice(0, 200);
  const out = new Map<string, ActorProfile>();
  if (ids.length === 0) return out;
  const result = await q.query<{ actor_id: string; display_name: string | null; email: string | null; avatar_url: string | null }>(
    'SELECT actor_id, display_name, email, avatar_url FROM craft.actors WHERE actor_id = ANY($1::text[])', [ids]);
  for (const row of result.rows) out.set(row.actor_id, { actorId: row.actor_id, displayName: row.display_name, email: row.email, avatarUrl: row.avatar_url });
  return out;
}

/** Everything `sub` signed in to before `notBefore` stops working. The cut-off only ever moves forward. */
export async function revokeSubject(q: Queryable, sub: string, notBefore: Date): Promise<void> {
  if (typeof sub !== 'string' || !ACTOR_ID.test(sub) || !(notBefore instanceof Date) || Number.isNaN(notBefore.getTime())) return fail('invalid_input');
  await q.query(
    `INSERT INTO craft.sso_revocations (sub, not_before, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (sub) DO UPDATE SET not_before = GREATEST(craft.sso_revocations.not_before, EXCLUDED.not_before), updated_at = now()`,
    [sub, notBefore.toISOString()]
  );
}

/** Records a signed-out session until it would have expired; also drops entries that are already past. */
export async function denySession(q: Queryable, sid: string, expiresAt: Date): Promise<void> {
  if (typeof sid !== 'string' || !SESSION_ID.test(sid) || !(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) return fail('invalid_input');
  await q.query('DELETE FROM craft.sso_denied_sessions WHERE expires_at < now()');
  await q.query(
    'INSERT INTO craft.sso_denied_sessions (sid, expires_at) VALUES ($1, $2) ON CONFLICT (sid) DO UPDATE SET expires_at = GREATEST(craft.sso_denied_sessions.expires_at, EXCLUDED.expires_at)',
    [sid, expiresAt.toISOString()]
  );
}

/** True when the session was revoked by person (issued before the cut-off) or signed out. Callers must treat a throw as revoked (fail closed). */
export async function isSessionRevoked(q: Queryable, input: { sub: string; sid: string; issuedAtSeconds: number }): Promise<boolean> {
  if (typeof input.sub !== 'string' || !ACTOR_ID.test(input.sub) || typeof input.sid !== 'string' || !SESSION_ID.test(input.sid) || !Number.isFinite(input.issuedAtSeconds)) return fail('invalid_input');
  const result = await q.query<{ revoked: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM craft.sso_revocations WHERE sub = $1 AND extract(epoch FROM not_before) * 1000 > $3)
             OR EXISTS (SELECT 1 FROM craft.sso_denied_sessions WHERE sid = $2 AND expires_at > now())) AS revoked`,
    [input.sub, input.sid, input.issuedAtSeconds * 1000]
  );
  return result.rows[0]?.revoked === true;
}
