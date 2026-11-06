import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { CRAFT_ROLES, CraftAuthError, completeLogin, createAuthCaches, createLoginTransaction, discover, isCraftRole, mapRoleToActions, openTransaction, sealTransaction } from '../dist/auth/index.js';
import { startMockIdp } from './helpers/mock-idp.mjs';

const SECRET = 'site-session-secret-'.padEnd(48, 's');
const REDIRECT = 'https://site.example.test/craft/auth/callback';
const idps = [];
after(async () => { await Promise.all(idps.map(idp => idp.close())); });

async function world({ clientSecret = 'sekret-' + 'q'.repeat(20), cache = {}, ...extra } = {}) {
  const idp = await startMockIdp({ clientSecret, redirectUris: [REDIRECT], ...extra });
  idps.push(idp);
  const config = { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, redirectUri: REDIRECT, dataset: 'production', secret: SECRET };
  const caches = createAuthCaches(cache);
  return { idp, config, caches };
}

/** Start -> authorize at the mock -> callback query, like a browser. Returns everything a test may want to tamper with. */
async function begin(w, deps = {}) {
  const tx = await createLoginTransaction({ config: w.config, caches: w.caches, ...deps });
  const callback = await w.idp.authorizeRedirect(tx.authorizeUrl);
  return { tx, callback };
}
const finish = (w, step, overrides = {}) => completeLogin({ transactionCookie: step.tx.cookieValue, query: step.callback.searchParams, config: w.config, caches: w.caches, ...overrides });
const login = async (w, deps = {}) => finish(w, await begin(w, deps), deps);

async function rejects(w, promise, code, extraSecrets = []) {
  let caught;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught instanceof CraftAuthError, `expected CraftAuthError(${code}), got ${caught?.name}: ${caught?.message}`);
  assert.equal(caught.code, code);
  const text = `${caught.message} ${caught.stack ?? ''} ${JSON.stringify(caught)}`;
  for (const secret of [w.idp.clientSecret, SECRET, ...extraSecrets]) assert.ok(!text.includes(secret), 'no secret in the error');
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(text), 'no token-like text in the error');
  return caught;
}

test('success: the full flow returns the verified identity', async () => {
  const w = await world();
  const step = await begin(w);
  const identity = await finish(w, step);
  assert.deepEqual({ ...identity, authTime: typeof identity.authTime }, {
    sub: w.idp.user.sub, email: 'editor@example.test', emailVerified: true, name: 'Ada Editor', dataset: 'production', role: 'publisher', via: 'site_grant', siteId: 'site-1', authTime: 'number'
  });
  // The authorize URL carries a standards-conformant request and nothing secret.
  const url = new URL(step.tx.authorizeUrl);
  assert.equal(url.origin + url.pathname, `${w.idp.origin}/oidc/authorize`);
  assert.deepEqual([url.searchParams.get('response_type'), url.searchParams.get('client_id'), url.searchParams.get('redirect_uri'), url.searchParams.get('scope'), url.searchParams.get('code_challenge_method')], ['code', w.idp.clientId, REDIRECT, 'openid email profile', 'S256']);
  assert.ok(!step.tx.authorizeUrl.includes(w.idp.clientSecret) && !step.tx.authorizeUrl.includes(SECRET));
  assert.equal(step.tx.maxAgeSeconds, 600);
  // PKCE: the challenge is S256 of a verifier that only the sealed cookie holds, and the token request sent that verifier.
  const payload = openTransaction(SECRET, step.tx.cookieValue);
  assert.ok(payload && payload.verifier.length >= 43);
  assert.ok(!step.tx.cookieValue.includes(payload.verifier) && !step.tx.cookieValue.includes(payload.state), 'the cookie is encrypted, not just signed');
  assert.equal(w.idp.lastToken.form.code_verifier, payload.verifier);
  assert.equal(w.idp.lastToken.form.grant_type, 'authorization_code');
  assert.equal(w.idp.lastToken.form.redirect_uri, REDIRECT);
  assert.equal(w.idp.lastToken.contentType, 'application/x-www-form-urlencoded');
  assert.match(w.idp.lastToken.authorization, /^Basic /);
  assert.equal(w.idp.lastToken.form.client_secret, undefined, 'client_secret_basic keeps the secret out of the body');
});

