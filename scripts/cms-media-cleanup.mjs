/** Durable CMS media cleanup worker. Provider use is opt-in and requires both B2/S3 and Cloudflare config. */
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const INTERVAL_MS = 15_000;

function loadCleanup() {
  const ts = require('typescript');
  require.extensions['.ts'] = (module, filename) => {
    if (!filename.startsWith(join(root, 'apps/web/src/lib/cms') + require('node:path').sep)) throw new Error('Unexpected TypeScript module.');
    const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText;
    module._compile(output, filename);
  };
  const file = join(root, 'apps/web/src/lib/cms/media-cleanup.ts');
  return require(file);
}

export async function runCleanup({ once = false } = {}) {
  if (process.env.CMS_MEDIA_CLEANUP_ENABLED !== 'true') {
    console.log('[cms-media-cleanup] Disabled; set CMS_MEDIA_CLEANUP_ENABLED=true to run.');
    return;
  }
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ log: [] });
  const cleanup = loadCleanup();
  let stopped = false, wake = null;
  const stop = () => { stopped = true; wake?.(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    do {
      let summary = { claimed: 0, completed: 0, retried: 0 };
      try { summary = await cleanup.dispatchMediaCleanupOnce(db); }
      catch { console.error('[cms-media-cleanup] Pass failed; pending jobs remain retryable.'); }
      console.log(`[cms-media-cleanup] claimed=${summary.claimed} completed=${summary.completed} retried=${summary.retried}`);
      if (once || stopped) break;
      await new Promise(ok => { wake = ok; setTimeout(ok, INTERVAL_MS); });
    } while (!stopped);
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runCleanup({ once: process.argv.includes('--once') }); }
  catch { console.error('[cms-media-cleanup] Cannot run; verify database and operator configuration.'); process.exitCode = 1; }
}
