import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  addAccountByKey,
  configureBindHost,
  getAccountList,
  removeAccount,
  shouldEmitNoAuthWarning,
  validateApiKey,
} from '../src/auth.js';

const originalApiKey = config.apiKey;
const createdAccountIds = [];

afterEach(() => {
  config.apiKey = originalApiKey;
  configureBindHost('0.0.0.0');
  while (createdAccountIds.length) removeAccount(createdAccountIds.pop());
});

describe('shouldEmitNoAuthWarning', () => {
  it('warns when unauthenticated service binds all interfaces', () => {
    assert.equal(shouldEmitNoAuthWarning('0.0.0.0', false), true);
    assert.equal(shouldEmitNoAuthWarning('::', false), true);
  });

  it('does not warn for localhost or configured auth', () => {
    assert.equal(shouldEmitNoAuthWarning('127.0.0.1', false), false);
    assert.equal(shouldEmitNoAuthWarning('0.0.0.0', true), false);
  });

  it('allows missing API_KEY only on local binds', () => {
    config.apiKey = '';
    configureBindHost('127.0.0.1');
    assert.equal(validateApiKey(''), true);
    configureBindHost('::1');
    assert.equal(validateApiKey(''), true);
    configureBindHost('[::1]');
    assert.equal(validateApiKey(''), true);
    configureBindHost('::ffff:127.0.0.1');
    assert.equal(validateApiKey(''), true);
    // Empty bindHost is "didn't configure / Node defaults to all interfaces"
    // which is non-local. Must fail closed.
    configureBindHost('');
    assert.equal(validateApiKey(''), false);

    configureBindHost('0.0.0.0');
    assert.equal(validateApiKey(''), false);
    configureBindHost('192.168.1.10');
    assert.equal(validateApiKey('anything'), false);
  });

  it('compares configured API_KEY without default-allowing missing or wrong keys', () => {
    config.apiKey = 'server-secret';
    configureBindHost('0.0.0.0');

    assert.equal(validateApiKey('server-secret'), true);
    assert.equal(validateApiKey('wrong'), false);
    assert.equal(validateApiKey(''), false);
  });

  it('returns masked account keys without the raw upstream apiKey', () => {
    const key = `abcd1234efgh5678-${Date.now()}`;
    const account = addAccountByKey(key, 'masked-list');
    createdAccountIds.push(account.id);

    const listed = getAccountList().find(a => a.id === account.id);
    assert.equal(listed.apiKey, undefined);
    assert.equal(listed.apiKey_masked, `${key.slice(0, 8)}...${key.slice(-4)}`);
    assert.equal(listed.keyPrefix, 'abcd1234...');
  });
});