test('client authentication: basic form-encodes odd secrets; post sends them in the body; a wrong secret fails', async () => {
  const odd = await world({ clientSecret: 'a:b+c%d e/é' });
  assert.equal((await login(odd)).role, 'publisher');
  const post = await world();
  post.config.clientAuth = 'client_secret_post';
  await login(post);
  assert.equal(post.idp.lastToken.authorization, null);
  assert.equal(post.idp.lastToken.form.client_secret, post.idp.clientSecret);
  const wrong = await world();
  wrong.config.clientSecret = 'not-the-secret';
  await rejects(wrong, login(wrong), 'token_exchange_failed', ['not-the-secret']);
});

test('a replayed callback fails: the cookie is gone, and the authorization code cannot be used twice', async () => {
  const w = await world();
  const step = await begin(w);
  await finish(w, step);
  await rejects(w, finish(w, step, { transactionCookie: undefined }), 'transaction_invalid');
  await rejects(w, finish(w, step, { transactionCookie: '' }), 'transaction_invalid');
  await rejects(w, finish(w, step), 'token_exchange_failed');
});

test('state: tampered, missing, repeated or foreign values are refused', async () => {
  const w = await world();
  const step = await begin(w);
  const query = name => { const q = new URLSearchParams(step.callback.searchParams); name(q); return q; };
  await rejects(w, finish(w, step, { query: query(q => q.set('state', `${q.get('state')}x`)) }), 'state_mismatch');
  await rejects(w, finish(w, step, { query: query(q => q.set('state', 'a'.repeat(22))) }), 'state_mismatch');
  await rejects(w, finish(w, step, { query: query(q => q.delete('state')) }), 'state_mismatch');
  await rejects(w, finish(w, step, { query: query(q => q.set('state', '')) }), 'state_mismatch');
  await rejects(w, finish(w, step, { query: query(q => q.append('state', q.get('state'))) }), 'invalid_callback');
  await rejects(w, finish(w, step, { query: query(q => q.delete('code')) }), 'invalid_callback');
  await rejects(w, finish(w, step, { query: query(q => q.set('iss', 'https://evil.example')) }), 'issuer_mismatch');
  await rejects(w, finish(w, step, { query: { state: [step.callback.searchParams.get('state'), 'x'], code: 'c' } }), 'invalid_callback');
  // A plain object works too, and an intact request still succeeds afterwards (nothing above consumed the code).
  const ok = await finish(w, step, { query: Object.fromEntries(step.callback.searchParams) });
  assert.equal(ok.role, 'publisher');
});

test('the transaction cookie: tampering, another secret, another client and expiry are refused', async () => {
  const w = await world();
  const step = await begin(w);
  const [version, iv, body, tag] = step.tx.cookieValue.split('.');
  const flipped = `${body.slice(0, -2)}${body.endsWith('AA') ? 'BB' : 'AA'}`;
  await rejects(w, finish(w, step, { transactionCookie: [version, iv, flipped, tag].join('.') }), 'transaction_invalid');
  await rejects(w, finish(w, step, { transactionCookie: [version, iv, body, tag.slice(0, -2) + 'AA'].join('.') }), 'transaction_invalid');
  for (const junk of ['garbage', `${step.tx.cookieValue}.x`, 'v1...', 'v2.a.b.c', 5, null, 'x'.repeat(5000)]) await rejects(w, finish(w, step, { transactionCookie: junk }), 'transaction_invalid');
  await rejects(w, finish(w, step, { config: { ...w.config, secret: 'another-secret-'.padEnd(48, 'z') } }), 'transaction_invalid');
  await rejects(w, finish(w, step, { config: { ...w.config, clientId: 'jc_other_client' } }), 'transaction_invalid');
  // Expired: created eleven minutes ago.
  const old = await begin(w, { now: () => Date.now() - 11 * 60_000 });
  await rejects(w, finish(w, old), 'transaction_expired');
  // Just inside the window still works.
  const fresh = await begin(w, { now: () => Date.now() - 9 * 60_000 });
  assert.equal((await finish(w, fresh)).role, 'publisher');
  // The sealed payload carries an expiry ten minutes out.
  const payload = openTransaction(SECRET, step.tx.cookieValue);
  assert.ok(Math.abs(payload.exp - (Math.floor(Date.now() / 1000) + 600)) <= 5);
  assert.equal(openTransaction(SECRET, sealTransaction(SECRET, { ...payload, exp: 'soon' })), null, 'malformed payloads are not accepted');
});

