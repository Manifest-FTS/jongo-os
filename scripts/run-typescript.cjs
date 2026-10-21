/** Local TS launcher using the already-installed compiler, not a new dependency.
 * Only repository TS files are compiled; source data is NEVER required/imported.
 * Does not load .env files. Node >=18.18 (matching the web runtime). */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const entry = path.resolve(root, process.argv[2] || '');
const entries = ['import-sanity-ndjson.ts', 'publish-marketing-release.ts'].map(name => path.join(__dirname, name));
if (!entries.includes(entry)) {
  console.error('Only the Sanity importer and marketing release entry points are supported.');
  process.exit(1);
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...args) {
  if (request.startsWith('@/')) request = path.join(root, 'apps/web/src', request.slice(2));
  return originalResolve.call(this, request, parent, ...args);
};
require.extensions['.ts'] = function(module, filename) {
  if (!filename.startsWith(root + path.sep) || filename.includes(path.sep + 'node_modules' + path.sep)) throw new Error('Unsupported TypeScript module.');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  });
  module._compile(output.outputText, filename);
};
process.argv = [process.argv[0], entry, ...process.argv.slice(3)];
// _load is needed so the imported TS entry observes require.main === module.
Module._load(entry, null, true);