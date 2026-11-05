import { fail } from './errors.js';
import type { SqlExecutor } from './executor.js';

export type CraftAction = 'read' | 'read-drafts' | 'write' | 'publish' | 'export' | 'export-private' | 'import' | 'admin';
/** Fail-closed: anything other than a resolved `true` (false, undefined, a throw, a rejection) denies. */
export type Authorize = (actorId: string, action: CraftAction, datasetName: string) => boolean | Promise<boolean>;
export type CraftContext = { executor: SqlExecutor; authorize: Authorize; actorId: string };

export const DATASET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACTOR_ID = /^[^\u0000-\u001f\u007f]{1,128}$/;

export function assertContext(ctx: unknown): asserts ctx is CraftContext {
  const c = ctx as Partial<CraftContext> | null;
  if (typeof c !== 'object' || c === null) return fail('invalid_input');
  if (typeof c.executor?.query !== 'function' || typeof c.executor?.transaction !== 'function') return fail('invalid_input');
  if (typeof c.authorize !== 'function') return fail('invalid_input');
  if (typeof c.actorId !== 'string' || !ACTOR_ID.test(c.actorId)) return fail('invalid_input');
}

export function assertDatasetName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !DATASET_NAME.test(name)) fail('invalid_input');
}

/** Validates the context and dataset name, then asks the host. Runs before any database access. */
export async function requireAccess(ctx: unknown, dataset: unknown, ...actions: CraftAction[]): Promise<void> {
  assertContext(ctx);
  assertDatasetName(dataset);
  for (const action of actions) {
    let allowed = false;
    try { allowed = (await ctx.authorize(ctx.actorId, action, dataset)) === true; } catch { allowed = false; }
    if (!allowed) return fail('denied');
  }
}
