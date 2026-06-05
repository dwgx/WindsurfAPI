import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'http2';
import { endOfStreamEnvelope, unwrapRequest, wrapEnvelope } from '../src/connect.js';
import { getField, parseFields, writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';

function grpcFrame(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.alloc(5 + buf.length);
  frame[0] = 0;
  frame.writeUInt32BE(buf.length, 1);
  buf.copy(frame, 5);
  return frame;
}

function stripGrpcFrame(buf) {
  if (buf.length >= 5 && buf[0] === 0) {
    const msgLen = buf.readUInt32BE(1);
    if (buf.length >= 5 + msgLen) return buf.subarray(5, 5 + msgLen);
  }
  return buf;
}

function extractGrpcFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const compressed = buf[offset];
    const msgLen = buf.readUInt32BE(offset + 1);
    if (compressed !== 0 || offset + 5 + msgLen > buf.length) break;
    frames.push(buf.subarray(offset + 5, offset + 5 + msgLen));
    offset += 5 + msgLen;
  }
  return frames;
}

function responseBody(payload, headers) {
  const contentType = String(headers['content-type'] || '');
  if (contentType.includes('application/connect+proto')) {
    return Buffer.concat([wrapEnvelope(payload, { compress: false }), endOfStreamEnvelope()]);
  }
  return grpcFrame(payload);
}

function errorBody(message, headers) {
  const contentType = String(headers['content-type'] || '');
  if (contentType.includes('application/connect+proto')) {
    const body = Buffer.from(JSON.stringify({ error: { message } }));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 0x02;
    frame.writeUInt32BE(body.length, 1);
    body.copy(frame, 5);
    return { body: frame, trailers: null };
  }
  return { body: Buffer.alloc(0), trailers: { 'grpc-status': '5', 'grpc-message': encodeURIComponent(message) } };
}

function requestPayload(body, headers) {
  const contentType = String(headers['content-type'] || '');
  if (contentType.includes('application/connect+proto')) {
    return unwrapRequest(body, headers);
  }
  const frames = extractGrpcFrames(body);
  return frames.length ? Buffer.concat(frames) : stripGrpcFrame(body);
}

function readStepOffset(payload) {
  const fields = parseFields(payload);
  const field = getField(fields, 2, 0);
  return field ? Number(field.value) : 0;
}

function startCascadeResponse(cascadeId) {
  return writeStringField(1, cascadeId);
}

function trajectoryStatusResponse(status) {
  return writeVarintField(2, status);
}

function trajectoryStepsResponse(text) {
  if (!text) return Buffer.alloc(0);
  const planner = writeStringField(1, text);
  const step = Buffer.concat([
    writeVarintField(1, 15),
    writeVarintField(4, 3),
    writeMessageField(20, planner),
  ]);
  return writeMessageField(1, step);
}

function runCommandStepResponse(command = 'printf HELLO') {
  const runCommandBody = writeStringField(23, command);
  const step = Buffer.concat([
    writeVarintField(1, 28),
    writeVarintField(4, 1),
    writeMessageField(28, runCommandBody),
  ]);
  return writeMessageField(1, step);
}

