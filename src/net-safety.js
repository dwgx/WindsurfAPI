import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns';

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(n => Number(n));
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function ipv4InCidr(ip, base, bits) {
  const n = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (n == null || b == null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) === (b & mask);
}

function expandIpv6(ip) {
  let input = ip.toLowerCase();
  const zone = input.indexOf('%');
  if (zone !== -1) input = input.slice(0, zone);
  if (input === '::') return Array(8).fill(0);
  const [leftRaw, rightRaw] = input.split('::');
  const left = leftRaw ? leftRaw.split(':').filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(':').filter(Boolean) : [];
  const parsePart = (part) => {
    if (part.includes('.')) {
      const n = ipv4ToInt(part);
      if (n == null) return [];
      return [(n >>> 16) & 0xffff, n & 0xffff];
    }
    return [parseInt(part || '0', 16)];
  };
  const leftNums = left.flatMap(parsePart);
  const rightNums = right.flatMap(parsePart);
  const missing = 8 - leftNums.length - rightNums.length;
  if (missing < 0) return null;
  return [...leftNums, ...Array(missing).fill(0), ...rightNums].map(n => Number.isFinite(n) ? n : 0);
}

function ipv6StartsWith(ip, prefix, bits) {
  const a = expandIpv6(ip);
  const p = expandIpv6(prefix);
  if (!a || !p) return false;
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((a[i] & mask) !== (p[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

function mappedIpv4(ip) {
  const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  const parts = expandIpv6(ip);
  if (!parts) return null;
  if (parts.slice(0, 5).every(n => n === 0) && parts[5] === 0xffff) {
    return `${parts[6] >>> 8}.${parts[6] & 255}.${parts[7] >>> 8}.${parts[7] & 255}`;
  }
  return null;
}

export function isPrivateIp(address) {
  if (!address) return false;
  const ip = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = mappedIpv4(ip);
  if (mapped) return isPrivateIp(mapped);
  const family = net.isIP(ip);
  if (family === 4) {
    return ipv4InCidr(ip, '0.0.0.0', 8)
      || ipv4InCidr(ip, '10.0.0.0', 8)
      || ipv4InCidr(ip, '100.64.0.0', 10)
      || ipv4InCidr(ip, '127.0.0.0', 8)
      || ipv4InCidr(ip, '169.254.0.0', 16)
      || ipv4InCidr(ip, '172.16.0.0', 12)
      || ipv4InCidr(ip, '192.168.0.0', 16);
  }
  if (family === 6) {
    return ip === '::' || ip === '::1'
      || ipv6StartsWith(ip, 'fc00::', 7)
      || ipv6StartsWith(ip, 'fe80::', 10);
  }
  return false;
}

export async function resolvePublicAddresses(hostname, lookupFn = dnsLookup) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (!host || host.toLowerCase() === 'localhost') throw new Error('ERR_PROXY_PRIVATE_HOST');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('ERR_PROXY_PRIVATE_IP');
    return [{ address: host, family: net.isIP(host) }];
  }
  const result = await new Promise((resolve, reject) => {
    lookupFn(host, { all: true }, (err, addrs) => err ? reject(err) : resolve(addrs));
  });
  const addrs = Array.isArray(result) ? result : [result];
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('ERR_PROXY_PRIVATE_IP');
  }
  return addrs;
}

