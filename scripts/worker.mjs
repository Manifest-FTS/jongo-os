#!/usr/bin/env node
/**
 * Jongo background worker.
 *
 * Runs recurring jobs on pg-boss, which keeps its queue in the existing
 * Postgres (schema `pgboss`) — no Redis or other service. Replaces the four
 * setInterval loops start-production.mjs used to spawn:
 *
 *  - one run at a time per job, even across restarts and multiple containers
 *    (queue policy "stately": at most one queued and one running);
 *  - schedules live in the database, so a restart does not reset the clock;
 *  - failures are retried with a delay and kept in pgboss.job for 7 days.
 *
 * Usage: `npm run worker` (started by start-production.mjs unless
 * JONGO_WORKER_MODE says otherwise). `--list` prints the schedule and exits.
 */
import { pathToFileURL } from "node:url";
import PgBoss from "pg-boss";
import { jobDefinitions, pgConnectionString } from "./worker-jobs.mjs";

function log(message) {
  console.log(`[worker] ${message}`);
}

function describe(job) {
  return `${job.name}: ${job.enabled ? `on, ${job.cron}${job.note ? ` (${job.note})` : ""}` : "off"}`;
}

async function setupQueues(boss, jobs) {
  for (const job of jobs) {
    const queue = {
      name: job.name,
      policy: "stately",
      retryLimit: job.retryLimit,
      retryDelay: job.retryDelaySeconds,
      expireInSeconds: job.expireInSeconds
    };
    await boss.createQueue(job.name, queue);
    await boss.updateQueue(job.name, queue); // apply changed settings on later starts
    if (job.enabled) await boss.schedule(job.name, job.cron, {}, { tz: "UTC" });
    else await boss.unschedule(job.name); // so turning a job off stops it everywhere
  }
}

export async function startWorker(env = process.env) {
  const databaseUrl = (env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const boss = new PgBoss({
    connectionString: pgConnectionString(databaseUrl),
    schema: "pgboss",
    application_name: "jongo-worker",
    // One shared server: keep the pool small. Each queue holds at most one
    // connection while polling.
    max: 5,
    pollingIntervalSeconds: 5
  });
  boss.on("error", (error) => console.error(`[worker] pg-boss error: ${error?.message || error}`));

  await boss.start();
  log("connected; queue schema is pgboss");

  const jobs = jobDefinitions(env);

  // Queue and schedule setup is idempotent, but two workers starting at the
  // same moment (a deploy overlapping the old container) can deadlock on
  // pg-boss's own tables. Retry the whole setup with jitter.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await setupQueues(boss, jobs);
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      const waitMs = 1000 + Math.floor(Math.random() * 3000);
      log(`queue setup attempt ${attempt} failed (${error?.message || error}); retrying in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  for (const job of jobs) {
    log(describe(job));
    if (!job.enabled) continue;

    const run = await job.load();
    await boss.work(job.name, { localConcurrency: 1 }, async ([pgJob]) => {
      const started = Date.now();
      try {
        await run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[worker] ${job.name} failed (attempt ${(pgJob?.retryCount ?? 0) + 1}): ${message}`);
        throw error; // pg-boss records it and retries per the queue settings
      }
      const ms = Date.now() - started;
      if (ms > 30_000) log(`${job.name} took ${Math.round(ms / 1000)}s`);
    });

    if (job.runAtStartup) {
      // Skipped by the queue policy if a run is already waiting.
      await boss.send(job.name, {});
    }
  }

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: finishing running jobs (up to 30s)...`);
    try {
      await boss.stop({ graceful: true, timeout: 30_000 });
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  return boss;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--list")) {
    for (const job of jobDefinitions()) console.log(describe(job));
    process.exit(0);
  }
  try {
    await startWorker();
  } catch (error) {
    console.error(`[worker] could not start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
