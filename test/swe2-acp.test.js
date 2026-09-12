import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sweModel,
  toolDefinitions,
  buildPrompt,
  errorInfo,
  conversationKey,
  isPrefix,
  hash,
  newToolCallId,
  isPendingAction,
  clientPermissionDenial,
} from '../src/swe2-acp/protocol.mjs';
import {
  __test,
  closeAllSessions,
  handleSwe2AcpChat,
} from '../src/swe2-acp/bridge.mjs';
test('Only exact SWE-2 identifiers select this transport', () => {
  for (const id of [
    'swe-2',
    'swe-2-high',
    'devin/swe-2-high',
    'opencodex/devin/swe-2-high',
    'ocx-devin-swe-2',
  ])
    assert.equal(sweModel(id, 'high'), 'swe-2-high');
  for (const id of [
    'grok-4.6',
    'ocx-codex-astra',
    'swe-1-6',
    'swe-2-unknown',
    'fake-swe-2',
  ])
    assert.equal(sweModel(id), null);
});
test('Medium high and max preserve exact requested effort', () => {
  assert.equal(sweModel('swe-2-high', 'medium'), 'swe-2-medium');
  assert.equal(sweModel('swe-2-high', 'xhigh'), 'swe-2-max');
  assert.equal(sweModel('swe-2-max'), 'swe-2-max');
});
test('Full caller context is preserved, including identities, policies and memory', () => {
  const m = [
    {
      role: 'developer',
      content:
        'You are OmO. OpenClaw is the integration. Do not reveal secrets.\nMemory: ABC',
    },
    { role: 'user', content: '네, 해주세요.' },
  ];
  const text = buildPrompt(m, {});
  assert.ok(text.endsWith(JSON.stringify(m)));
  assert.ok(text.includes('platform policies'));
  assert.ok(text.includes('not a request to summarize'));
});
test('MCP conversion preserves schema and original descriptions without coercion', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string', enum: ['OpenClaw', 'Devin'] },
      summary: { type: 'string' },
    },
    required: ['path', 'summary'],
    additionalProperties: false,
  };
  const tools = [
    {
      type: 'function',
      function: {
        name: 'read',
        description: 'Original OmO / OpenClaw description',
        parameters: schema,
      },
    },
  ];
  const d = toolDefinitions({ tools });
  assert.deepEqual(d[0].inputSchema, schema);
  assert.equal(d[0].originalName, 'read');
  assert.ok(d[0].description.includes(tools[0].function.description));
  assert.equal(tools[0].function.parameters, schema);
  assert.deepEqual(toolDefinitions({ tools, tool_choice: 'none' }), []);
});
test('Policy rejection remains explicit and is not classified as auth failure', () => {
  const d = errorInfo(
    new Error(
      'Your request was blocked by our content policy. (trace ID: testtrace)',
    ),
  );
  assert.equal(d.code, 'CONTENT_BLOCKED');
  assert.equal(d.status, 400);
  assert.ok(d.message.includes('testtrace'));
});
test('Conversation match retains tool IDs and ignores provider-only reasoning metadata', () => {
  const a = [
    { role: 'system', content: 'policy' },
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'unique', function: { name: 'read', arguments: '{}' } },
      ],
    },
  ];
  const b = [
    ...a,
    {
      role: 'tool',
      tool_call_id: 'unique',
      content: [{ type: 'text', text: 'x' }],
    },
  ];
  assert.ok(isPrefix(conversationKey(a), conversationKey(b)));
  assert.notDeepEqual(
    conversationKey(b),
    conversationKey([
      ...a,
      { role: 'tool', tool_call_id: 'other', content: 'x' },
    ]),
  );
});
test('Pending tool results cannot cross caller or model', async () => {
  const body = {
    model: 'swe-2-high',
    tools: [],
    messages: [{ role: 'tool', tool_call_id: 'test_pending', content: 'x' }],
  };
  const s = {
    owner: 'owner-A',
    model: 'swe-2-high',
    schemaHash: hash([]),
    instructionHash: hash([]),
    lastConversation: [],
    busy: false,
  };
  __test.pendingCalls.set('test_pending', { session: s });
  await assert.rejects(
    __test.acquire(body, { callerKey: 'owner-B' }),
    /does not match/,
  );
  await assert.rejects(
    __test.acquire(
      { ...body, reasoning_effort: 'max' },
      { callerKey: 'owner-A' },
    ),
    /does not match/,
  );
  __test.pendingCalls.delete('test_pending');
});

