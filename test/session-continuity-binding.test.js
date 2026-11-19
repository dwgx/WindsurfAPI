import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as continuity from '../src/session-continuity.js';
import { stripImageParts } from '../src/devin-connect.js';
import { solidPngBase64 } from './helpers/png-encode.mjs';

const env = { DEVIN_CONNECT_SESSION_REUSE: '1', DEVIN_CONNECT_MODEL_CONFIG_STABLE: '1' };
const caller = 'session:fixture';
const message = (role, content) => ({ role, content });
const answer = message('assistant', 'done');
const bind = (messages, options = env) => continuity.resolveSessionBinding(caller, messages, options);
const commit = (binding, request, options = env) =>
  continuity.commitSessionBinding(caller, binding, [...request, answer], options);
const png = solidPngBase64(1, 1, [28, 60, 92, 255]);
const otherPng = solidPngBase64(1, 1, [47, 83, 121, 255]);
const imageUrl = data => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } });
const imageBlock = data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });

describe('Connect dispatch binding', () => {
  beforeEach(() => continuity._resetForTests());

  it('fingerprints image bytes and part order consistently across inline carriers', () => {
    const text = { type: 'text', text: 'sample' };
    const events = (...parts) => continuity.canonicalize([message('user', parts)]);
    assert.notDeepEqual(events(text, imageUrl(png)), events(text, imageUrl(otherPng)));
    assert.deepEqual(events(text, imageBlock(png)), events(text, imageUrl(png)));
    assert.notDeepEqual(events(text, imageUrl(png)), events(imageUrl(png), text));
    assert.ok(!JSON.stringify(events(imageBlock(png))).includes(png));
  });

  it('commits identical completed records independently to the two selected states, in reverse order', () => {
    const first = bind([message('user', 'first work item')]);
    const second = bind([message('user', 'second work item')]);
    assert.notEqual(first.sessionId, second.sessionId);
    const completed = [message('user', 'check status')];
    assert.equal(commit(second, completed), second.sessionId);
    assert.equal(commit(first, completed), first.sessionId);
    assert.equal(commit(first, completed), first.sessionId);
    assert.equal(commit(second, completed), second.sessionId);
    assert.equal(continuity._getStoreSize(), 2);
    assert.equal(continuity._getIndexStats().commitKeys, 2);
  });

  it('advances each original dispatch once when two ordinary requests finish out of order', () => {
    const requestA = [message('user', 'catalogue one item')];
    const requestB = [message('user', 'list one task')];
    const a = bind(requestA);
    const b = bind(requestB);
    assert.equal(commit(b, requestB), b.sessionId);
    assert.equal(commit(a, requestA), a.sessionId);
    for (const [request, receipt] of [[requestA, a], [requestB, b]]) {
      const follow = bind([...request, answer, message('user', 'next step')]);
      assert.equal(follow.sessionId, receipt.sessionId);
      assert.equal(follow.modelConfig.turn, 2);
    }
  });

  it('opens a fresh state when a completed opener arrives again without history', () => {
    const request = [message('user', 'one work item')];
    const first = bind(request);
    assert.equal(commit(first, request), first.sessionId);
    const again = bind(request);
    assert.notEqual(again.sessionId, first.sessionId);
    assert.equal(again.modelConfig.turn, 1);
    assert.equal(continuity._getStoreSize(), 2);
    const continued = bind([...request, answer, message('user', 'next')]);
    assert.equal(continued.sessionId, first.sessionId);
    assert.equal(continued.modelConfig.turn, 2);
  });

  it('selects text continuity after the model capability strip removes an image', () => {
    const text = { type: 'text', text: 'one work item' };
    const { messages, dropped } = stripImageParts([message('user', [text, imageUrl(png)])]);
    assert.equal(dropped, 1);
    const receipt = bind(messages);
    assert.equal(commit(receipt, messages), receipt.sessionId);
    const follow = bind([message('user', text.text), answer, message('user', 'continue')]);
    assert.equal(follow.sessionId, receipt.sessionId);
    assert.equal(follow.modelConfig.turn, 2);
  });

  it('rejects missing, copied, wrong-scope and evicted receipts without creating a replacement', () => {
    const request = [message('user', 'one work item')];
    const receipt = bind(request);
    assert.equal(commit(null, request), null);
    assert.equal(commit({ ...receipt }, request), null);
    assert.equal(continuity.commitSessionBinding('session:other-fixture', receipt, [...request, answer], env), null);
    assert.equal(continuity._getIndexStats().commitKeys, 0);
    const other = bind([message('user', 'new work item')], { ...env, DEVIN_CONNECT_SESSION_MAX_STATES: '1' });
    assert.notEqual(other.sessionId, receipt.sessionId);
    assert.equal(commit(receipt, request), null);
    assert.equal(continuity._getStoreSize(), 1);
  });

  it('refuses a completion after its selected state expires', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const options = { ...env, DEVIN_CONNECT_SESSION_TTL_MS: '50' };
    const request = [message('user', 'short scope')];
    const receipt = bind(request, options);
    t.mock.timers.tick(51);
    assert.equal(commit(receipt, request, options), null);
    assert.equal(continuity._getIndexStats().commitKeys, 0);
  });

  it('keeps the first accepted completion for concurrent dispatches at the same revision', () => {
    const request = [message('user', 'one work item')];
    const earlier = bind(request);
    const later = bind(request);
    assert.equal(earlier.sessionId, later.sessionId);
    assert.equal(commit(later, request), later.sessionId);
    assert.equal(continuity.commitSessionBinding(caller, earlier, [...request, message('assistant', 'other result')], env), null);
    assert.equal(commit(earlier, request), earlier.sessionId);
    assert.equal(continuity._getIndexStats().commitKeys, 1);
  });

  it('advances identical turns past the pair window while retries of each receipt stay idempotent', () => {
    const history = [];
    let sessionId;
    for (let turn = 1; turn <= 14; turn++) {
      history.push(message('user', 'status'));
      const receipt = bind(history);
      sessionId ??= receipt.sessionId;
      assert.equal(receipt.sessionId, sessionId);
      assert.equal(receipt.modelConfig.turn, turn, 'each completed dispatch advances the next turn once');
      assert.equal(commit(receipt, history), sessionId);
      assert.equal(commit(receipt, history), sessionId);
      history.push(answer);
    }
    assert.equal(continuity._getStoreSize(), 1);
    assert.equal(continuity._getIndexStats().commitKeys, 14);
  });

  it('preserves pure-image turn identity and gives unidentifiable images the fresh path', () => {
    const request = [message('user', [imageUrl(png)])];
    const receipt = bind(request);
    assert.ok(receipt.sessionId);
    assert.equal(commit(receipt, request), receipt.sessionId);
    const next = bind([message('user', [imageBlock(png)]), answer, message('user', 'continue')]);
    assert.equal(next.sessionId, receipt.sessionId);
    assert.equal(next.modelConfig.turn, 2);
    assert.notEqual(bind([message('user', [imageUrl(otherPng)])]).sessionId, receipt.sessionId);
    for (const part of [
      { type: 'image_url', image_url: { url: 'https://fixture.invalid/image' } },
      imageBlock('%%%'), { type: 'input_image', file_id: 'fixture' },
    ]) {
      assert.equal(bind([message('user', [part])]), null);
    }
    assert.equal(continuity._getStoreSize(), 2);
    assert.equal(bind(request, {}), null);
  });
});
