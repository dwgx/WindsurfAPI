import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { closeAllSessions } from '../src/swe2-acp/bridge.mjs';
import {
  setModelAccessMode,
  setModelAccessList,
} from '../src/dashboard/model-access.js';

const fixture = fileURLToPath(
  new URL('./fixtures/swe2-acp-cli.mjs', import.meta.url),
);
chmodSync(fixture, 0o755);
process.env.DEVIN_SWE2_TRANSPORT = 'acp';
process.env.DEVIN_CLI_PATH = fixture;
process.env.DEVIN_SWE2_ACP_DATA = process.env.DATA_DIR + '/acp';
after(closeAllSessions);

const tools = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a client fixture.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
];

for (const effort of ['medium', 'high', 'max']) {
  test(`Chat handler relays a client tool and preserves ${effort} selection`, async () => {
    const context = { callerKey: `fixture-${effort}` };
    const body = {
      model: 'swe-2-high',
      reasoning_effort: effort,
      tools,
      messages: [{ role: 'user', content: 'Read the fixture.' }],
    };
    const first = await handleChatCompletions(body, context);
    assert.equal(first.status, 200);
    const message = first.body.choices[0].message;
    const call = message.tool_calls[0];
    assert.equal(first.body.choices[0].finish_reason, 'tool_calls');
    assert.match(call.id, /^call[a-f0-9]{24}$/);
    assert.equal(call.function.name, 'read');
    assert.deepEqual(JSON.parse(call.function.arguments), {
      path: 'fixture.txt',
    });
    // Only the client supplies the fixture value. Omitting effort on this
    // continuation must not change the running prompt's selected CLI variant.
    const continuation = {
      ...body,
      reasoning_effort: undefined,
      messages: [
        ...body.messages,
        message,
        {
          role: 'tool',
          tool_call_id: call.id,
          content: 'unique-client-value-9137',
        },
      ],
    };
    const final = await handleChatCompletions(continuation, context);
    assert.equal(final.status, 200);
    assert.equal(
      final.body.choices[0].message.content,
      `swe-2-${effort}: unique-client-value-9137`,
    );
    assert.equal(final.body.choices[0].finish_reason, 'stop');
    assert.equal(final.body.usage.total_tokens, 14);
    await closeAllSessions();
  });
}

test('ACP still respects the proxy model blocklist', async () => {
  setModelAccessMode('blocklist');
  setModelAccessList(['swe-2-medium']);
  try {
    const result = await handleChatCompletions(
      {
        model: 'swe-2-high',
        reasoning_effort: 'medium',
        messages: [{ role: 'user', content: 'hello' }],
      },
      { callerKey: 'test' },
    );
    assert.equal(result.status, 403);
    assert.equal(result.body.error.type, 'model_blocked');
  } finally {
    setModelAccessMode('all');
    setModelAccessList([]);
  }
});

for (const role of ['system', 'developer', 'user']) {
  test(`new ${role} instructions reach a fresh prompt before it can request another tool`, async () => {
    const context = { callerKey: `steering-${role}` };
    const body = {
      model: 'swe-2-high',
      tools,
      messages: [{ role: 'user', content: 'Read the fixture.' }],
    };
    const first = await handleChatCompletions(body, context);
    const message = first.body.choices[0].message;
    const result = {
      role: 'tool',
      tool_call_id: message.tool_calls[0].id,
      content: 'fixture result',
    };
    const steering = {
      role,
      content: 'STOP_AFTER_READ: Do not request another tool.',
    };
    const messages =
      role === 'user'
        ? [...body.messages, message, result, steering]
        : [steering, ...body.messages, message, result];
    const final = await handleChatCompletions({ ...body, messages }, context);
    assert.equal(final.status, 200);
    assert.equal(
      final.body.choices[0].message.content,
      'New instructions received; no additional client tool requested.',
    );
    assert.equal(final.body.choices[0].message.tool_calls, undefined);
    await closeAllSessions();
  });
}

test('continuations recheck access for their pinned effort variant', async () => {
  const context = { callerKey: 'pinned-access' };
  const body = {
    model: 'swe-2-high',
    reasoning_effort: 'medium',
    tools,
    messages: [{ role: 'user', content: 'Read the fixture.' }],
  };
  const first = await handleChatCompletions(body, context);
  const message = first.body.choices[0].message;
  setModelAccessMode('blocklist');
  setModelAccessList(['swe-2-medium']);
  try {
    const final = await handleChatCompletions(
      {
        ...body,
        reasoning_effort: undefined,
        messages: [
          ...body.messages,
          message,
          {
            role: 'tool',
            tool_call_id: message.tool_calls[0].id,
            content: 'fixture result',
          },
        ],
      },
      context,
    );
    assert.equal(final.status, 403);
    assert.equal(final.body.error.type, 'model_blocked');
  } finally {
    setModelAccessMode('all');
    setModelAccessList([]);
    await closeAllSessions();
  }
});
