// Executed inside Jongo; credentials stay in its environment. stdout is captured
// into root-only recovery files by the rollout, never printed to the terminal.
const fs = require('node:fs');
const image = 'wordpress:php8.3-apache@sha256:f3e6835fa7d4a5b786615c24b67ec70816e06ebd517d31276bef423e49dfd126';
(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!/^[a-z0-9]{24}$/.test(input.uuid)) throw Error('Invalid service UUID');
  const base = process.env.COOLIFY_API_BASE_URL.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${process.env.COOLIFY_API_TOKEN}`, 'Content-Type': 'application/json' };
  async function req(method, body) {
    const r = await fetch(`${base}/api/v1/services/${input.uuid}`, {
      method, headers, ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!r.ok) throw Error(`Coolify ${method} HTTP ${r.status}`);
    return r.json();
  }
  const before = await req('GET');
  if (!before.applications?.some(a => a.name === 'wordpress')) throw Error('Not a WordPress service');
  if (input.action === 'read') { console.log(JSON.stringify(before)); return; }
  if (input.expectedRaw !== before.docker_compose_raw) throw Error('Concurrent compose change; refusing');
  let raw;
  if (input.action === 'pin') {
    const pattern = /^(\s*image:\s*)['"]?(?:docker\.io\/library\/)?wordpress:[^\s'"#]+['"]?[ \t]*$/gm;
    if (before.docker_compose_raw.match(pattern)?.length !== 1) throw Error('Expected one official WordPress image');
    raw = before.docker_compose_raw.replace(pattern, `$1'${image}'`);
  } else if (input.action === 'restore' && typeof input.restoreRaw === 'string') {
    raw = input.restoreRaw;
  } else throw Error('Unsupported action');
  await req('PATCH', { docker_compose_raw: Buffer.from(raw).toString('base64'), instant_deploy: false });
  const after = await req('GET');
  if (after.docker_compose_raw !== raw) throw Error('Saved compose mismatch');
  const domains = x => JSON.stringify(x.applications.map(a => [a.name, a.fqdn]).sort());
  if (domains(before) !== domains(after)) throw Error('Unexpected domain change');
  console.log(JSON.stringify(after));
})().catch(e => { console.error(e.message); process.exit(1); });