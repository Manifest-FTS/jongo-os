/**
 * Runs tests/db/*.test.mjs against a throwaway PostgreSQL cluster.
 *
 *   npm run test:db                    build, start a temp cluster, run the DB tests, always clean up
 *   node scripts/test-db.mjs --fail-after-start   rehearse cleanup: start, fail on purpose, verify cleanup
 *
 * The cluster lives in an os temp directory, listens on 127.0.0.1 on a random port, uses a random password and a
 * scrubbed environment (no DATABASE_URL, PG* variables, NODE_OPTIONS or application secrets are inherited).
 * PG_BIN overrides the binary directory; otherwise PostgreSQL 17 then 16 default locations are tried.
 * If no binaries are found the run FAILS, unless CRAFT_DB_TESTS_OPTIONAL=1, which prints a SKIPPED banner and exits 0.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const candidates = process.env.PG_BIN ? [process.env.PG_BIN]
  : win ? ['C:/Program Files/PostgreSQL/17/bin', 'C:/Program Files/PostgreSQL/16/bin'] : ['/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin'];
const exe = (dir, name) => join(dir, `${name}${win ? '.exe' : ''}`);
const exists = async path => { try { await access(path); return true; } catch { return false; } };

// Allowlist, never {...process.env}.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|systemroot|windir|comspec|pathext|temp|tmp|home|userprofile|localappdata|appdata|lang|lc_all)$/i.test(key)));
const password = randomBytes(32).toString('hex');
let bin, temp, data, port, started = false, cleanupPromise;

async function run(command, args) {
  return new Promise((accept, reject) => {
    const child = execFile(command, args, { cwd: temp ?? root, env, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return accept(stdout);
      const detail = String(stderr || error.code || 'unknown error').replaceAll(password, '[redacted]').trim();
      reject(new Error(`${command.split(/[\\/]/).at(-1)} failed: ${detail}`));
    });
    // Windows postgres inherits pg_ctl's pipes; release them when the controller exits.
    child.once('exit', () => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); });
  });
}
async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, accept); });
  const selected = server.address().port;
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return selected;
}
const portIsOpen = () => new Promise(accept => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(2000);
  socket.once('connect', () => { socket.destroy(); accept(true); });
  socket.once('error', () => { socket.destroy(); accept(false); });
  socket.once('timeout', () => { socket.destroy(); accept(true); });
});

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (!temp) return;
    // Only our own mkdtemp data directory is ever stopped: no service, port or process scan.
    if (started && await exists(join(data, 'postmaster.pid'))) {
      await run(exe(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']);
      assert.equal(await exists(join(data, 'postmaster.pid')), false, 'own PID file removed');
      assert.equal(await portIsOpen(), false, 'temporary listener stopped');
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    assert.equal(await exists(temp), false, 'temporary directory removed');
    console.log('cleanup: temporary cluster stopped and directory removed');
  })();
  return cleanupPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup().finally(() => process.exit(130)); });

let exitCode = 0;
try {
  for (const dir of candidates) {
    if (await exists(exe(dir, 'initdb')) && await exists(exe(dir, 'pg_ctl'))) { bin = dir; break; }
  }
  if (!bin) {
    const banner = '='.repeat(72);
    console.error(`${banner}\nPostgreSQL binaries (initdb, pg_ctl) not found in: ${candidates.join(', ')}\nDATABASE TESTS WERE NOT RUN. Set PG_BIN to a PostgreSQL 16/17 bin directory.\n${banner}`);
    if (process.env.CRAFT_DB_TESTS_OPTIONAL === '1') { console.error('SKIPPED (CRAFT_DB_TESTS_OPTIONAL=1): exiting 0.'); }
    else exitCode = 1;
  } else {
    temp = await mkdtemp(join(tmpdir(), 'craft-db-test-'));
    data = join(temp, 'data');
    port = await freePort();
    const pwfile = join(temp, 'pw');
    await writeFile(pwfile, password, { mode: 0o600 });
    await run(exe(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=scram-sha-256', '--pwfile', pwfile, '--encoding=UTF8', '--no-locale']);
    await rm(pwfile);
    started = true;
    await run(exe(bin, 'pg_ctl'), ['-D', data, '-l', join(temp, 'postgres.log'), '-w', '-t', '30',
      '-o', `-h 127.0.0.1 -p ${port} -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200${win ? '' : ` -k "${temp}"`}`, 'start']);
    console.log(`Isolated PostgreSQL on 127.0.0.1:${port} (${bin})`);
    if (process.argv.includes('--fail-after-start')) throw new Error('Intentional cleanup rehearsal');

    const dir = join(root, 'tests', 'db');
    const files = (await readdir(dir)).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(dir, name));
    if (!files.length) throw new Error('No tests/db/*.test.mjs files found');
    const code = await new Promise(accept => {
      const child = spawn(process.execPath, ['--test', '--test-concurrency=4', ...files], {
        cwd: root, stdio: 'inherit', windowsHide: true,
        env: { ...env, CRAFT_TEST_PG_HOST: '127.0.0.1', CRAFT_TEST_PG_PORT: String(port), CRAFT_TEST_PG_USER: 'postgres', CRAFT_TEST_PG_PASSWORD: password }
      });
      child.once('error', () => accept(1));
      child.once('close', status => accept(status ?? 1));
    });
    exitCode = code;
  }
} catch (error) {
  exitCode = 1;
  console.error(String(error?.message ?? error).replaceAll(password, '[redacted]'));
} finally {
  try { await cleanup(); } catch (error) { exitCode = 1; console.error(`CLEANUP FAILED: ${String(error?.message ?? error).replaceAll(password, '[redacted]')}`); }
}
process.exit(exitCode);