test('provider error responses are rejected without echoing provider text', async () => {
  const w = await world();
  w.idp.authorizeMode = 'deny';
  const step = await begin(w);
  assert.equal(step.callback.searchParams.get('error'), 'access_denied');
  const error = await rejects(w, finish(w, step), 'provider_error');
  assert.ok(!/access_denied/.test(error.message));
  assert.equal(w.idp.stats.token, 0, 'no code exchange was attempted');
});

test('ID token: wrong audience, issuer, nonce and time claims are rejected', async () => {
  const w = await world();
  const bad = async (overrides, code = 'token_invalid') => {
    w.idp.claimOverrides = overrides;
    try { await rejects(w, login(w), code); } finally { w.idp.claimOverrides = {}; }
  };
  await bad({ aud: 'jc_another_client' });
  await bad({ aud: [w.idp.clientId, 'jc_another_client'] });
  await bad({ aud: undefined });
  await bad({ azp: 'jc_another_client' });
  await bad({ iss: 'https://evil.example' });
  await bad({ iss: undefined });
  await bad({ nonce: 'not-the-nonce' });
  await bad({ nonce: undefined });
  await bad({ sub: undefined });
  await bad({ exp: undefined });
  await bad({ iat: undefined });
  const now = Math.floor(Date.now() / 1000);
  await bad({ exp: now - 120 });                     // expired beyond the 60 s skew
  await bad({ iat: now + 3600, exp: now + 7200 });   // issued in the future
  await bad({ iat: now - 3600, exp: now + 3600 });   // issued far too long ago
  await bad({ sub: 'x y' }, 'claims_invalid');
  await bad({ sub: 42 }, 'claims_invalid');
  // Small skew is tolerated: expired ten seconds ago is still accepted.
  w.idp.claimOverrides = { exp: now - 10 };
  assert.equal((await login(w)).role, 'publisher');
  w.idp.claimOverrides = {};
  // An injected clock decides the time checks: a token minted now is expired for a verifier six minutes later.
  const step = await begin(w);
  await rejects(w, finish(w, step, { now: () => Date.now() + 6 * 60_000 }), 'token_invalid');
});

