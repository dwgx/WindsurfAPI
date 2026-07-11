import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectBackend, usesCascadeFlow, BACKEND } from '../src/backend-router.js';

// Behaviour-preserving decision table. These cases mirror the inline routing
// logic in handlers/chat.js (isSpecialAgentModelInfo → special-agent, then
// useCascade = !!(modelUid || enumValue), else legacy). If any of these change
// the router has diverged from the legacy behaviour P1 promised to preserve.

describe('backend-router selectBackend — behaviour parity with legacy', () => {
  it('special_agent backend + default mode → devin-print', () => {
    const sel = selectBackend({ modelInfo: { backend: 'special_agent' }, env: {} });
    assert.equal(sel.backend, BACKEND.DEVIN_PRINT);
    assert.equal(sel.flow, 'special_agent');
  });

  it('special_agent backend + DEVIN_CLI_MODE=acp → devin-acp', () => {
    const sel = selectBackend({ modelInfo: { backend: 'special_agent' }, env: { DEVIN_CLI_MODE: 'acp' } });
    assert.equal(sel.backend, BACKEND.DEVIN_ACP);
    assert.equal(sel.flow, 'special_agent');
  });

  it('special_agent wins even when a modelUid is also present', () => {
    const sel = selectBackend({ modelInfo: { backend: 'special_agent', modelUid: 'MODEL_X' }, env: {} });
    assert.equal(sel.flow, 'special_agent');
  });

  it('modelUid present → cascade', () => {
    const sel = selectBackend({ modelInfo: { modelUid: 'MODEL_CLAUDE_4_SONNET' }, env: {} });
    assert.equal(sel.backend, BACKEND.CASCADE);
    assert.equal(sel.flow, 'cascade');
    assert.equal(sel.reason, 'modelUid');
    assert.ok(usesCascadeFlow(sel));
  });

  it('enumValue > 0 (no uid) → cascade', () => {
    const sel = selectBackend({ modelInfo: { enumValue: 166 }, env: {} });
    assert.equal(sel.backend, BACKEND.CASCADE);
    assert.equal(sel.reason, 'enumValue');
    assert.ok(usesCascadeFlow(sel));
  });

  it('no uid and no enum → legacy', () => {
    const sel = selectBackend({ modelInfo: { enumValue: 0 }, env: {} });
    assert.equal(sel.backend, BACKEND.LEGACY);
    assert.equal(sel.flow, 'legacy');
    assert.equal(usesCascadeFlow(sel), false);
  });

  it('null modelInfo → legacy (defensive)', () => {
    const sel = selectBackend({ modelInfo: null, env: {} });
    assert.equal(sel.backend, BACKEND.LEGACY);
    assert.equal(sel.flow, 'legacy');
  });

  it('uses process.env by default (no env arg)', () => {
    // Smoke: must not throw and must return a known backend.
    const sel = selectBackend({ modelInfo: { modelUid: 'X' } });
    assert.ok(Object.values(BACKEND).includes(sel.backend));
  });

  it('DEVIN_REST constant exists but is never auto-selected in P1', () => {
    // P1 must not route anything to devin-rest yet.
    const cases = [
      { backend: 'special_agent' },
      { modelUid: 'X' },
      { enumValue: 5 },
      { enumValue: 0 },
      null,
    ];
    for (const modelInfo of cases) {
      const sel = selectBackend({ modelInfo, env: {} });
      assert.notEqual(sel.backend, BACKEND.DEVIN_REST);
    }
  });
});

