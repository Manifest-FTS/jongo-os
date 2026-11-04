import { spawn } from "node:child_process";

const npmCommand = "npm";
let activeChild = null;
let backgroundChildren = [];

function log(message) {
  console.log(`[startup] ${message}`);
}

function forwardSignal(signal) {
  shuttingDown = true;
  if (activeChild && !activeChild.killed) {
    activeChild.kill(signal);
  }

  for (const child of backgroundChildren) {
    if (child && !child.killed) {
      child.kill(signal);
    }
  }
}

function startBackgroundProcess(label, args, extraEnv = {}, executable = npmCommand) {
  log(`${label}...`);

  const env = {
    ...process.env,
    ...extraEnv
  };

  const child = process.platform === "win32"
    ? spawn(`${executable} ${args.join(" ")}`, {
        stdio: "inherit",
        shell: true,
        env
      })
    : spawn(executable, args, {
        stdio: "inherit",
        env
      });

  child.on("exit", (code, signal) => {
    if (signal) {
      log(`${label} exited from signal ${signal}.`);
      return;
    }

    if (code && code !== 0) {
      console.error(`[startup] ${label} exited with code ${code}.`);
    }
  });

  backgroundChildren.push(child);
}

async function runStep(label, args, extraEnv = {}) {
  log(`${label}...`);

  await new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...extraEnv
    };

    activeChild = process.platform === "win32"
      ? spawn(`${npmCommand} ${args.join(" ")}`, {
          stdio: "inherit",
          shell: true,
          env
        })
      : spawn(npmCommand, args, {
          stdio: "inherit",
          env
        });

    activeChild.on("error", (error) => {
      reject(error);
    });

    activeChild.on("exit", (code, signal) => {
      activeChild = null;

      if (code === 0) {
        resolve();
        return;
      }

      if (signal) {
        reject(new Error(`${label} exited from signal ${signal}`));
        return;
      }

      reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

let shuttingDown = false;

// The worker is restarted if it dies, so a lost database connection does not
// silently stop backups and metering until the next deploy.
function startWorker() {
  log("Starting background worker...");
  const child = spawn("node", ["./scripts/worker.mjs"], { stdio: "inherit", env: process.env });
  backgroundChildren.push(child);
  child.on("exit", (code, signal) => {
    backgroundChildren = backgroundChildren.filter((c) => c !== child);
    if (shuttingDown) return;
    console.error(`[startup] Background worker exited (${signal || `code ${code}`}); restarting in 30s.`);
    setTimeout(() => {
      if (!shuttingDown) startWorker();
    }, 30_000).unref();
  });
}

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

try {
  await runStep("Generating Prisma client", ["run", "prisma:generate"]);
  await runStep("Applying committed Prisma migrations", ["run", "db:migrate:deploy"]);

  if (process.env.JONGO_SKIP_APP_START === "1") {
    log("Skipping web app start because JONGO_SKIP_APP_START=1.");
    process.exit(0);
  }

  // Background jobs. "embedded" (default): the pg-boss worker runs in this
  // container. "external": another container runs `npm run worker`, so start
  // nothing here. "legacy": the old setInterval loops, kept for one release as
  // a way back. "off": no background jobs.
  const workerMode = (process.env.JONGO_WORKER_MODE || "embedded").trim().toLowerCase();
  if (workerMode === "embedded") {
    startWorker();
  } else if (workerMode === "legacy") {
    const backupSchedulerEnabled = (process.env.BACKUP_RECONCILE_SCHEDULE_ENABLED || "false").trim().toLowerCase() === "true";
    if (backupSchedulerEnabled) {
      startBackgroundProcess("Starting backup reconcile scheduler", ["run", "ops:backup-reconcile:scheduler"]);
    }

    const namecheapSyncEnabled = (process.env.NAMECHEAP_SYNC_SCHEDULE_ENABLED || "false").trim().toLowerCase() === "true";
    if (namecheapSyncEnabled) {
      startBackgroundProcess("Starting daily Namecheap domain sync", ["./scripts/namecheap-domain-sync-scheduler.mjs"], {}, "node");
    }

    // Fast deletion sync. On by default: without it, deleting an app in Coolify
    // takes the reconciler's seven-day path to disappear from Jongo, which is the
    // behaviour this was added to fix. Set COOLIFY_DELETION_WATCH_ENABLED=false to
    // opt out. The watcher exits on its own if its ops token is missing.
    const deletionWatchEnabled =
      (process.env.COOLIFY_DELETION_WATCH_ENABLED || "true").trim().toLowerCase() !== "false";
    if (deletionWatchEnabled) {
      startBackgroundProcess("Starting Coolify deletion watcher", ["run", "ops:coolify-deletion:watcher"]);
    }

    // Resource usage metering. On by default: usage history only exists from the
    // moment collection starts, so every day it is off is a day the 30/60/90-day
    // views can never show. Set USAGE_COLLECT_ENABLED=false to opt out.
    const usageCollectEnabled = (process.env.USAGE_COLLECT_ENABLED || "true").trim().toLowerCase() !== "false";
    if (usageCollectEnabled) {
      startBackgroundProcess("Starting usage collector", ["run", "ops:usage-collect:scheduler"]);
    }
  } else {
    log(`Background worker not started here (JONGO_WORKER_MODE=${workerMode}).`);
  }

  await runStep("Starting web application", ["run", "start:web"], {
    HOSTNAME: process.env.HOSTNAME || "0.0.0.0"
  });
} catch (error) {
  console.error(`[startup] ${error.message}`);
  console.error("[startup] Aborting startup because database migrations did not complete cleanly.");
  process.exit(1);
}