async function withFakeLanguageServer(handler, fn) {
  const server = http2.createServer();
  server.on('stream', handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('WindsurfClient cascade panel retry', () => {
  it('resets trajectory offsets after re-warming to a fresh cascade', async () => {
    process.env.CASCADE_POLL_INTERVAL_MS = '10';
    process.env.CASCADE_IDLE_GRACE_MS = '1';
    process.env.CASCADE_MAX_WAIT_MS = '500';
    process.env.CASCADE_COLD_STALL_BASE_MS = '500';
    process.env.CASCADE_WARM_STALL_MS = '500';
    process.env.GRPC_PROTOCOL = 'connect';

    const observedStepOffsets = [];
    let sendCount = 0;

    await withFakeLanguageServer((stream, headers) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const path = String(headers[':path'] || '');
        const payload = requestPayload(Buffer.concat(chunks), headers);
        const method = path.split('/').pop();

        if (method === 'StartCascade') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(startCascadeResponse('fresh-cascade'), headers));
          return;
        }

        if (method === 'SendUserCascadeMessage') {
          sendCount++;
          if (sendCount === 1) {
            const err = errorBody('panel state not found', headers);
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            if (err.trailers) stream.additionalHeaders(err.trailers);
            stream.end(err.body);
            return;
          }
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(Buffer.alloc(0), headers));
          return;
        }

        if (method === 'GetCascadeTrajectorySteps') {
          const offset = readStepOffset(payload);
          observedStepOffsets.push(offset);
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(trajectoryStepsResponse(offset === 0 ? 'fresh-output' : ''), headers));
          return;
        }

        if (method === 'GetCascadeTrajectory') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(trajectoryStatusResponse(1), headers));
          return;
        }

        if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(Buffer.alloc(0), headers));
          return;
        }

        stream.respond({ ':status': 404 });
        stream.end();
      });
    }, async (port) => {
      const { WindsurfClient } = await import('../src/client.js');
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const chunks = await client.cascadeChat([
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'continue' },
      ], 0, 'claude-sonnet-4-6', {
        reuseEntry: {
          cascadeId: 'expired-cascade',
          sessionId: 'expired-session',
          lsPort: port,
          apiKey: 'test-api-key',
          stepOffset: 5,
          generatorOffset: 5,
        },
      });

      const text = chunks.map(c => c.text || '').join('');
      assert.equal(sendCount, 2);
      assert.ok(observedStepOffsets.length > 0);
      assert.equal(observedStepOffsets[0], 0);
      assert.match(text, /fresh-output/);
    });
  });

  it('v2.0.25 HIGH-2: cascade not_found triggers fresh fallback and marks reuse entry invalidated', async () => {
    process.env.CASCADE_POLL_INTERVAL_MS = '10';
    process.env.CASCADE_IDLE_GRACE_MS = '1';
    process.env.CASCADE_MAX_WAIT_MS = '500';
    process.env.CASCADE_COLD_STALL_BASE_MS = '500';
    process.env.CASCADE_WARM_STALL_MS = '500';
    process.env.GRPC_PROTOCOL = 'connect';

    let startCount = 0;
    let sendCount = 0;
    let observedFreshCascadeId = null;

    await withFakeLanguageServer((stream, headers) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const path = String(headers[':path'] || '');
        const payload = requestPayload(Buffer.concat(chunks), headers);
        const method = path.split('/').pop();

        if (method === 'StartCascade') {
          startCount++;
          observedFreshCascadeId = 'fresh-' + startCount;
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(startCascadeResponse(observedFreshCascadeId), headers));
          return;
        }

        if (method === 'SendUserCascadeMessage') {
          sendCount++;
          if (sendCount === 1) {
            // Simulate the upstream telling us the cascade we tried to
            // resume is gone — different message text from "panel state
            // not found" so we can prove isExpiredCascade triggers the
            // same recovery and not isPanelMissing.
            const err = errorBody('not_found: cascade trajectory has been expired by ttl', headers);
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            if (err.trailers) stream.additionalHeaders(err.trailers);
            stream.end(err.body);
            return;
          }
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(Buffer.alloc(0), headers));
          return;
        }

        if (method === 'GetCascadeTrajectorySteps') {
          const offset = readStepOffset(payload);
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(trajectoryStepsResponse(offset === 0 ? 'recovered-output' : ''), headers));
          return;
        }

        if (method === 'GetCascadeTrajectory') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(trajectoryStatusResponse(1), headers));
          return;
        }

        if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(Buffer.alloc(0), headers));
          return;
        }

        stream.respond({ ':status': 404 });
        stream.end();
      });
    }, async (port) => {
      const { WindsurfClient } = await import('../src/client.js');
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const chunks = await client.cascadeChat([
        { role: 'user', content: 'turn1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'turn2' },
      ], 0, 'claude-sonnet-4-6', {
        reuseEntry: {
          cascadeId: 'long-dead-cascade',
          sessionId: 'long-dead-session',
          lsPort: port,
          apiKey: 'test-api-key',
          stepOffset: 5,
          generatorOffset: 5,
        },
      });

      // Recovery path actually fired: client called StartCascade after the
      // expired-send and got a fresh cascadeId on the trailing send.
      assert.equal(sendCount, 2, 'should retry send once after recovery');
      assert.equal(startCount, 1, 'recovery path should issue exactly one fresh StartCascade');
      assert.equal(chunks.cascadeId, observedFreshCascadeId, 'final cascadeId must be the fresh one, not the dead reuseEntry.cascadeId');
      assert.notEqual(chunks.cascadeId, 'long-dead-cascade');
      assert.equal(chunks.reuseEntryInvalidated, true, 'should signal the caller to skip restoring the dead entry');
      assert.match(chunks.map(c => c.text || '').join(''), /recovered-output/);
    });
  });

  it('native bridge returns after first cascade-native tool call instead of waiting for remote execution', async () => {
    process.env.CASCADE_POLL_INTERVAL_MS = '10';
    process.env.CASCADE_IDLE_GRACE_MS = '1';
    process.env.CASCADE_MAX_WAIT_MS = '500';
    process.env.CASCADE_COLD_STALL_BASE_MS = '500';
    process.env.CASCADE_WARM_STALL_MS = '500';
    process.env.GRPC_PROTOCOL = 'connect';

    let statusPolls = 0;
    let stepPolls = 0;
    const streamed = [];

    await withFakeLanguageServer((stream, headers) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const path = String(headers[':path'] || '');
        const method = path.split('/').pop();

        if (method === 'StartCascade') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(startCascadeResponse('native-cascade'), headers));
          return;
        }

        if (method === 'SendUserCascadeMessage') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(Buffer.alloc(0), headers));
          return;
        }

        if (method === 'GetCascadeTrajectorySteps') {
          stepPolls++;
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(runCommandStepResponse('printf HELLO'), headers));
          return;
        }

        if (method === 'GetCascadeTrajectory') {
          statusPolls++;
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(trajectoryStatusResponse(2), headers));
          return;
        }

        if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(Buffer.alloc(0), headers));
          return;
        }

        stream.respond({ ':status': 404 });
        stream.end();
      });
    }, async (port) => {
      const { WindsurfClient } = await import('../src/client.js');
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const chunks = await client.cascadeChat([{ role: 'user', content: 'run it' }], 0, 'claude-4.5-haiku', {
        nativeMode: true,
        nativeAllowlist: ['run_command'],
        onChunk: c => streamed.push(c),
      });

      assert.equal(stepPolls, 1);
      assert.equal(statusPolls, 0, 'native tool call should end before status polling waits for remote execution');
      assert.equal(chunks.toolCalls.length, 1);
      assert.equal(chunks.toolCalls[0].name, 'run_command');
      assert.match(chunks.toolCalls[0].argumentsJson, /printf HELLO/);
      assert.equal(streamed.filter(c => c.nativeToolCall).length, 1);
    });
  });

  it('native bridge protocol lab can poll after a cascade-native tool call', async () => {
    const prevPollAfterTool = process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_POLL_AFTER_TOOL;
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_POLL_AFTER_TOOL = '1';
    process.env.CASCADE_POLL_INTERVAL_MS = '10';
    process.env.CASCADE_IDLE_GRACE_MS = '1';
    process.env.CASCADE_MAX_WAIT_MS = '700';
    process.env.CASCADE_COLD_STALL_BASE_MS = '700';
    process.env.CASCADE_WARM_STALL_MS = '700';
    process.env.GRPC_PROTOCOL = 'connect';

    let statusPolls = 0;
    let stepPolls = 0;
    const streamed = [];

    try {
      await withFakeLanguageServer((stream, headers) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          const path = String(headers[':path'] || '');
          const method = path.split('/').pop();

          if (method === 'StartCascade') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(startCascadeResponse('native-cascade-lab'), headers));
            return;
          }

          if (method === 'SendUserCascadeMessage') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.alloc(0), headers));
            return;
          }

          if (method === 'GetCascadeTrajectorySteps') {
            stepPolls++;
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(runCommandStepResponse('printf LAB'), headers));
            return;
          }

          if (method === 'GetCascadeTrajectory') {
            statusPolls++;
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(trajectoryStatusResponse(1), headers));
            return;
          }

          if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
            stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
            stream.end(responseBody(Buffer.alloc(0), headers));
            return;
          }

          stream.respond({ ':status': 404 });
          stream.end();
        });
      }, async (port) => {
        const { WindsurfClient } = await import('../src/client.js');
        const client = new WindsurfClient('test-api-key', port, 'csrf-token');
        const chunks = await client.cascadeChat([{ role: 'user', content: 'run it' }], 0, 'claude-4.5-haiku', {
          nativeMode: true,
          nativeAllowlist: ['run_command'],
          onChunk: c => streamed.push(c),
        });

        assert.ok(stepPolls > 1, 'lab mode should keep polling trajectory steps after the native tool call');
        assert.ok(statusPolls > 0, 'lab mode should poll trajectory status instead of returning immediately');
        assert.equal(chunks.toolCalls.length, 1);
        assert.equal(chunks.toolCalls[0].name, 'run_command');
        assert.match(chunks.toolCalls[0].argumentsJson, /printf LAB/);
        assert.equal(streamed.filter(c => c.nativeToolCall).length, 1);
      });
    } finally {
      if (prevPollAfterTool === undefined) delete process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_POLL_AFTER_TOOL;
      else process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_POLL_AFTER_TOOL = prevPollAfterTool;
    }
  });
});
