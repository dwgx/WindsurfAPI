import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  geminiToOpenAI,
  openAIToGemini,
  geminiError,
  handleGemini,
  parseGeminiPath,
  GeminiStreamTranslator,
} from '../src/handlers/gemini.js';

// ─── helpers ────────────────────────────────────────────────────
function chatChunk(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function fakeRes() {
  const listeners = new Map();
  return {
    body: '',
    writableEnded: false,
    write(chunk) {
      this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      const cbs = listeners.get('close') || [];
      for (const cb of cbs) cb();
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
  };
}

// Parse an SSE-mode Gemini stream into an array of GenerateContentResponse.
function parseSseFrames(raw) {
  return raw
    .split('\r\n\r\n')
    .filter(Boolean)
    .filter(f => f.startsWith('data: '))
    .map(f => JSON.parse(f.slice(6)));
}

// ─── request translation ────────────────────────────────────────
describe('geminiToOpenAI request translation', () => {
  it('maps roles, systemInstruction, text parts', () => {
    const out = geminiToOpenAI({
      systemInstruction: { parts: [{ text: 'be terse' }] },
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'hello' }] },
        { role: 'user', parts: [{ text: 'bye' }] },
      ],
    }, 'gemini-2.5-pro');
    assert.deepEqual(out.messages[0], { role: 'system', content: 'be terse' });
    assert.deepEqual(out.messages[1], { role: 'user', content: 'hi' });
    assert.deepEqual(out.messages[2], { role: 'assistant', content: 'hello' });
    assert.deepEqual(out.messages[3], { role: 'user', content: 'bye' });
    assert.equal(out.model, 'gemini-2.5-pro');
  });

  it('accepts string systemInstruction', () => {
    const out = geminiToOpenAI({
      systemInstruction: 'sys text',
      contents: [{ role: 'user', parts: [{ text: 'q' }] }],
    });
    assert.deepEqual(out.messages[0], { role: 'system', content: 'sys text' });
  });

  it('converts inlineData to an OpenAI image_url data URL', () => {
    const out = geminiToOpenAI({
      contents: [{
        role: 'user',
        parts: [
          { text: 'what is this' },
          { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
        ],
      }],
    });
    const msg = out.messages[0];
    assert.equal(msg.role, 'user');
    assert.ok(Array.isArray(msg.content));
    const img = msg.content.find(p => p.type === 'image_url');
    assert.equal(img.image_url.url, 'data:image/jpeg;base64,AAAA');
    const txt = msg.content.find(p => p.type === 'text');
    assert.equal(txt.text, 'what is this');
  });

  it('converts functionCall to assistant tool_calls and functionResponse to a tool message', () => {
    const out = geminiToOpenAI({
      contents: [
        { role: 'user', parts: [{ text: 'weather?' }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 20 } } }] },
      ],
    });
    const asst = out.messages.find(m => m.role === 'assistant' && m.tool_calls);
    assert.equal(asst.tool_calls[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(asst.tool_calls[0].function.arguments), { city: 'SF' });
    const toolMsg = out.messages.find(m => m.role === 'tool');
    assert.equal(toolMsg.tool_call_id, asst.tool_calls[0].id);
    assert.deepEqual(JSON.parse(toolMsg.content), { temp: 20 });
  });

  it('FIFO-pairs parallel same-name functionResponses to distinct calls (no orphan / dup id)', () => {
    // Two parallel `search` calls in one model turn, then two responses. The old
    // "last id per name" Map routed BOTH responses to the second call → orphaned
    // the first call and duplicated a tool_call_id. FIFO must pair in issue order.
    const out = geminiToOpenAI({
      contents: [
        { role: 'model', parts: [
          { functionCall: { name: 'search', args: { q: 'A' } } },
          { functionCall: { name: 'search', args: { q: 'B' } } },
        ] },
        { role: 'user', parts: [
          { functionResponse: { name: 'search', response: { r: 'respA' } } },
          { functionResponse: { name: 'search', response: { r: 'respB' } } },
        ] },
      ],
    });
    const asst = out.messages.find(m => m.role === 'assistant' && m.tool_calls);
    const ids = asst.tool_calls.map(t => t.id);
    assert.equal(new Set(ids).size, 2, 'two distinct call ids');
    const toolMsgs = out.messages.filter(m => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    // First response pairs to first call, second to second (FIFO).
    assert.equal(toolMsgs[0].tool_call_id, ids[0]);
    assert.equal(toolMsgs[1].tool_call_id, ids[1]);
    assert.notEqual(toolMsgs[0].tool_call_id, toolMsgs[1].tool_call_id, 'no duplicate tool_call_id');
  });

  it('prefers Gemini native functionCall.id / functionResponse.id when present', () => {
    const out = geminiToOpenAI({
      contents: [
        { role: 'model', parts: [{ functionCall: { id: 'g_native_1', name: 'search', args: { q: 'x' } } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'g_native_1', name: 'search', response: { r: 'ok' } } }] },
      ],
    });
    const asst = out.messages.find(m => m.role === 'assistant' && m.tool_calls);
    assert.equal(asst.tool_calls[0].id, 'g_native_1', 'uses native id verbatim');
    const toolMsg = out.messages.find(m => m.role === 'tool');
    assert.equal(toolMsg.tool_call_id, 'g_native_1', 'response pairs via native id');
  });

  it('maps functionDeclarations to OpenAI tools', () => {
    const out = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      tools: [
        { functionDeclarations: [{ name: 'lookup', description: 'd', parameters: { type: 'object' } }] },
      ],
    });
    assert.equal(out.tools.length, 1);
    assert.equal(out.tools[0].function.name, 'lookup');
    assert.equal(out.tools[0].type, 'function');
  });

  it('refuses a server-side tool instead of dropping it (G06)', () => {
    // Measured before this: the translator counted googleSearch/codeExecution/
    // urlContext and dropped them with a log line, so the client got a 200 for
    // a turn whose search never ran. Every other surface returns a typed 400;
    // the translator now throws the same code and handleGemini maps it.
    for (const key of ['googleSearch', 'googleSearchRetrieval', 'codeExecution', 'urlContext']) {
      assert.throws(
        () => geminiToOpenAI({
          contents: [{ role: 'user', parts: [{ text: 'x' }] }],
          tools: [{ [key]: {} }],
        }),
        (err) => {
          assert.equal(err.code, 'unsupported_server_side_tool', `${key} must be refused`);
          assert.equal(err.param, 'tools');
          assert.match(err.message, new RegExp(key), 'the error names the offending tool');
          return true;
        },
      );
    }
  });

  it('maps generationConfig (maxOutputTokens, temperature, topP, stopSequences)', () => {
    const out = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      generationConfig: {
        maxOutputTokens: 256,
        temperature: 0.4,
        topP: 0.9,
        stopSequences: ['END'],
      },
    });
    assert.equal(out.max_tokens, 256);
    assert.equal(out.temperature, 0.4);
    assert.equal(out.top_p, 0.9);
    assert.deepEqual(out.stop, ['END']);
  });

  it('maps toolConfig ANY+single name to a pinned function tool_choice', () => {
    const out = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['only_fn'] } },
    });
    assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'only_fn' } });
  });

  it('maps responseMimeType json to response_format', () => {
    const withSchema = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'object' } },
    });
    assert.equal(withSchema.response_format.type, 'json_schema');
    const noSchema = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });
    assert.deepEqual(noSchema.response_format, { type: 'json_object' });
  });

  it('drops prior-turn thought parts from history', () => {
    const out = geminiToOpenAI({
      contents: [{ role: 'model', parts: [{ text: 'secret plan', thought: true }, { text: 'answer' }] }],
    });
    assert.equal(out.messages[0].content, 'answer');
  });
});

