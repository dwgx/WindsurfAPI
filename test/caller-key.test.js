import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callerKeyFromRequest, extractBodyCallerSubKey } from '../src/caller-key.js';

function fakeReq({ headers = {}, ip = '127.0.0.1' } = {}) {
  return { headers, socket: { remoteAddress: ip } };
}

describe('extractBodyCallerSubKey (v2.0.25 HIGH-3)', () => {
  it('returns empty for body with no user signal', () => {
    assert.equal(extractBodyCallerSubKey({}), '');
    assert.equal(extractBodyCallerSubKey(null), '');
    assert.equal(extractBodyCallerSubKey({ messages: [], model: 'm' }), '');
  });

  it('returns a digest when body.user is present (OpenAI chat convention)', () => {
    const k = extractBodyCallerSubKey({ user: 'alice@example.com' });
    assert.ok(k && k.length === 16);
  });

  it('different users yield different digests', () => {
    const a = extractBodyCallerSubKey({ user: 'alice' });
    const b = extractBodyCallerSubKey({ user: 'bob' });
    assert.notEqual(a, b);
  });

  it('audit S6: surrounding whitespace does not split one user into two buckets', () => {
    // usableSignal trims, so " alice " and "alice" map to the same tenant scope
    // (previously the raw untrimmed value hashed into different :user: buckets).
    assert.equal(extractBodyCallerSubKey({ user: ' alice ' }), extractBodyCallerSubKey({ user: 'alice' }));
    assert.equal(extractBodyCallerSubKey({ user: '\talice\n' }), extractBodyCallerSubKey({ user: 'alice' }));
    // whitespace-only is still no signal
    assert.equal(extractBodyCallerSubKey({ user: '   ' }), '');
  });

  it('uses Responses-style previous_response_id when no user', () => {
    const k = extractBodyCallerSubKey({ previous_response_id: 'resp_abc123' });
    assert.ok(k && k.length === 16);
  });

  it('does NOT inspect metadata.user_id (handled by messages.js parser)', () => {
    // metadata.user_id is the Anthropic Claude Code device id field; the
    // /v1/messages handler has a specialized parser for its JSON-encoded
    // shape and appends `:user:` itself. Two-handler stamping would
    // double-prefix the callerKey, so caller-key.js stays out of it.
    assert.equal(extractBodyCallerSubKey({ metadata: { user_id: '{"device_id":"abc"}' } }), '');
  });
});

describe('extractBodyCallerSubKey empty-value fail-closed (audit)', () => {
  // Before the fix, `typeof body.user === 'string'` accepted "" / "   " and
  // hashed them to the constant sha256("") prefix, minting a shared :user:
  // segment across every distinct end user of a common key (cross-tenant
  // answer bleed). Empty/whitespace must fall through, never mint a scope.
  it('returns empty for user:"" (no constant sha256("") scope)', () => {
    assert.equal(extractBodyCallerSubKey({ user: '' }), '');
  });

  it('returns empty for whitespace-only user', () => {
    assert.equal(extractBodyCallerSubKey({ user: '   ' }), '');
    assert.equal(extractBodyCallerSubKey({ user: '\t\n ' }), '');
  });

  it('empty user does NOT collapse to a real user digest', () => {
    const empty = extractBodyCallerSubKey({ user: '' });
    const real = extractBodyCallerSubKey({ user: 'alice' });
    assert.equal(empty, '');
    assert.notEqual(empty, real);
  });

  it('falls through to sibling candidates when user is empty', () => {
    // Empty user must not short-circuit; a real conversation id should
    // still produce a scope via the candidates path.
    const k = extractBodyCallerSubKey({ user: '', conversation: 'conv-xyz' });
    assert.ok(k && k.length === 16);
    // and it must match the same body without the empty user field
    assert.equal(k, extractBodyCallerSubKey({ conversation: 'conv-xyz' }));
  });

  it('empty sibling fields (conversation / previous_response_id / metadata.*) mint no scope', () => {
    assert.equal(extractBodyCallerSubKey({ conversation: '' }), '');
    assert.equal(extractBodyCallerSubKey({ conversation: '   ' }), '');
    assert.equal(extractBodyCallerSubKey({ previous_response_id: '' }), '');
    assert.equal(extractBodyCallerSubKey({ metadata: { conversation_id: '' } }), '');
    assert.equal(extractBodyCallerSubKey({ metadata: { session_id: '  ' } }), '');
    assert.equal(
      extractBodyCallerSubKey({ user: '', conversation: '', previous_response_id: '', metadata: { conversation_id: '', session_id: '' } }),
      '',
    );
  });
});

