import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createContentRegistry, defineType } from '../../dist/index.js';
import { createDataset, createPgExecutor, runMigrations } from '../../dist/server/index.js';

const base = {
  host: process.env.CRAFT_TEST_PG_HOST, port: Number(process.env.CRAFT_TEST_PG_PORT),
  user: process.env.CRAFT_TEST_PG_USER, password: process.env.CRAFT_TEST_PG_PASSWORD
};
if (!base.host || !base.port) throw new Error('Run through scripts/test-db.mjs (npm run test:db)');

const suffix = () => randomBytes(4).toString('hex');
const adminPool = new pg.Pool({ ...base, database: 'postgres', max: 2 });
export const poolFor = (database, user, password, max = 6) => new pg.Pool({ ...base, database, ...(user ? { user, password } : {}), max });

/** A fresh database with its own superuser pool. `migrate: true` applies the Craft migrations. */
export async function freshDb(label, { migrate = true } = {}) {
  const database = `craft_${label}_${suffix()}`.slice(0, 60);
  await adminPool.query(`CREATE DATABASE "${database}"`);
  const pool = poolFor(database);
  const executor = createPgExecutor(pool);
  if (migrate) await runMigrations(executor);
  const pools = [pool];
  return {
    database, pool, executor,
    sql: (text, params) => pool.query(text, params),
    track: extra => { pools.push(extra); return extra; },
    async close() { await Promise.allSettled(pools.map(p => p.end())); }
  };
}

/** Non-superuser login role with exactly the grants given (SQL statements run as superuser in `db`). */
export async function makeRole(db, grants) {
  const name = `craft_t_${suffix()}`;
  const password = randomBytes(16).toString('hex');
  await db.sql(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await db.sql(`GRANT CONNECT ON DATABASE "${db.database}" TO ${name}`);
  for (const statement of grants) await db.sql(statement.replaceAll('$ROLE', name));
  const pool = db.track(poolFor(db.database, name, password));
  return { name, pool, executor: createPgExecutor(pool) };
}

export const ALL_ACTIONS = ['read', 'read-drafts', 'write', 'publish', 'export', 'export-private', 'import', 'admin'];
export const allow = (...actions) => async (_actor, action) => (actions.length ? actions : ALL_ACTIONS).includes(action);
export const makeCtx = (db, { actorId = 'alice', authorize = allow(), executor } = {}) => ({ executor: executor ?? db.executor, authorize, actorId });

/** Wraps an executor: records statement text, optionally fails statements matching `failOn`, optionally fails `transaction` starts. */
export function spyExecutor(inner, { failOn, failTransactions = 0, failCode = '40001' } = {}) {
  const log = [];
  let transactions = 0;
  const wrap = q => ({
    async query(text, params) {
      log.push(text);
      if (failOn && failOn.test(text)) throw Object.assign(new Error('driver failure with SECRET_SQL_TEXT and row data'), { code: 'XX000' });
      return q.query(text, params);
    }
  });
  return {
    log, get transactions() { return transactions; },
    query: (text, params) => wrap(inner).query(text, params),
    transaction: (fn, options) => {
      transactions++;
      if (transactions <= failTransactions) return Promise.reject(Object.assign(new Error('retryable'), { code: failCode }));
      return inner.transaction(tx => fn(wrap(tx)), options);
    }
  };
}

export const registry = createContentRegistry([
  defineType({ name: 'person', type: 'document', schemaVersion: 1, fields: [
    { name: 'name', type: 'string', required: true, maxLength: 80 },
    { name: 'email', type: 'string', private: true }
  ] }),
  defineType({ name: 'page', type: 'document', schemaVersion: 2, fields: [
    { name: 'title', type: 'string', required: true, maxLength: 80 },
    { name: 'summary', type: 'string', publishRequired: true, maxLength: 200 },
    { name: 'internalNote', type: 'string', private: true },
    { name: 'slug', type: 'slug' },
    { name: 'author', type: 'reference', to: ['person'] },
    { name: 'related', type: 'array', of: [{ type: 'reference', to: ['page'], weak: true }] },
    { name: 'meta', type: 'object', fields: [{ name: 'label', type: 'string' }, { name: 'internalCode', type: 'string', private: true }] },
    { name: 'blocks', type: 'array', of: [{ type: 'object', fields: [{ name: 'text', type: 'string' }, { name: 'hidden', type: 'string', private: true }] }] },
    { name: 'hero', type: 'image' }
  ] })
]);

export const page = (id, extra = {}) => ({ _id: id, _type: 'page', title: `Title ${id}`, summary: `Summary ${id}`, ...extra });
export const person = (id, extra = {}) => ({ _id: id, _type: 'person', name: `Name ${id}`, email: `${id}@example.invalid`, ...extra });

let counter = 0;
export const key = (prefix = 'k') => `${prefix}-${++counter}-${suffix()}`;

export async function withDataset(db, name = 'production', ctx = makeCtx(db)) {
  await createDataset(ctx, { name });
  return name;
}

export async function count(db, table, where = 'true', params = []) {
  return Number((await db.sql(`SELECT count(*) AS n FROM craft.${table} WHERE ${where}`, params)).rows[0].n);
}

export async function expectError(promise, code) {
  try { await promise; } catch (error) {
    if (error?.name !== 'CraftError' || error.code !== code) throw new Error(`Expected CraftError ${code}, got ${error?.name}:${error?.code ?? ''} ${error?.message}`);
    return error;
  }
  throw new Error(`Expected CraftError ${code}, but nothing was thrown`);
}
