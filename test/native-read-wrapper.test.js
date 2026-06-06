import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'http2';
import { WindsurfClient } from '../src/client.js';
import { parseTrajectorySteps } from '../src/windsurf.js';
import { repairToolCallArguments } from '../src/handlers/chat.js';
import { parseFields, getField, writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';
import { endOfStreamEnvelope, unwrapRequest, wrapEnvelope } from '../src/connect.js';

function grpcFrame(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.alloc(5 + buf.length);
  frame[0] = 0;
  frame.writeUInt32BE(buf.length, 1);
  buf.copy(frame, 5);
  return frame;
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

function requestPayload(body, headers) {
  const contentType = String(headers['content-type'] || '');
  if (contentType.includes('application/connect+proto')) return unwrapRequest(body, headers);
  const frames = extractGrpcFrames(body);
  return frames.length ? Buffer.concat(frames) : body.subarray(5);
}

function responseBody(payload, headers) {
  const contentType = String(headers['content-type'] || '');
  if (contentType.includes('application/connect+proto')) {
    return Buffer.concat([wrapEnvelope(payload, { compress: false }), endOfStreamEnvelope()]);
  }
  return grpcFrame(payload);
}

function startCascadeResponse(cascadeId) {
  return writeStringField(1, cascadeId);
}

function trajectoryStatusResponse(status) {
  return writeVarintField(2, status);
}

function viewFileWrapperStep() {
  const wrapper = Buffer.concat([
    writeStringField(2, 'file:///home/user/projects/workspace-abc123/README.md'),
    writeMessageField(3, writeStringField(1, 'nested request')),
    writeStringField(4, 'observed content'),
  ]);
  return Buffer.concat([
    writeVarintField(1, 14),
    writeVarintField(4, 3),
    writeMessageField(19, wrapper),
  ]);
}

function errorStep(message) {
  const details = writeStringField(1, message);
  const errorMessage = writeMessageField(3, details);
  return Buffer.concat([
    writeVarintField(1, 17),
    writeVarintField(4, 3),
    writeMessageField(24, errorMessage),
  ]);
}

function trajectoryStepsResponse(...steps) {
  return Buffer.concat(steps.map(step => writeMessageField(1, step)));
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

describe('native Read wrapper trajectory parsing', () => {
  it('promotes type 14 field 19 wrapper into a view_file native tool call', () => {
    const steps = parseTrajectorySteps(trajectoryStepsResponse(viewFileWrapperStep()));
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'view_file');
    const args = JSON.parse(calls[0].argumentsJson);
    assert.equal(args.absolute_path_uri, 'file:///home/user/projects/workspace-abc123/README.md');
    assert.equal(calls[0].result, 'observed content');
  });

  it('does not promote wrapper field 2 when it contains the prompt text', () => {
    const wrapper = Buffer.concat([
      writeStringField(2, '- Working directory: /tmp/project\n\nUse the Read tool exactly once for README.md.'),
      writeMessageField(3, writeStringField(1, 'nested request')),
      writeStringField(4, 'observed content'),
    ]);
    const step = Buffer.concat([
      writeVarintField(1, 14),
      writeVarintField(4, 3),
      writeMessageField(19, wrapper),
    ]);
    const steps = parseTrajectorySteps(trajectoryStepsResponse(step));
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 0);
  });

  it('prefers wrapper field 1 path over field 2 prompt text', () => {
    const wrapper = Buffer.concat([
      writeStringField(1, 'file:///home/user/projects/workspace-abc123/README.md'),
      writeStringField(2, '- Working directory: /tmp/project\n\nUse the Read tool exactly once for README.md.'),
      writeStringField(4, 'observed content'),
    ]);
    const step = Buffer.concat([
      writeVarintField(1, 14),
      writeVarintField(4, 3),
      writeMessageField(19, wrapper),
    ]);
    const steps = parseTrajectorySteps(trajectoryStepsResponse(step));
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].argumentsJson).absolute_path_uri, 'file:///home/user/projects/workspace-abc123/README.md');
  });

  it('does not promote a nested wrapper field before the field role is confirmed', () => {
    const wrapper = Buffer.concat([
      writeMessageField(3, writeStringField(1, 'file:///home/user/projects/workspace-abc123/README.md')),
      writeStringField(4, 'observed content'),
    ]);
    const step = Buffer.concat([
      writeVarintField(1, 14),
      writeVarintField(4, 3),
      writeMessageField(19, wrapper),
    ]);
    const steps = parseTrajectorySteps(trajectoryStepsResponse(step));
    const calls = steps[0].toolCalls.filter(tc => tc.cascade_native);
    assert.equal(calls.length, 0);
  });

  it('repairs native Read workspace paths to caller cwd-relative paths before sanitizing', () => {
    const tc = {
      name: 'Read',
      argumentsJson: JSON.stringify({ file_path: '/home/user/projects/workspace-abc123/README.md', limit: 20 }),
    };
    const repaired = repairToolCallArguments(tc, [
      { role: 'system', content: '- Working directory: D:\\Project\\WindsurfAPI\n- Platform: windows' },
      { role: 'user', content: 'Use Read for README.md.' },
    ]);
    assert.equal(JSON.parse(repaired.argumentsJson).file_path, 'D:\\Project\\WindsurfAPI\\README.md');
  });

  it('does not rename view_file absolute_path_uri for cascade-style callers', () => {
    const tc = {
      name: 'view_file',
      argumentsJson: JSON.stringify({ absolute_path_uri: 'file:///home/user/projects/workspace-abc123/README.md' }),
    };
    const repaired = repairToolCallArguments(tc, [
      { role: 'system', content: '- Working directory: /repo' },
      { role: 'user', content: 'view README.md' },
    ]);
    const args = JSON.parse(repaired.argumentsJson);
    assert.equal(args.absolute_path_uri, 'file:///repo/README.md');
    assert.equal(Object.prototype.hasOwnProperty.call(args, 'file_path'), false);
  });

  it('keeps native proposal when the same trajectory batch also contains a remote execution error', async () => {
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
        const method = String(headers[':path'] || '').split('/').pop();
        const payload = requestPayload(Buffer.concat(chunks), headers);
        if (payload.length) {
          try { parseFields(payload); } catch {}
        }

        if (method === 'StartCascade') {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          stream.end(responseBody(startCascadeResponse('native-read-cascade'), headers));
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
          stream.end(responseBody(trajectoryStepsResponse(
            viewFileWrapperStep(),
            errorStep('invalid tool call: model_not_available'),
          ), headers));
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
      const client = new WindsurfClient('test-api-key', port, 'csrf-token');
      const chunks = await client.cascadeChat([{ role: 'user', content: 'read README.md' }], 0, 'claude-4.5-haiku', {
        nativeMode: true,
        nativeAllowlist: ['read_file'],
        onChunk: c => streamed.push(c),
      });

      assert.equal(stepPolls, 1);
      assert.equal(statusPolls, 0);
      assert.equal(chunks.toolCalls.length, 1);
      assert.equal(chunks.toolCalls[0].name, 'view_file');
      const args = JSON.parse(chunks.toolCalls[0].argumentsJson);
      assert.equal(args.absolute_path_uri, 'file:///home/user/projects/workspace-abc123/README.md');
      assert.equal(streamed.filter(c => c.nativeToolCall).length, 1);
    });
  });
});
