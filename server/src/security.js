import dns from 'node:dns/promises';
import net from 'node:net';

export class AppError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Pull every http(s) URL out of free text (people paste "look at this https://..."). */
export function extractUrls(text) {
  if (typeof text !== 'string') return [];
  const found = text.match(URL_RE) || [];
  return [...new Set(found.map((u) => u.replace(/[),.;!?\]]+$/, '')))];
}

/** Validate and sanitize one URL. Throws AppError. Returns a URL object. */
export function sanitizeUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new AppError('EMPTY_URL', 'Paste a video link first.');
  }
  const raw = input.trim();
  if (raw.length > 2048) throw new AppError('URL_TOO_LONG', 'That link is too long.');
  const candidate = extractUrls(raw)[0] || raw;

  let u;
  try {
    u = new URL(candidate);
  } catch {
    throw new AppError('INVALID_URL', 'That does not look like a valid link.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new AppError('INVALID_SCHEME', 'Only http and https links are supported.');
  }
  if (u.username || u.password) {
    throw new AppError('INVALID_URL', 'Links containing a username or password are not allowed.');
  }
  if (u.port && u.port !== '80' && u.port !== '443') {
    throw new AppError('INVALID_PORT', 'Links with a custom port are not allowed.');
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || (!host.includes('.') && !net.isIP(host.replace(/^\[|\]$/g, '')))) {
    throw new AppError('BLOCKED_HOST', 'Links to local or internal addresses are not allowed.', 403);
  }
  u.hash = '';
  return u;
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([b, m]) => [ipv4ToInt(b), m === 0 ? 0 : (~0 << (32 - m)) >>> 0]);

/** True for loopback, private, link-local, CGNAT, multicast, reserved, metadata addresses. */
export function isPrivateIp(ip) {
  let addr = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) addr = mapped[1];
  const kind = net.isIP(addr);
  if (kind === 4) {
    const n = ipv4ToInt(addr);
    return V4_BLOCKS.some(([base, mask]) => (n & mask) === (base & mask));
  }
  if (kind === 6) {
    if (addr === '::' || addr === '::1') return true;
    if (/^(fc|fd)/.test(addr)) return true; // unique local
    if (/^fe[89ab]/.test(addr)) return true; // link-local
    if (/^ff/.test(addr)) return true; // multicast
    if (addr.startsWith('2001:db8')) return true; // documentation
    if (addr.startsWith('64:ff9b:')) return true; // NAT64 → could reach v4 internals
    return false;
  }
  return true; // not an IP at all → treat as unsafe
}

/** SSRF guard: resolve the hostname and refuse if ANY address is internal. */
export async function assertPublicHost(hostname, { allowPrivate = false, lookup = dns.lookup } = {}) {
  if (allowPrivate) return;
  const host = hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host }];
  } else {
    try {
      addrs = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new AppError('DNS_FAILED', 'Could not reach that website. Check the link and your connection.', 400);
    }
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new AppError('BLOCKED_HOST', 'Links to local or internal addresses are not allowed.', 403);
  }
}

/** Safe file name piece for the Content-Disposition header. */
export function safeFileName(name) {
  return String(name || 'video')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
    .slice(0, 180);
}
