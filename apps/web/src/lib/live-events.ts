/**
 * Live updates: "something about this app changed".
 *
 * Producers call publishSiteEvent (or the SQL in notifyOperationChanged) and
 * Postgres's LISTEN/NOTIFY carries it to every web process, so it works with
 * the worker, detached jobs and more than one container. Nothing new to run.
 *
 * Events carry no data beyond the app id and a kind. A browser that receives
 * one re-reads what it shows through the normal, access-checked routes, so an
 * event can never leak anything by itself.
 */

export const LIVE_EVENTS_CHANNEL = "jongo_events";

export type SiteEventKind = "operation" | "backup" | "restore" | "staging" | "settings";
export type SiteEvent = { siteId: string; kind: SiteEventKind; at: string };

type Db = { $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> };

async function loadDb(): Promise<Db> {
  const { db } = await import("@/lib/db");
  return db as Db;
}

/** Best effort: a missed event only means the page catches up on its fallback timer. */
export async function publishSiteEvent(siteId: string | null | undefined, kind: SiteEventKind, options: { db?: Db } = {}) {
  if (!siteId) return;
  try {
    const db = options.db ?? (await loadDb());
    const payload = JSON.stringify({ siteId, kind, at: new Date().toISOString() } satisfies SiteEvent);
    await db.$executeRaw`select pg_notify(${LIVE_EVENTS_CHANNEL}, ${payload})`;
  } catch (error) {
    console.warn("[live-events] publish failed", { siteId, kind, message: (error as Error)?.message });
  }
}

/** After an operation changes: tell anyone watching its app. */
export async function notifyOperationChanged(db: Db, operationId: string) {
  try {
    await db.$executeRaw`
      select pg_notify(${LIVE_EVENTS_CHANNEL}, json_build_object(
        'siteId', "resourceId", 'kind', 'operation', 'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      )::text)
      from "Operation"
      where "id" = ${operationId}::uuid and "resourceType" = 'site' and "resourceId" is not null
    `;
  } catch {
    // Best effort, as above.
  }
}

export function parseSiteEvent(payload: string | undefined): SiteEvent | null {
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as Partial<SiteEvent>;
    if (typeof value.siteId !== "string" || !value.siteId || typeof value.kind !== "string") return null;
    return { siteId: value.siteId, kind: value.kind as SiteEventKind, at: typeof value.at === "string" ? value.at : "" };
  } catch {
    return null;
  }
}