test('ID token: the signature algorithm is EdDSA only (none, HS256, RS256, key tricks all fail)', async () => {
  const w = await world();
  for (const alg of ['none', 'HS256', 'RS256']) {
    w.idp.tokenAlg = alg;
    await rejects(w, login(w), 'token_invalid');
  }
  w.idp.tokenAlg = 'EdDSA';
  for (const headerExtra of [{ jku: 'https://evil.example/jwks' }, { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' } }, { x5u: 'https://evil.example/x' }, { crit: ['b64'], b64: true }]) {
    w.idp.headerExtra = headerExtra;
    await rejects(w, login(w), 'token_invalid');
  }
  w.idp.headerExtra = {};
  w.idp.signWithUnpublishedKey = true;               // right kid, wrong key: signature fails
  await rejects(w, login(w), 'token_invalid');
  w.idp.signWithUnpublishedKey = false;
  w.idp.kidOverride = '';
  await rejects(w, login(w), 'token_invalid');
  w.idp.kidOverride = undefined;
  assert.equal((await login(w)).role, 'publisher', 'control: untouched token still passes');
  w.idp.tokenMode = 'garbage';
  await rejects(w, login(w), 'token_invalid');
});

test('ID token: unverified email, wrong dataset, missing craft claim and unknown roles are rejected', async () => {
  const w = await world();
  const bad = async (overrides, code) => { w.idp.claimOverrides = overrides; try { await rejects(w, login(w), code); } finally { w.idp.claimOverrides = {}; } };
  const craft = (extra = {}) => ({ dataset: 'production', role: 'editor', via: 'site_grant', ...extra });
  await bad({ email_verified: false }, 'email_unverified');
  await bad({ email_verified: 'true' }, 'email_unverified');
  await bad({ email_verified: undefined }, 'email_unverified');
  await bad({ email: undefined }, 'claims_invalid');
  await bad({ email: 'a\nb@example.test' }, 'claims_invalid');
  await bad({ name: 42 }, 'claims_invalid');
  await bad({ craft: craft({ dataset: 'staging' }) }, 'dataset_mismatch');
  await bad({ craft: craft({ dataset: undefined }) }, 'dataset_mismatch');
  await bad({ craft: undefined }, 'claims_invalid');
  await bad({ craft: 'editor' }, 'claims_invalid');
  await bad({ craft: [] }, 'claims_invalid');
  await bad({ craft: craft({ role: 'owner' }) }, 'role_unknown');
  await bad({ craft: craft({ role: 'Admin' }) }, 'role_unknown');
  await bad({ craft: craft({ role: undefined }) }, 'role_unknown');
  await bad({ craft: craft({ role: ['admin'] }) }, 'role_unknown');
  await bad({ craft: craft({ via: 'BAD VALUE' }) }, 'claims_invalid');
  // A person without a name is fine; via defaults when absent; platform admin access is reported, never widened.
  w.idp.claimOverrides = { name: undefined, craft: { dataset: 'production', role: 'admin', via: 'platform_admin' } };
  const identity = await login(w);
  assert.deepEqual([identity.name, identity.role, identity.via, identity.siteId], [null, 'admin', 'platform_admin', null]);
  w.idp.claimOverrides = { craft: { dataset: 'production', role: 'reader' } };
  assert.equal((await login(w)).via, 'site_grant');
});

test('JWKS: an unknown kid causes exactly one refetch per cooldown, rotation is picked up, and the last good keys survive an outage', async () => {
  const w = await world({ cache: { jwksCooldownMs: 60_000, jwksTtlMs: 10 * 60_000 } });
  let clock = Date.now();
  const now = () => clock;
  // The provider's clock moves with the simulated one, so freshly minted tokens stay fresh.
  const advance = ms => { clock += ms; w.idp.clockOffset = Math.round((clock - Date.now()) / 1000); };
  await login(w, { now });
  assert.equal(w.idp.stats.jwks, 1);
  await login(w, { now });
  assert.equal(w.idp.stats.jwks, 1, 'cached');

  const unpublished = w.idp.rotate({ publish: false });
  assert.notEqual(unpublished, w.idp.publishedKids()[0]);
  await rejects(w, login(w, { now }), 'token_invalid');
  assert.equal(w.idp.stats.jwks, 2, 'one refetch for the unknown kid');
  for (let i = 0; i < 5; i++) await rejects(w, login(w, { now }), 'token_invalid');
  assert.equal(w.idp.stats.jwks, 2, 'the cooldown stops repeated refetches');
  advance(61_000);
  await rejects(w, login(w, { now }), 'token_invalid');
  assert.equal(w.idp.stats.jwks, 3, 'allowed again after the cooldown');

  // Rotation: the new key is published, the next login finds it with one refetch (after the cooldown).
  w.idp.publishCurrent();
  advance(61_000);
  assert.equal((await login(w, { now })).role, 'publisher');
  assert.equal(w.idp.stats.jwks, 4);
  assert.equal((await login(w, { now })).role, 'publisher');
  assert.equal(w.idp.stats.jwks, 4);

  // Outage: the TTL lapses and the endpoint is down; known keys keep working, unknown ones never do.
  advance(11 * 60_000);
  w.idp.jwksMode = 'down';
  assert.equal((await login(w, { now })).role, 'publisher');
  w.idp.rotate({ publish: false });
  advance(61_000);
  await rejects(w, login(w, { now }), 'token_invalid');
});

test('JWKS: with no keys at all, an unreachable, failing, empty or garbled endpoint means no login', async () => {
  for (const mode of ['down', 'status500', 'empty', 'garbage']) {
    const w = await world();
    w.idp.jwksMode = mode;
    await rejects(w, login(w), 'jwks_unavailable');
  }
});

test('token endpoint: 400, 500, slow, redirect, HTML and oversized responses all fail safely', async () => {
  const w = await world();
  w.idp.tokenMode = 'status400';
  await rejects(w, login(w), 'token_exchange_failed');
  w.idp.tokenMode = 'status500';
  await rejects(w, login(w), 'token_exchange_failed', ['secret=']);
  w.idp.tokenMode = 'html';
  await rejects(w, login(w), 'token_exchange_failed');
  w.idp.tokenMode = 'huge';
  await rejects(w, login(w), 'token_exchange_failed');
  w.idp.tokenMode = 'redirect';
  const before = w.idp.stats.token;
  await rejects(w, login(w), 'token_exchange_failed');
  assert.equal(w.idp.stats.token, before + 1, 'the redirect target was never requested');
  w.idp.tokenMode = 'slow'; w.idp.slowMs = 2500;
  const started = Date.now();
  await rejects(w, login(w, { timeoutMs: 250 }), 'token_exchange_failed');
  assert.ok(Date.now() - started < 1800, 'the exchange timed out instead of waiting for the slow provider');
  w.idp.tokenMode = 'ok';
  assert.equal((await login(w)).role, 'publisher');
});

test('the code is only ever sent to the discovered token endpoint, and requests never follow redirects or carry cookies', async () => {
  const w = await world();
  const seen = [];
  const spy = async (input, init) => { seen.push({ url: String(input), init }); return fetch(input, init); };
  await login(w, { fetch: spy });
  assert.ok(seen.length >= 3);
  for (const call of seen) {
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.credentials, 'omit');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.ok(call.url.startsWith(w.idp.origin + '/'), call.url);
  }
  assert.deepEqual(seen.filter(call => call.init.method === 'POST').map(call => call.url), [`${w.idp.origin}/api/oidc/token`]);
  // A fetch that answers 3xx for any request is refused everywhere (discovery, JWKS and token).
  const redirecting = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
  await rejects(w, createLoginTransaction({ config: w.config, caches: createAuthCaches(), fetch: redirecting }), 'discovery_failed');
});

test('discovery: validates issuer, same-origin endpoints, https and the supported flow; caches with a TTL', async () => {
  const w = await world();
  const fresh = () => createAuthCaches();
  const ok = await discover(w.idp.issuer, { caches: fresh() });
  assert.deepEqual(ok, { issuer: w.idp.issuer, authorizationEndpoint: `${w.idp.origin}/oidc/authorize`, tokenEndpoint: `${w.idp.origin}/api/oidc/token`, jwksUri: `${w.idp.origin}/api/oidc/jwks` });
  const invalid = async overrides => {
    w.idp.discoveryOverrides = overrides;
    try { await rejects(w, discover(w.idp.issuer, { caches: fresh() }), 'discovery_invalid'); } finally { w.idp.discoveryOverrides = {}; }
  };
  await invalid({ issuer: 'https://evil.example' });
  await invalid({ issuer: `${w.idp.origin}/` });
  await invalid({ issuer: undefined });
  await invalid({ token_endpoint: 'https://evil.example/api/oidc/token' });
  await invalid({ authorization_endpoint: 'https://evil.example/oidc/authorize' });
  await invalid({ jwks_uri: 'https://evil.example/jwks' });
  await invalid({ token_endpoint: `${w.idp.origin.replace('http:', 'https:')}/api/oidc/token` });
  await invalid({ token_endpoint: 'javascript:alert(1)' });
  await invalid({ token_endpoint: `http://user:pass@${w.idp.origin.slice(7)}/api/oidc/token` });
  await invalid({ token_endpoint: undefined });
  await invalid({ response_types_supported: ['token'] });
  await invalid({ code_challenge_methods_supported: ['plain'] });
  await invalid({ code_challenge_methods_supported: undefined });
  await invalid({ id_token_signing_alg_values_supported: ['RS256'] });
  await invalid({ grant_types_supported: ['implicit'] });
  await invalid({ token_endpoint_auth_methods_supported: ['private_key_jwt'] });
  w.idp.discoveryMode = 'status500';
  await rejects(w, discover(w.idp.issuer, { caches: fresh() }), 'discovery_failed');
  w.idp.discoveryMode = 'ok';
  // The issuer in settings must be a bare https origin (http only for loopback).
  for (const issuer of ['http://jongo.example', 'https://jongo.example/path', 'https://jongo.example/', 'https://user@jongo.example', 'jongo.example', '', 'ftp://jongo.example']) {
    await rejects(w, discover(issuer, { caches: fresh(), fetch: async () => { throw new Error('must not fetch'); } }), 'invalid_config');
  }
  // Cache: one request inside the TTL, another after it.
  const caches = createAuthCaches({ discoveryTtlMs: 1000 });
  let clock = 5_000_000;
  const before = w.idp.stats.discovery;
  await discover(w.idp.issuer, { caches, now: () => clock });
  await discover(w.idp.issuer, { caches, now: () => clock + 500 });
  assert.equal(w.idp.stats.discovery, before + 1);
  await discover(w.idp.issuer, { caches, now: () => clock + 1500 });
  assert.equal(w.idp.stats.discovery, before + 2);
});

test('settings are validated before anything is sent', async () => {
  const w = await world();
  const never = async () => { throw new Error('must not fetch'); };
  for (const patch of [{ redirectUri: 'http://site.example.test/cb' }, { redirectUri: 'not a url' }, { clientSecret: '' }, { secret: 'short' }, { dataset: 'Bad Name' }, { clientId: '' }, { issuer: 'https://jongo.example/x' }]) {
    await rejects(w, createLoginTransaction({ config: { ...w.config, ...patch }, caches: createAuthCaches(), fetch: never }), 'invalid_config');
    await rejects(w, completeLogin({ transactionCookie: 'x', query: {}, config: { ...w.config, ...patch }, caches: createAuthCaches(), fetch: never }), 'invalid_config');
  }
});

test('every failure is a CraftAuthError with a fixed message; nothing is written to the console', async () => {
  const w = await world();
  const logged = [];
  const originals = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) { originals[name] = console[name]; console[name] = (...args) => logged.push(args.join(' ')); }
  try {
    w.idp.claimOverrides = { email_verified: false };
    const error = await rejects(w, login(w), 'email_unverified');
    assert.equal(error.name, 'CraftAuthError');
    assert.equal(error.message, 'The account email is not verified.');
    w.idp.claimOverrides = {}; w.idp.tokenMode = 'status500';
    await rejects(w, login(w), 'token_exchange_failed');
  } finally { Object.assign(console, originals); }
  assert.deepEqual(logged, []);
});

