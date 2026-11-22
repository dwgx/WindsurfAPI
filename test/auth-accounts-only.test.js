// PR #194 — per-instance account isolation. Multi-port deployments share one
// accounts.json; WAPI_ACCOUNTS_ONLY must filter by email or account id, be
// case-insensitive, and fail closed for a non-blank value with no tokens.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { accountsOnlyFilter, accountAllowedByFilter } from '../src/auth.js';

const AUTH_URL = new URL('../src/auth.js', import.meta.url).href;

describe('WAPI_ACCOUNTS_ONLY', () => {
  it('is disabled when unset or blank', () => {
    assert.equal(accountsOnlyFilter({}), null);
    assert.equal(accountsOnlyFilter({ WAPI_ACCOUNTS_ONLY: '' }), null);
    assert.equal(accountsOnlyFilter({ WAPI_ACCOUNTS_ONLY: '   ' }), null);
  });

  it('parses a comma-separated list case-insensitively', () => {
    const filter = accountsOnlyFilter({ WAPI_ACCOUNTS_ONLY: ' A@Example.com, 1234abcd ,B@example.com ' });
    assert.deepEqual([...filter], ['a@example.com', '1234abcd', 'b@example.com']);
  });

  it('fails closed for a non-blank value with no tokens', () => {
    const filter = accountsOnlyFilter({ WAPI_ACCOUNTS_ONLY: ' , , ' });
    assert.ok(filter instanceof Set);
    assert.equal(filter.size, 0);
    assert.equal(accountAllowedByFilter({ email: 'a@example.com', id: '1234abcd' }, filter), false);
  });

  it('matches email or account id, case-insensitively', () => {
    const filter = accountsOnlyFilter({ WAPI_ACCOUNTS_ONLY: 'a@example.com,1234abcd' });
    assert.equal(accountAllowedByFilter({ email: 'A@EXAMPLE.COM', id: 'ffff' }, filter), true);
    assert.equal(accountAllowedByFilter({ email: 'other@example.com', id: '1234ABCD' }, filter), true);
    assert.equal(accountAllowedByFilter({ email: 'other@example.com', id: 'ffff' }, filter), false);
  });

  it('allows every account when the filter is null', () => {
    assert.equal(accountAllowedByFilter({ email: 'a@example.com', id: '1234' }, null), true);
    assert.equal(accountAllowedByFilter({}, null), true);
  });

  it('does not match an empty email or id against an empty filter token', () => {
    const filter = new Set(['']);
    assert.equal(accountAllowedByFilter({ email: '', id: '' }, filter), false);
  });

  it('keeps filtered-out accounts on disk when this instance saves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wapi-accounts-only-'));
    try {
      writeFileSync(join(dir, 'accounts.json'), JSON.stringify([
        { id: 'a1', email: 'a@example.com', apiKey: 'sk-a', method: 'api_key', status: 'active', addedAt: 1 },
        { id: 'b1', email: 'b@example.com', apiKey: 'sk-b', method: 'api_key', status: 'active', addedAt: 1 },
      ]));
      const script = `
        const auth = await import(${JSON.stringify(AUTH_URL)});
        auth.__setModelCatalogDeps({ disableConnectSync: true, getCascadeModelConfigs: async () => ({ configs: [] }) });
        auth.__loadAccountsForTest();
        auth.addAccountByKey('sk-new', 'new');
        auth.saveAccountsSync();
        await auth.__waitForModelCatalogSync();
        process.stdout.write('RESULT:' + JSON.stringify(auth.__serializeAccounts().map(a => a.apiKey)));
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          DATA_DIR: dir,
          WAPI_ACCOUNTS_ONLY: 'a@example.com',
          WINDSURFAPI_SKIP_DOTENV: '1',
          REPLICA_ISOLATE: '0',
        },
      });
      assert.equal(child.status, 0, child.stderr || child.stdout);
      const saved = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'));
      const keys = saved.map(a => a.apiKey).sort();
      assert.deepEqual(keys, ['sk-a', 'sk-b', 'sk-new'],
        'the filtered instance must preserve b@example.com and its own new account');
      assert.deepEqual(JSON.parse(child.stdout.split('RESULT:').pop()).sort(), ['sk-a', 'sk-b', 'sk-new']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
