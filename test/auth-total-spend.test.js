import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAccountByKey,
  removeAccount,
  recordAccountSpend,
  getAccountPublic,
  __serializeAccounts,
  __deserializeAccount,
} from '../src/auth.js';

// K8: per-account lifetime spend accumulator. Monotonic, survives restart,
// backward-compatible with a pre-K8 accounts.json (loads as zero, never NaN).

const createdIds = [];
function addTestAccount(label = 'spend') {
  const account = addAccountByKey(`spend-key-${Date.now()}-${Math.random().toString(36).slice(2)}`, label);
  createdIds.push(account.id);
  return account;
}
afterEach(() => { while (createdIds.length) removeAccount(createdIds.pop()); });

describe('K8 — per-account lifetime spend', () => {
  it('a new account starts at zero spend', () => {
    const a = addTestAccount();
    const pub = getAccountPublic(a.id);
    assert.deepEqual(pub.totalSpend, {
      requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, creditCost: 0,
    });
  });

  it('recordAccountSpend accumulates tokens across requests', () => {
    const a = addTestAccount();
    recordAccountSpend(a.apiKey, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    recordAccountSpend(a.apiKey, { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 });
    const s = getAccountPublic(a.id).totalSpend;
    assert.equal(s.requests, 2);
    assert.equal(s.promptTokens, 150);
    assert.equal(s.completionTokens, 30);
    assert.equal(s.totalTokens, 180);
  });

  it('derives total_tokens from prompt+completion when the field is missing', () => {
    const a = addTestAccount();
    recordAccountSpend(a.apiKey, { prompt_tokens: 7, completion_tokens: 3 });
    assert.equal(getAccountPublic(a.id).totalSpend.totalTokens, 10);
  });

  it('accrues creditCost only when provided', () => {
    const a = addTestAccount();
    recordAccountSpend(a.apiKey, { total_tokens: 5 }, { creditCost: 0.25 });
    recordAccountSpend(a.apiKey, { total_tokens: 5 });
    assert.equal(getAccountPublic(a.id).totalSpend.creditCost, 0.25);
  });

  it('is a safe no-op for an unknown apiKey', () => {
    assert.doesNotThrow(() => recordAccountSpend('no-such-key', { total_tokens: 999 }));
  });

  it('ignores null/garbage usage without corrupting the counter', () => {
    const a = addTestAccount();
    recordAccountSpend(a.apiKey, null);
    recordAccountSpend(a.apiKey, { prompt_tokens: 'x', completion_tokens: undefined });
    const s = getAccountPublic(a.id).totalSpend;
    assert.equal(s.requests, 2);
    assert.equal(s.totalTokens, 0);
  });

  it('survives a serialize → load round-trip (monotonic across restart)', () => {
    const a = addTestAccount();
    recordAccountSpend(a.apiKey, { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 }, { creditCost: 1.5 });
    const serialized = __serializeAccounts().find(x => x.id === a.id);
    assert.ok(serialized._totalSpend, 'persisted');
    assert.equal(serialized._totalSpend.totalTokens, 240);
    // Rehydrate a fresh in-memory account from the persisted record.
    const restored = __deserializeAccount(serialized);
    assert.equal(restored._totalSpend.totalTokens, 240);
    assert.equal(restored._totalSpend.promptTokens, 200);
    assert.equal(restored._totalSpend.creditCost, 1.5);
    assert.equal(restored._totalSpend.requests, 1);
  });

  it('loads a pre-K8 record (no _totalSpend) as zero, not NaN', () => {
    // Simulate an accounts.json written before K8 existed.
    const legacy = { id: 'legacy-1', apiKey: 'legacy-key', status: 'active' };
    const restored = __deserializeAccount(legacy);
    assert.deepEqual(restored._totalSpend, {
      requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, creditCost: 0,
    });
  });
});
