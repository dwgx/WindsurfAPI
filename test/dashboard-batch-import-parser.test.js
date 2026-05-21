import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BatchImportParseError, parseBatchImportInput } from '../src/dashboard/import-parser.js';

function parseProxyUrl(proxy) {
  const s = String(proxy || '').trim();
  if (/^\w+:\/\//.test(s)) return { type: 'http', host: 'proxy.example.com', port: 8080 };
  if (/^[^:\s]+:\d+$/.test(s)) return { type: 'http', host: s.split(':')[0], port: Number(s.split(':')[1]) };
  return null;
}

describe('parseBatchImportInput text mode', () => {
  it('supports multiple separators without breaking old whitespace format', () => {
    const input = [
      'alpha@example.com pass123',
      'beta@example.com    pass456',
      'gamma@example.com\tpass789',
      'delta@example.com----pass000',
      'echo@example.com|pass111',
      'foxtrot@example.com,pass222',
      'golf@example.com:pass333',
    ].join('\n');
    const parsed = parseBatchImportInput(input, parseProxyUrl);
    assert.equal(parsed.mode, 'text');
    assert.equal(parsed.items.length, 7);
    assert.deepEqual(
      parsed.items.map(item => item.kind),
      Array(7).fill('email_password')
    );
    assert.deepEqual(
      parsed.items.map(item => item.password),
      ['pass123', 'pass456', 'pass789', 'pass000', 'pass111', 'pass222', 'pass333']
    );
  });

  it('keeps parsing valid lines when one line is invalid', () => {
    const parsed = parseBatchImportInput(
      'https://proxy.example.com:8080 user1@example.com pass1\ninvalid-line\nuser2@example.com:pass2',
      parseProxyUrl
    );
    assert.equal(parsed.items.length, 3);
    assert.equal(parsed.items[0].kind, 'email_password');
    assert.equal(parsed.items[0].proxyRaw, 'https://proxy.example.com:8080');
    assert.equal(parsed.items[1].kind, 'issue');
    assert.equal(parsed.items[1].error, 'ERR_FORMAT_INVALID');
    assert.equal(parsed.items[2].kind, 'email_password');
    assert.equal(parsed.items[2].password, 'pass2');
  });
});

describe('parseBatchImportInput json mode', () => {
  it('supports arrays, wrappers, token aliases, and api key aliases', () => {
    const payload = JSON.stringify({
      accounts: [
        { email: 'one@example.com', password: 'pass1' },
        { username: 'two@example.com', token: 'tok-2', proxy: 'http://proxy.example.com:8080' },
        { account: 'three@example.com', access_token: 'tok-3' },
        { email: 'four@example.com', api_key: 'key-4' },
        { items: 'not-used' },
      ],
    });
    const parsed = parseBatchImportInput(payload, parseProxyUrl);
    assert.equal(parsed.mode, 'json');
    assert.equal(parsed.items.length, 5);
    assert.equal(parsed.items[0].kind, 'email_password');
    assert.equal(parsed.items[1].kind, 'token');
    assert.equal(parsed.items[1].proxyRaw, 'http://proxy.example.com:8080');
    assert.equal(parsed.items[2].kind, 'token');
    assert.equal(parsed.items[3].kind, 'api_key');
    assert.equal(parsed.items[4].kind, 'issue');
    assert.equal(parsed.items[4].error, 'ERR_UNSUPPORTED_IMPORT_ITEM');
  });

  it('supports single-object payloads and throws on invalid json', () => {
    const single = parseBatchImportInput(
      JSON.stringify({ email: 'solo@example.com', pass: 'secret' }),
      parseProxyUrl
    );
    assert.equal(single.items.length, 1);
    assert.equal(single.items[0].kind, 'email_password');

    assert.throws(
      () => parseBatchImportInput('{"broken"', parseProxyUrl),
      (error) => error instanceof BatchImportParseError && error.code === 'ERR_JSON_INVALID'
    );
  });

  it('supports exported Windsurf credential objects', () => {
    const payload = JSON.stringify([
      {
        github_email: 'exported@example.com',
        windsurf_api_key: 'ws-key-123',
        windsurf_api_server_url: 'https://server.self-serve.windsurf.com',
      },
      {
        windsurf_auth_token: 'windsurf-auth-token',
        windsurf_auth_status_raw: {
          email: 'fallback@example.com',
          apiServerUrl: 'https://server.codeium.com',
        },
      },
    ]);
    const parsed = parseBatchImportInput(payload, parseProxyUrl);
    assert.equal(parsed.mode, 'json');
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.items[0].kind, 'api_key');
    assert.equal(parsed.items[0].email, 'exported@example.com');
    assert.equal(parsed.items[0].apiServerUrl, 'https://server.self-serve.windsurf.com');
    assert.equal(parsed.items[1].kind, 'token');
    assert.equal(parsed.items[1].email, 'fallback@example.com');
    assert.equal(parsed.items[1].apiServerUrl, 'https://server.codeium.com');
  });
});
