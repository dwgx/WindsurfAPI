import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as dashboard from '../src/dashboard/api.js';
import * as parser from '../src/dashboard/import-parser.js';

test('batch login publishes only the supported result fields and the masked key', () => {
  const account = { id: 'row-1', email: 'sample@example.test', status: 'active' };
  const result = {
    success: true, apiKey: '12345678', email: account.email, name: 'Sample',
    apiServerUrl: 'https://api.example.test', method: 'password', credentialStored: false,
    viaHost: 'login.example.test', reauthenticated: true,
    account: { ...account, internalNote: 'private field' }, internalNote: 'private field',
  };
  const publicRow = JSON.parse(JSON.stringify(dashboard.publicBatchLoginResult(result)));
  assert.deepEqual(publicRow, {
    success: true, apiKey_masked: '12...', email: account.email, name: 'Sample',
    apiServerUrl: result.apiServerUrl, method: 'password', credentialStored: false, account,
    viaHost: result.viaHost, reauthenticated: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(dashboard.publicBatchLoginResult(publicRow))), publicRow);
  assert.equal(result.apiKey, '12345678');
});

test('import validates proxy fields before formatting a public label', () => {
  const invalid = [
    { host: 'north wing' }, { host: 'node.test/path' }, { host: 'node.test:443' },
    { host: '[2001:db8::10' }, { type: 'north wing' }, { port: '80x' }, { port: 65536 },
  ];
  for (const fields of invalid) {
    const proxy = { type: 'http', host: 'node.test', port: 80, ...fields };
    const parsed = parser.parseBatchImportJsonItem({ token: 'sample', label: 'submitted label', proxy }, 7, dashboard.parseProxyUrl);
    assert.equal(parsed.kind, 'issue');
    assert.equal(parsed.error, 'ERR_PROXY_FORMAT_INVALID');
    assert.equal(parsed.lineNumber, 7);
    assert.equal(parsed.label, 'Line 7');
    assert.equal(parser.redactedProxyLabel(proxy), null);
    assert.equal(dashboard.buildBatchProxyBinding({ success: true, account: { id: 'row-1' } }, proxy), null);
  }
  for (const proxy of [[], false, 2]) {
    const parsed = parser.parseBatchImportJsonItem({ token: 'sample', proxy }, 7, dashboard.parseProxyUrl);
    assert.equal(parsed.error, 'ERR_PROXY_FORMAT_INVALID');
  }
});

test('import keeps usable public labels for DNS, IP and supported proxy types', () => {
  for (const [type, host, display] of [
    ['http', 'Proxy.Example.', 'Proxy.Example.'], ['https', 'localhost', 'localhost'],
    ['socks5', '192.0.2.1', '192.0.2.1'], ['socks', '[2001:db8::10]', '[2001:db8::10]'],
    ['socks5h', '2001:db8::10', '[2001:db8::10]'],
    ['http', 'fe80::1%eth0', '[fe80::1]'], ['http', 'münchen.example', 'münchen.example'],
  ]) {
    const proxy = { type, host, port: 1080, username: 'sample-user', password: '' };
    const parsed = parser.parseBatchImportJsonItem({ token: 'sample', proxy }, 1, dashboard.parseProxyUrl);
    assert.equal(parsed.kind, 'token');
    assert.equal(parser.redactedProxyLabel(parsed.proxy), `${type}://${display}:1080`);
    const binding = dashboard.buildBatchProxyBinding({ success: true, account: { id: 'row-1' } }, parsed.proxy);
    assert.deepEqual(binding, { accountId: 'row-1', proxy });
  }
});

test('object proxies retain bare internationalized hostnames and IDNA label separators', () => {
  for (const host of ['l·l.example', '例え。テスト', '例え．テスト', '例え｡テスト', 'カタカナ・ラベル.example', 'א׳.example']) {
    const proxy = { type: 'https', host, port: 443 };
    const entry = parser.parseBatchImportJsonItem({ token: 'sample', proxy }, 1, dashboard.parseProxyUrl);
    assert.equal(entry.kind, 'token');
    assert.equal(entry.proxy.host, host);
    assert.equal(parser.redactedProxyLabel(entry.proxy), `https://${host}:443`);
  }
});
