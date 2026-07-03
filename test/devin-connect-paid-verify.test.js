import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyProbe, runSweep } from '../scripts/devin-connect-paid-verify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const script = join(root, 'scripts', 'devin-connect-paid-verify.mjs');

function runScript(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const fakeCatalog = [
  { selector: 'swe-1-6-slow', alias: 'swe-1.6-slow', provider: 'cognition', isFreeDefault: true },
  { selector: 'claude-opus-4-8-medium', alias: 'claude-opus-4.8', provider: 'anthropic', isFreeDefault: false },
  { selector: 'gpt-5-5-low', alias: 'gpt-5.5', provider: 'openai', isFreeDefault: false },
];
const FREE_SELECTOR = 'swe-1-6-slow';
const makeChat = (paidBehavior) => async ({ model }) => {
  if (model === FREE_SELECTOR) return { content: 'ALIVE' };
  return paidBehavior(model);
};
const deps = (extra) => ({
  fetchUserStatus: async () => ({ isPaid: false, plan: 'free' }),
  fetchCatalog: async () => fakeCatalog,
  ...extra,
});

describe('devin-connect paid-verify harness', () => {
  it('runs its offline self-test clean with no token, no network, no billing', async () => {
    // PAID_VERIFY_REAL unset → self-test path. Must exit 0 and never fire a probe.
    const { code, stdout } = await runScript({ PAID_VERIFY_REAL: '' });
    assert.equal(code, 0, `self-test exit 0\n${stdout}`);
    assert.match(stdout, /SELFTEST\] OK/);
    assert.match(stdout, /no token, no network, no billing/);
  });

  it('refuses to fire real probes without a token', async () => {
    const { code, stderr } = await runScript({ PAID_VERIFY_REAL: '1', CONNECT_SMOKE_PAID_TOKEN: '', CONNECT_SMOKE_TOKEN: '', DEVIN_CONNECT_TOKEN: '', DEVIN_SESSION_TOKEN: '' });
    assert.equal(code, 2, 'no-token guard exits 2');
    assert.match(stderr, /no token/);
  });

  it('classifyProbe buckets each upstream outcome', () => {
    assert.equal(classifyProbe({ content: 'PAID_OK' }).bucket, 'reachable');
    assert.equal(classifyProbe({ error: { code: 'MODEL_BLOCKED', message: 'x' } }).bucket, 'tier-wall');
    assert.equal(classifyProbe({ error: { code: 'UNAUTHORIZED', message: 'x' } }).bucket, 'dead-token');
    assert.equal(classifyProbe({ error: { code: 'RATE_LIMITED', message: 'x' } }).bucket, 'error');
    assert.equal(classifyProbe({ content: '   ' }).bucket, 'error');
  });

  it('reclassifies a bare UNAUTHORIZED on a paid selector to tier-wall when the free model proves the token alive (#42)', async () => {
    // The whole point: a free→paid request gets `permission_denied`/"internal
    // error" indistinguishable from a dead token. The free-model liveness baseline
    // is what disambiguates — without it this harness would slander a working
    // token as dead, exactly the bug that hid in the handler.
    const r = await runSweep({
      token: 'fake', real: true,
      deps: deps({ chat: makeChat(() => { throw { code: 'UNAUTHORIZED', message: 'an internal error occurred (trace ID: x)' }; }) }),
    });
    assert.equal(r.tokenAlive, true, 'free probe proved liveness');
    assert.ok(r.rows.every((row) => row.bucket === 'tier-wall'), `all tier-wall, got ${r.rows.map((x) => x.bucket).join(',')}`);
  });

  it('keeps paid UNAUTHORIZED as dead-token (and verdict DEAD) when the liveness probe itself fails', async () => {
    const r = await runSweep({
      token: 'fake', real: true,
      deps: deps({ chat: async () => { throw { code: 'UNAUTHORIZED', message: 'dead' }; } }),
    });
    assert.equal(r.tokenAlive, false);
    assert.match(r.verdict, /DEAD/);
    assert.ok(r.rows.every((row) => row.bucket === 'dead-token'), 'no false tier-wall without a live baseline');
  });

  it('confirms paid entitlement when every selector is reachable', async () => {
    const r = await runSweep({
      token: 'fake', real: true,
      deps: deps({ fetchUserStatus: async () => ({ isPaid: true, plan: 'pro' }), fetchCatalog: async () => fakeCatalog, chat: makeChat(() => ({ content: 'PAID_OK' })) }),
    });
    assert.ok(r.rows.every((row) => row.bucket === 'reachable'));
    assert.match(r.verdict, /CONFIRMED/);
  });
});
