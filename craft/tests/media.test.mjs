import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  MediaStorageError, PRESIGN_EXPIRES_SECONDS, SNIFF_BYTES, EMPTY_PAYLOAD_SHA256, buildMediaKey, checkStoredObject, createS3Client, inspectMedia, isMediaKey, isMediaPrefix,
  normalizeEndpoint, readImageDimensions, signRequest, slugifyFilename, sniffMediaType, uriEncode, MEDIA_KEY_PATTERN
} from '../dist/server/index.js';
import {
  ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES, ASSET_TYPE_DEFINITIONS, DEFAULT_MEDIA_LIMITS, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, MEDIA_TYPES, UPLOAD_MESSAGES,
  checkUpload, createReferenceIndex, describeBytes, displayFilename, isAllowedMediaType, mediaLimits, searchReferences, validateDocument, createContentRegistry
} from '../dist/content.js';

const sha = text => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------------------------------------------------------
// AWS Signature V4: the published examples from "Signature Calculations for the Authorization Header" and
// "Authenticating Requests: Using Query Parameters" (examplebucket, 20130524, us-east-1).
// ---------------------------------------------------------------------------------------------------------------------
const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', host: 'examplebucket.s3.amazonaws.com', date: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)) };

test('SigV4 presigned URL: the documented "GET /test.txt" example (X-Amz-Expires=86400) yields the documented signature', () => {
  const signed = signRequest({ ...AWS, method: 'GET', path: '/test.txt', payloadHash: 'UNSIGNED-PAYLOAD', mode: 'query', expiresSeconds: 86400 });
  assert.equal(signed.canonicalRequest, [
    'GET', '/test.txt',
    'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
    'host:examplebucket.s3.amazonaws.com', '', 'host', 'UNSIGNED-PAYLOAD'
  ].join('\n'));
  assert.equal(signed.stringToSign, ['AWS4-HMAC-SHA256', '20130524T000000Z', '20130524/us-east-1/s3/aws4_request', sha(signed.canonicalRequest)].join('\n'));
  assert.equal(sha(signed.canonicalRequest), '3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04');
  assert.equal(signed.signature, 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.ok(signed.query.endsWith('&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'));
  assert.equal(signed.authorization, undefined);
});

test('SigV4 header auth: the documented "GET Object with Range" example', () => {
  const headers = { range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256, 'x-amz-date': '20130524T000000Z' };
  const signed = signRequest({ ...AWS, method: 'GET', path: '/test.txt', headers, payloadHash: EMPTY_PAYLOAD_SHA256, mode: 'headers' });
  assert.equal(signed.canonicalRequest, ['GET', '/test.txt', '', 'host:examplebucket.s3.amazonaws.com', 'range:bytes=0-9', `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}`, 'x-amz-date:20130524T000000Z', '', 'host;range;x-amz-content-sha256;x-amz-date', EMPTY_PAYLOAD_SHA256].join('\n'));
  assert.equal(signed.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(signed.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('SigV4 header auth: the documented "PUT Object" example (encoded "$" in the key, extra signed headers)', () => {
  const headers = { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072' };
  const signed = signRequest({ ...AWS, method: 'PUT', path: '/test$file.text', headers, payloadHash: headers['x-amz-content-sha256'], mode: 'headers' });
  assert.ok(signed.canonicalRequest.startsWith('PUT\n/test%24file.text\n\n'));
  assert.equal(signed.signedHeaders, 'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class');
  assert.equal(signed.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('uriEncode follows RFC 3986 exactly', () => {
  assert.equal(uriEncode('a b/c'), 'a%20b%2Fc');
  assert.equal(uriEncode('a b/c', true), 'a%20b/c');
  assert.equal(uriEncode("!'()*~-_."), '%21%27%28%29%2A~-_.');
  assert.equal(uriEncode('é'), '%C3%A9');
});

// ---------------------------------------------------------------------------------------------------------------------
// Backblaze-style path-style presigned PUT
// ---------------------------------------------------------------------------------------------------------------------
const B2 = { endpoint: 'https://s3.us-east-005.backblazeb2.com', region: 'us-east-005', bucket: 'jongo-craft', accessKeyId: '005abcdef0123456789000000a', secretAccessKey: 'K005SecretSecretSecretSecretSecret1' };
const NOW = new Date(Date.UTC(2026, 10, 5, 12, 30, 15));
const KEY = 'thegolflab/assets/images/2026/11/0a1b2c3d-range-photo.png';

/** Independent re-derivation from the URL alone, written differently from the signer. */
function verifyPresigned(url, { method, headers, secretAccessKey }) {
  const parsed = new URL(url);
  const query = new Map([...parsed.searchParams.entries()]);
  const given = query.get('X-Amz-Signature');
  query.delete('X-Amz-Signature');
  const enc = text => encodeURIComponent(text).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const canonicalQuery = [...query.entries()].map(([k, v]) => [enc(k), enc(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const signedNames = query.get('X-Amz-SignedHeaders').split(';');
  const lookup = { host: parsed.host, ...headers };
  const canonicalHeaders = signedNames.map(name => `${name}:${lookup[name]}\n`).join('');
  const canonical = [method, parsed.pathname, canonicalQuery, canonicalHeaders, query.get('X-Amz-SignedHeaders'), 'UNSIGNED-PAYLOAD'].join('\n');
  const [, day, region, service] = query.get('X-Amz-Credential').split('/');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${query.get('X-Amz-Date')}\n${scope}\n${sha(canonical)}`;
  let key = createHmac('sha256', `AWS4${secretAccessKey}`).update(day).digest();
  for (const part of [region, service, 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
  return { matches: createHmac('sha256', key).update(toSign).digest('hex') === given, query };
}

test('B2 presigned PUT: path-style URL, five-minute expiry, host + content-type + content-length signed, UNSIGNED-PAYLOAD', () => {
  const s3 = createS3Client(B2, { now: () => NOW });
  const put = s3.presignPut({ key: KEY, contentType: 'image/png', contentLength: 4321 });
  const url = new URL(put.url);
  assert.equal(url.origin, 'https://s3.us-east-005.backblazeb2.com');
  assert.equal(url.pathname, `/jongo-craft/${KEY}`);
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-Credential'), `${B2.accessKeyId}/20261105/us-east-005/s3/aws4_request`);
  assert.equal(url.searchParams.get('X-Amz-Date'), '20261105T123015Z');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(PRESIGN_EXPIRES_SECONDS, 300);
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host');
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
  assert.deepEqual(put.headers, { 'content-type': 'image/png' });
  assert.equal(put.expiresAt, '2026-11-05T12:35:15.000Z');
  const check = verifyPresigned(put.url, { method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': '4321' }, secretAccessKey: B2.secretAccessKey });
  assert.ok(check.matches, 'an independent derivation agrees');
  assert.ok(!put.url.includes(B2.secretAccessKey), 'the secret never appears in the URL');
});

test('the signature binds the content type, the length, the key, the bucket, the expiry and the time', () => {
  const sig = (overrides = {}, client = {}, call = {}) => new URL(createS3Client({ ...B2, ...overrides }, { now: () => NOW, ...client }).presignPut({ key: KEY, contentType: 'image/png', contentLength: 4321, ...call }).url).searchParams.get('X-Amz-Signature');
  const base = sig();
  assert.equal(sig(), base, 'deterministic');
  for (const [label, value] of [
    ['type', sig({}, {}, { contentType: 'image/jpeg' })], ['length', sig({}, {}, { contentLength: 4322 })], ['key', sig({}, {}, { key: KEY.replace('range', 'rangf') })],
    ['bucket', sig({ bucket: 'other-bucket' })], ['expiry', sig({}, {}, { expiresSeconds: 301 })], ['time', sig({}, { now: () => new Date(NOW.getTime() + 1000) })], ['region', sig({ region: 'us-east-004' })], ['host', sig({ endpoint: 'https://s3.us-west-004.backblazeb2.com' })]
  ]) assert.notEqual(value, base, label);
});

test('presignPut refuses bad input without leaking settings', () => {
  const s3 = createS3Client(B2, { now: () => NOW });
  for (const bad of [{ key: '../x', contentType: 'image/png', contentLength: 1 }, { key: '/abs', contentType: 'image/png', contentLength: 1 }, { key: 'a//b', contentType: 'image/png', contentLength: 1 }, { key: KEY, contentType: 'image/png; x=y', contentLength: 1 }, { key: KEY, contentType: 'image/png', contentLength: 0 }, { key: KEY, contentType: 'image/png', contentLength: 1.5 }, { key: KEY, contentType: 'image/png', contentLength: 1, expiresSeconds: 0 }, { key: KEY, contentType: 'image/png', contentLength: 1, expiresSeconds: 7200 }]) {
    assert.throws(() => s3.presignPut(bad), error => error instanceof MediaStorageError && error.code === 'invalid' && !error.message.includes(B2.secretAccessKey) && !error.message.includes(B2.accessKeyId));
  }
  for (const bad of [{ endpoint: 'ftp://x' }, { endpoint: '' }, { bucket: 'A_B' }, { region: 'US EAST' }, { accessKeyId: '' }, { secretAccessKey: '' }]) {
    assert.throws(() => createS3Client({ ...B2, ...bad }), error => error instanceof MediaStorageError && !error.message.includes(B2.secretAccessKey));
  }
});

test('normalizeEndpoint accepts a host or an https URL, refuses everything else; http only when allowed', () => {
  assert.equal(normalizeEndpoint('s3.us-east-005.backblazeb2.com'), 'https://s3.us-east-005.backblazeb2.com');
  assert.equal(normalizeEndpoint('https://s3.us-east-005.backblazeb2.com/'), 'https://s3.us-east-005.backblazeb2.com');
  assert.equal(normalizeEndpoint('  https://S3.example.com:9000  '), 'https://s3.example.com:9000');
  for (const bad of ['http://s3.example.com', 'https://user:pw@s3.example.com', 'https://s3.example.com/bucket', 'https://s3.example.com/?x=1', 'https://s3.example.com/#x', 'javascript:alert(1)', '', '   ', 'a b', undefined, 5, null, `https://${'a'.repeat(300)}.com`]) assert.equal(normalizeEndpoint(bad), null, String(bad));
  assert.equal(normalizeEndpoint('http://127.0.0.1:9000', { allowInsecure: true }), 'http://127.0.0.1:9000');
});

// ---------------------------------------------------------------------------------------------------------------------
// Key builder
// ---------------------------------------------------------------------------------------------------------------------
const fixed = { prefix: 'thegolflab', now: new Date(Date.UTC(2026, 10, 5)), random: () => '0a1b2c3d' };

test('buildMediaKey: {prefix}/assets/{kind}/{yyyy}/{mm}/{8 hex}-{slug}.{ext}, extension from the type', () => {
  assert.equal(buildMediaKey({ ...fixed, kind: 'images', contentType: 'image/png', filename: 'Range Photo.PNG' }), KEY);
  assert.equal(buildMediaKey({ ...fixed, contentType: 'video/mp4', filename: 'tour.mov' }), 'thegolflab/assets/video/2026/11/0a1b2c3d-tour.mp4');
  assert.equal(buildMediaKey({ ...fixed, contentType: 'image/jpeg', filename: 'a.jpeg' }), 'thegolflab/assets/images/2026/11/0a1b2c3d-a.jpg');
  assert.equal(buildMediaKey({ ...fixed, now: new Date(Date.UTC(2027, 0, 1)), contentType: 'image/webp', filename: 'x' }), 'thegolflab/assets/images/2027/01/0a1b2c3d-x.webp');
  assert.equal(buildMediaKey({ ...fixed, now: new Date(Date.UTC(2026, 11, 31, 23, 59, 59)), contentType: 'image/gif', filename: 'x' }), 'thegolflab/assets/images/2026/12/0a1b2c3d-x.gif');
  for (const type of Object.keys(MEDIA_TYPES)) assert.ok(isMediaKey(buildMediaKey({ ...fixed, contentType: type, filename: 'f' }), 'thegolflab'), type);
});

test('buildMediaKey: the kind must agree with the type, prefix and random are validated', () => {
  assert.throws(() => buildMediaKey({ ...fixed, kind: 'video', contentType: 'image/png', filename: 'a' }), MediaStorageError);
  assert.throws(() => buildMediaKey({ ...fixed, contentType: 'image/svg+xml', filename: 'a' }), MediaStorageError);
  assert.throws(() => buildMediaKey({ ...fixed, contentType: 'text/html', filename: 'a' }), MediaStorageError);
  for (const prefix of ['', 'Upper', 'a/b', '../x', 'a b', '-lead', 'x'.repeat(49), 'é', 'a.b']) assert.throws(() => buildMediaKey({ ...fixed, prefix, contentType: 'image/png', filename: 'a' }), MediaStorageError, prefix);
  for (const random of ['', 'ABCDEF12', '0a1b2c3', '0a1b2c3d4', '../../../', 'zzzzzzzz']) assert.throws(() => buildMediaKey({ ...fixed, random: () => random, contentType: 'image/png', filename: 'a' }), MediaStorageError, random);
  assert.throws(() => buildMediaKey({ ...fixed, now: new Date(NaN), contentType: 'image/png', filename: 'a' }), MediaStorageError);
  assert.ok(isMediaPrefix('thegolflab') && isMediaPrefix('a') && isMediaPrefix('x'.repeat(48)) && isMediaPrefix('a-b-9'));
});

test('slugifyFilename: traversal, unicode tricks, long, empty and odd names always give [a-z0-9-]{1,60}', () => {
  const nasty = ['../../etc/passwd', '..\\..\\windows\\system32', '/abs/path/photo.png', 'photo.png.exe', '.png', '..', '.', '', '   ', 'A'.repeat(500) + '.jpg', '写真.jpg', 'ÀÉÎõü ñ.PNG', 'ｆｕｌｌｗｉｄｔｈ．ｐｎｇ', '\u202Egnp.exe', 'a\u0000b.png', 'a%2e%2e%2fb.png', 'CON', 'a\nb\tc.png', '😀😀.png', 'file name with spaces   .gif', '--a--b--.png', 'x.y.z.tar.gz', 'photo.jpeg?x=1#y', '<script>alert(1)</script>.png', "a'b\"c.png", 'ａ／ｂ．ｐｎｇ', 'ǅ.png', 'ß.png', '.hidden', 'a.', 'a..b', 'x'.repeat(10) + '\u0301'.repeat(100)];
  for (const name of nasty) {
    const slug = slugifyFilename(name);
    assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, JSON.stringify(name));
    assert.ok(slug.length >= 1 && slug.length <= 60, JSON.stringify(name));
    const key = buildMediaKey({ ...fixed, contentType: 'image/png', filename: name });
    assert.ok(MEDIA_KEY_PATTERN.test(key), key);
    assert.equal(key.split('/').length, 6, 'no extra path separators');
    assert.ok(!key.includes('..') && !key.includes('\\') && !/[^\x20-\x7e]/.test(key));
  }
  assert.equal(slugifyFilename('Range Photo.PNG'), 'range-photo');
  assert.equal(slugifyFilename(''), 'file');
  assert.equal(slugifyFilename('...'), 'file');
  assert.equal(slugifyFilename('写真.jpg'), 'file');
  assert.equal(slugifyFilename('Café Ñandú.jpg'), 'cafe-nandu');
  assert.equal(slugifyFilename('a'.repeat(100)).length, 60);
  assert.equal(slugifyFilename(`${'a'.repeat(59)}-b-c`), 'a'.repeat(59), 'a cut never leaves a trailing hyphen');
  assert.equal(slugifyFilename(undefined), 'file');
  assert.equal(slugifyFilename(42), 'file');
  assert.equal(slugifyFilename('x'.repeat(5_000_000)).length, 60, 'enormous input is bounded');
});

test('buildMediaKey fuzz: random names never escape the folder, and keys do not collide in practice', () => {
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const alphabet = ['a', 'Z', '0', '-', '_', '.', '/', '\\', ' ', 'é', '写', '😀', '\u202e', '\u0000', '%', '?', '#', '<', '>', '"', "'", '\n', '$', '~', '*'];
  const keys = new Set();
  for (let i = 0; i < 3000; i++) {
    let name = '';
    for (let n = next() % 40; n > 0; n--) name += alphabet[next() % alphabet.length];
    const key = buildMediaKey({ prefix: 'thegolflab', now: new Date(Date.UTC(2026, 10, 5)), contentType: 'image/png', filename: name });
    assert.ok(MEDIA_KEY_PATTERN.test(key), JSON.stringify(name));
    assert.ok(key.startsWith('thegolflab/assets/images/2026/11/'), key);
    keys.add(key);
  }
  assert.equal(keys.size, 3000, 'eight random hex characters keep identical names apart');
  const same = new Set(Array.from({ length: 1000 }, () => buildMediaKey({ prefix: 'p', contentType: 'image/png', filename: 'same name.png' })));
  assert.equal(same.size, 1000, 'the same file uploaded twice gets two keys');
});

test('isMediaKey: only keys this builder can make under the configured prefix', () => {
  assert.ok(isMediaKey(KEY, 'thegolflab'));
  for (const bad of ['', 'thegolflab/assets/images/2026/11/0a1b2c3d-x.png/../y', 'other/assets/images/2026/11/0a1b2c3d-x.png', 'thegolflab/assets/_check/0a1b2c3d-x.png', 'thegolflab/assets/images/2026/13/0a1b2c3d-x.png', 'thegolflab/assets/images/2026/11/0A1B2C3D-x.png', 'thegolflab/assets/images/2026/11/0a1b2c3d-x.svg.png/', 'thegolflab/assets/images/2026/11/0a1b2c3d-.png', 'thegolflab/assets/images/2026/11/x.png', `thegolflab/assets/images/2026/11/0a1b2c3d-${'a'.repeat(300)}.png`, 'thegolflab/assets/images/2026/11//0a1b2c3d-x.png', 'thegolflab/assets/other/2026/11/0a1b2c3d-x.png', 5, null, undefined]) assert.equal(isMediaKey(bad, 'thegolflab'), false, String(bad));
  assert.equal(isMediaKey(KEY, 'thegolfla'), false, 'a prefix that is only a prefix of the folder name does not match');
  assert.equal(isMediaKey(KEY, 'thegolflab/assets'), false);
  assert.equal(isMediaKey(KEY, ''), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Allowlist, limits, request checks
// ---------------------------------------------------------------------------------------------------------------------
test('the allowlist is exactly the seven images and videos; SVG and everything else is refused', () => {
  assert.deepEqual(Object.keys(MEDIA_TYPES).sort(), ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']);
  assert.deepEqual([...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES].sort(), Object.keys(MEDIA_TYPES).sort());
  for (const bad of ['image/svg+xml', 'image/svg', 'text/html', 'application/pdf', 'application/octet-stream', 'application/x-msdownload', 'application/zip', 'audio/mpeg', 'image/tiff', 'image/heic', 'image/bmp', 'video/quicktime', 'IMAGE/PNG', 'image/png; charset=x', ' image/png', '', undefined, null, 5, '__proto__', 'constructor', 'toString']) {
    assert.equal(isAllowedMediaType(bad), false, String(bad));
    assert.equal(checkUpload({ contentType: bad, size: 10 }).code, 'type_not_allowed', String(bad));
  }
});

test('size limits: images 15 MB, video 250 MB, overridable; zero, negative, fractional and non-numbers are refused', () => {
  assert.equal(MAX_IMAGE_BYTES, 15 * 1024 * 1024);
  assert.equal(MAX_VIDEO_BYTES, 250 * 1024 * 1024);
  assert.deepEqual(DEFAULT_MEDIA_LIMITS, { maxImageBytes: MAX_IMAGE_BYTES, maxVideoBytes: MAX_VIDEO_BYTES });
  assert.equal(checkUpload({ contentType: 'image/png', size: MAX_IMAGE_BYTES }).ok, true);
  assert.equal(checkUpload({ contentType: 'image/png', size: MAX_IMAGE_BYTES + 1 }).code, 'too_large');
  assert.equal(checkUpload({ contentType: 'video/mp4', size: MAX_IMAGE_BYTES + 1 }).ok, true);
  assert.equal(checkUpload({ contentType: 'video/webm', size: MAX_VIDEO_BYTES }).ok, true);
  assert.equal(checkUpload({ contentType: 'video/webm', size: MAX_VIDEO_BYTES + 1 }).code, 'too_large');
  assert.equal(checkUpload({ contentType: 'image/png', size: 0 }).code, 'empty');
  for (const size of [-1, 1.5, NaN, Infinity, '10', null, undefined, 2 ** 60]) assert.equal(checkUpload({ contentType: 'image/png', size }).code, 'invalid', String(size));
  const small = mediaLimits({ maxImageBytes: 1000, maxVideoBytes: 5000 });
  assert.equal(checkUpload({ contentType: 'image/png', size: 1001 }, small).code, 'too_large');
  assert.equal(checkUpload({ contentType: 'video/mp4', size: 5000 }, small).ok, true);
  assert.deepEqual(mediaLimits({ maxImageBytes: -5, maxVideoBytes: NaN }), DEFAULT_MEDIA_LIMITS);
  assert.match(checkUpload({ contentType: 'image/png', size: MAX_IMAGE_BYTES + 1 }).message, /15 MB/);
  assert.equal(describeBytes(15 * 1024 * 1024), '15 MB'); assert.equal(describeBytes(2048), '2 KB'); assert.equal(describeBytes(10), '10 B');
});

test('no client-controlled key, bucket or prefix: the only inputs are filename, type and size, and the key comes from the server', () => {
  const key = buildMediaKey({ ...fixed, contentType: 'image/png', filename: 'thegolflab/assets/images/2026/11/deadbeef-evil.png' });
  assert.equal(key, 'thegolflab/assets/images/2026/11/0a1b2c3d-deadbeef-evil.png', 'a key typed as the filename is just a name');
  assert.equal(buildMediaKey({ ...fixed, contentType: 'image/png', filename: '../../other-client/assets/images/x.png' }), 'thegolflab/assets/images/2026/11/0a1b2c3d-x.png');
  assert.deepEqual(Object.keys(checkUpload({ contentType: 'image/png', size: 5 })).sort(), ['contentType', 'ext', 'kind', 'ok']);
});

test('displayFilename keeps a readable label and drops paths, control and direction characters', () => {
  assert.equal(displayFilename('C:\\Users\\x\\Range Photo.png'), 'Range Photo.png');
  assert.equal(displayFilename('/a/b/../c.png'), 'c.png');
  assert.equal(displayFilename('a\u202Eb\u0000.png'), 'ab.png');
  assert.equal(displayFilename('x'.repeat(500)).length, 120);
  assert.equal(displayFilename(''), 'upload'); assert.equal(displayFilename(undefined), 'upload'); assert.equal(displayFilename('///'), 'upload');
  assert.equal(displayFilename('  many   spaces  .png'), 'many spaces .png');
});

// ---------------------------------------------------------------------------------------------------------------------
// Magic bytes and dimensions, with small generated files
// ---------------------------------------------------------------------------------------------------------------------
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const l16 = n => [n & 255, (n >> 8) & 255];
const l24 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const l32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const txt = text => [...Buffer.from(text, 'latin1')];
const bytes = (...parts) => Uint8Array.from(parts.flatMap(part => [...part]));
const png = (w, h) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32(13), txt('IHDR'), u32(w), u32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0], u32(0), txt('IEND'));
const gif = (w, h, v = 'GIF89a') => bytes(txt(v), l16(w), l16(h), [0xf7, 0, 0], new Array(20).fill(0));
const jpeg = (w, h, { sof = 0xc0, app = 0 } = {}) => bytes([0xff, 0xd8], [0xff, 0xe0], [0, 16], txt('JFIF\0'), [1, 1, 0, 0, 1, 0, 1, 0, 0], app ? [[0xff, 0xe1], [(app + 2) >> 8, (app + 2) & 255], new Array(app).fill(7)].flat() : [], [0xff, sof, 0, 17, 8], [h >> 8, h & 255, w >> 8, w & 255], [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xff, 0xda, 0, 12]);
const webpX = (w, h) => bytes(txt('RIFF'), l32(30), txt('WEBP'), txt('VP8X'), l32(10), [0x10, 0, 0, 0], l24(w - 1), l24(h - 1));
const webpLossy = (w, h) => bytes(txt('RIFF'), l32(30), txt('WEBP'), txt('VP8 '), l32(10), [0x10, 0x02, 0x00], [0x9d, 0x01, 0x2a], l16(w), l16(h), [0, 0]);
const webpLossless = (w, h) => bytes(txt('RIFF'), l32(25), txt('WEBP'), txt('VP8L'), l32(5), [0x2f], l32((w - 1) | ((h - 1) << 14)));
const box = (type, ...body) => { const content = body.flatMap(part => [...part]); return bytes(u32(8 + content.length), txt(type), content); };
const avif = (sizes = [[800, 600]], { major = 'avif', compat = ['avif', 'mif1', 'miaf'] } = {}) => bytes(
  box('ftyp', txt(major), u32(0), compat.flatMap(txt)),
  box('meta', [0, 0, 0, 0], box('hdlr', new Array(20).fill(0)), box('iprp', box('ipco', ...sizes.map(([w, h]) => box('ispe', [0, 0, 0, 0], u32(w), u32(h)))))),
  box('mdat', new Array(16).fill(1)));
const mp4 = (major = 'isom') => bytes(box('ftyp', txt(major), u32(512), txt('isomiso2avc1mp41')), box('moov', new Array(8).fill(0)));
const webm = (doctype = 'webm') => bytes([0x1a, 0x45, 0xdf, 0xa3], [0x9f], [0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08], [0x42, 0x82, 0x80 | doctype.length], txt(doctype), [0x42, 0x87, 0x81, 0x04]);

test('sniffMediaType recognises each allowed type by its first bytes only', () => {
  assert.equal(sniffMediaType(jpeg(10, 10)), 'image/jpeg');
  assert.equal(sniffMediaType(png(10, 10)), 'image/png');
  assert.equal(sniffMediaType(gif(2, 2)), 'image/gif');
  assert.equal(sniffMediaType(gif(2, 2, 'GIF87a')), 'image/gif');
  assert.equal(sniffMediaType(webpX(10, 10)), 'image/webp');
  assert.equal(sniffMediaType(avif()), 'image/avif');
  assert.equal(sniffMediaType(avif([[1, 1]], { major: 'avis', compat: ['avis'] })), 'image/avif');
  assert.equal(sniffMediaType(avif([[1, 1]], { major: 'mif1', compat: ['mif1', 'avif'] })), 'image/avif');
  for (const major of ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ']) assert.equal(sniffMediaType(mp4(major)), 'video/mp4', major);
  assert.equal(sniffMediaType(webm()), 'video/webm');
});

test('sniffMediaType refuses SVG, HTML, executables, archives, PDF, other ISO media, Matroska, empty and truncated input', () => {
  const cases = {
    svg: txt('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), xmlSvg: txt('<?xml version="1.0"?><svg/>'), html: txt('<!doctype html><script>alert(1)</script>'),
    exe: [0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff], elf: [0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0], zip: txt('PK\x03\x04') .concat(new Array(20).fill(0)), pdf: txt('%PDF-1.7\n'),
    heic: [...box('ftyp', txt('heic'), u32(0), txt('mif1heic'))], quicktime: [...box('ftyp', txt('qt  '), u32(0), txt('qt  '))], mkv: [...webm('matroska')], mp3: [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0],
    empty: [], tiny: [0xff, 0xd8], riffOther: [...txt('RIFF'), 0, 0, 0, 0, ...txt('WAVE'), 0, 0], text: txt('hello world, this is not an image'), bmp: [0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], tiff: [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0]
  };
  for (const [name, data] of Object.entries(cases)) assert.equal(sniffMediaType(Uint8Array.from(data)), null, name);
  const spoofed = Uint8Array.from([...cases.exe]);
  assert.equal(inspectMedia(spoofed), null, 'exe bytes are not an image whatever the file is called');
});

test('readImageDimensions: png, gif, jpeg (also behind a large EXIF segment), webp (lossy, lossless, extended), avif (largest ispe), none for video', () => {
  assert.deepEqual(readImageDimensions(png(1920, 1080), 'image/png'), { width: 1920, height: 1080 });
  assert.deepEqual(readImageDimensions(gif(320, 240), 'image/gif'), { width: 320, height: 240 });
  assert.deepEqual(readImageDimensions(jpeg(4032, 3024), 'image/jpeg'), { width: 4032, height: 3024 });
  assert.deepEqual(readImageDimensions(jpeg(640, 480, { sof: 0xc2 }), 'image/jpeg'), { width: 640, height: 480 }, 'progressive');
  assert.deepEqual(readImageDimensions(jpeg(800, 600, { app: 60_000 }), 'image/jpeg'), { width: 800, height: 600 }, 'after a 60 KB metadata segment');
  assert.deepEqual(readImageDimensions(webpX(1200, 800), 'image/webp'), { width: 1200, height: 800 });
  assert.deepEqual(readImageDimensions(webpLossy(500, 333), 'image/webp'), { width: 500, height: 333 });
  assert.deepEqual(readImageDimensions(webpLossless(16383, 2), 'image/webp'), { width: 16383, height: 2 });
  assert.deepEqual(readImageDimensions(avif([[800, 600]]), 'image/avif'), { width: 800, height: 600 });
  assert.deepEqual(readImageDimensions(avif([[128, 128], [4000, 3000], [160, 120]]), 'image/avif'), { width: 4000, height: 3000 }, 'a grid or thumbnails: the largest picture');
  assert.equal(readImageDimensions(mp4(), 'video/mp4'), null);
  assert.equal(readImageDimensions(webm(), 'video/webm'), null);
});

test('readImageDimensions never throws and returns null for damaged or truncated headers and absurd sizes', () => {
  const good = [png(10, 10), gif(1, 1), jpeg(5, 5), webpX(5, 5), webpLossy(5, 5), webpLossless(5, 5), avif()];
  const types = ['image/png', 'image/gif', 'image/jpeg', 'image/webp', 'image/webp', 'image/webp', 'image/avif'];
  good.forEach((file, i) => { for (let cut = 0; cut < file.length; cut++) assert.doesNotThrow(() => readImageDimensions(file.subarray(0, cut), types[i]), `${types[i]} cut at ${cut}`); });
  assert.equal(readImageDimensions(png(0, 5), 'image/png'), null);
  assert.equal(readImageDimensions(png(100_001, 5), 'image/png'), null);
  assert.equal(readImageDimensions(jpeg(0, 0), 'image/jpeg'), null);
  assert.equal(readImageDimensions(gif(0, 5), 'image/gif'), null);
  assert.equal(readImageDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xff]), 'image/jpeg'), null);
  let seed = 7; const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) & 255;
  for (let i = 0; i < 500; i++) { const junk = Uint8Array.from({ length: 1 + (rand() % 200) }, rand); for (const t of types) assert.doesNotThrow(() => readImageDimensions(junk, t)); assert.doesNotThrow(() => sniffMediaType(junk)); }
  const loop = bytes(box('ftyp', txt('avif'), u32(0), txt('avif')), u32(8), txt('meta'));
  assert.doesNotThrow(() => readImageDimensions(loop, 'image/avif'));
});

test('inspectMedia combines the sniffed type with the dimensions when they are known', () => {
  assert.deepEqual(inspectMedia(png(3, 4)), { contentType: 'image/png', width: 3, height: 4 });
  assert.deepEqual(inspectMedia(webm()), { contentType: 'video/webm' });
  assert.deepEqual(inspectMedia(png(0, 4)), { contentType: 'image/png' }, 'unknown size is simply left out');
  assert.equal(SNIFF_BYTES, 131072);
});

test('checkStoredObject: size, declared type and the real bytes must all agree', () => {
  const file = png(30, 20);
  const base = { expectedType: 'image/png', expectedSize: 5000, storedSize: 5000, storedType: 'image/png', firstBytes: file };
  assert.deepEqual(checkStoredObject(base), { ok: true, width: 30, height: 20 });
  assert.deepEqual(checkStoredObject({ ...base, storedType: 'IMAGE/PNG; charset=binary' }), { ok: true, width: 30, height: 20 });
  assert.equal(checkStoredObject({ ...base, storedSize: 5001 }).reason, 'size_mismatch');
  assert.equal(checkStoredObject({ ...base, storedSize: 0, expectedSize: 0 }).reason, 'empty');
  assert.equal(checkStoredObject({ ...base, storedSize: MAX_IMAGE_BYTES + 1, expectedSize: MAX_IMAGE_BYTES + 1 }).reason, 'too_large');
  assert.equal(checkStoredObject({ ...base, storedType: 'image/jpeg' }).reason, 'type_mismatch');
  assert.equal(checkStoredObject({ ...base, storedType: undefined }).reason, 'type_mismatch');
  assert.equal(checkStoredObject({ ...base, firstBytes: Uint8Array.from([0x4d, 0x5a, 0x90, 0]) }).reason, 'content_mismatch', 'executable bytes named .png');
  assert.equal(checkStoredObject({ ...base, firstBytes: jpeg(3, 3) }).reason, 'content_mismatch', 'a different allowed type than declared');
  assert.equal(checkStoredObject({ ...base, firstBytes: txt('<svg xmlns="http://www.w3.org/2000/svg"/>') }).reason, 'content_mismatch');
  assert.deepEqual(checkStoredObject({ expectedType: 'video/mp4', expectedSize: 9, storedSize: 9, storedType: 'video/mp4', firstBytes: mp4() }), { ok: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// S3 client over an injected fetch
// ---------------------------------------------------------------------------------------------------------------------
function recorder(respond) {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url: String(url), ...init }); return respond(String(url), init); };
  return { calls, fetcher };
}
const headersOf = init => Object.fromEntries(Object.entries(init.headers));

test('HEAD, ranged GET and DELETE are signed header requests with the empty-payload hash and redirect refused', async () => {
  const body = png(8, 8);
  const { calls, fetcher } = recorder((url, init) => init.method === 'HEAD' ? new Response(null, { status: 200, headers: { 'content-length': '5000', 'content-type': 'image/png', etag: '"abc123"' } })
    : init.method === 'GET' ? new Response(body, { status: 206 }) : new Response(null, { status: 204 }));
  const s3 = createS3Client(B2, { fetch: fetcher, now: () => NOW });
  assert.deepEqual(await s3.head(KEY), { size: 5000, contentType: 'image/png', etag: 'abc123' });
  assert.deepEqual([...await s3.getRange(KEY, 0, SNIFF_BYTES - 1)], [...body]);
  await s3.deleteObject(KEY);
  assert.deepEqual(calls.map(call => call.method), ['HEAD', 'GET', 'DELETE']);
  for (const call of calls) {
    assert.equal(call.url, `https://s3.us-east-005.backblazeb2.com/jongo-craft/${KEY}`);
    assert.equal(call.redirect, 'error');
    assert.ok(call.signal instanceof AbortSignal, 'a timeout is always set');
    const h = headersOf(call);
    assert.equal(h['x-amz-content-sha256'], EMPTY_PAYLOAD_SHA256);
    assert.equal(h['x-amz-date'], '20261105T123015Z');
    assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=005abcdef0123456789000000a\/20261105\/us-east-005\/s3\/aws4_request, SignedHeaders=host;(?:range;)?x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(h).includes(B2.secretAccessKey));
  }
  assert.equal(headersOf(calls[1]).range, `bytes=0-${SNIFF_BYTES - 1}`);
  assert.match(headersOf(calls[1]).authorization, /SignedHeaders=host;range;/);
});

test('the client signature verifies with an independent derivation', async () => {
  const { calls, fetcher } = recorder(() => new Response(null, { status: 200, headers: { 'content-length': '1' } }));
  await createS3Client(B2, { fetch: fetcher, now: () => NOW }).head(KEY);
  const h = headersOf(calls[0]);
  const canonical = ['HEAD', `/jongo-craft/${KEY}`, '', 'host:s3.us-east-005.backblazeb2.com', `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}`, 'x-amz-date:20261105T123015Z', '', 'host;x-amz-content-sha256;x-amz-date', EMPTY_PAYLOAD_SHA256].join('\n');
  let key = createHmac('sha256', `AWS4${B2.secretAccessKey}`).update('20261105').digest();
  for (const part of ['us-east-005', 's3', 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
  const expected = createHmac('sha256', key).update(`AWS4-HMAC-SHA256\n20261105T123015Z\n20261105/us-east-005/s3/aws4_request\n${sha(canonical)}`).digest('hex');
  assert.ok(h.authorization.endsWith(`Signature=${expected}`));
});

test('storage errors become typed, secret-free MediaStorageErrors', async () => {
  const status = code => createS3Client(B2, { fetch: async () => new Response('<Error><Message>secret-ish detail</Message></Error>', { status: code }), now: () => NOW });
  for (const [code, expected] of [[404, 'not_found'], [403, 'denied'], [401, 'denied'], [500, 'unavailable'], [503, 'unavailable'], [301, 'unavailable']]) {
    await assert.rejects(status(code).head(KEY), error => error instanceof MediaStorageError && error.code === expected && !/secret-ish|backblaze|005abc|K005/.test(error.message), String(code));
  }
  const down = createS3Client(B2, { fetch: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443 with 005abcdef0123456789000000a'); }, now: () => NOW });
  await assert.rejects(down.head(KEY), error => error.code === 'unavailable' && !/ECONNREFUSED|10\.0\.0\.1|005abc/.test(error.message));
  await assert.rejects(down.getRange(KEY, 0, 10), error => error.code === 'unavailable');
  await assert.rejects(status(404).getRange(KEY, 0, 10), error => error.code === 'not_found');
  await status(404).deleteObject(KEY);
  await assert.rejects(status(500).deleteObject(KEY), error => error.code === 'unavailable');
  await assert.rejects(createS3Client(B2, { fetch: async () => new Response(null, { status: 200 }) }).head(KEY), error => error.code === 'unavailable', 'a HEAD without a length is not trusted');
});

test('getRange reads only the bytes asked for even when the server ignores Range and sends everything', async () => {
  const big = new Uint8Array(1_000_000).fill(9);
  const s3 = createS3Client(B2, { fetch: async () => new Response(big, { status: 200 }), now: () => NOW });
  assert.equal((await s3.getRange(KEY, 0, 99)).length, 100);
  await assert.rejects(s3.getRange(KEY, 5, 4), error => error.code === 'invalid');
  await assert.rejects(s3.getRange(KEY, 0, 10 * 1024 * 1024), error => error.code === 'invalid');
  await assert.rejects(s3.head('../etc'), error => error.code === 'invalid');
});

// ---------------------------------------------------------------------------------------------------------------------
// Asset documents and the picker contract
// ---------------------------------------------------------------------------------------------------------------------
test('asset document definitions validate a server-made asset and reject malformed ones', () => {
  const registry = createContentRegistry(ASSET_TYPE_DEFINITIONS);
  const image = registry.get('sanity.imageAsset');
  const doc = { _id: 'image-1', _type: 'sanity.imageAsset', url: 'https://jongo-craft.s3.us-east-005.backblazeb2.com/' + KEY, mimeType: 'image/png', size: 4321, width: 30, height: 20, originalFilename: 'Range Photo.png', storageKey: KEY, etag: 'abc', createdAt: '2026-11-05T12:30:15.000Z', uploadedBy: 'Craft session' };
  const issues = value => validateDocument(image, value, createReferenceIndex([])).filter(issue => issue.severity === 'error');
  assert.deepEqual(issues(doc), []);
  assert.ok(issues({ ...doc, url: 'javascript:alert(1)' }).some(issue => issue.path[0] === 'url'));
  assert.ok(issues({ ...doc, size: 0 }).length && issues({ ...doc, size: 1.5 }).length && issues({ ...doc, storageKey: undefined }).length && issues({ ...doc, createdAt: 'yesterday' }).length);
  assert.ok(registry.get('sanity.fileAsset'));
});

test('the picker lists uploaded assets newest first, then the supplied library by title', () => {
  const fixture = (id, name) => ({ _id: id, _type: 'sanity.imageAsset', url: `/assets/${name}`, originalFilename: name });
  const upload = (id, name, createdAt) => ({ _id: id, _type: 'sanity.imageAsset', url: `https://x/${name}`, originalFilename: name, size: 10, createdAt });
  const index = createReferenceIndex([], [fixture('a', 'zebra.png'), fixture('b', 'apple.png'), upload('c', 'old.png', '2026-01-01T00:00:00.000Z'), upload('d', 'new.png', '2026-11-05T00:00:00.000Z'), upload('e', 'mid.png', '2026-06-01T00:00:00.000Z')]);
  const names = query => searchReferences(index, ['sanity.imageAsset'], query, new Map()).map(item => item.title);
  assert.deepEqual(names(''), ['new.png', 'mid.png', 'old.png', 'apple.png', 'zebra.png']);
  assert.deepEqual(names('png'), ['new.png', 'mid.png', 'old.png', 'apple.png', 'zebra.png']);
  assert.deepEqual(names('mid'), ['mid.png']);
  assert.ok(UPLOAD_MESSAGES.verify_failed.includes('could not be verified'));
});
