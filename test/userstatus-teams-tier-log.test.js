// #245: the maintainer asked for the `UserStatus ... teams_tier=... plan=...`
// line, and the proxy never emitted one. The UserStatus/Tier-change lines report
// only `account.tier`, i.e. the tier AFTER mapTeamsTier ran, so a teams account
// whose TeamsTier enum decodes as UNSPECIFIED(0) reads exactly like a genuine
// free account in the log — which is the one thing the line has to distinguish.
//
// The signal pinned here is the value the mapping actually consumed
// (status.teamsTier, the raw enum) together with the tier it produced
// (status.tierName). It must NOT be emitted for a response with no teams
// evidence at all: a plain free account carries teams_tier=0 by protobuf
// default, and printing it there would look like the #245 failure and train the
// reader to ignore the line.
//
// fetchUserStatus talks to the language server and the gRPC client, so the test
// executes the production function body with only those two imports substituted
// — the same source-slice harness test/s4-r3.test.js uses for refreshCredits.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { safeAccountRef } from '../src/log-safety.js';
import { sanitizeLabelText } from '../src/auth.js';

const AUTH_JS = readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');
const HEAD = 'export async function fetchUserStatus(id, { allowLsStart = true } = {}) {';

/** Run the real fetchUserStatus against a fixed GetUserStatus response. */
function load(status, { account = {}, models = {} } = {}) {
  const start = AUTH_JS.indexOf(HEAD);
  assert.ok(start >= 0, 'fetchUserStatus must be present in src/auth.js');
  const end = AUTH_JS.indexOf('\n}\n', start);
  assert.ok(end > start, 'locate the end of fetchUserStatus');
  const block = AUTH_JS.slice(start, end + 3)
    .replace(/^export /gm, '')
    .replace("await import('./client.js')", 'await Promise.resolve(_client)')
    .replace("await import('./langserver.js')", 'await Promise.resolve(_ls)');
  assert.ok(block.includes('_client') && block.includes('_ls'), 'both network imports must be substituted');

  const acct = { id: 'acct-1', apiKey: 'sk-ws-01-secret-token', tier: 'unknown', ...account };
  const accounts = [acct];
  const lines = { info: [], warn: [], debug: [], error: [] };
  const deps = {
    accounts,
    // V-26: fetchUserStatus revalidates the row + credential after its RPC with
    // the same identity predicate the rest of auth.js uses.
    isCurrentAccount: (a) => Boolean(a) && accounts.find(x => x.id === a.id) === a,
    _client: { WindsurfClient: class { async getUserStatus() { return status; } } },
    _ls: { ensureLs: async () => {}, getLsFor: () => ({ port: 42100, csrfToken: 'csrf' }) },
    getEffectiveProxy: () => null,
    getLsAdmissionForAccount: () => ({}),
    residentProbeSkip: () => null,
    saveAccounts: () => {},
    MODELS: models,
    log: {
      debug: (...a) => lines.debug.push(a.join(' ')),
      info: (...a) => lines.info.push(a.join(' ')),
      warn: (...a) => lines.warn.push(a.join(' ')),
      error: (...a) => lines.error.push(a.join(' ')),
    },
    safeAccountRef,
    // fetchUserStatus sanitizes upstream-supplied fields through the real
    // label boundary — inject the helper, do not reimplement it.
    sanitizeLabelText,
  };
  const fn = new Function(...Object.keys(deps), `${block}\nreturn fetchUserStatus;`)(...Object.values(deps));
  return { fn, account: acct, lines };
}

/** The shape parseGetUserStatusResponse always returns. */
function statusOf(overrides = {}) {
  return {
    pro: false,
    teamsTier: 0,
    tierName: 'free',
    email: '',
    displayName: '',
    teamId: '',
    userUsedPromptCredits: 0,
    userUsedFlowCredits: 0,
    trialEndMs: 0,
    maxPremiumChatMessages: 0,
    planName: '',
    monthlyPromptCredits: 0,
    monthlyFlowCredits: 0,
    hasPaidFeatures: false,
    isTeams: false,
    isEnterprise: false,
    allowedModels: [],
    ...overrides,
  };
}

const teamsLine = (lines) => lines.find(l => l.includes('teams_tier='));

