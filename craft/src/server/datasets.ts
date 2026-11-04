import { assertDatasetName, requireAccess, type CraftContext } from './auth.js';
import { fail } from './errors.js';
import { audit, inTransaction, TS } from './store.js';

export type DatasetInfo = { id: string; name: string; title: string | null; createdAt: string };
type Row = { id: string; name: string; title: string | null; created_at: string };
const info = (row: Row): DatasetInfo => ({ id: row.id, name: row.name, title: row.title, createdAt: row.created_at });

/** Requires 'admin'. Fails with dataset_exists when the name is taken (archived datasets keep their name). */
export async function createDataset(ctx: CraftContext, input: { name: string; title?: string }): Promise<DatasetInfo> {
  await requireAccess(ctx, input?.name, 'admin');
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200 || /[\u0000-\u001f\u007f]/.test(input.title))) return fail('invalid_input');
  return inTransaction(ctx, async q => {
    const made = await q.query<Row>(
      `INSERT INTO craft.datasets (name, title, created_by) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING
       RETURNING id, name, title, ${TS('created_at')} AS created_at`, [input.name, input.title ?? null, ctx.actorId]);
    const row = made.rows[0] ?? fail('dataset_exists');
    await audit(q, ctx, { action: 'dataset.create', datasetId: row.id, detail: { name: row.name } });
    return info(row);
  });
}

/** Requires 'admin'. Returns null for an unknown or archived dataset. */
export async function getDataset(ctx: CraftContext, name: string): Promise<DatasetInfo | null> {
  await requireAccess(ctx, name, 'admin');
  assertDatasetName(name);
  return inTransaction(ctx, async q => {
    const found = await q.query<Row>(`SELECT id, name, title, ${TS('created_at')} AS created_at FROM craft.datasets WHERE name = $1 AND archived_at IS NULL`, [name]);
    return found.rows[0] ? info(found.rows[0]) : null;
  });
}