// DEVIN_ONLY: Cascade retired — every request is forced onto Devin regardless
// of the model. This is the "Devin is the only core" kill-switch.
describe('backend-router selectBackend — DEVIN_ONLY (Cascade retired)', () => {
  it('forces a cascade model (claude) onto Devin when DEVIN_ONLY=1', () => {
    const sel = selectBackend({
      modelInfo: { modelUid: 'MODEL_CLAUDE_4_5_SONNET', enumValue: 200 },
      env: { DEVIN_ONLY: '1' },
    });
    assert.equal(sel.flow, 'special_agent');
    assert.equal(sel.reason, 'devin_only');
    assert.equal(sel.backend, BACKEND.DEVIN_PRINT); // default sub-mode
    assert.ok(!usesCascadeFlow(sel), 'no longer a cascade flow');
  });

  it('honours DEVIN_CLI_MODE=acp under DEVIN_ONLY', () => {
    const sel = selectBackend({
      modelInfo: { modelUid: 'MODEL_GPT_5' },
      env: { DEVIN_ONLY: '1', DEVIN_CLI_MODE: 'acp' },
    });
    assert.equal(sel.flow, 'special_agent');
    assert.equal(sel.backend, BACKEND.DEVIN_ACP);
  });

  it('forces even a legacy (no uid, no enum) model onto Devin', () => {
    const sel = selectBackend({ modelInfo: { enumValue: 0 }, env: { DEVIN_ONLY: '1' } });
    assert.equal(sel.flow, 'special_agent');
    assert.equal(sel.reason, 'devin_only');
  });

  it('forces null modelInfo onto Devin (defensive)', () => {
    const sel = selectBackend({ modelInfo: null, env: { DEVIN_ONLY: '1' } });
    assert.equal(sel.flow, 'special_agent');
    assert.equal(sel.reason, 'devin_only');
  });

  it('DEVIN_ONLY wins over a special_agent model too (same flow, devin_only reason)', () => {
    const sel = selectBackend({ modelInfo: { backend: 'special_agent' }, env: { DEVIN_ONLY: '1' } });
    assert.equal(sel.flow, 'special_agent');
    assert.equal(sel.reason, 'devin_only');
  });

  it('DEVIN_ONLY=0 / unset leaves legacy routing intact (cascade still selected)', () => {
    const off = selectBackend({ modelInfo: { modelUid: 'MODEL_CLAUDE_4_5_SONNET' }, env: { DEVIN_ONLY: '0' } });
    assert.equal(off.flow, 'cascade');
    const unset = selectBackend({ modelInfo: { modelUid: 'MODEL_CLAUDE_4_5_SONNET' }, env: {} });
    assert.equal(unset.flow, 'cascade');
  });

  it('only the exact value "1" enables DEVIN_ONLY (truthy-string guard)', () => {
    for (const v of ['true', 'yes', '2', 'on', ' ']) {
      const sel = selectBackend({ modelInfo: { modelUid: 'MODEL_X' }, env: { DEVIN_ONLY: v } });
      assert.equal(sel.flow, 'cascade', `DEVIN_ONLY=${JSON.stringify(v)} must NOT enable`);
    }
    // surrounding whitespace around "1" is tolerated
    const padded = selectBackend({ modelInfo: { modelUid: 'MODEL_X' }, env: { DEVIN_ONLY: ' 1 ' } });
    assert.equal(padded.flow, 'special_agent');
  });
});

// DEVIN_CONNECT: pure-HTTP cloud egress (no local CLI). Highest precedence —
// retires both Cascade and the Devin CLI.
describe('backend-router selectBackend — DEVIN_CONNECT (pure-HTTP egress)', () => {
  it('routes a cascade model to DEVIN_CONNECT when DEVIN_CONNECT=1', () => {
    const sel = selectBackend({
      modelInfo: { modelUid: 'MODEL_CLAUDE_4_5_SONNET' },
      env: { DEVIN_CONNECT: '1' },
    });
    assert.equal(sel.backend, BACKEND.DEVIN_CONNECT);
    assert.equal(sel.flow, 'devin_connect');
    assert.equal(sel.reason, 'devin_connect');
  });

  it('routes a legacy (no-uid-no-enum) request to DEVIN_CONNECT too', () => {
    const sel = selectBackend({ modelInfo: { enumValue: 0 }, env: { DEVIN_CONNECT: '1' } });
    assert.equal(sel.backend, BACKEND.DEVIN_CONNECT);
  });

  it('wins over DEVIN_ONLY when both are set', () => {
    const sel = selectBackend({
      modelInfo: { backend: 'special_agent' },
      env: { DEVIN_CONNECT: '1', DEVIN_ONLY: '1' },
    });
    assert.equal(sel.backend, BACKEND.DEVIN_CONNECT);
    assert.equal(sel.flow, 'devin_connect');
  });

  it('wins over a special_agent model', () => {
    const sel = selectBackend({ modelInfo: { backend: 'special_agent' }, env: { DEVIN_CONNECT: '1' } });
    assert.equal(sel.backend, BACKEND.DEVIN_CONNECT);
  });

  it('DEVIN_CONNECT=0 / unset leaves routing intact', () => {
    const off = selectBackend({ modelInfo: { modelUid: 'MODEL_X' }, env: { DEVIN_CONNECT: '0' } });
    assert.equal(off.flow, 'cascade');
    const viaOnly = selectBackend({ modelInfo: { modelUid: 'MODEL_X' }, env: { DEVIN_ONLY: '1' } });
    assert.equal(viaOnly.flow, 'special_agent');
  });

  it('only the exact value "1" enables DEVIN_CONNECT (truthy-string guard)', () => {
    for (const v of ['true', 'yes', '2', 'on', ' ']) {
      const sel = selectBackend({ modelInfo: { modelUid: 'MODEL_X' }, env: { DEVIN_CONNECT: v } });
      assert.notEqual(sel.flow, 'devin_connect', `DEVIN_CONNECT=${JSON.stringify(v)} must NOT enable`);
    }
    const padded = selectBackend({ modelInfo: { modelUid: 'MODEL_X' }, env: { DEVIN_CONNECT: ' 1 ' } });
    assert.equal(padded.flow, 'devin_connect');
  });
});

