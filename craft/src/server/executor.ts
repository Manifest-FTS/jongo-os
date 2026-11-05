/** Minimal SQL boundary. Craft never imports a database driver; the host passes an adapter. */
export type QueryResult<R> = { rows: R[]; rowCount: number };
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}
export type TransactionOptions = {
  /** REPEATABLE READ, READ ONLY: one consistent snapshot for multi-statement reads. */
  snapshot?: boolean;
};
export interface SqlExecutor extends Queryable {
  /** Runs `fn` in one transaction: COMMIT when it resolves, ROLLBACK when it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T>;
}

/** Structural subset of `pg.Pool`/`pg.Client`: lets Craft type-check without depending on `pg`. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgQueryable & { release(error?: Error | boolean): void }>;
}

const wrap = (target: PgQueryable): Queryable => ({
  async query<R>(text: string, params?: readonly unknown[]) {
    const result = await target.query(text, params === undefined ? undefined : [...params]);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
  }
});

/** Adapter for a `pg.Pool`. Each transaction owns one pooled connection. */
export function createPgExecutor(pool: PgPoolLike): SqlExecutor {
  return {
    ...wrap(pool),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query(options.snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { broken = true; }
        throw error;
      } finally { client.release(broken ? true : undefined); }
    }
  };
}