test('Lazy client tool discovery refreshes schemas without breaking the pending session', async () => {
  const oldTools = [
    { function: { name: 'read', parameters: { type: 'object' } } },
  ];
  const newTools = [
    ...oldTools,
    {
      function: {
        name: 'edit',
        description: 'Newly discovered client edit tool',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
      },
    },
  ];
  const s = {
    owner: 'A',
    model: 'swe-2-high',
    schemaHash: hash(toolDefinitions({ tools: oldTools })),
    instructionHash: hash([]),
    lastConversation: [],
    defs: toolDefinitions({ tools: oldTools }),
    busy: false,
    calls: new Map([['lazy', {}]]),
  };
  const sent = [];
  __test.pendingCalls.set('lazy', { session: s, send: (r) => sent.push(r) });
  const body = {
    model: 'swe-2-high',
    messages: [
      { role: 'tool', tool_call_id: 'lazy', content: 'actual read result' },
    ],
    tools: newTools,
  };
  assert.equal(await __test.acquire(body, { callerKey: 'A' }), s);
  assert.deepEqual(s.defs, toolDefinitions(body));
  assert.equal(s.schemaHash, hash(s.defs));
  assert.equal(sent[0].content[0].text, 'actual read result');
  assert.equal(__test.pendingCalls.has('lazy'), false);
});
test('Pending result is passed through once, without inventing content', async () => {
  const sent = [];
  const s = {
    owner: 'A',
    model: 'swe-2-high',
    schemaHash: hash([]),
    instructionHash: hash([]),
    lastConversation: [],
    busy: false,
    calls: new Map([['once', {}]]),
  };
  __test.pendingCalls.set('once', { session: s, send: (x) => sent.push(x) });
  const body = {
    model: 'swe-2-high',
    messages: [
      {
        role: 'tool',
        tool_call_id: 'once',
        content: 'actual result from client',
      },
    ],
    tools: [],
  };
  assert.equal(await __test.acquire(body, { callerKey: 'A' }), s);
  assert.equal(sent[0].content[0].text, 'actual result from client');
  assert.equal(__test.pendingCalls.has('once'), false);
  assert.equal(s.calls.size, 0);
});
test('Malformed input fails without starting a Devin process', async () => {
  const r = await handleSwe2AcpChat({ model: 'swe-2-high', messages: [] });
  assert.equal(r.status, 400);
  assert.equal(__test.sessions.size, 0);
});

test('Tool IDs survive OmO limits and OpenClaw punctuation removal', () => {
  const a = newToolCallId(),
    b = newToolCallId();
  assert.match(a, /^call[a-f0-9]{24}$/);
  assert.ok(a.length <= 32);
  assert.equal(a.replace(/[^a-zA-Z0-9]/g, ''), a);
  assert.notEqual(a, b);
});

test('Only unfinished action narration qualifies for bounded continuation', () => {
  assert.ok(
    isPendingAction(
      "Read-only connection verification — I'll read the fixture file, then compute a*b with eval.",
    ),
  );
  assert.equal(
    isPendingAction('The request was blocked by our content policy.'),
    false,
  );
  assert.equal(isPendingAction('The product is 3973.'), false);
  assert.equal(isPendingAction('I will be available tomorrow.'), false);
});

test('Explicit client approval rejection closes the pending session before another tool can run', async () => {
  const rejection =
    'The user rejected permission to use this specific tool call with the following feedback: Permission required for external_directory (/fixture).';
  let closed = false,
    sent = false;
  const s = {
    owner: 'A',
    model: 'swe-2-high',
    schemaHash: hash([]),
    instructionHash: hash([]),
    lastConversation: [],
    busy: false,
    close: async () => {
      closed = true;
      __test.pendingCalls.delete('denied');
    },
  };
  __test.pendingCalls.set('denied', {
    session: s,
    send: () => {
      sent = true;
    },
  });
  const body = {
    model: 'swe-2-high',
    messages: [{ role: 'tool', tool_call_id: 'denied', content: rejection }],
    tools: [],
  };
  const result = await handleSwe2AcpChat(body, { callerKey: 'A' });
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'CLIENT_TOOL_PERMISSION_DENIED');
  assert.equal(closed, true);
  assert.equal(sent, false);
  const replay = await handleSwe2AcpChat(body, { callerKey: 'A' });
  assert.equal(replay.status, 403);
  assert.equal(__test.sessions.size, 0);
});
test('Earlier rejection does not block a later user decision or ordinary file contents', () => {
  const m = [
    {
      role: 'tool',
      content: 'The user rejected permission to use this specific tool call.',
    },
  ];
  assert.ok(clientPermissionDenial(m));
  assert.equal(
    clientPermissionDenial([
      ...m,
      { role: 'user', content: 'Use this permitted file instead.' },
    ]),
    null,
  );
  assert.equal(
    clientPermissionDenial([
      {
        role: 'tool',
        content:
          '1| The user rejected permission to use this specific tool call.',
      },
    ]),
    null,
  );
});

