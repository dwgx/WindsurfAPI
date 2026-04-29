import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, resolvePublicAddresses } from '../src/net-safety.js';
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