// handlers/chat.js calls selectBackend TWICE per request — once early at
// chat.js:2151 (`selectBackend({ modelInfo }).flow === 'devin_connect'`, to
// short-circuit into the DEVIN_CONNECT egress BEFORE the Cascade "unsupported
// model" gate) and once as the main decision at chat.js:2779. Between those two
// calls `modelInfo` can be REASSIGNED (chat.js:2764, the model-blocked →
// default-model fallback). If the two calls could disagree, a request could be
// early-routed to DEVIN_CONNECT and then main-routed elsewhere (or vice versa),
// splitting the pipeline. These tests pin the invariants that keep the two
// calls in lockstep so a future edit to selectBackend can't silently fork them.
describe('backend-router selectBackend — double-call consistency (chat.js:2151 vs :2779)', () => {
  it('is a pure function: repeated calls with identical input are byte-identical', () => {
    const cases = [
      { modelInfo: { modelUid: 'MODEL_CLAUDE_4_5_SONNET' }, env: {} },
      { modelInfo: { backend: 'special_agent' }, env: { DEVIN_CLI_MODE: 'acp' } },
      { modelInfo: { enumValue: 0 }, env: { DEVIN_ONLY: '1' } },
      { modelInfo: { modelUid: 'X' }, env: { DEVIN_CONNECT: '1' } },
      { modelInfo: null, env: {} },
    ];
    for (const args of cases) {
      const a = selectBackend(args);
      const b = selectBackend(args);
      assert.deepEqual(a, b, `selectBackend must be deterministic for ${JSON.stringify(args)}`);
    }
  });

  it('devin_connect decision is env-only — invariant to any modelInfo swap at chat.js:2764', () => {
    // This is THE invariant protecting the early short-circuit: the 2151 check
    // only looks at .flow==='devin_connect', which selectBackend derives purely
    // from env (devinConnectEnabled). So the model-blocked fallback reassigning
    // modelInfo between 2151 and 2779 CANNOT flip the devin_connect routing.
    const env = { DEVIN_CONNECT: '1' };
    const modelInfos = [
      { modelUid: 'MODEL_CLAUDE_4_5_SONNET' },   // original requested model
      { modelUid: 'MODEL_DEFAULT_FALLBACK' },    // reassigned at 2764
      { backend: 'special_agent' },
      { enumValue: 0 },
      null,
    ];
    for (const modelInfo of modelInfos) {
      assert.equal(
        selectBackend({ modelInfo, env }).flow, 'devin_connect',
        `devin_connect must hold regardless of modelInfo=${JSON.stringify(modelInfo)}`
      );
    }
    // And when DEVIN_CONNECT is off, NO modelInfo can early-route to it.
    for (const modelInfo of modelInfos) {
      assert.notEqual(selectBackend({ modelInfo, env: {} }).flow, 'devin_connect');
    }
  });

  it('same modelInfo at both call sites → identical backend/flow/reason', () => {
    // Simulate chat.js: modelInfo resolved once, used at 2151 and again at 2779
    // WITHOUT the blocked-fallback reassignment (the common path). Both call
    // sites must land on the same backend.
    for (const env of [{}, { DEVIN_ONLY: '1' }, { DEVIN_CONNECT: '1' }]) {
      const modelInfo = { modelUid: 'MODEL_CLAUDE_4_5_SONNET', enumValue: 200 };
      const early = selectBackend({ modelInfo, env });
      const main = selectBackend({ modelInfo, env });
      assert.equal(early.backend, main.backend);
      assert.equal(early.flow, main.flow);
      assert.equal(early.reason, main.reason);
    }
  });
});
