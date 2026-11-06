/**
 * Validates the "Sign in with Jongo" migration against a THROWAWAY PostgreSQL cluster and runs the DB integration test.
 *
 *   node scripts/test-oidc-db.mjs
 *
 * 1. start a temp cluster (random loopback port, random password, temp dir, scrubbed env, always cleaned up)
 * 2. `prisma migrate deploy` every migration EXCEPT the OIDC one, snapshot all pre-existing schema objects
 * 3. `prisma migrate deploy` with the OIDC migration, snapshot again: the pre-existing objects must be identical
 * 4. `prisma migrate diff` database vs schema.prisma (drift check), `prisma generate`
 * 5. run apps/web/src/lib/oidc/oidc-db.integration.test.ts against the temp cluster
 *
 * DATABASE_URL is set only in the environment of those child processes, and only ever to the temp cluster.
 * Nothing reads .env files or uses the network. PG_BIN overrides the PostgreSQL bin directory (16/17 default paths).
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const MIGRATION = "20261106120000_oidc_provider_site_craft_access";
const NEW_TABLES = ["OidcClient", "OidcAuthCode", "OidcConsent", "SiteCraftAccess"];
const NEW_ENUMS = ["OidcClientStatus", "SiteCraftRole"];
const candidates = process.env.PG_BIN ? [process.env.PG_BIN]
  : win ? ["C:/Program Files/PostgreSQL/17/bin", "C:/Program Files/PostgreSQL/16/bin"] : ["/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin"];
const exe = (dir, name) => join(dir, `${name}${win ? ".exe" : ""}`);
const exists = async path => { try { await access(path); return true; } catch { return false; } };

const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|systemroot|windir|comspec|pathext|temp|tmp|home|userprofile|localappdata|appdata|lang|lc_all)$/i.test(key)));
// No Prisma update check / telemetry call.
Object.assign(baseEnv, { CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" });
const password = randomBytes(24).toString("hex");
let bin, temp, data, port, started = false, cleanupPromise;

const redact = text => String(text).replaceAll(password, "[redacted]");

function run(command, args, { env = baseEnv, cwd = temp ?? root, allowFail = false } = {}) {
  return new Promise((accept, reject) => {
    const child = execFile(command, args, { cwd, env, windowsHide: true, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error || allowFail) return accept({ stdout: redact(stdout), stderr: redact(stderr), code: error?.code ?? 0 });
      reject(new Error(`${command.split(/[\\/]/).at(-1)} ${args.slice(0, 2).join(" ")} failed: ${redact(stderr || stdout || error.code)}`.trim()));
    });
    child.once("exit", () => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); });
  });
}
async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, accept); });
  const selected = server.address().port;
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return selected;
}
const portIsOpen = () => new Promise(accept => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(2000);
  socket.once("connect", () => { socket.destroy(); accept(true); });
  socket.once("error", () => { socket.destroy(); accept(false); });
  socket.once("timeout", () => { socket.destroy(); accept(true); });
});

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (!temp) return;
    // Only our own mkdtemp data directory is ever stopped: no service, port or process scan.
    if (started && await exists(join(data, "postmaster.pid"))) {
      await run(exe(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"], { cwd: root });
      assert.equal(await exists(join(data, "postmaster.pid")), false, "own PID file removed");
      assert.equal(await portIsOpen(), false, "temporary listener stopped");
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    assert.equal(await exists(temp), false, "temporary directory removed");
    console.log("cleanup: temporary cluster stopped and directory removed");
  })();
  return cleanupPromise;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cleanup().finally(() => process.exit(130)); });

const quoted = names => names.map(name => `'${name}'`).join(",");
// Every fact about pre-existing objects that a DROP/ALTER could change.
const snapshotSql = `
SELECT 'col|'||table_name||'|'||column_name||'|'||data_type||'|'||udt_name||'|'||is_nullable||'|'||coalesce(column_default,'')
  FROM information_schema.columns WHERE table_schema='public' AND table_name NOT IN (${quoted(NEW_TABLES)})
UNION ALL SELECT 'con|'||c.relname||'|'||k.conname||'|'||pg_get_constraintdef(k.oid)
  FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE k.connamespace='public'::regnamespace AND c.relname NOT IN (${quoted(NEW_TABLES)})
UNION ALL SELECT 'idx|'||tablename||'|'||indexdef FROM pg_indexes WHERE schemaname='public' AND tablename NOT IN (${quoted(NEW_TABLES)})
UNION ALL SELECT 'trg|'||event_object_table||'|'||trigger_name||'|'||action_statement FROM information_schema.triggers
  WHERE trigger_schema='public' AND event_object_table NOT IN (${quoted(NEW_TABLES)})
UNION ALL SELECT 'enum|'||t.typname||'|'||string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
  FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typname NOT IN (${quoted(NEW_ENUMS)}) GROUP BY t.typname
UNION ALL SELECT 'rel|'||c.relname||'|'||c.relkind::text FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname NOT IN (${quoted(NEW_TABLES)})
  AND c.relname NOT LIKE 'Oidc%' AND c.relname NOT LIKE 'SiteCraftAccess%' AND c.relname NOT LIKE '%Oidc%'
ORDER BY 1`;

let exitCode = 0;
try {
  for (const dir of candidates) if (await exists(exe(dir, "initdb")) && await exists(exe(dir, "pg_ctl"))) { bin = dir; break; }
  if (!bin) throw new Error(`PostgreSQL binaries not found in: ${candidates.join(", ")} (set PG_BIN). DATABASE TESTS WERE NOT RUN.`);

  temp = await mkdtemp(join(tmpdir(), "oidc-db-test-"));
  data = join(temp, "data");
  port = await freePort();
  const pwfile = join(temp, "pw");
  await writeFile(pwfile, password, { mode: 0o600 });
  await run(exe(bin, "initdb"), ["-D", data, "-U", "postgres", "--auth=scram-sha-256", "--pwfile", pwfile, "--encoding=UTF8", "--no-locale"]);
  await rm(pwfile);
  started = true;
  await run(exe(bin, "pg_ctl"), ["-D", data, "-l", join(temp, "postgres.log"), "-w", "-t", "30",
    "-o", `-h 127.0.0.1 -p ${port} -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200${win ? "" : ` -k "${temp}"`}`, "start"]);
  console.log(`Isolated PostgreSQL on 127.0.0.1:${port} (${bin})`);

  const pgEnv = { ...baseEnv, PGPASSWORD: password };
  const psql = (args) => run(exe(bin, "psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-At", ...args], { env: pgEnv });
  await psql(["-d", "postgres", "-c", "CREATE DATABASE oidc_test"]);
  const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/oidc_test?schema=public`;
  const prismaEnv = { ...baseEnv, DATABASE_URL: databaseUrl };
  const prismaCli = join(root, "node_modules", "prisma", "build", "index.js");
  const prisma = (args, options = {}) => run(process.execPath, [prismaCli, ...args], { env: prismaEnv, ...options });
  const snapshot = async () => (await psql(["-d", "oidc_test", "-c", snapshotSql])).stdout.trim().split(/\r?\n/).filter(Boolean);

  // Stage 1: everything that existed before this change.
  const stage = join(temp, "stage", "prisma");
  await cp(join(root, "prisma"), stage, { recursive: true, filter: source => !source.includes(MIGRATION) });
  assert.equal(await exists(join(stage, "migrations", MIGRATION)), false, "stage excludes the OIDC migration");
  const stage1 = await prisma(["migrate", "deploy", "--schema", join(stage, "schema.prisma")]);
  console.log(stage1.stdout.trim().split(/\r?\n/).slice(-2).join("\n"));
  const before = await snapshot();
  assert.ok(before.length > 100, `pre-existing schema snapshot has content (${before.length} facts)`);

  // Stage 2: the real migrations directory, now including the OIDC migration.
  const stage2 = await prisma(["migrate", "deploy", "--schema", join(root, "prisma", "schema.prisma")]);
  console.log(stage2.stdout.trim().split(/\r?\n/).slice(-3).join("\n"));
  assert.match(stage2.stdout, new RegExp(`${MIGRATION}`), "the OIDC migration was applied");
  const after = await snapshot();
  assert.deepEqual(after, before, "pre-existing schema objects changed");
  console.log(`OK: ${before.length} facts about pre-existing tables/columns/constraints/indexes/triggers/enums are identical before and after the OIDC migration`);

  const tables = (await psql(["-d", "oidc_test", "-c", `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN (${quoted(NEW_TABLES)}) ORDER BY 1`])).stdout.trim().split(/\r?\n/);
  assert.deepEqual(tables, [...NEW_TABLES].sort(), "new tables exist");
  const status = await prisma(["migrate", "status", "--schema", join(root, "prisma", "schema.prisma")], { allowFail: true });
  assert.match(status.stdout, /Database schema is up to date/, "migrate status is up to date");

  // Drift: the new objects must match schema.prisma. Older drift on pre-existing tables is reported, not ours to fix here.
  const drift = await prisma(["migrate", "diff", "--from-url", databaseUrl, "--to-schema-datamodel", join(root, "prisma", "schema.prisma"), "--script"], { allowFail: true });
  const statements = drift.stdout.split(/\r?\n\r?\n/).map(part => part.trim()).filter(part => part && !part.startsWith("-- This is an empty migration"));
  const ours = statements.filter(part => /Oidc|SiteCraftAccess/.test(part));
  console.log(`schema.prisma drift: ${statements.length} statement(s) on pre-existing objects (informational, not touched by this change), ${ours.length} on the new objects`);
  assert.deepEqual(ours, [], "the new tables/enums/indexes match schema.prisma exactly");
  console.log("OK: migrated database matches schema.prisma for every new object (the partial unique index is invisible to Prisma, as intended)");

  const generated = await prisma(["generate", "--schema", join(root, "prisma", "schema.prisma")], { cwd: root });
  assert.match(generated.stdout + generated.stderr, /Generated Prisma Client/, "prisma generate succeeded");
  console.log("OK: prisma generate");

  // Integration test.
  const web = join(root, "apps", "web");
  const code = await new Promise(accept => {
    const child = spawn(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "src/lib/oidc/oidc-db.integration.test.ts"], {
      cwd: web, stdio: "inherit", windowsHide: true, env: { ...baseEnv, OIDC_TEST_DATABASE_URL: databaseUrl }
    });
    child.once("error", () => accept(1));
    child.once("close", status => accept(status ?? 1));
  });
  exitCode = code;
} catch (error) {
  exitCode = 1;
  console.error(redact(error?.stack ?? error?.message ?? error));
} finally {
  try { await cleanup(); } catch (error) { exitCode = 1; console.error(`CLEANUP FAILED: ${redact(error?.message ?? error)}`); }
}
process.exit(exitCode);