test('An ACP prompt can await client work without an overall RPC deadline', async () => {
  const s = new __test.Session({ model: 'swe-2-high', messages: [] }, {});
  s.child = { stdin: { write: () => {} } };
  const p = s.request('session/prompt', {}, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  s.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { stopReason: 'end_turn' },
    }),
  );
  assert.deepEqual(await p, { stopReason: 'end_turn' });
  assert.equal(s.rpc.size, 0);
});

test('A body-supplied caller key cannot impersonate the server caller', async () => {
  const r = await handleSwe2AcpChat({
    model: 'swe-2-high',
    __callerKey: 'forged',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(r.status, 400);
  assert.equal(__test.sessions.size, 0);
});
test('Unsupported image input is explicit and does not start a CLI', async () => {
  const r = await handleSwe2AcpChat(
    {
      model: 'swe-2-high',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'https://example.invalid/image.png' },
            },
          ],
        },
      ],
    },
    { callerKey: 'test' },
  );
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /text content only/);
  assert.equal(__test.sessions.size, 0);
});
test('Duplicate pending results fail before releasing a tool call', async () => {
  let sent = false;
  const s = {
    owner: 'A',
    model: 'swe-2-high',
    schemaHash: hash([]),
    instructionHash: hash([]),
    lastConversation: [],
    busy: false,
  };
  __test.pendingCalls.set('duplicate', {
    session: s,
    send: () => {
      sent = true;
    },
  });
  try {
    const m = {
      role: 'tool',
      tool_call_id: 'duplicate',
      content: 'actual result',
    };
    await assert.rejects(
      __test.acquire(
        { model: 'swe-2-high', messages: [m, m] },
        { callerKey: 'A' },
      ),
      /Duplicate/,
    );
    assert.equal(sent, false);
  } finally {
    __test.pendingCalls.delete('duplicate');
  }
});

test('capacity admission never evicts an initializing session', async () => {
  const start = __test.Session.prototype.start;
  const begin = __test.Session.prototype.begin;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  __test.Session.prototype.start = async function () {
    await gate;
  };
  __test.Session.prototype.begin = function () {
    this.active = true;
  };
  const requests = Array.from({ length: 12 }, (_, i) =>
    __test.acquire(
      { model: 'swe-2-high', messages: [{ role: 'user', content: 'hello' }] },
      { callerKey: `capacity-${i}` },
    ),
  );
  let overflow;
  let timer;
  try {
    assert.equal(__test.sessions.size, 12);
    assert.ok([...__test.sessions].every((s) => s.busy && !s.closed));
    overflow = __test.acquire(
      { model: 'swe-2-high', messages: [{ role: 'user', content: 'hello' }] },
      { callerKey: 'overflow' },
    );
    await assert.rejects(
      Promise.race([
        overflow,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('capacity check hung')),
            100,
          );
        }),
      ]),
      (error) => error.status === 429,
    );
    assert.ok([...__test.sessions].every((s) => !s.closed));
  } finally {
    clearTimeout(timer);
    release();
    await Promise.allSettled([...requests, overflow]);
    __test.Session.prototype.start = start;
    __test.Session.prototype.begin = begin;
    await Promise.allSettled([...__test.sessions].map((s) => s.close()));
  }
});

test('an explicitly closed session cannot start allocating resources', async () => {
  const s = new __test.Session({ model: 'swe-2-high', messages: [] }, {});
  await s.close();
  await assert.rejects(s.start(), /closed during startup/);
  assert.equal(s.child, undefined);
  assert.equal(s.dir, undefined);
});

test('a packaged executable fails explicitly instead of spawning itself as a relay', async () => {
  const previous = process.pkg;
  process.pkg = { entrypoint: '/snapshot/windsurfapi' };
  try {
    const result = await handleSwe2AcpChat(
      { model: 'swe-2-high', messages: [{ role: 'user', content: 'hello' }] },
      { callerKey: 'test' },
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'ACP_SOURCE_INSTALL_REQUIRED');
    assert.equal(__test.sessions.size, 0);
  } finally {
    if (previous === undefined) delete process.pkg;
    else process.pkg = previous;
  }
});
