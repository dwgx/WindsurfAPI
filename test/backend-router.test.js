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
