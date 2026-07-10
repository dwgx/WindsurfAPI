import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, resolvePublicAddresses, resolveProxyConnectHost } from '../src/net-safety.js';
import { parseGenericDataUrl } from '../src/image.js';

describe('SSRF private address detection', () => {
  it('blocks IPv4 private, loopback, link-local, and carrier-grade NAT ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1']) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    assert.equal(isPrivateIp('8.8.8.8'), false);
  });

  it('blocks IPv6 loopback, unique-local, link-local, and IPv4-mapped private addresses', () => {
    for (const ip of ['::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:192.168.1.9']) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    assert.equal(isPrivateIp('2001:4860:4860::8888'), false);
  });

  it('rejects hostnames after DNS resolution to private IPs', async () => {
    const lookup = (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    await assert.rejects(() => resolvePublicAddresses('evil.example', lookup), /ERR_PROXY_PRIVATE_IP/);
  });

  it('rejects oversized generic data URLs', () => {
    const tooLarge = 'data:application/pdf;base64,' + 'A'.repeat(Math.ceil(5 * 1024 * 1024 * 4 / 3) + 200);
    assert.throws(() => parseGenericDataUrl(tooLarge), /Data URL exceeds/);
  });
});

// #11 (W6): proxy connect used the hostname, so net.connect / http CONNECT
// re-resolved it — a second DNS lookup an attacker controls (rebinding).
// resolveProxyConnectHost resolves ONCE and hands back a vetted IP literal to
// dial, so the address we validate is the address we connect to.
describe('proxy connect host pinning (#11 DNS rebinding TOCTOU)', () => {
  it('returns the validated public IP literal so the socket does no second lookup', async () => {
    const lookup = (h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);
    const ip = await resolveProxyConnectHost('proxy.example', { lookupFn: lookup });
    assert.equal(ip, '93.184.216.34');
    assert.equal(isPrivateIp(ip), false);
  });

  it('rejects when DNS resolves the proxy host to a private IP', async () => {
    const lookup = (h, o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    await assert.rejects(() => resolveProxyConnectHost('rebind.evil', { lookupFn: lookup }), /ERR_PROXY_PRIVATE_IP/);
  });

  it('rejects when ANY resolved address is private (mixed public+private rebinding answer)', async () => {
    const lookup = (h, o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]);
    await assert.rejects(() => resolveProxyConnectHost('mixed.evil', { lookupFn: lookup }), /ERR_PROXY_PRIVATE_IP/);
  });

  it('rejects a private IP literal and localhost by default', async () => {
    await assert.rejects(() => resolveProxyConnectHost('192.168.1.5'), /ERR_PROXY_PRIVATE_IP/);
    await assert.rejects(() => resolveProxyConnectHost('localhost'), /ERR_PROXY_PRIVATE_HOST/);
  });

  it('passes a public IP literal straight through (no resolution needed)', async () => {
    assert.equal(await resolveProxyConnectHost('1.1.1.1'), '1.1.1.1');
  });

  it('allowPrivate=1 still pins to a literal but permits private targets', async () => {
    const lookup = (h, o, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]);
    assert.equal(await resolveProxyConnectHost('internal.corp', { allowPrivate: true, lookupFn: lookup }), '10.0.0.5');
    assert.equal(await resolveProxyConnectHost('192.168.1.5', { allowPrivate: true }), '192.168.1.5');
  });

  it('surfaces an empty DNS answer instead of dialing nothing', async () => {
    const lookup = (h, o, cb) => cb(null, []);
    await assert.rejects(() => resolveProxyConnectHost('void.example', { lookupFn: lookup }), /ERR_PROXY_DNS_EMPTY/);
  });
});
