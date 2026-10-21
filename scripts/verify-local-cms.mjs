import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run verify:local.');
// No dotenv, configured database writes, migrations or external provider calls.
run(process.execPath, [npm, 'run', 'type-check']);
run(process.execPath, [npm, 'run', 'test']);
run(process.execPath, ['scripts/test-cms-migration.mjs']);
run(process.execPath, ['scripts/test-cms-marketing-delivery.mjs']);
console.log('Local CMS checks passed. Configured databases were not migrated.');