describe('#245 teams_tier log line — raw enum plus the tier it mapped to', () => {
  it('reports the raw TeamsTier and the mapped tier on a teams response', async () => {
    const { fn, account, lines } = load(statusOf({
      teamsTier: 3, tierName: 'pro', planName: 'Enterprise', isTeams: true, isEnterprise: true,
    }));
    await fn('acct-1');

    const line = teamsLine(lines.info);
    assert.ok(line, 'a teams response must emit the teams_tier line');
    assert.match(line, /teams_tier=3\b/, 'raw enum the mapping consumed');
    assert.match(line, /mapped=pro\b/, 'tier mapTeamsTier produced from it');
    assert.match(line, /plan="Enterprise"/, 'the maintainer greps teams_tier and plan together');

    // No behaviour change: the mapped tier is still what lands on the account.
    assert.equal(account.tier, 'pro');
    assert.equal(account.userStatus.teamsTier, 3);
  });

  it('still reports teams_tier=0 for a teams plan — the exact #245 shape', async () => {
    // Hypothesis from the issue: a teams account reporting teams_tier=0 reads as
    // free until a refresh re-promotes it. Gating the line on teamsTier > 0 would
    // hide precisely the failure the maintainer is asking us to expose.
    const { fn, account, lines } = load(statusOf({
      teamsTier: 0, tierName: 'free', planName: 'Enterprise', isTeams: true,
    }));
    await fn('acct-1');

    const line = teamsLine(lines.info);
    assert.ok(line, 'a teams plan whose enum decoded as 0 must still be logged');
    assert.match(line, /teams_tier=0\b/);
    assert.match(line, /mapped=free\b/);
    assert.equal(account.tier, 'free', 'the mapping itself is unchanged');
  });

  it('does not fire on the non-teams path', async () => {
    const { fn, lines } = load(statusOf({
      teamsTier: 0, tierName: 'free', planName: 'Free',
    }), { account: { tier: 'free' } });
    await fn('acct-1');

    assert.equal(teamsLine(lines.info), undefined,
      'a plain free response carries teams_tier=0 only as the protobuf default; logging it would fake a teams plan');
    // The ordinary tier line must still be there — absence above is not a dead log.
    assert.ok(lines.info.some(l => l.includes('UserStatus') && l.includes('tier=free') && l.includes('plan="Free"')),
      'the pre-existing UserStatus line still fires');
  });

  it('fires alongside the Tier change line, not only on the unchanged branch', async () => {
    const { fn, lines } = load(statusOf({
      teamsTier: 3, tierName: 'pro', planName: 'Enterprise', isTeams: true, isEnterprise: true,
    }), { account: { tier: 'free' } });
    await fn('acct-1');

    assert.ok(lines.info.some(l => l.startsWith('Tier change ')), 'tier actually changed');
    const line = teamsLine(lines.info);
    assert.ok(line, 'the diagnostic must survive the branch that reports the change');
    assert.match(line, /teams_tier=3\b/);
    assert.match(line, /mapped=pro\b/);
  });

  it('reports what the mapping saw even when tierManual pins the applied tier', async () => {
    // The raw enum is the input to the mapping, not a restatement of
    // account.tier: under the operator escape hatch (#8) the mapping still runs
    // but its result is discarded, and the log must show both facts.
    const { fn, account, lines } = load(statusOf({
      teamsTier: 3, tierName: 'pro', planName: 'Enterprise', isTeams: true, isEnterprise: true,
    }), { account: { tier: 'free', tierManual: true } });
    await fn('acct-1');

    const line = teamsLine(lines.info);
    assert.ok(line, 'a pinned tier must not suppress the raw signal');
    assert.match(line, /teams_tier=3\b/);
    assert.match(line, /mapped=pro\b/);
    assert.equal(account.tier, 'free', 'tierManual still wins for the applied tier');
  });

  it('carries no account secret or raw email', async () => {
    const { fn, lines } = load(statusOf({
      teamsTier: 2, tierName: 'pro', planName: 'Pro', email: 'user@example.com',
    }), { account: { email: 'user@example.com', name: 'Real Name' } });
    await fn('acct-1');

    const line = teamsLine(lines.info);
    assert.ok(line, 'pro-tier response with a populated enum is still a teams_tier observation');
    for (const out of lines.info) {
      assert.ok(!out.includes('sk-ws-01-secret-token'), 'api key must never be logged');
      assert.ok(!out.includes('user@example.com'), 'email is logged only as a hash');
      assert.ok(!out.includes('Real Name'), 'display label is logged only as a hash');
    }
  });
});

// P2 (wave-7 review): GetUserStatus deliberately preserved a prior
// `reason:'success'` when the refreshed allowlist omitted that enum, so a
// Pro/trial success survived a downgrade or trial expiry indefinitely. The
// refreshed snapshot is authoritative: an enum it no longer lists becomes
// not_entitled, and only a call that succeeds AFTER the snapshot can restore
// success (updateCapability writes the newer lastCheck).
describe('P2 — a refreshed allowlist denial supersedes an older success', () => {
  const MODELS_FIXTURE = {
    'glm-4.7': { enumValue: 417 },
    'kimi-k2': { enumValue: 323 },
  };

  it('writes not_entitled over a success the refreshed allowlist omits', async () => {
    const { fn, account } = load(statusOf({
      tierName: 'free', planName: 'Free',
      allowedModels: [{ modelEnum: 417 }],
    }), {
      account: {
        tier: 'pro',
        capabilities: { 'kimi-k2': { ok: true, reason: 'success', lastCheck: 1 } },
      },
      models: MODELS_FIXTURE,
    });

    await fn('acct-1');

    assert.deepEqual(
      { ok: account.capabilities['glm-4.7'].ok, reason: account.capabilities['glm-4.7'].reason },
      { ok: true, reason: 'user_status' },
      'the enum the allowlist still lists stays positive',
    );
    assert.deepEqual(
      { ok: account.capabilities['kimi-k2'].ok, reason: account.capabilities['kimi-k2'].reason },
      { ok: false, reason: 'not_entitled' },
      'the snapshot that omitted kimi-k2 is newer than the success and must win',
    );
  });
});