// ─── non-stream response translation ────────────────────────────
describe('openAIToGemini response translation', () => {
  it('maps a text completion to a candidate with STOP', () => {
    const g = openAIToGemini({
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }, 'gemini-2.5-pro');
    assert.equal(g.candidates[0].content.parts[0].text, 'hello');
    assert.equal(g.candidates[0].content.role, 'model');
    assert.equal(g.candidates[0].finishReason, 'STOP');
    assert.equal(g.usageMetadata.promptTokenCount, 3);
    assert.equal(g.usageMetadata.candidatesTokenCount, 5);
    assert.equal(g.usageMetadata.totalTokenCount, 8);
  });

  it('maps length finish_reason to MAX_TOKENS', () => {
    const g = openAIToGemini({
      choices: [{ message: { content: 'x' }, finish_reason: 'length' }],
    });
    assert.equal(g.candidates[0].finishReason, 'MAX_TOKENS');
  });

  it('maps error/unterminated to OTHER, never a clean STOP (G3)', () => {
    // The Connect decoder's truncation terminal: a payload arrived but no
    // stopReason did. `finish_reason:'error'` (and the additive unterminated
    // marker) must not fall through the map's default to STOP.
    for (const choice of [
      { message: { content: 'half' }, finish_reason: 'error' },
      { message: { content: 'half' }, finish_reason: 'stop', unterminated: true },
    ]) {
      const g = openAIToGemini({ choices: [choice] });
      assert.equal(g.candidates[0].finishReason, 'OTHER',
        `${JSON.stringify(choice)} must not certify the partial answer as STOP`);
    }
  });

  it('maps tool_calls to functionCall parts with STOP', () => {
    const g = openAIToGemini({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', function: { name: 'do_it', arguments: '{"a":1}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const fc = g.candidates[0].content.parts.find(p => p.functionCall);
    assert.equal(fc.functionCall.name, 'do_it');
    assert.deepEqual(fc.functionCall.args, { a: 1 });
    assert.equal(g.candidates[0].finishReason, 'STOP');
  });

  it('maps reasoning_content to a thought part', () => {
    const g = openAIToGemini({
      choices: [{ message: { reasoning_content: 'thinking...', content: 'done' }, finish_reason: 'stop' }],
    });
    assert.equal(g.candidates[0].content.parts[0].thought, true);
    assert.equal(g.candidates[0].content.parts[0].text, 'thinking...');
    assert.equal(g.candidates[0].content.parts[1].text, 'done');
  });
});

// ─── error mapping (transient-first) ────────────────────────────
describe('geminiError mapping', () => {
  it('maps capacity_error to UNAVAILABLE 503, NOT permission denied', () => {
    const e = geminiError(503, 'capacity_error', 'high demand');
    assert.equal(e.status, 503);
    assert.equal(e.body.error.status, 'UNAVAILABLE');
    assert.equal(e.body.error.code, 503);
  });

  it('maps upstream_transient_error to UNAVAILABLE 503', () => {
    const e = geminiError(503, 'upstream_transient_error', 'blip');
    assert.equal(e.body.error.status, 'UNAVAILABLE');
  });

  it('maps insufficient_quota to RESOURCE_EXHAUSTED 429', () => {
    const e = geminiError(402, 'insufficient_quota', 'out of quota');
    assert.equal(e.status, 429);
    assert.equal(e.body.error.status, 'RESOURCE_EXHAUSTED');
  });

  it('maps model_blocked to PERMISSION_DENIED 403', () => {
    const e = geminiError(402, 'model_blocked', 'blocked');
    assert.equal(e.status, 403);
    assert.equal(e.body.error.status, 'PERMISSION_DENIED');
  });

  it('falls back on HTTP status for unknown internal type (401 -> UNAUTHENTICATED)', () => {
    const e = geminiError(401, undefined, 'no auth');
    assert.equal(e.body.error.status, 'UNAUTHENTICATED');
  });

  it('maps bare 503 to UNAVAILABLE', () => {
    const e = geminiError(503, undefined, 'down');
    assert.equal(e.body.error.status, 'UNAVAILABLE');
  });
});

// ─── path parsing ───────────────────────────────────────────────
describe('parseGeminiPath', () => {
  it('parses generateContent', () => {
    assert.deepEqual(parseGeminiPath('/v1beta/models/gemini-2.5-pro:generateContent'),
      { model: 'gemini-2.5-pro', method: 'generateContent' });
  });
  it('parses streamGenerateContent', () => {
    assert.deepEqual(parseGeminiPath('/v1beta/models/gemini-3.0-flash:streamGenerateContent'),
      { model: 'gemini-3.0-flash', method: 'streamGenerateContent' });
  });
  it('returns null for non-generate paths', () => {
    assert.equal(parseGeminiPath('/v1beta/models'), null);
    assert.equal(parseGeminiPath('/v1/chat/completions'), null);
  });
});

// ─── main entry: non-stream ─────────────────────────────────────
describe('handleGemini non-stream', () => {
  it('translates a full non-stream round trip', async () => {
    let captured = null;
    const result = await handleGemini('gemini-2.5-pro', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }, {
      async handleChatCompletions(body) {
        captured = body;
        return {
          status: 200,
          body: {
            model: body.model,
            choices: [{ message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          },
        };
      },
    }, { stream: false });
    assert.equal(captured.stream, false);
    assert.equal(captured.__route, 'gemini');
    assert.equal(result.status, 200);
    assert.equal(result.body.candidates[0].content.parts[0].text, 'hello there');
    assert.equal(result.body.candidates[0].finishReason, 'STOP');
  });

  it('maps a chat-handler error to a Gemini error body (capacity -> UNAVAILABLE)', async () => {
    const result = await handleGemini('gemini-2.5-pro', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }, {
      async handleChatCompletions() {
        return { status: 503, body: { error: { type: 'capacity_error', message: 'high demand' } } };
      },
    }, { stream: false });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.status, 'UNAVAILABLE');
  });

  it('fails a 200 body whose finish_reason is error instead of returning STOP (G3)', async () => {
    for (const choice of [
      { message: { content: 'half an answer' }, finish_reason: 'error' },
      { message: { content: 'half an answer' }, finish_reason: 'stop', unterminated: true },
    ]) {
      const result = await handleGemini('gemini-2.5-pro', {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      }, {
        async handleChatCompletions() {
          return { status: 200, body: { choices: [choice] } };
        },
      }, { stream: false });
      assert.equal(result.status, 503, 'a truncated turn must be an error, not a 200 candidate');
      assert.equal(result.body.error.status, 'UNAVAILABLE');
      assert.match(result.body.error.message, /without a completion reason|truncated/i);
      assert.equal(result.body.candidates, undefined, 'no candidate may certify the partial answer');
    }
  });

  it('returns 400 unsupported_server_side_tool for googleSearch/codeExecution/urlContext (G06)', async () => {
    let upstreamCalls = 0;
    for (const key of ['googleSearch', 'codeExecution', 'urlContext']) {
      const result = await handleGemini('gemini-2.5-pro', {
        contents: [{ role: 'user', parts: [{ text: 'search the web' }] }],
        tools: [{ [key]: {} }],
      }, {
        async handleChatCompletions() {
          upstreamCalls++;
          return { status: 200, body: { choices: [] } };
        },
      }, { stream: false });
      assert.equal(result.status, 400, `${key} must be a 400, not a 200 with the tool gone`);
      assert.equal(result.body.error.status, 'INVALID_ARGUMENT');
      assert.equal(result.body.error.code, 400);
      assert.equal(result.body.error.type, 'unsupported_server_side_tool');
      assert.equal(result.body.error.param, 'tools');
      assert.match(result.body.error.message, new RegExp(key));
    }
    assert.equal(upstreamCalls, 0, 'the rejected request must never reach the upstream');
  });
});

// ─── main entry: streaming ──────────────────────────────────────
describe('handleGemini streaming', () => {
  // #234 — every frame's modelVersion must name what ACTUALLY ran.
  //
  // The translator is built with the REQUESTED name (it exists before the upstream call),
  // so a degraded connect request — WINDSURFAPI_STRICT_MODEL=0 rewriting an unmapped paid
  // name to the free selector — used to report the paid name it never ran.
  it('non-stream modelVersion reports what ran, not what was requested', async () => {
    // The non-stream twin of the streaming test below. Separate because the two paths
    // build modelVersion in different places (openAIToGemini vs the frame builder), and a
    // precedence flip in one is invisible to a test that only drives the other.
    const result = await handleGemini('claude-opus-4.9', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }, {
      async handleChatCompletions() {
        return {
          status: 200,
          body: {
            id: 'x', object: 'chat.completion', created: 0,
            model: 'swe-1-6-slow',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      },
    }, {});

    assert.equal(result.body.modelVersion, 'swe-1-6-slow',
      'modelVersion must name what ran, not the requested claude-opus-4.9');
  });

  it('adopts the upstream model name into modelVersion', async () => {
    const result = await handleGemini('claude-opus-4.9', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }, {
      async handleChatCompletions() {
        return {
          stream: true, status: 200,
          async handler(res) {
            res.write(chatChunk({ model: 'swe-1-6-slow', choices: [{ delta: { content: 'ok' } }] }));
            res.write(chatChunk({ model: 'swe-1-6-slow', choices: [{ delta: {}, finish_reason: 'stop' }] }));
            res.write('data: [DONE]\n\n');
            res.end();
          },
        };
      },
    }, { stream: true, alt: 'sse' });

    const res = fakeRes();
    await result.handler(res);
    const frames = parseSseFrames(res.body);

    assert.ok(frames.length > 0, 'frames emitted');
    assert.equal(frames[0].modelVersion, 'swe-1-6-slow',
      'modelVersion must name what ran, not the requested claude-opus-4.9');
  });

  it('keeps modelVersion identical across every frame', async () => {
    // Load-bearing here in a way it is not for the Anthropic route: gemini re-reads the
    // name on EVERY frame, so adopting a late-arriving different name would emit two
    // model identities inside one response.
    const result = await handleGemini('claude-opus-4.9', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }, {
      async handleChatCompletions() {
        return {
          stream: true, status: 200,
          async handler(res) {
            res.write(chatChunk({ model: 'swe-1-6-slow', choices: [{ delta: { content: 'a' } }] }));
            // A later chunk disagreeing must not change frames already committed.
            res.write(chatChunk({ model: 'something-else-entirely', choices: [{ delta: { content: 'b' } }] }));
            res.write(chatChunk({ model: 'something-else-entirely', choices: [{ delta: {}, finish_reason: 'stop' }] }));
            res.write('data: [DONE]\n\n');
            res.end();
          },
        };
      },
    }, { stream: true, alt: 'sse' });

    const res = fakeRes();
    await result.handler(res);
    const frames = parseSseFrames(res.body);
    const names = [...new Set(frames.map(f => f.modelVersion))];

    assert.deepEqual(names, ['swe-1-6-slow'],
      `all frames must carry one model identity; saw ${JSON.stringify(names)}`);
  });

  it('translates an OpenAI SSE stream to SSE-mode Gemini frames', async () => {
    const result = await handleGemini('gemini-2.5-pro', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }, {
      async handleChatCompletions() {
        return {
          stream: true,
          status: 200,
          async handler(res) {
            res.write(chatChunk({ choices: [{ delta: { content: 'Hel' } }] }));
            res.write(chatChunk({ choices: [{ delta: { content: 'lo' } }] }));
            res.write(chatChunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
            res.write('data: [DONE]\n\n');
            res.end();
          },
        };
      },
    }, { stream: true, alt: 'sse' });

    assert.equal(result.stream, true);
    assert.equal(result.mode, 'sse');
    assert.equal(result.headers['Content-Type'], 'text/event-stream');

    const res = fakeRes();
    await result.handler(res);
    const frames = parseSseFrames(res.body);
    const text = frames.map(f => f.candidates[0].content.parts[0].text || '').join('');
    assert.ok(text.includes('Hello'));
    const last = frames[frames.length - 1];
    assert.equal(last.candidates[0].finishReason, 'STOP');
    assert.equal(last.usageMetadata.totalTokenCount, 3);
  });

  it('emits a JSON array in default (array) mode', async () => {
    const result = await handleGemini('gemini-2.5-pro', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }, {
      async handleChatCompletions() {
        return {
          stream: true,
          status: 200,
          async handler(res) {
            res.write(chatChunk({ choices: [{ delta: { content: 'X' } }] }));
            res.write(chatChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
            res.end();
          },
        };
      },
    }, { stream: true });

    assert.equal(result.mode, 'array');
    assert.equal(result.headers['Content-Type'], 'application/json');
    const res = fakeRes();
    await result.handler(res);
    // Body must be a single parseable JSON array of GenerateContentResponse.
    const arr = JSON.parse(res.body);
    assert.ok(Array.isArray(arr));
    assert.ok(arr.length >= 1);
    assert.equal(arr[0].candidates[0].content.role, 'model');
  });

  it('streams tool_calls as a functionCall part', async () => {
    const result = await handleGemini('gemini-2.5-pro', {
      contents: [{ role: 'user', parts: [{ text: 'go' }] }],
    }, {
      async handleChatCompletions() {
        return {
          stream: true,
          status: 200,
          async handler(res) {
            res.write(chatChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'run', arguments: '{"a":' } }] } }] }));
            res.write(chatChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }));
            res.write(chatChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
            res.end();
          },
        };
      },
    }, { stream: true, alt: 'sse' });

    const res = fakeRes();
    await result.handler(res);
    const frames = parseSseFrames(res.body);
    const fc = frames.flatMap(f => f.candidates[0].content.parts).find(p => p.functionCall);
    assert.equal(fc.functionCall.name, 'run');
    assert.deepEqual(fc.functionCall.args, { a: 1 });
  });

  it('emits a Gemini error frame when the stream errors mid-flight', async () => {
    const result = await handleGemini('gemini-2.5-pro', {
      contents: [{ role: 'user', parts: [{ text: 'go' }] }],
    }, {
      async handleChatCompletions() {
        return {
          stream: true,
          status: 200,
          async handler(res) {
            res.write(chatChunk({ error: { code: 'CAPACITY', message: 'high demand' } }));
            res.end();
          },
        };
      },
    }, { stream: true, alt: 'sse' });

    const res = fakeRes();
    await result.handler(res);
    const frames = parseSseFrames(res.body);
    const errFrame = frames.find(f => f.error);
    assert.ok(errFrame, 'expected an error frame');
    assert.equal(errFrame.error.status, 'UNAVAILABLE');
  });

  it('streams a finish_reason:error terminal as an error frame, never STOP (G3)', async () => {
    const result = await handleGemini('gemini-2.5-pro', {
      contents: [{ role: 'user', parts: [{ text: 'go' }] }],
    }, {
      async handleChatCompletions() {
        return {
          stream: true,
          status: 200,
          async handler(res) {
            res.write(chatChunk({ choices: [{ delta: { content: 'half an answer' } }] }));
            res.write(chatChunk({ choices: [{ delta: {}, finish_reason: 'error' }] }));
            res.end();
          },
        };
      },
    }, { stream: true, alt: 'sse' });

    const res = fakeRes();
    await result.handler(res);
    const frames = parseSseFrames(res.body);
    const errFrame = frames.find(f => f.error);
    assert.ok(errFrame, 'the truncation terminal must surface as an error frame');
    assert.equal(errFrame.error.status, 'UNAVAILABLE');
    assert.match(errFrame.error.message, /completion reason|truncated/i);
    const terminalCandidate = frames
      .flatMap(f => f.candidates || [])
      .find(c => c.finishReason);
    assert.equal(terminalCandidate, undefined,
      'a failed turn must not emit a terminal candidate (STOP/OTHER) after the error');
  });

  it('maps a pre-stream error to a Gemini error body', async () => {
    const result = await handleGemini('gemini-2.5-pro', {
      contents: [{ role: 'user', parts: [{ text: 'go' }] }],
    }, {
      async handleChatCompletions() {
        return { status: 401, body: { error: { type: 'authentication_error', message: 'bad token' } } };
      },
    }, { stream: true, alt: 'sse' });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.status, 'UNAUTHENTICATED');
  });
});

