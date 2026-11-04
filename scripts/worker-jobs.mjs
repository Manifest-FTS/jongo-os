/**
 * The worker's job catalogue: which recurring jobs exist, when they run, and
 * which existing one-pass function each calls.
 *
 * Pure configuration so it can be tested without a database. The functions it
 * points at are the same ones the old standalone schedulers looped over, so the
 * work itself is unchanged; what changes is that pg-boss now decides when it
 * runs, guarantees only one copy runs at a time across restarts and replicas,
 * retries startup failures, and keeps a history of every run.
 */

export function flag(env, name, defaultOn) {
  const value = (env[name] || "").trim().toLowerCase();
  if (!value) return defaultOn;
  return defaultOn ? value !== "false" : value === "true";
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Cron for "every N minutes". Cron cannot express every interval exactly, so
 * the result is the closest schedule that never runs more often than asked
 * and a note when it had to round.
 */
export function intervalMinutesToCron(minutes) {
  const m = Math.max(1, Math.floor(minutes));
  if (m === 1) return { cron: "* * * * *" };
  const minuteStep = [2, 3, 4, 5, 6, 10, 12, 15, 20, 30].find((d) => d >= m);
  if (minuteStep) {
    return { cron: `*/${minuteStep} * * * *`, ...(minuteStep === m ? {} : { note: `every ${m} minutes is not a cron step; running every ${minuteStep}` }) };
  }
  const hourStep = [1, 2, 3, 4, 6, 8, 12].find((d) => d * 60 >= m);
  if (!hourStep) return { cron: "0 0 * * *", ...(m === 1440 ? {} : { note: `running daily instead of every ${m} minutes` }) };
  return {
    cron: hourStep === 1 ? "0 * * * *" : `0 */${hourStep} * * *`,
    ...(hourStep * 60 === m ? {} : { note: `every ${m} minutes is not a cron step; running every ${hourStep} hour(s)` })
  };
}

/**
 * @returns {Array<{ name: string, enabled: boolean, cron: string, note?: string,
 *   runAtStartup: boolean, retryLimit: number, retryDelaySeconds: number,
 *   expireInSeconds: number, load: () => Promise<() => Promise<unknown>> }>}
 */
export function jobDefinitions(env = process.env) {
  const deletionWatchSeconds = positiveInt(env.COOLIFY_DELETION_WATCH_INTERVAL_SECONDS, 60);
  const usageMinutes = positiveInt(env.USAGE_COLLECT_INTERVAL_MINUTES, 5);
  const backupMinutes = positiveInt(env.BACKUP_RECONCILE_INTERVAL_MINUTES, 60);
  const startupAttempts = (name, fallback) => Math.max(0, positiveInt(env[name], fallback) - 1);

  const deletionCron = intervalMinutesToCron(Math.ceil(deletionWatchSeconds / 60));
  if (deletionWatchSeconds < 60) deletionCron.note = "the worker runs at most once a minute; using every minute";

  return [
    {
      // Fast deletion sync. On by default (see start-production.mjs history).
      name: "coolify-deletion-watch",
      enabled: flag(env, "COOLIFY_DELETION_WATCH_ENABLED", true),
      ...deletionCron,
      runAtStartup: false, // the next minute is soon enough
      retryLimit: 0, // the next tick is the retry
      retryDelaySeconds: 0,
      expireInSeconds: 120,
      load: async () => (await import("./coolify-deletion-watcher.mjs")).watchOnce
    },
    {
      // Usage metering. On by default: history only exists from when it starts.
      name: "usage-collect",
      enabled: flag(env, "USAGE_COLLECT_ENABLED", true),
      ...intervalMinutesToCron(usageMinutes),
      runAtStartup: true,
      // Counters are cumulative, so a missed tick loses nothing; retries only
      // cover the web app still starting up.
      retryLimit: startupAttempts("USAGE_COLLECT_STARTUP_ATTEMPTS", 5),
      retryDelaySeconds: Math.ceil(positiveInt(env.USAGE_COLLECT_STARTUP_BACKOFF_MS, 15000) / 1000),
      expireInSeconds: 330,
      load: async () => (await import("./usage-collector-scheduler.mjs")).collectOnce
    },
    {
      name: "backup-reconcile",
      enabled: flag(env, "BACKUP_RECONCILE_SCHEDULE_ENABLED", false),
      ...intervalMinutesToCron(backupMinutes),
      runAtStartup: flag(env, "BACKUP_RECONCILE_RUN_IMMEDIATE", true),
      retryLimit: startupAttempts("BACKUP_RECONCILE_STARTUP_ATTEMPTS", 5),
      retryDelaySeconds: Math.ceil(positiveInt(env.BACKUP_RECONCILE_STARTUP_BACKOFF_MS, 15000) / 1000),
      expireInSeconds: 30 * 60,
      load: async () => (await import("./backup-reconcile-scheduler.mjs")).runReconcileOnce
    },
    {
      // Daily at a fixed time. The old loop also ran on every restart, which
      // called Namecheap on every deploy; once a day is what it is for.
      name: "namecheap-domain-sync",
      enabled: flag(env, "NAMECHEAP_SYNC_SCHEDULE_ENABLED", false),
      cron: (env.NAMECHEAP_SYNC_CRON || "").trim() || "17 3 * * *",
      runAtStartup: false,
      retryLimit: 2,
      retryDelaySeconds: 300,
      expireInSeconds: 15 * 60,
      load: async () => {
        const { syncOnce } = await import("./namecheap-domain-sync-scheduler.mjs");
        return () => syncOnce();
      }
    }
  ];
}

/** pg's connection string parser does not know Prisma's own URL parameters. */
export function pgConnectionString(databaseUrl) {
  const url = new URL(databaseUrl);
  for (const key of ["schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size", "socket_timeout"]) {
    url.searchParams.delete(key);
  }
  return url.toString();
}
