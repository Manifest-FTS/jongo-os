import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const action = process.argv[2];
const directory = join(process.env.LOCALAPPDATA || homedir(), "jongo-os", "TSK-01088-local-db");
const data = join(directory, "data");
const bin = process.env.PG_BIN || "C:/Program Files/PostgreSQL/17/bin";
try {
  if (!["start", "stop", "status"].includes(action)) throw new Error("Choose start, stop or status.");
  await access(join(data, "PG_VERSION"));
  const args = ["-D", data];
  if (action === "start") args.push("-l", join(directory, "postgres.log"), "-w", "-t", "30", "-o", "-h 127.0.0.1 -p 15433");
  if (action === "stop") args.push("-m", "fast", "-w");
  args.push(action);
  await new Promise((accept, reject) => {
    const child = execFile(join(bin, `pg_ctl${process.platform === "win32" ? ".exe" : ""}`), args, { windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error("Local database operation failed; check whether the cluster is running and port 15433 is free."));
      else { console.log(stdout.trim()); accept(); }
    });
    child.once("exit", () => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); });
  });
} catch (error) {
  console.error(error.code === "ENOENT" ? "Local cluster or PostgreSQL binaries missing; run local database setup first." : error.message);
  process.exitCode = 1;
}