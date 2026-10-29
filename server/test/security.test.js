import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHost, extractUrls, isPrivateIp, safeFileName, sanitizeUrl } from '../src/security.js';

test('extractUrls pulls links out of shared text and strips trailing punctuation', () => {
  assert.deepEqual(extractUrls('look https://youtu.be/abc123, and https://x.com/a/status/1!'),
    ['https://youtu.be/abc123', 'https://x.com/a/status/1']);
  assert.deepEqual(extractUrls('no links here'), []);
});

test('sanitizeUrl accepts normal links and drops the #fragment', () => {
  assert.equal(sanitizeUrl('  https://www.youtube.com/watch?v=abc#t=1 ').href, 'https://www.youtube.com/watch?v=abc');
  assert.equal(sanitizeUrl('Watch this: https://vm.tiktok.com/ZM123/').hostname, 'vm.tiktok.com');
});

test('sanitizeUrl rejects bad input', () => {
  const codes = (u) => { try { sanitizeUrl(u); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(codes(''), 'EMPTY_URL');
  assert.equal(codes('not a url'), 'INVALID_URL');
  assert.equal(codes('ftp://example.com/a.mp4'), 'INVALID_SCHEME');
  assert.equal(codes('file:///etc/passwd'), 'INVALID_SCHEME');
  assert.equal(codes('javascript:alert(1)'), 'INVALID_SCHEME');
  assert.equal(codes('https://user:pw@example.com/v'), 'INVALID_URL');
  assert.equal(codes('https://example.com:8080/v'), 'INVALID_PORT');
  assert.equal(codes('http://localhost/v'), 'BLOCKED_HOST');
  assert.equal(codes('http://intranet/v'), 'BLOCKED_HOST');
  assert.equal(codes('http://printer.local/v'), 'BLOCKED_HOST');
  assert.equal(codes('https://a.com/' + 'x'.repeat(3000)), 'URL_TOO_LONG');
});

test('isPrivateIp covers internal ranges (SSRF)', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '142.250.1.1', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('assertPublicHost blocks hostnames that resolve to internal IPs (DNS rebinding style)', async () => {
  const fake = (addrs) => async () => addrs.map((address) => ({ address }));
  await assert.rejects(assertPublicHost('evil.example', { lookup: fake(['93.184.216.34', '127.0.0.1']) }), { code: 'BLOCKED_HOST' });
  await assert.rejects(assertPublicHost('meta.example', { lookup: fake(['169.254.169.254']) }), { code: 'BLOCKED_HOST' });
  await assert.rejects(assertPublicHost('127.0.0.1'), { code: 'BLOCKED_HOST' });
  await assert.doesNotReject(assertPublicHost('ok.example', { lookup: fake(['93.184.216.34']) }));
  await assert.rejects(assertPublicHost('nx.example', { lookup: async () => { throw new Error('ENOTFOUND'); } }), { code: 'DNS_FAILED' });
});

test('safeFileName removes path and header-breaking characters', () => {
  assert.equal(safeFileName('../a/b:"c"\n.mp4'), '.._a_b_c_.mp4');
});
