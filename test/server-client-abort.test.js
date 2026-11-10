// Pins the client-disconnect AbortSignal on every chat-shaped POST route.
//
// Chat and completions already bound an AbortController at the route.
// messages / gemini / responses streamed abort via captureRes, but their
// non-stream await of handleChatCompletions had no signal — hanging up left
// the upstream running. bindClientAbort is the shared seam.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { bindClientAbort } from '../src/server.js';

function fakeRes({ writableEnded = false } = {}) {
  const res = new EventEmitter();
  res.writableEnded = writableEnded;
  return res;
}

describe('bindClientAbort', () => {
  it('aborts when the client hangs up before the response ends', () => {
    const res = fakeRes();
    const ac = bindClientAbort(res);
    assert.equal(ac.signal.aborted, false);
    res.emit('close');
    assert.equal(ac.signal.aborted, true);
  });

  it('does not abort on the normal end-of-response close', () => {
    const res = fakeRes({ writableEnded: true });
    const ac = bindClientAbort(res);
    res.emit('close');
    assert.equal(ac.signal.aborted, false);
  });
});

describe('every chat-shaped POST route threads bindClientAbort into context.signal', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  function routeBlock(marker) {
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `missing route marker: ${marker}`);
    const next = src.indexOf('\n  if (', start + marker.length);
    return src.slice(start, next > start ? next : src.length);
  }

  const routes = [
    { name: 'chat/completions', marker: "if (path === '/v1/chat/completions' && method === 'POST')" },
    { name: 'completions', marker: "if (path === '/v1/completions' && method === 'POST')" },
    { name: 'responses', marker: "if (path === '/v1/responses' && method === 'POST')" },
    { name: 'messages', marker: "if (path === '/v1/messages' && method === 'POST')" },
    { name: 'gemini', marker: "if (method === 'POST' && GEMINI_GENERATE_PATH_RE.test(path))" },
  ];

  for (const { name, marker } of routes) {
    it(`${name} binds bindClientAbort and passes signal`, () => {
      const block = routeBlock(marker);
      assert.match(block, /bindClientAbort\(res\)/, `${name} must call bindClientAbort`);
      assert.match(block, /signal:\s*abortController\.signal/, `${name} must pass abortController.signal`);
    });
  }
});

describe('translators forward context.signal into handleChatCompletions', () => {
  // The route scan above stays green if handleMessages rebuilds effectiveContext
  // without spreading `...context`. That was the original gap: AbortController
  // bound at the route, never reaching chat.js. Inject the chat handler — the
  // translators already accept context.handleChatCompletions / deps.handleChatCompletions.
  const okChat = (seen) => async (_body, ctx) => {
    seen.signal = ctx?.signal;
    return {
      status: 200,
      body: {
        id: 'chatcmpl-abort-probe',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      },
    };
  };

  it('messages non-stream forwards signal', async () => {
    const { handleMessages } = await import('../src/handlers/messages.js');
    const ac = new AbortController();
    const seen = {};
    const result = await handleMessages(
      { model: 'claude-sonnet-4.6', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      { signal: ac.signal, handleChatCompletions: okChat(seen) },
    );
    assert.equal(result.status, 200);
    assert.equal(seen.signal, ac.signal);
  });

  it('messages forwards signal through the user-scoped effectiveContext rebuild', async () => {
    // handleMessages rebuilds context when metadata.user_id is present.
    // Dropping `...context` there would keep the route-scan and the
    // no-subKey case green while aborting hang-up stopped reaching chat.js.
    const { handleMessages } = await import('../src/handlers/messages.js');
    const ac = new AbortController();
    const seen = {};
    const result = await handleMessages(
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { user_id: 'abort-probe-user' },
      },
      {
        signal: ac.signal,
        callerKey: 'api:abort-probe',
        handleChatCompletions: okChat(seen),
      },
    );
    assert.equal(result.status, 200);
    assert.equal(seen.signal, ac.signal);
  });

  it('gemini non-stream forwards signal', async () => {
    const { handleGemini } = await import('../src/handlers/gemini.js');
    const ac = new AbortController();
    const seen = {};
    const result = await handleGemini(
      'gemini-2.5-pro',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      { signal: ac.signal, handleChatCompletions: okChat(seen) },
      { stream: false },
    );
    assert.equal(result.status, 200);
    assert.equal(seen.signal, ac.signal);
  });

  it('completions forwards signal', async () => {
    const { handleCompletions } = await import('../src/handlers/completions.js');
    const ac = new AbortController();
    const seen = {};
    const result = await handleCompletions(
      { model: 'claude-sonnet-4.6', prompt: 'hi' },
      { signal: ac.signal, handleChatCompletions: okChat(seen) },
    );
    assert.equal(result.status, 200);
    assert.equal(seen.signal, ac.signal);
  });

  it('responses non-stream forwards signal via deps.context', async () => {
    const { handleResponses } = await import('../src/handlers/responses.js');
    const ac = new AbortController();
    const seen = {};
    const result = await handleResponses(
      { model: 'claude-sonnet-4.6', input: 'hi' },
      {
        context: { signal: ac.signal, callerKey: 'api:abort-probe' },
        handleChatCompletions: okChat(seen),
      },
    );
    assert.equal(result.status, 200);
    assert.equal(seen.signal, ac.signal);
  });
});
