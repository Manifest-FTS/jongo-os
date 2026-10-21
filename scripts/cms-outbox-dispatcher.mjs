/** CMS outbox dispatcher worker. Opt-in: CMS_OUTBOX_DISPATCH_ENABLED=true (default off).
 * `--once` runs one pass; otherwise loops. No dotenv: uses the process environment only.
 * Never logs secrets, URLs, DB errors or payloads; the DB lease handles replicas. */
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const INTERVAL_MS = 15_000;

/** Transpiles the single dependency-free server module with the installed compiler. */
export function loadDispatcher() {
  const ts = require('typescript');
  const file = join(root, 'apps/web/src/lib/cms/outbox-dispatcher.ts');
  const output = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const module = new Module(file);
  module.filename = file;
  module.paths = Module._nodeModulePaths(dirname(file));
  module._compile(output, file);
  return module.exports;
}

export async function dispatchOnce(db, dispatcher = loadDispatcher(), options = {}) {
  const summary = await dispatcher.dispatchOutboxOnce(dispatcher.createPostgresOutboxStore(db), { log: line => console.log(line), ...options });
  const { claimed, delivered, retried, deadLettered, leaseLost } = summary;
  console.log(`[cms-outbox] claimed=${claimed} delivered=${delivered} retried=${retried} deadLettered=${deadLettered} leaseLost=${leaseLost}`);
  return summary;
}

export async function runDispatcher({ once = false } = {}) {
  const dispatcher = loadDispatcher();
  if (!dispatcher.dispatchEnabled(process.env)) {
    console.log('[cms-outbox] Disabled; set CMS_OUTBOX_DISPATCH_ENABLED=true to dispatch.');
    return;
  }
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ log: [] });
  let stopped = false, wake = null;
  const stop = () => { stopped = true; wake?.(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (once) { await dispatchOnce(db, dispatcher); return; }
    while (!stopped) {
      let full = false;
      try { full = (await dispatchOnce(db, dispatcher)).claimed >= dispatcher.DEFAULT_BATCH_SIZE; }
      catch { console.error('[cms-outbox] Dispatch pass failed; check database connectivity and configuration.'); }
      // Drain backlogs immediately; otherwise wait (sequential passes never overlap locally).
      if (!full && !stopped) await new Promise(ok => { wake = ok; setTimeout(ok, INTERVAL_MS); });
    }
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runDispatcher({ once: process.argv.includes('--once') });
  } catch {
    console.error('[cms-outbox] Cannot run dispatcher; verify database and target configuration.');
    process.exitCode = 1;
  }
}
