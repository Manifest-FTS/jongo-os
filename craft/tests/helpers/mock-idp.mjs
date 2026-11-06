// In-process mock of the Jongo OIDC provider for tests: discovery, JWKS, authorize (auto-approves the configured user) and token
// (authorization_code + PKCE + client_secret_basic/post). Signs ID tokens with a test Ed25519 key and can misbehave on demand.
// Binds 127.0.0.1 only; nothing here talks to a real network.
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign as nodeSign } from 'node:crypto';
import { createServer } from 'node:http';

const b64 = input => Buffer.from(input).toString('base64url');
const json = value => b64(JSON.stringify(value));

export function makeEd25519Key() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = randomBytes(8).toString('hex');
  return { kid, privateKey, publicKey, jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, use: 'sig', alg: 'EdDSA' } };
}

export const DEFAULT_USER = { sub: '11111111-2222-4333-8444-555555555555', email: 'editor@example.test', name: 'Ada Editor', emailVerified: true, role: 'publisher', via: 'site_grant', siteId: 'site-1' };

export async function startMockIdp(options = {}) {
  const clientId = options.clientId ?? 'jc_test_client_0123456789';
  const clientSecret = options.clientSecret ?? randomBytes(24).toString('base64url');
  const dataset = options.dataset ?? 'production';
  const redirectUris = new Set(options.redirectUris ?? []);
  let key = makeEd25519Key();
  const keys = [key];
  const codes = new Map();
  const idp = {
    clientId, clientSecret, dataset, redirectUris,
    user: { ...DEFAULT_USER, ...(options.user ?? {}) },
    /** 'approve' | 'deny' (redirects with error=access_denied) | 'no-iss' (approve without the RFC 9207 iss parameter) */
    authorizeMode: 'approve',
    /** 'ok' | 'status400' | 'status500' | 'slow' | 'redirect' | 'garbage' | 'html' | 'huge' */
    tokenMode: 'ok',
    slowMs: 3000,
    /** 'ok' | 'down' | 'status500' | 'empty' | 'garbage' */
    jwksMode: 'ok',
    discoveryMode: 'ok',
    discoveryOverrides: {},
    /** Claims merged over (or, with undefined values, removed from) the default ID token payload. */
    claimOverrides: {},
    /** 'EdDSA' | 'none' | 'HS256' | 'RS256' */
    tokenAlg: 'EdDSA',
    /** Extra protected-header fields (for jku/jwk style attacks). */
    headerExtra: {},
    /** Sign with a key that is not in the JWKS (but keep its kid unless overridden). */
    signWithUnpublishedKey: false,
    kidOverride: undefined,
    /** Offset (seconds) applied to iat and exp. */
    clockOffset: 0,
    ttlSeconds: 300,
    stats: { discovery: 0, jwks: 0, token: 0, authorize: 0 },
    lastToken: null,
    get kid() { return key.kid; },
    publishedKids: () => keys.map(k => k.kid),
    /** Adds a new signing key and makes it the active one; `publish: false` keeps it out of the JWKS. */
    rotate({ publish = true } = {}) { key = makeEd25519Key(); if (publish) keys.push(key); return key.kid; },
    publishCurrent() { if (!keys.includes(key)) keys.push(key); },
    unpublishAllButCurrent() { keys.splice(0, keys.length, key); },
    origin: '', issuer: '', redirectUri: ''
  };

  const payloadFor = (nonce, overrides = {}) => {
    const now = Math.floor(Date.now() / 1000) + idp.clockOffset;
    const u = idp.user;
    const base = {
      iss: idp.issuer, sub: u.sub, aud: clientId, iat: now, exp: now + idp.ttlSeconds, auth_time: now, nonce, jti: randomUUID(),
      email: u.email, email_verified: u.emailVerified, name: u.name,
      craft: { dataset: idp.dataset, role: u.role, siteId: u.siteId, via: u.via }
    };
    const merged = { ...base, ...idp.claimOverrides, ...overrides };
    for (const [name, value] of Object.entries(merged)) if (value === undefined) delete merged[name];
    return merged;
  };

  const signToken = payload => {
    const header = { alg: idp.tokenAlg, typ: 'JWT', kid: idp.kidOverride ?? key.kid, ...idp.headerExtra };
    if (idp.tokenAlg === 'none') { delete header.kid; header.alg = 'none'; return `${json(header)}.${json(payload)}.`; }
    const signingInput = `${json(header)}.${json(payload)}`;
    if (idp.tokenAlg === 'HS256') {
      // Classic algorithm confusion: HMAC with the public key bytes as the secret.
      return `${signingInput}.${createHmac('sha256', Buffer.from(key.jwk.x, 'base64url')).update(signingInput).digest('base64url')}`;
    }
    if (idp.tokenAlg === 'RS256') {
      const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
      return `${signingInput}.${nodeSign('sha256', Buffer.from(signingInput), rsa.privateKey).toString('base64url')}`;
    }
    const signer = idp.signWithUnpublishedKey ? makeEd25519Key().privateKey : key.privateKey;
    return `${signingInput}.${nodeSign(null, Buffer.from(signingInput), signer).toString('base64url')}`;
  };
  idp.signToken = signToken;
  idp.payloadFor = payloadFor;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const readBody = req => new Promise(accept => { let data = ''; req.on('data', chunk => { data += chunk; }); req.on('end', () => accept(data)); });
  const sleep = ms => new Promise(accept => setTimeout(accept, ms));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, idp.origin);
      if (url.pathname === '/.well-known/openid-configuration') {
        idp.stats.discovery++;
        if (idp.discoveryMode === 'status500') return send(res, 500, { error: 'boom' });
        const doc = {
          issuer: idp.issuer, authorization_endpoint: `${idp.origin}/oidc/authorize`, token_endpoint: `${idp.origin}/api/oidc/token`, jwks_uri: `${idp.origin}/api/oidc/jwks`,
          response_types_supported: ['code'], response_modes_supported: ['query'], grant_types_supported: ['authorization_code'], subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['EdDSA'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'email', 'profile', 'craft'], authorization_response_iss_parameter_supported: true
        };
        for (const [name, value] of Object.entries(idp.discoveryOverrides)) { if (value === undefined) delete doc[name]; else doc[name] = value; }
        return send(res, 200, doc);
      }
      if (url.pathname === '/api/oidc/jwks') {
        idp.stats.jwks++;
        if (idp.jwksMode === 'down') return void req.socket.destroy();
        if (idp.jwksMode === 'status500') return send(res, 500, { error: 'boom' });
        if (idp.jwksMode === 'empty') return send(res, 200, { keys: [] });
        if (idp.jwksMode === 'garbage') return send(res, 200, 'not json');
        return send(res, 200, { keys: keys.map(k => k.jwk) });
      }
      if (url.pathname === '/oidc/authorize' && req.method === 'GET') {
        idp.stats.authorize++;
        const q = url.searchParams;
        const redirectUri = q.get('redirect_uri') ?? '';
        if (q.get('client_id') !== clientId || (idp.redirectUris.size && !idp.redirectUris.has(redirectUri))) return send(res, 400, { error: 'invalid_client_or_redirect' });
        const target = new URL(redirectUri);
        if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state') || !q.get('nonce')) {
          target.searchParams.set('error', 'invalid_request'); target.searchParams.set('state', q.get('state') ?? '');
          return void res.writeHead(302, { location: target.href }).end();
        }
        if (idp.authorizeMode === 'deny') {
          target.searchParams.set('error', 'access_denied'); target.searchParams.set('state', q.get('state'));
          return void res.writeHead(302, { location: target.href }).end();
        }
        const code = randomBytes(24).toString('base64url');
        codes.set(code, { challenge: q.get('code_challenge'), nonce: q.get('nonce'), redirectUri, used: false });
        target.searchParams.set('code', code); target.searchParams.set('state', q.get('state'));
        if (idp.authorizeMode !== 'no-iss') target.searchParams.set('iss', idp.issuer);
        return void res.writeHead(302, { location: target.href }).end();
      }
      if (url.pathname === '/api/oidc/token' && req.method === 'POST') {
        idp.stats.token++;
        const raw = await readBody(req);
        const form = new URLSearchParams(raw);
        idp.lastToken = { authorization: req.headers.authorization ?? null, form: Object.fromEntries(form), contentType: req.headers['content-type'] ?? null };
        if (idp.tokenMode === 'slow') await sleep(idp.slowMs);
        if (idp.tokenMode === 'status400') return send(res, 400, { error: 'invalid_grant' });
        if (idp.tokenMode === 'status500') return send(res, 500, { error: 'server_error', error_description: `secret=${clientSecret}` });
        if (idp.tokenMode === 'redirect') return void res.writeHead(302, { location: `${idp.origin}/somewhere-else` }).end();
        if (idp.tokenMode === 'html') return send(res, 200, '<html>not json</html>', { 'content-type': 'text/html' });
        if (idp.tokenMode === 'huge') return send(res, 200, JSON.stringify({ id_token: 'x'.repeat(200_000) }));
        let id = '', secret = '';
        const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? '');
        if (basic) {
          const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
          const at = decoded.indexOf(':');
          id = decodeURIComponent(decoded.slice(0, at).replace(/\+/g, ' ')); secret = decodeURIComponent(decoded.slice(at + 1).replace(/\+/g, ' '));
        } else { id = form.get('client_id') ?? ''; secret = form.get('client_secret') ?? ''; }
        if (id !== clientId || secret !== clientSecret) return send(res, 401, { error: 'invalid_client' });
        const entry = codes.get(form.get('code') ?? '');
        if (!entry || entry.used || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== entry.redirectUri) return send(res, 400, { error: 'invalid_grant' });
        entry.used = true;
        const verifier = form.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier, 'ascii').digest('base64url') !== entry.challenge) return send(res, 400, { error: 'invalid_grant' });
        if (idp.tokenMode === 'garbage') return send(res, 200, { id_token: 'not.a.jwt', token_type: 'N_A' });
        return send(res, 200, { id_token: signToken(payloadFor(entry.nonce)), token_type: 'N_A', expires_in: idp.ttlSeconds });
      }
      send(res, 404, { error: 'not_found' });
    } catch { try { send(res, 500, { error: 'mock_failure' }); } catch { /* socket gone */ } }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: options.port ?? 0 }, accept); });
  idp.origin = `http://127.0.0.1:${server.address().port}`;
  idp.issuer = idp.origin;
  idp.close = () => new Promise(accept => { server.closeAllConnections?.(); server.close(() => accept()); });
  // Walks the authorize redirect the way a browser would, without cookies, and returns the callback query the site would receive.
  idp.authorizeRedirect = async authorizeUrl => {
    const response = await fetch(authorizeUrl, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status !== 302 || !location) throw new Error(`authorize did not redirect: ${response.status}`);
    return new URL(location);
  };
  return idp;
}
