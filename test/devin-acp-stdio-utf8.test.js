import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { __setDevinAcpSpawnForTest, runDevinAcpProcess } from '../src/devin-acp.js';

const rawLimit = 1024;
const previousLimit = process.env.DEVIN_OUTPUT_LIMIT_BYTES;
const handshake = new Map([
  ['initialize', { protocolVersion: 1 }],
  ['authenticate', {}],
  ['session/new', { sessionId: 'fixture-session' }],
]);

afterEach(() => {
  __setDevinAcpSpawnForTest(null);
  if (previousLimit === undefined) delete process.env.DEVIN_OUTPUT_LIMIT_BYTES;
  else process.env.DEVIN_OUTPUT_LIMIT_BYTES = previousLimit;
});

function line(frame) {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\r\n');
}

function update(sessionUpdate, text) {
  return line({
    method: 'session/update',
    params: { sessionId: 'fixture-session', update: { sessionUpdate, content: { type: 'text', text } } },
  });
}

function runFixture(onPrompt, { limit = 16_384, onChunk } = {}) {
  process.env.DEVIN_OUTPUT_LIMIT_BYTES = String(limit);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.kill = () => true;

  let bytesSent = 0;
  const emit = (pipe, bytes) => {
    bytesSent += bytes.length;
    child[pipe].emit('data', bytes);
  };
  child.stdin.write = (request) => {
    const { id, method } = JSON.parse(request);
    queueMicrotask(() => {
      if (method === 'session/prompt') {
        onPrompt({ emit, bytesSent, terminal: line({ id, result: { stopReason: 'end_turn' } }) });
      } else {
        assert.ok(handshake.has(method), `Unexpected ACP fixture request: ${method}`);
        emit('stdout', line({ id, result: handshake.get(method) }));
      }
    });
    return true;
  };
  __setDevinAcpSpawnForTest(() => child);
  return runDevinAcpProcess('hello', { apiKey: 'fixture-key', onChunk });
}

it('preserves interleaved split UTF-8 on stdout and stderr', async () => {
  const chunks = [];
  let streamedCount;
  const result = await runFixture(({ emit, terminal }) => {
    const stdout = Buffer.concat([
      update('agent_thought_chunk', '推理💭'),
      Buffer.from('\r\n'),
      update('agent_message_chunk', '你好'),
      update('agent_message_chunk', '🌊完成'),
    ]);
    const stderr = Buffer.from('诊断📌');
    for (let i = 0; i < stdout.length; i++) {
      if (i < stderr.length) emit('stderr', stderr.subarray(i, i + 1));
      emit('stdout', stdout.subarray(i, i + 1));
    }
    streamedCount = chunks.length;
    emit('stdout', terminal);
  }, { onChunk: (chunk) => chunks.push(chunk) });

  assert.equal(streamedCount, 3);
  assert.deepEqual(chunks, [
    { kind: 'thought', text: '推理💭' },
    { kind: 'message', text: '你好' },
    { kind: 'message', text: '🌊完成' },
  ]);
  assert.equal(result.text, '你好🌊完成');
  assert.equal(result.reasoning, '推理💭');
  assert.equal(result.stderr, '诊断📌');
  assert.equal(result.stopReason, 'end_turn');
});

for (const extraBytes of [0, 1]) {
  it(`counts physical stdio bytes at the limit plus ${extraBytes}`, async () => {
    const result = runFixture(({ emit, bytesSent, terminal }) => {
      const suffix = Buffer.from('海🌊');
      const padding = Buffer.alloc(rawLimit + extraBytes - bytesSent - terminal.length - suffix.length, 0x61);
      const stderr = Buffer.concat([padding, suffix]);
      emit('stderr', stderr.subarray(0, -1));
      emit('stderr', stderr.subarray(-1));
      emit('stdout', terminal);
    }, { limit: rawLimit });

    if (extraBytes) {
      await assert.rejects(result, { status: 502, type: 'backend_output_too_large' });
    } else {
      const value = await result;
      assert.equal(value.text, '');
      assert.ok(value.stderr.endsWith('海🌊'));
      assert.equal(value.stopReason, 'end_turn');
    }
  });
}
