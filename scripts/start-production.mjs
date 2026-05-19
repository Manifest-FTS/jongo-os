import { spawn } from "node:child_process";

const npmCommand = "npm";
let activeChild = null;

function log(message) {
  console.log(`[startup] ${message}`);
}

function forwardSignal(signal) {
  if (activeChild && !activeChild.killed) {
    activeChild.kill(signal);
  }
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

  await runStep("Starting web application", ["run", "start:web"], {
    HOSTNAME: process.env.HOSTNAME || "0.0.0.0"
  });
} catch (error) {
  console.error(`[startup] ${error.message}`);
  console.error("[startup] Aborting startup because database migrations did not complete cleanly.");
  process.exit(1);
}