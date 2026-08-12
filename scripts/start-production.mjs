import { spawn } from "node:child_process";

const npmCommand = "npm";
let activeChild = null;
let backgroundChildren = [];

function log(message) {
  console.log(`[startup] ${message}`);
}

function forwardSignal(signal) {
  if (activeChild && !activeChild.killed) {
    activeChild.kill(signal);
  }

  for (const child of backgroundChildren) {
    if (child && !child.killed) {
      child.kill(signal);
    }
  }
}

function startBackgroundProcess(label, args, extraEnv = {}) {
  log(`${label}...`);

  const env = {
    ...process.env,
    ...extraEnv
  };

  const child = process.platform === "win32"
    ? spawn(`${npmCommand} ${args.join(" ")}`, {
        stdio: "inherit",
        shell: true,
        env
      })
    : spawn(npmCommand, args, {
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

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

try {
  await runStep("Generating Prisma client", ["run", "prisma:generate"]);
  await runStep("Applying committed Prisma migrations", ["run", "db:migrate:deploy"]);

  if (process.env.JONGO_SKIP_APP_START === "1") {
    log("Skipping web app start because JONGO_SKIP_APP_START=1.");
    process.exit(0);
  }

  const backupSchedulerEnabled = (process.env.BACKUP_RECONCILE_SCHEDULE_ENABLED || "false").trim().toLowerCase() === "true";
  if (backupSchedulerEnabled) {
    startBackgroundProcess("Starting backup reconcile scheduler", ["run", "ops:backup-reconcile:scheduler"]);
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

  await runStep("Starting web application", ["run", "start:web"], {
    HOSTNAME: process.env.HOSTNAME || "0.0.0.0"
  });
} catch (error) {
  console.error(`[startup] ${error.message}`);
  console.error("[startup] Aborting startup because database migrations did not complete cleanly.");
  process.exit(1);
}