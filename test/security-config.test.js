import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey,
  getAccountList,
  removeAccount,
  shouldRejectInsecureExternalBind,
  canAccessVerboseHealth,
} from '../src/auth.js';
import {
  DEFAULT_HOST,
  defaultLsBinaryPath,
  defaultLsDataDir,
  defaultWorkspaceDir,
  shouldForwardCallerEnvironment,
} from '../src/config.js';
import { extractCallerEnvironment, resolveForwardedCallerEnvironment } from '../src/handlers/chat.js';

const createdAccountIds = [];

afterEach(() => {
  while (createdAccountIds.length) {
    removeAccount(createdAccountIds.pop());
  }
});

describe('secure binding defaults', () => {
  it('uses localhost-only default host', () => {
    assert.equal(DEFAULT_HOST, '127.0.0.1');
  });

  it('rejects non-local binds when both API and dashboard auth are empty', () => {
    assert.equal(shouldRejectInsecureExternalBind('0.0.0.0', '', ''), true);
    assert.equal(shouldRejectInsecureExternalBind('::', '', ''), true);
    assert.equal(shouldRejectInsecureExternalBind('10.0.0.5', '', ''), true);
  });

  it('allows localhost bind without auth and non-local bind with auth', () => {
    assert.equal(shouldRejectInsecureExternalBind('127.0.0.1', '', ''), false);
    assert.equal(shouldRejectInsecureExternalBind('0.0.0.0', 'x-api-key', ''), false);
    assert.equal(shouldRejectInsecureExternalBind('0.0.0.0', '', 'dashboard-pass'), false);
  });
});

describe('verbose health gating', () => {
  it('requires configured API key before verbose health can be shown', () => {
    assert.equal(canAccessVerboseHealth('any-token', ''), false);
    assert.equal(canAccessVerboseHealth('wrong', 'secret'), false);
    assert.equal(canAccessVerboseHealth('secret', 'secret'), true);
  });
});

describe('account list redaction', () => {
  it('does not expose full api keys in default account listing', () => {
    const account = addAccountByKey(`test-key-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'redaction-check');
    createdAccountIds.push(account.id);

    const listed = getAccountList().find(a => a.id === account.id);
    assert.ok(listed);
    assert.equal(typeof listed.keyPrefix, 'string');
    assert.ok(!('apiKey' in listed));
  });

  it('can expose api key only when explicitly requested for privileged operations', () => {
    const account = addAccountByKey(`test-key-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'redaction-privileged');
    createdAccountIds.push(account.id);

    const listed = getAccountList({ includeSecrets: true }).find(a => a.id === account.id);
    assert.ok(listed?.apiKey);
  });
});

describe('caller environment forwarding policy', () => {
  const messages = [
    { role: 'system', content: 'You are Claude Code.\n<env>\nWorking directory: /repo/project\nPlatform: linux\nOS Version: Linux\n</env>' },
    { role: 'user', content: 'check files' },
  ];

  it('keeps extraction capability intact for parser-level tests', () => {
    const extracted = extractCallerEnvironment(messages);
    assert.match(extracted, /Working directory: \/repo\/project/);
  });

  it('does not forward caller environment when forwarding is disabled', () => {
    const forwarded = resolveForwardedCallerEnvironment(messages, { enabled: false });
    assert.equal(forwarded, '');
  });

  it('forwards caller environment only when explicitly enabled', () => {
    const forwarded = resolveForwardedCallerEnvironment(messages, { enabled: true });
    assert.match(forwarded, /Working directory: \/repo\/project/);
  });

  it('recognizes explicit forward caller env flag values', () => {
    assert.equal(shouldForwardCallerEnvironment('1'), true);
    assert.equal(shouldForwardCallerEnvironment('true'), true);
    assert.equal(shouldForwardCallerEnvironment('0'), false);
    assert.equal(shouldForwardCallerEnvironment(''), false);
  });
});

describe('platform-aware LS/workspace defaults', () => {
  it('builds macOS LS binary default from HOME', () => {
    const p = defaultLsBinaryPath({
      platform: 'darwin',
      home: '/Users/alice',
      arch: 'arm64',
    });
    assert.equal(p, '/Users/alice/.windsurf/language_server_macos_arm');
  });

  it('builds macOS LS data dir and generic workspace path without unsupported platform defaults', () => {
    const lsData = defaultLsDataDir({
      platform: 'darwin',
      home: '/Users/alice',
    });
    const workspace = defaultWorkspaceDir({
      tmpDir: '/var/tmp',
      hostname: 'devbox',
    });
    assert.equal(lsData.replace(/\\/g, '/'), '/Users/alice/.windsurf/data');
    assert.equal(workspace.replace(/\\/g, '/'), '/var/tmp/windsurf-workspace-devbox');
  });
});