// ─── translator direct unit (array mode empties) ────────────────
describe('GeminiStreamTranslator edge cases', () => {
  it('emits [] for an empty array-mode stream', () => {
    const res = fakeRes();
    const t = new GeminiStreamTranslator(res, 'gemini-2.5-pro', { mode: 'array' });
    t.finish();
    // finish on an empty stream still emits a terminal candidate frame, then ].
    const arr = JSON.parse(res.body);
    assert.ok(Array.isArray(arr));
  });

  it('fails the turn on a finish_reason:error terminal (G3, array mode too)', () => {
    for (const mode of ['sse', 'array']) {
      const res = fakeRes();
      const t = new GeminiStreamTranslator(res, 'gemini-2.5-pro', { mode });
      t.processChunk({ choices: [{ delta: { content: 'half' } }] });
      t.processChunk({ choices: [{ delta: {}, finish_reason: 'error' }] });
      t.finish();
      const frames = mode === 'sse' ? parseSseFrames(res.body) : JSON.parse(res.body);
      const err = frames.find(f => f.error);
      assert.ok(err, `${mode}: the truncation terminal must surface as an error frame`);
      assert.equal(err.error.status, 'UNAVAILABLE');
      assert.equal(frames.some(f => (f.candidates || []).some(c => c.finishReason)), false,
        `${mode}: no terminal candidate may follow the error`);
    }
  });

  it('fails the turn when the frame carries the unterminated marker', () => {
    // responses.js accepts the marker on the chunk OR its choice; this route
    // must read the same shapes. A 'stop' finish_reason alongside it must not
    // win — the marker says the turn never actually completed.
    for (const chunk of [
      { unterminated: true, choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [{ delta: {}, finish_reason: 'stop', unterminated: true }] },
    ]) {
      const res = fakeRes();
      const t = new GeminiStreamTranslator(res, 'gemini-2.5-pro', { mode: 'sse' });
      t.processChunk({ choices: [{ delta: { content: 'half' } }] });
      t.processChunk(chunk);
      t.finish();
      const frames = parseSseFrames(res.body);
      assert.ok(frames.find(f => f.error), `${JSON.stringify(chunk)} must fail the turn`);
      assert.equal(frames.some(f => (f.candidates || []).some(c => c.finishReason === 'STOP')), false);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// G2-A supplemental coverage — gaps not exercised by the G1 suite.
// ════════════════════════════════════════════════════════════════

// ─── request translation: remaining part / config shapes ────────
describe('geminiToOpenAI supplemental part + config coverage', () => {
  it('forwards fileData.fileUri as an image_url part', () => {
    const out = geminiToOpenAI({
      contents: [{ role: 'user', parts: [
        { text: 'describe' },
        { fileData: { mimeType: 'image/png', fileUri: 'https://generativelanguage.googleapis.com/files/abc' } },
      ] }],
    });
    const img = out.messages[0].content.find(p => p.type === 'image_url');
    assert.equal(img.image_url.url, 'https://generativelanguage.googleapis.com/files/abc');
  });

  it('defaults inlineData mimeType to image/png when omitted', () => {
    const out = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ inlineData: { data: 'ZZZ' } }] }],
    });
    const img = out.messages[0].content.find(p => p.type === 'image_url');
    assert.equal(img.image_url.url, 'data:image/png;base64,ZZZ');
  });

  it('passes a string functionResponse through verbatim (no double-encoding)', () => {
    const out = geminiToOpenAI({
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'echo', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'echo', response: 'plain string result' } }] },
      ],
    });
    const toolMsg = out.messages.find(m => m.role === 'tool');
    assert.equal(toolMsg.content, 'plain string result');
  });

  it('defaults the model when neither path nor body carries one', () => {
    const out = geminiToOpenAI({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    assert.equal(out.model, 'gemini-2.5-pro');
  });

  it('prefers body.model over the built-in default', () => {
    const out = geminiToOpenAI({ model: 'gemini-3.0-flash', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    assert.equal(out.model, 'gemini-3.0-flash');
  });

  it('maps toolConfig AUTO/NONE/ANY-multi to OpenAI tool_choice', () => {
    const auto = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    });
    assert.equal(auto.tool_choice, 'auto');

    const none = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
    });
    assert.equal(none.tool_choice, 'none');

    // ANY with several (or zero) allowed names is a generic "must call a tool".
    const anyMulti = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['a', 'b'] } },
    });
    assert.equal(anyMulti.tool_choice, 'required');
  });

  it('omits tool_choice when no toolConfig is present', () => {
    const out = geminiToOpenAI({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] });
    assert.equal(out.tool_choice, undefined);
  });

  it('maps thinkingConfig.thinkingBudget=0 to disabled and a positive budget to enabled', () => {
    const off = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    });
    assert.deepEqual(off.thinking, { type: 'disabled' });

    const on = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } },
    });
    assert.equal(on.thinking.type, 'enabled');
    assert.equal(on.thinking.budget_tokens, 2048);
  });

  it('accepts parametersJsonSchema as a fallback for tool parameters', () => {
    const out = geminiToOpenAI({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      tools: [{ functionDeclarations: [{ name: 'lookup', parametersJsonSchema: { type: 'object', properties: { q: { type: 'string' } } } }] }],
    });
    assert.deepEqual(out.tools[0].function.parameters, { type: 'object', properties: { q: { type: 'string' } } });
  });

  it('refuses a request whose only tools are server-side (no silent empty tools key)', () => {
    // Companion to the per-key test above: the old behaviour omitted `tools`
    // entirely, which made the dropped declaration indistinguishable from a
    // client that never declared one (and re-enabled the preamble injection
    // this route avoids when there are no function tools).
    assert.throws(
      () => geminiToOpenAI({
        contents: [{ role: 'user', parts: [{ text: 'x' }] }],
        tools: [{ googleSearch: {} }, { codeExecution: {} }],
      }),
      (err) => {
        assert.equal(err.code, 'unsupported_server_side_tool');
        return true;
      },
    );
  });
});

