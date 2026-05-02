// v2.0.57 Fix 1 — RegisterUser dual-path. Verify
// `registerWithFirebaseToken` tries register.windsurf.com first and
// falls back to api.codeium.com on failure. Mock requestFn so we don't
// hit real Windsurf during tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerWithFirebaseToken } from '../src/windsurf-api.js';

describe('registerWithFirebaseToken — dual-path migration (v2.0.57 Fix 1)', () => {
  it('returns from new endpoint when it succeeds', async () => {
    const calls = [];
    const requestFn = async (url) => {
      calls.push(url);
      return {
        status: 200,
        data: { api_key: 'sk-new-123', name: 'alice', api_server_url: 'https://server.codeium.com' },
        raw: '{"api_key":"sk-new-123"}',
      };
    };
    const r = await registerWithFirebaseToken('fbtoken123', { requestFn });
    assert.equal(r.apiKey, 'sk-new-123');
    assert.equal(r.source, 'new');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /register\.windsurf\.com/);
  });

  it('falls back to legacy endpoint when new returns 5xx', async () => {
    const calls = [];
    const requestFn = async (url) => {
      calls.push(url);
      if (url.includes('register.windsurf.com')) {
        return { status: 502, data: { error: 'bad gateway' }, raw: '{"error":"bad gateway"}' };
      }
      return {
        status: 200,
        data: { api_key: 'sk-legacy-456', name: 'bob' },
        raw: '{"api_key":"sk-legacy-456"}',
      };
    };
    const r = await registerWithFirebaseToken('fbtoken123', { requestFn });
    assert.equal(r.apiKey, 'sk-legacy-456');
    assert.equal(r.source, 'legacy');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /register\.windsurf\.com/);
    assert.match(calls[1], /api\.codeium\.com/);
  });

  it('handles camelCase response shape', async () => {
    const requestFn = async () => ({
      status: 200,
      data: { apiKey: 'sk-camel-789', name: 'charlie', apiServerUrl: 'https://x' },
      raw: '',
    });
    const r = await registerWithFirebaseToken('fbtoken', { requestFn });
    assert.equal(r.apiKey, 'sk-camel-789');
    assert.equal(r.apiServerUrl, 'https://x');
  });

  it('throws when both endpoints fail', async () => {
    const requestFn = async () => ({ status: 500, data: { error: 'down' }, raw: 'down' });
    await assert.rejects(
      () => registerWithFirebaseToken('fbtoken', { requestFn }),
      /both endpoints/i,
    );
  });

  it('rejects empty/missing token early', async () => {
    await assert.rejects(() => registerWithFirebaseToken(''), /firebase token required/i);
    await assert.rejects(() => registerWithFirebaseToken(null), /firebase token required/i);
  });

  it('falls through to legacy when new throws (network error)', async () => {
    const calls = [];
    const requestFn = async (url) => {
      calls.push(url);
      if (url.includes('register.windsurf.com')) {
        throw new Error('ENOTFOUND register.windsurf.com');
      }
      return { status: 200, data: { api_key: 'sk-x' }, raw: '' };
    };
    const r = await registerWithFirebaseToken('t', { requestFn });
    assert.equal(r.apiKey, 'sk-x');
    assert.equal(r.source, 'legacy');
  });
});
