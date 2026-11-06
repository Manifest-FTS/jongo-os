/**
 * One LISTEN connection per web process, shared by every open live-update
 * stream. Reconnects with backoff if the database connection drops; streams
 * stay open meanwhile and the pages fall back to their slow timers.
 */
import { LIVE_EVENTS_CHANNEL, parseSiteEvent, type SiteEvent } from "@/lib/live-events";

type Listener = (event: SiteEvent) => void;

type State = {
  listeners: Map<string, Set<Listener>>;
  client: { end(): Promise<void> } | null;
  connecting: Promise<void> | null;
  retryMs: number;
};

const globalForLive = globalThis as unknown as { jongoLive?: State };
const state: State = (globalForLive.jongoLive ??= { listeners: new Map(), client: null, connecting: null, retryMs: 1000 });

function connectionString(): string {
  const url = new URL((process.env.DATABASE_URL || "").trim());
  for (const key of ["schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size", "socket_timeout"]) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

function dispatch(payload: string | undefined) {
  const event = parseSiteEvent(payload);
  if (!event) return;
  for (const listener of state.listeners.get(event.siteId) ?? []) {
    try {
      listener(event);
    } catch {
      // One broken stream must not stop the others.
    }
  }
}

function scheduleReconnect() {
  state.client = null;
  if (state.listeners.size === 0) return; // reconnect lazily on the next subscriber
  const wait = state.retryMs;
  state.retryMs = Math.min(state.retryMs * 2, 30_000);
  setTimeout(() => void ensureConnected(), wait).unref?.();
}

async function ensureConnected(): Promise<void> {
  if (state.client || state.connecting) return state.connecting ?? undefined;
  state.connecting = (async () => {
    try {
      const { Client } = await import("pg");
      const client = new Client({ connectionString: connectionString(), application_name: "jongo-live" });
      client.on("notification", (message: { channel: string; payload?: string }) => {
        if (message.channel === LIVE_EVENTS_CHANNEL) dispatch(message.payload);
      });
      client.on("error", (error: Error) => {
        console.warn("[live-events] listener connection error", error.message);
        client.end().catch(() => undefined);
        scheduleReconnect();
      });
      await client.connect();
      await client.query(`LISTEN ${LIVE_EVENTS_CHANNEL}`);
      state.client = client;
      state.retryMs = 1000;
    } catch (error) {
      console.warn("[live-events] could not listen", (error as Error)?.message);
      scheduleReconnect();
    } finally {
      state.connecting = null;
    }
  })();
  return state.connecting;
}

/** Subscribe to one app's events. Returns the unsubscribe function. */
export function subscribeToSite(siteId: string, listener: Listener): () => void {
  let set = state.listeners.get(siteId);
  if (!set) state.listeners.set(siteId, (set = new Set()));
  set.add(listener);
  void ensureConnected();
  return () => {
    const current = state.listeners.get(siteId);
    current?.delete(listener);
    if (current && current.size === 0) state.listeners.delete(siteId);
  };
}

/** For tests. */
export function __dispatchForTest(payload: string) {
  dispatch(payload);
}