test('role mapping matrix: exactly the documented actions, never import, export-private or admin', () => {
  assert.deepEqual(mapRoleToActions('reader'), ['read']);
  assert.deepEqual(mapRoleToActions('editor'), ['read', 'read-drafts', 'write']);
  assert.deepEqual(mapRoleToActions('publisher'), ['read', 'read-drafts', 'write', 'publish']);
  assert.deepEqual(mapRoleToActions('admin'), ['read', 'read-drafts', 'write', 'publish', 'export']);
  for (const role of CRAFT_ROLES) {
    const actions = mapRoleToActions(role);
    for (const never of ['import', 'export-private', 'admin']) assert.ok(!actions.includes(never), `${role} must not get ${never}`);
    // `via` never widens a role (a Jongo platform admin is just an admin).
    for (const via of ['platform_admin', 'org_owner', 'org_admin', 'site_grant', undefined]) assert.deepEqual(mapRoleToActions(role, { via }), actions);
  }
  for (const unknown of ['owner', 'superadmin', 'ADMIN', '', undefined, null, 5, {}, ['admin'], '__proto__', 'constructor']) assert.deepEqual(mapRoleToActions(unknown), [], String(unknown));
  // Callers cannot corrupt later answers by mutating a result.
  mapRoleToActions('admin').push('import');
  assert.deepEqual(mapRoleToActions('admin'), ['read', 'read-drafts', 'write', 'publish', 'export']);
  assert.deepEqual([...CRAFT_ROLES], ['reader', 'editor', 'publisher', 'admin']);
  assert.ok(isCraftRole('editor') && !isCraftRole('owner') && !isCraftRole(undefined));
});
