import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const SPECIFIER = /(?:^|[\s;}])(?:import|export)\s*(?:[^'"()]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
function specifiers(file) {
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...source.matchAll(SPECIFIER)].map(match => match[1] ?? match[2]);
}
/** Every package and relative file reachable from the entry through static or dynamic imports. */
function graph(entry) {
  const files = new Set(), external = new Set(), queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!file.endsWith('.js')) continue;
    for (const specifier of specifiers(file)) {
      if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
      else external.add(specifier);
    }
  }
  return { files, external };
}
const clientTargets = () => Object.entries(pkg.exports).filter(([name]) => !name.startsWith('./server') && name !== './auth' && name !== './styles.css' && name !== './studio.css')
  .map(([name, target]) => [name, resolve(root, target.import)]);

test('the build produced every export target', () => {
  for (const [name, target] of Object.entries(pkg.exports)) {
    const file = typeof target === 'string' ? target : target.import;
    assert.ok(existsSync(resolve(root, file)), `${name} -> ${file}`);
    if (typeof target !== 'string') assert.ok(existsSync(resolve(root, target.types)), `${name} types`);
  }
});

test('client entries (@jongo/craft, ./content, ./golf-lab, ./logic) never reach the server subpath, pg, groq-js or Node built-ins', () => {
  const forbidden = specifier => /^(pg|groq-js)(\/|$)/.test(specifier) || specifier.startsWith('node:') || /^(fs|path|crypto|net|os|child_process|util|url)$/.test(specifier);
  const entries = clientTargets();
  assert.ok(entries.length >= 4, 'client entries found');
  // Positive controls: the scanner really sees imports.
  assert.ok(graph(resolve(root, pkg.exports['.'].import)).external.has('react/jsx-runtime') || graph(resolve(root, pkg.exports['.'].import)).external.has('react'));
  assert.ok(graph(join(dist, 'server', 'index.js')).external.has('node:crypto'));
  assert.ok(graph(join(dist, 'server', 'query', 'groq.js')).files.size >= 2);
  for (const [name, entry] of entries) {
    const { files, external } = graph(entry);
    for (const file of files) assert.ok(!file.startsWith(join(dist, 'server')) && !file.startsWith(join(dist, 'auth')), `${name} imports server file ${file}`);
    for (const specifier of external) assert.ok(!forbidden(specifier), `${name} imports ${specifier}`);
    assert.ok(!external.has('@jongo/craft/server') && !external.has('@jongo/craft/auth') && !external.has('jose'));
  }
});

test('the server graph is where the Node-only imports live, and it never imports React or UI modules', () => {
  const { files, external } = graph(join(dist, 'server', 'index.js'));
  assert.ok([...files].some(f => f.endsWith(join('server', 'migrate.js'))));
  for (const specifier of external) assert.ok(!/^react/.test(specifier), specifier);
  const shared = ['schema.js', 'content-ops.js', 'validate.js', 'portable-text.js', 'media-contract.js'].map(name => join(dist, name));
  for (const file of files) assert.ok(file.startsWith(join(dist, 'server')) || shared.includes(file), `unexpected module in the server graph: ${file}`);
  // Optional peers are never imported statically: groq-js is dynamic, pg is not imported at all.
  assert.ok(![...files].some(file => /\bimport\s+[^(]*from\s*["']pg["']|\bimport\s+[^(]*from\s*["']groq-js["']/.test(readFileSync(file, 'utf8'))));
  assert.ok(!external.has('pg'));
});

test('package.json: ./server and ./auth exports, optional peers, shipped migrations, preview.23', () => {
  assert.equal(pkg.version, '0.1.0-preview.23');
  assert.equal(pkg.engines.node, '>=22.12');
  assert.deepEqual(pkg.exports['./server'], { types: './dist/server/index.d.ts', import: './dist/server/index.js' });
  assert.deepEqual(pkg.exports['./auth'], { types: './dist/auth/index.d.ts', import: './dist/auth/index.js' });
  assert.ok(pkg.files.includes('migrations') && pkg.files.includes('dist'));
  for (const name of ['pg', 'groq-js', 'jose']) {
    assert.ok(pkg.peerDependencies[name], `${name} peer`);
    assert.equal(pkg.peerDependenciesMeta[name].optional, true, `${name} optional`);
    assert.ok(pkg.devDependencies[name], `${name} dev dependency`);
    assert.equal(pkg.dependencies?.[name], undefined, `${name} is not a hard dependency`);
  }
  assert.ok(pkg.peerDependencies.react, 'UI peers unchanged');
  assert.equal(pkg.scripts['test:db'].includes('test-db.mjs'), true);
  assert.ok(!/test-db|tests\/db/.test(pkg.scripts.test), 'npm test stays independent of PostgreSQL');
});

test('migrations are real, ordered, numbered files next to the package root', () => {
  const names = readdirSync(join(root, 'migrations'));
  assert.deepEqual(names, ['0001_init.sql', '0002_sso_actors_revocations.sql']);
  for (const name of names) {
    const sql = readFileSync(join(root, 'migrations', name), 'utf8');
    assert.ok(!/\b(BEGIN|COMMIT)\b\s*;/i.test(sql), 'the runner owns the transaction');
    assert.ok(!/\b(organization|stripe|subscription|entitlement|tenant)\b/i.test(sql.replace(/--.*$/gm, '')), 'no SaaS concepts in the schema');
    for (const statement of sql.match(/CREATE TABLE [^\s(]+/g)) assert.match(statement, /CREATE TABLE craft\./);
  }
  // 0002 is additive: it never alters or drops anything that 0001 created.
  const second = readFileSync(join(root, 'migrations', names[1]), 'utf8').replace(/--.*$/gm, '');
  assert.ok(!/\b(ALTER|DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(second), '0002 only creates');
});

test('./auth is server-only: Node crypto and a lazily imported jose, no React, UI, database, server subpath or client entry', () => {
  const entry = join(dist, 'auth', 'index.js');
  const { files, external } = graph(entry);
  assert.ok(external.has('node:crypto'), 'the scanner sees the crypto import');
  assert.ok([...files].some(file => file.endsWith(join('auth', 'login.js'))));
  for (const file of files) assert.ok(file.startsWith(join(dist, 'auth')), `unexpected module in the auth graph: ${file}`);
  for (const specifier of external) assert.ok(/^node:/.test(specifier) || specifier === 'jose', `unexpected import in the auth graph: ${specifier}`);
  // jose is an optional peer: imported dynamically inside the verifier only.
  const login = readFileSync(join(dist, 'auth', 'login.js'), 'utf8');
  assert.ok(/import\(\s*['"]jose['"]\s*\)/.test(login));
  for (const file of files) assert.ok(!/\bimport\s+[^(]*from\s*["']jose["']/.test(readFileSync(file, 'utf8')), `static jose import in ${file}`);
  // Nothing in the auth graph logs.
  for (const file of files) assert.ok(!/\bconsole\./.test(readFileSync(file, 'utf8')), `console use in ${file}`);
  // No client entry reaches it (also asserted per entry above).
  for (const [name, target] of clientTargets()) assert.ok(![...graph(target).files].some(file => file.startsWith(join(dist, 'auth'))), name);
});
