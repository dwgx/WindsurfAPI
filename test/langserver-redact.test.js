import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactProxyUrl, buildLanguageServerEnv } from '../src/langserver.js';

describe('redactProxyUrl', () => {
  it('redacts credentials from proxy URLs', () => {
    assert.equal(redactProxyUrl('http://user:secret@example.com:8080'), 'example.com:8080 (auth=true)');
  });

  it('shows host and port for unauthenticated proxies', () => {
    assert.equal(redactProxyUrl({ host: 'proxy.example.com', port: 1080 }), 'proxy.example.com:1080');
  });
});

describe('buildLanguageServerEnv', () => {
  it('keeps only allowlisted vars and applies proxy override', () => {
    const env = buildLanguageServerEnv({
      HOME: '/home/dev',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      SECRET_TOKEN: 'should-not-pass',
      HTTP_PROXY: 'http://old-proxy:8080',
    }, { proxyUrl: 'http://new-proxy:9999' });

    assert.equal(env.HOME, '/home/dev');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HTTPS_PROXY, 'http://new-proxy:9999');
    assert.equal(env.HTTP_PROXY, 'http://new-proxy:9999');
    assert.ok(!('SECRET_TOKEN' in env));
  });
});

