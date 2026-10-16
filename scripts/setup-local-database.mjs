/** Explicit isolated development setup; never connects to an existing database. */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdir, writeFile, unlink, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "apps/web/package.json"));
const nextRequire = createRequire(webRequire.resolve("next/package.json"));
nextRequire("@next/env").loadEnvConfig(join(root, "apps/web"), true);
const bin = process.env.PG_BIN || "C:/Program Files/PostgreSQL/17/bin";
const pg = (name) => join(bin, `${name}${process.platform === "win32" ? ".exe" : ""}`);
const directory = join(process.env.LOCALAPPDATA || homedir(), "jongo-os", "TSK-01088-local-db");
const data = join(directory, "data");
const pwFile = join(directory, "init-password");
let client;
let started = false;

async function run(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = execFile(command, args, { cwd: directory, windowsHide: true, ...options }, (error, stdout) => {
      if (error) reject(new Error("Local database command failed; inspect the local PostgreSQL log."));
      else accept(stdout);
    });
    if (command === pg("pg_ctl")) child.once("exit", () => {
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    });
  });
}

try {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing production mode.");
  const url = new URL(process.env.DATABASE_URL || "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "15433" || url.pathname !== "/postgres") {
    throw new Error("This setup requires the existing localhost:15433/postgres development URL.");
  }
  const email = process.env.DEV_AUTH_EMAIL?.trim().toLowerCase();
  const password = process.env.DEV_AUTH_PASSWORD;
  if (!email || !password || !url.username || !url.password) throw new Error("Local database and DEV_AUTH settings are required.");
  // Refuse occupied ports: this must not migrate a tunnel or unrelated server.
  const server = createServer();
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(15433, "127.0.0.1", accept); });
  await new Promise((accept) => server.close(accept));
  try { await access(join(data, "PG_VERSION")); throw new Error("Local cluster already exists; start it rather than recreating it."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(directory, { recursive: true });
  await writeFile(pwFile, decodeURIComponent(url.password), { mode: 0o600 });
  try {
    await run(pg("initdb"), ["-D", data, "-U", decodeURIComponent(url.username), "--auth=scram-sha-256", `--pwfile=${pwFile}`, "--encoding=UTF8", "--no-locale"]);
  } finally { await unlink(pwFile).catch(() => {}); }
  await run(pg("pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "-t", "30", "-o", "-h 127.0.0.1 -p 15433", "start"]);
  started = true;
  const { PrismaClient } = webRequire("@prisma/client");
  client = new PrismaClient({ log: [] });
  const rows = await client.$queryRaw`SHOW data_directory`;
  if (resolve(rows[0].data_directory).toLowerCase() !== resolve(data).toLowerCase()) throw new Error("Local cluster identity mismatch.");
  // Fresh disposable development schema only. Never use db push on production.
  const prisma = createRequire(join(root, "package.json")).resolve("prisma/build/index.js");
  await run(process.execPath, [prisma, "db", "push", "--schema", join(root, "prisma/schema.prisma"), "--skip-generate"], {
    env: { ...process.env, DATABASE_URL: url.toString() }
  });
  const { hash } = webRequire("bcryptjs");
  await client.user.create({ data: {
    email, passwordHash: await hash(password, 12), fullName: "Local Development", emailVerified: true,
    role: email === "devkev@manifestfts.com" ? "super_admin" : "collaborator"
  } });
  console.log("Isolated local database ready at localhost:15433; local dev account created. No production data copied.");
  console.log(`Cluster directory: ${data}`);
} catch (error) {
  console.error(error.code === "EADDRINUSE" ? "Port 15433 is occupied; stop the database tunnel before setup." : error.message);
  if (started) await run(pg("pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]).catch(() => {});
  process.exitCode = 1;
} finally {
  await client?.$disconnect();
}