// ─── non-stream response: finish + usage edge cases ─────────────
describe('openAIToGemini supplemental response coverage', () => {
  it('maps content_filter to SAFETY', () => {
    const g = openAIToGemini({
      choices: [{ message: { content: 'redacted' }, finish_reason: 'content_filter' }],
    });
    assert.equal(g.candidates[0].finishReason, 'SAFETY');
  });

  it('defaults an unknown/empty finish_reason to STOP', () => {
    const g = openAIToGemini({ choices: [{ message: { content: 'x' } }] });
    assert.equal(g.candidates[0].finishReason, 'STOP');
  });

  it('surfaces cached + reasoning usage as cachedContentTokenCount / thoughtsTokenCount', () => {
    const g = openAIToGemini({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 6 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    });
    assert.equal(g.usageMetadata.cachedContentTokenCount, 6);
    assert.equal(g.usageMetadata.thoughtsTokenCount, 3);
  });

  it('accepts Anthropic-style usage field names (input_tokens/output_tokens)', () => {
    const g = openAIToGemini({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { input_tokens: 7, output_tokens: 2 },
    });
    assert.equal(g.usageMetadata.promptTokenCount, 7);
    assert.equal(g.usageMetadata.candidatesTokenCount, 2);
    assert.equal(g.usageMetadata.totalTokenCount, 9, 'total falls back to prompt + candidates');
  });

  it('omits usageMetadata when usage is absent', () => {
    const g = openAIToGemini({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    assert.equal(g.usageMetadata, undefined);
  });

  it('carries assistant text alongside tool_calls as a leading text part', () => {
    const g = openAIToGemini({
      choices: [{
        message: { role: 'assistant', content: 'let me check', tool_calls: [{ id: 'c1', function: { name: 'run', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
    });
    const parts = g.candidates[0].content.parts;
    assert.equal(parts[0].text, 'let me check');
    assert.ok(parts.find(p => p.functionCall?.name === 'run'));
  });

  // This assertion used to read `deepEqual(args, {})`, and its name said
  // "args -> {}". What it was really testing is that a malformed argument string
  // does not throw — but writing the empty object into the expectation pinned the
  // DATA LOSS as intended behaviour, so the missing B4 parity (messages.js logs
  // and keeps the raw string; this path silently dropped every parameter) looked
  // deliberate to every later reader. The crash-resistance intent is kept below;
  // the recovery property is covered in test/gemini-tool-args-parity.test.js.
  it('survives malformed tool-call argument JSON without losing it', () => {
    const g = openAIToGemini({
      choices: [{
        message: { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'run', arguments: '{not json' } }] },
        finish_reason: 'tool_calls',
      }],
    });
    const fc = g.candidates[0].content.parts.find(p => p.functionCall);
    assert.ok(fc, 'a functionCall part is still emitted — the original "survives" claim');
    assert.equal(fc.functionCall.name, 'run');
    assert.equal(fc.functionCall.args.__raw_arguments, '{not json',
      'the unparseable string is preserved rather than silently dropped');
  });
});

// ─── error mapping: transient-first invariant + full fallback ───
describe('geminiError supplemental mapping', () => {
  it('maps upstream_internal_error to UNAVAILABLE (transient-first, never PERMISSION_DENIED)', () => {
    const e = geminiError(403, 'upstream_internal_error', 'internal error occurred');
    assert.equal(e.status, 503);
    assert.equal(e.body.error.status, 'UNAVAILABLE');
    assert.notEqual(e.body.error.status, 'PERMISSION_DENIED',
      'an internal/transient blip wrapped in a 403 shell must NOT leak as PERMISSION_DENIED');
  });

  it('maps capacity_error wrapped in a 401/403 shell to UNAVAILABLE (does not burn the token)', () => {
    const e = geminiError(401, 'capacity_error', 'high demand');
    assert.equal(e.body.error.status, 'UNAVAILABLE');
    assert.equal(e.status, 503);
  });

  it('maps rate_limit_error / rate_limit_exceeded to RESOURCE_EXHAUSTED 429', () => {
    assert.equal(geminiError(429, 'rate_limit_error').body.error.status, 'RESOURCE_EXHAUSTED');
    assert.equal(geminiError(429, 'rate_limit_exceeded').status, 429);
  });

  it('covers the HTTP-status fallback enum table', () => {
    assert.equal(geminiError(400, undefined).body.error.status, 'INVALID_ARGUMENT');
    assert.equal(geminiError(403, undefined).body.error.status, 'PERMISSION_DENIED');
    assert.equal(geminiError(404, undefined).body.error.status, 'NOT_FOUND');
    assert.equal(geminiError(413, undefined).body.error.status, 'INVALID_ARGUMENT');
    assert.equal(geminiError(429, undefined).body.error.status, 'RESOURCE_EXHAUSTED');
    assert.equal(geminiError(504, undefined).body.error.status, 'DEADLINE_EXCEEDED');
    // 502 upstream-unavailable is normalized up to 503/UNAVAILABLE so SDKs back off.
    const u502 = geminiError(502, undefined);
    assert.equal(u502.status, 503);
    assert.equal(u502.body.error.status, 'UNAVAILABLE');
    // Unknown 5xx -> INTERNAL, unknown 4xx -> INVALID_ARGUMENT.
    assert.equal(geminiError(500, undefined).body.error.status, 'INTERNAL');
    assert.equal(geminiError(418, undefined).body.error.status, 'INVALID_ARGUMENT');
  });

  it('uses a default message when none is supplied', () => {
    assert.equal(geminiError(500, undefined).body.error.message, 'Upstream error');
  });
});

// ─── path parsing: edge cases ───────────────────────────────────
describe('parseGeminiPath supplemental coverage', () => {
  it('parses a bare /models/... path (no version prefix)', () => {
    assert.deepEqual(parseGeminiPath('/models/gemini-2.5-pro:generateContent'),
      { model: 'gemini-2.5-pro', method: 'generateContent' });
  });

  it('parses a v1 (non-beta) alias path', () => {
    assert.deepEqual(parseGeminiPath('/v1/models/gemini-2.5-flash:streamGenerateContent'),
      { model: 'gemini-2.5-flash', method: 'streamGenerateContent' });
  });

  it('preserves dots and dashes in the model id', () => {
    const p = parseGeminiPath('/v1beta/models/gemini-3.0-pro-preview:generateContent');
    assert.equal(p.model, 'gemini-3.0-pro-preview');
  });

  it('url-decodes a percent-encoded model id', () => {
    const p = parseGeminiPath('/v1beta/models/models%2Fgemini-2.5-pro:generateContent');
    assert.equal(p.model, 'models/gemini-2.5-pro');
  });

  it('returns null when there is no method suffix', () => {
    assert.equal(parseGeminiPath('/v1beta/models/gemini-2.5-pro'), null);
  });
});

// ─── streaming: array-mode error frame + reasoning + multi-tool ─
describe('GeminiStreamTranslator + handleGemini streaming supplemental', () => {
  it('terminates an array-mode stream with a well-formed error frame on a mid-stream blip', async () => {
    const result = await handleGemini('gemini-2.5-pro', {
      contents: [{ role: 'user', parts: [{ text: 'go' }] }],
    }, {
      async handleChatCompletions() {
        return {
          stream: true,
          status: 200,
          async handler(res) {
            res.write(chatChunk({ choices: [{ delta: { content: 'partial' } }] }));
            res.write(chatChunk({ error: { code: 'UPSTREAM_INTERNAL', message: 'internal error occurred' } }));
            res.end();
          },
        };
      },
    }, { stream: true }); // array mode (no alt)

    const res = fakeRes();
    await result.handler(res);
    // The whole body must still parse as one JSON array, last element = error.
    const arr = JSON.parse(res.body);
    assert.ok(Array.isArray(arr));
    const errFrame = arr.find(f => f.error);
    assert.ok(errFrame, 'array stream closes with an error frame');
    assert.equal(errFrame.error.status, 'UNAVAILABLE', 'UPSTREAM_INTERNAL stays transient (not PERMISSION_DENIED)');
  });

  it('emits reasoning_content deltas as thought:true text parts', () => {
    const res = fakeRes();
    const t = new GeminiStreamTranslator(res, 'gemini-2.5-pro', { mode: 'sse' });
    t.processChunk({ choices: [{ delta: { reasoning_content: 'thinking' } }] });
    t.processChunk({ choices: [{ delta: { content: 'answer' } }] });
    t.processChunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    t.finish();
    const frames = parseSseFrames(res.body);
    const thoughtPart = frames.flatMap(f => f.candidates[0].content.parts).find(p => p.thought === true);
    assert.equal(thoughtPart.text, 'thinking');
    const answerPart = frames.flatMap(f => f.candidates[0].content.parts).find(p => p.text === 'answer' && !p.thought);
    assert.ok(answerPart, 'visible content is emitted without thought flag');
  });

  it('flushes multiple buffered tool calls as separate functionCall parts and maps the OpenAI finish to STOP', () => {
    const res = fakeRes();
    const t = new GeminiStreamTranslator(res, 'gemini-2.5-pro', { mode: 'array' });
    t.processChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'first', arguments: '{"a":1}' } }] } }] });
    t.processChunk({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'second', arguments: '{"b":2}' } }] } }] });
    t.processChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    t.finish();
    const arr = JSON.parse(res.body);
    const calls = arr.flatMap(f => f.candidates[0].content.parts).filter(p => p.functionCall);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.functionCall.name), ['first', 'second']);
    assert.deepEqual(calls[0].functionCall.args, { a: 1 });
    // tool_calls -> STOP (Gemini has no FUNCTION_CALL finish reason); on the last frame.
    const finishFrame = arr.find(f => f.candidates[0].finishReason);
    assert.equal(finishFrame.candidates[0].finishReason, 'STOP');
  });

  it('maps length finish_reason to MAX_TOKENS on the terminal stream frame', () => {
    const res = fakeRes();
    const t = new GeminiStreamTranslator(res, 'gemini-2.5-pro', { mode: 'sse' });
    t.processChunk({ choices: [{ delta: { content: 'truncated' } }] });
    t.processChunk({ choices: [{ delta: {}, finish_reason: 'length' }] });
    t.finish();
    const frames = parseSseFrames(res.body);
    const finishFrame = frames.find(f => f.candidates[0].finishReason);
    assert.equal(finishFrame.candidates[0].finishReason, 'MAX_TOKENS');
  });

  it('ignores SSE [DONE] sentinels and surfaces an unrepairable data line as a typed error', () => {
    // [DONE] is a sentinel, not content: it must not disturb the frames around it.
    const res = fakeRes();
    const t = new GeminiStreamTranslator(res, 'gemini-2.5-pro', { mode: 'sse' });
    t.feed('data: [DONE]\n\n');
    t.feed(chatChunk({ choices: [{ delta: { content: 'ok' } }] }));
    t.feed(chatChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    t.finish();
    const frames = parseSseFrames(res.body);
    const text = frames
      .flatMap(f => (f.candidates || []).flatMap(c => c.content?.parts || []))
      .map(p => p.text || '').join('');
    assert.ok(text.includes('ok'));

    // A malformed `data:` line is NOT silently swallowed any more: sse-framer
    // classifies an unrepairable JSON payload as SSE_MALFORMED_JSON and the
    // translator emits it as a typed error frame. Dropping it instead ends the
    // turn with zero content and a clean STOP — the exact failure the framer
    // exists to prevent. Pinned here because this route used to log-and-skip.
    const badRes = fakeRes();
    const bad = new GeminiStreamTranslator(badRes, 'gemini-2.5-pro', { mode: 'sse' });
    bad.feed('data: {not valid json}\n\n');
    const errFrame = parseSseFrames(badRes.body).find(f => f.error);
    assert.ok(errFrame, 'an unrepairable data line must surface, not vanish');
    assert.equal(errFrame.error.__upstream_code, 'SSE_MALFORMED_JSON');
    assert.equal(errFrame.error.status, 'UNAVAILABLE');
  });

  it('is idempotent on a second finish() (no duplicate terminal frame)', () => {
    const res = fakeRes();
    const t = new GeminiStreamTranslator(res, 'gemini-2.5-pro', { mode: 'array' });
    t.processChunk({ choices: [{ delta: { content: 'x' } }] });
    t.finish();
    const lenAfterFirst = res.body.length;
    t.finish();
    assert.equal(res.body.length, lenAfterFirst, 'second finish() is a no-op');
  });

  it('surfaces an abnormally truncated stream as an error frame, NOT a bogus STOP', () => {
    // Content started, then the upstream stream ends with NO terminal signal
    // (no finish_reason, no [DONE], no error) — e.g. network drop / hung-stream
    // deadline. finish() must not fake finishReason:STOP (which tells the client
    // the partial answer is complete); it must surface a retryable error.
    const res = fakeRes();
    const t = new GeminiStreamTranslator(res, 'gemini-2.5-pro', { mode: 'array' });
    t.processChunk({ choices: [{ delta: { content: 'partial answer that got cut' } }] });
    t.finish(); // abnormal: no terminal signal was ever seen
    const arr = JSON.parse(res.body);
    assert.ok(Array.isArray(arr), 'array stream is still well-formed JSON');
    const errFrame = arr.find(f => f.error);
    assert.ok(errFrame, 'truncation surfaces as an error frame');
    assert.equal(errFrame.error.status, 'UNAVAILABLE', 'truncation maps to retryable UNAVAILABLE');
    const stopFrame = arr.find(f => f.candidates && f.candidates[0].finishReason === 'STOP');
    assert.ok(!stopFrame, 'must NOT emit a bogus STOP terminal frame');
  });

  it('treats SSE [DONE] as a terminal signal (clean close, no truncation error)', () => {
    const res = fakeRes();
    const t = new GeminiStreamTranslator(res, 'gemini-2.5-pro', { mode: 'sse' });
    t.feed(chatChunk({ choices: [{ delta: { content: 'done cleanly' } }] }));
    t.feed('data: [DONE]\n\n');
    t.finish();
    const frames = parseSseFrames(res.body);
    const errFrame = frames.find(f => f.error);
    assert.ok(!errFrame, '[DONE] is a clean terminal signal — no truncation error');
  });
});
