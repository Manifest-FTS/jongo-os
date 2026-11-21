// Run inside the deployed Jongo container with its existing Coolify credentials.
// Staging only: no deployment is triggered here. Never print compose or secrets.
const uuid = 'iodhibjd37x9rox2phx54g9f';
const image = 'wordpress:php8.3-apache@sha256:f3e6835fa7d4a5b786615c24b67ec70816e06ebd517d31276bef423e49dfd126';
const base = process.env.COOLIFY_API_BASE_URL.replace(/\/$/, '');
const headers = { Authorization: `Bearer ${process.env.COOLIFY_API_TOKEN}`, 'Content-Type': 'application/json' };
async function request(method, body) {
  const response = await fetch(`${base}/api/v1/services/${uuid}`, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error(`Coolify ${method} failed: HTTP ${response.status}`);
  return response.json();
}
(async () => {
  const service = await request('GET');
  if (service.name !== 'staging-gse' || service.applications?.length !== 1 ||
      service.applications[0].fqdn !== 'https://gse.staging.mfts.link') {
    throw new Error('Staging identity mismatch; refusing update.');
  }
  const raw = service.docker_compose_raw;
  const matches = raw.match(/^(\s*image:\s*)['"]?wordpress:latest['"]?\s*$/gm);
  if (matches?.length !== 1) throw new Error('Expected exactly one unmodified WordPress image.');
  const updated = raw.replace(/^(\s*image:\s*)['"]?wordpress:latest['"]?\s*$/m, `$1'${image}'`);
  await request('PATCH', { docker_compose_raw: Buffer.from(updated).toString('base64'), instant_deploy: false });
  const after = await request('GET');
  if (after.docker_compose_raw !== updated || after.applications[0].fqdn !== service.applications[0].fqdn) {
    throw new Error('Saved configuration did not match expected image-only change.');
  }
  console.log(JSON.stringify({ ok: true, uuid, image, deployed: false, domainUnchanged: true }));
})().catch(error => { console.error(error.message); process.exit(1); });