describe('callerKeyFromRequest empty-user fail-closed (audit)', () => {
  it('user:"" does NOT mint :user: — falls back to :client: (IP+UA)', () => {
    const k = callerKeyFromRequest(fakeReq(), 'sk-test-key', { user: '' });
    assert.doesNotMatch(k, /:user:/);
    assert.match(k, /^api:[a-f0-9]+:client:[a-f0-9]{16}$/);
  });

  it('whitespace user:"   " does NOT mint :user:', () => {
    const k = callerKeyFromRequest(fakeReq(), 'sk-test-key', { user: '   ' });
    assert.doesNotMatch(k, /:user:/);
  });

  it('empty and whitespace users do NOT collapse into the same callerKey as each other or a real user', () => {
    // Distinct physical clients so the :client: fallback keeps them apart;
    // if the empty-user bug were present both would carry the same constant
    // :user: segment and compare equal regardless of IP/UA.
    const kEmpty = callerKeyFromRequest(
      fakeReq({ ip: '1.1.1.1', headers: { 'user-agent': 'cli/a' } }), 'shared', { user: '' },
    );
    const kSpace = callerKeyFromRequest(
      fakeReq({ ip: '2.2.2.2', headers: { 'user-agent': 'cli/b' } }), 'shared', { user: '   ' },
    );
    const kReal = callerKeyFromRequest(
      fakeReq({ ip: '3.3.3.3', headers: { 'user-agent': 'cli/c' } }), 'shared', { user: 'alice' },
    );
    assert.notEqual(kEmpty, kSpace);
    assert.notEqual(kEmpty, kReal);
    assert.notEqual(kSpace, kReal);
  });

  it('a real non-empty user still scopes as before', () => {
    const k = callerKeyFromRequest(fakeReq(), 'sk-test-key', { user: 'alice' });
    assert.match(k, /^api:[a-f0-9]+:user:[a-f0-9]{16}$/);
  });

});

describe('callerKeyFromRequest with body', () => {
  it('appends :user:<digest> when body has a user signal', () => {
    const k = callerKeyFromRequest(fakeReq(), 'sk-test-key', { user: 'alice' });
    assert.match(k, /^api:[a-f0-9]+:user:[a-f0-9]{16}$/);
  });

  it('falls back to :client:<ip+ua-digest> when body has no user signal', () => {
    // v2.0.37 (#93 follow-up): bare apiKey + no body user used to drop
    // straight to "shared API key, no per-user scope" and disable
    // cascade reuse. Now we synthesize a stable per-physical-client
    // subkey from IP + UA so single-user self-hosted setups can reuse.
    const k = callerKeyFromRequest(fakeReq(), 'sk-test-key', {});
    assert.match(k, /^api:[a-f0-9]+:client:[a-f0-9]{16}$/);
  });

  it('two end-users on same shared API key get different keys', () => {
    const ka = callerKeyFromRequest(fakeReq(), 'shared-key', { user: 'alice' });
    const kb = callerKeyFromRequest(fakeReq(), 'shared-key', { user: 'bob' });
    assert.notEqual(ka, kb);
  });

  it('two physical clients on same apiKey land on different subkeys via IP+UA', () => {
    // The v2.0.37 fallback must not collapse distinct clients into one
    // pool — that would re-introduce the cross-user cascade bleed
    // v2.0.25 originally guarded against.
    const ka = callerKeyFromRequest(
      fakeReq({ ip: '1.2.3.4', headers: { 'user-agent': 'claude-cli/1.0' } }),
      'shared-key', null,
    );
    const kb = callerKeyFromRequest(
      fakeReq({ ip: '5.6.7.8', headers: { 'user-agent': 'claude-cli/1.0' } }),
      'shared-key', null,
    );
    assert.notEqual(ka, kb);
    assert.match(ka, /^api:[a-f0-9]+:client:[a-f0-9]{16}$/);
  });

  it('same physical client across turns lands on the same subkey (reuse precondition)', () => {
    // The whole point of the v2.0.37 fallback: stable identity across
    // requests so the cascade pool actually finds the prior entry.
    const ka = callerKeyFromRequest(
      fakeReq({ ip: '1.2.3.4', headers: { 'user-agent': 'claude-cli/1.0' } }),
      'shared-key', null,
    );
    const kb = callerKeyFromRequest(
      fakeReq({ ip: '1.2.3.4', headers: { 'user-agent': 'claude-cli/1.0' } }),
      'shared-key', null,
    );
    assert.equal(ka, kb);
  });

  it('omits :client: when no IP and no UA are extractable', () => {
    // Defensive: if both IP and UA are empty strings the fallback
    // produces no useful identity so we fall back to the bare apiKey.
    const k = callerKeyFromRequest({ headers: {} }, 'sk-test-key', {});
    assert.match(k, /^api:[a-f0-9]+$/);
  });

  it('falls back to header session id when no API key', () => {
    const k = callerKeyFromRequest(fakeReq({ headers: { 'x-session-id': 'sess-xyz' } }));
    assert.match(k, /^session:[a-f0-9]+$/);
  });

  it('falls back to ip+ua when nothing else available', () => {
    const k = callerKeyFromRequest(fakeReq({ ip: '1.2.3.4', headers: { 'user-agent': 'Mozilla/X' } }));
    assert.match(k, /^client:[a-f0-9]+$/);
  });
});

// hasCallerScope() removed 2026-07-11 (audit S1): it was dead + diverged from
// the live gate chat.js:hasPerUserScope. Scope-gate coverage lives with that
// function; these tests exercised the dead twin and were removed with it.
