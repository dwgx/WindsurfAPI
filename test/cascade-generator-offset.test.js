// D5 — the generator-metadata window must never silently restart at record 0.
//
// MEASURED on the audited baseline (evidence/audit2/Cascade.md F6, probe E):
// a cascade whose generator-metadata records carried no usage fields produced
// `entryCount: null` (parseGeneratorMetadata returned null as soon as no record
// had usage), the client turned that into `generatorOffset: null`, and the
// conversation pool coerced null→0. The next turn therefore asked the metadata
// RPC for the WHOLE cascade again and reported every earlier turn's tokens as
// this turn's usage — the over-bill the offset exists to prevent. Measured
// offsets were `[0,0]` where the valid-usage control gave `[0,1]`.
//
// The contract pinned here:
//   * a metadata response that has records but no usage still reports the
//     record count (the offset advance) and says `hasUsage: false`;
//   * the next reuse asks from that count, and a valid-usage turn bills only the
//     records after the stored offset (`[0,1]` control);
//   * the pool keeps an unknown offset as unknown instead of record 0;
//   * a metadata read that fails is an explicit abstention (`generatorOffset:
//     null`, no aggregate usage), never a silent restart at 0.

import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { endOfStreamEnvelope, unwrapRequest, wrapEnvelope } from '../src/connect.js';
import { getField, parseFields, writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';
import { parseGeneratorMetadata } from '../src/windsurf.js';
import { isConnectContentType, terminateRpcWithStatus } from './helpers/fake-grpc-trailers.mjs';

const MODEL_UID = 'claude-sonnet-4-6';

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
  if (isConnectContentType(contentType)) {
    return Buffer.concat([wrapEnvelope(payload, { compress: false }), endOfStreamEnvelope()]);
  }
  return grpcFrame(payload);
}

function errorBody(message, headers) {
  const contentType = String(headers['content-type'] || '');
  if (isConnectContentType(contentType)) {
    const body = Buffer.from(JSON.stringify({ error: { message } }));
    const frame = Buffer.alloc(5 + body.length);
    frame[0] = 0x02;
    frame.writeUInt32BE(body.length, 1);
    body.copy(frame, 5);
    return { body: frame, trailers: null };
  }
  return { body: Buffer.alloc(0), trailers: { 'grpc-status': '13', 'grpc-message': encodeURIComponent(message) } };
}

function requestPayload(body, headers) {
  const contentType = String(headers['content-type'] || '');
  if (isConnectContentType(contentType)) return unwrapRequest(body, headers);
  const frames = extractGrpcFrames(body);
  return frames.length ? Buffer.concat(frames) : stripGrpcFrame(body);
}

function startCascadeResponse(cascadeId) {
  return writeStringField(1, cascadeId);
}

function trajectoryStatusResponse(status) {
  return writeVarintField(2, status);
}

function trajectoryStepsResponse(text, usage = null) {
  const planner = writeStringField(1, text);
  const step = Buffer.concat([
    writeVarintField(1, 15),
    writeVarintField(4, 3),
    writeMessageField(20, planner),
    ...(usage ? [writeMessageField(5, writeMessageField(9, usage))] : []),
  ]);
  return writeMessageField(1, step);
}

/** One CortexStepGeneratorMetadata; `usage: null` is a record with no usage. */
function metadataRecord(usage) {
  // A record without usage still names its model — an EMPTY nested message
  // encodes to zero bytes and would vanish from the response entirely.
  const chatModel = usage
    ? writeMessageField(4, Buffer.concat([
      writeVarintField(2, usage.input),
      writeVarintField(3, usage.output),
    ]))
    : writeStringField(1, 'MODEL_WITHOUT_USAGE');
  return writeMessageField(1, chatModel);
}

function metadataResponse(records) {
  return Buffer.concat(records.map(record => writeMessageField(1, record)));
}

function readOffset(payload) {
  const field = getField(parseFields(payload), 2, 0);
  return field ? Number(field.value) : 0;
}

async function withFakeLanguageServer(handler, fn) {
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => { terminateRpcWithStatus(stream); handler(stream, headers); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    for (const session of sessions) {
      try { session.close(); } catch {}
      try { session.destroy(); } catch {}
    }
    await new Promise(resolve => server.close(resolve));
  }
}

const ENV = {
  CASCADE_POLL_INTERVAL_MS: '10',
  CASCADE_IDLE_GRACE_MS: '1',
  CASCADE_MAX_WAIT_MS: '500',
  CASCADE_COLD_STALL_BASE_MS: '500',
  CASCADE_WARM_STALL_MS: '500',
  GRPC_PROTOCOL: 'connect',
};

const savedEnv = new Map();
beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
});

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * Fake LS whose generator-metadata answer is a function of the requested offset:
 * `answer(offset)` returns the response bytes, or throws to fail the RPC.
 */
function metadataServer(answer) {
  const offsets = [];
  let stepsCalls = 0;
  const handler = (stream, headers) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      const payload = requestPayload(Buffer.concat(chunks), headers);
      const method = String(headers[':path'] || '').split('/').pop();
      const respond = (body) => {
        stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
        stream.end(responseBody(body, headers));
      };
      if (method === 'StartCascade') {
        respond(startCascadeResponse('fresh-cascade'));
        return;
      }
      if (method === 'SendUserCascadeMessage') {
        respond(Buffer.alloc(0));
        return;
      }
      if (method === 'GetCascadeTrajectorySteps') {
        stepsCalls++;
        const steps = answer.steps || [trajectoryStepsResponse('answer')];
        respond(steps[stepsCalls - 1] ?? Buffer.alloc(0));
        return;
      }
      if (method === 'GetCascadeTrajectory') {
        respond(trajectoryStatusResponse(stepsCalls < (answer.steps?.length ?? 1) ? 2 : 1));
        return;
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        const offset = readOffset(payload);
        offsets.push(offset);
        if (answer.fail) {
          const err = errorBody(answer.fail, headers);
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc' });
          if (err.trailers) stream.additionalHeaders(err.trailers);
          stream.end(err.body);
          return;
        }
        respond(answer.records(offset));
        return;
      }
      stream.respond({ ':status': 404 });
      stream.end();
    });
  };
  return { handler, offsets };
}

async function runTurn({ reuseEntry = null, answer }) {
  const fixture = metadataServer(answer);
  let chunks;
  await withFakeLanguageServer(fixture.handler, async (port) => {
    const { WindsurfClient } = await import('../src/client.js');
    const client = new WindsurfClient('test-api-key', port, 'csrf-token');
    chunks = await client.cascadeChat(
      [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'continue' }],
      0,
      MODEL_UID,
      {
        reuseEntry: reuseEntry ? { ...reuseEntry, lsPort: port, apiKey: 'test-api-key' } : null,
      },
    );
  });
  return { ...fixture, chunks };
}

describe('D5: the metadata window start survives a turn that reports no usage', () => {
  it('the parser keeps the record count when no record carries usage', () => {
    const parsed = parseGeneratorMetadata(metadataResponse([
      metadataRecord(null),
      metadataRecord(null),
    ]));
    assert.ok(parsed, 'two returned records must not be reported as "nothing"');
    assert.equal(parsed.entryCount, 2, 'the offset advance is the record count');
    assert.equal(parsed.hasUsage, false, 'no record carried usage');
    assert.equal(parsed.inputTokens, 0);
    assert.equal(parsed.outputTokens, 0);

    const withUsage = parseGeneratorMetadata(metadataResponse([metadataRecord({ input: 7, output: 3 })]));
    assert.equal(withUsage.entryCount, 1);
    assert.equal(withUsage.hasUsage, true);
    assert.equal(withUsage.inputTokens, 7);
    assert.equal(withUsage.outputTokens, 3);

    assert.equal(parseGeneratorMetadata(Buffer.alloc(0)), null, 'an empty response is still nothing');
  });

  it('carries explicit zero to the handler without inventing usage on missing turns', async () => {
    const { chunks } = await runTurn({
      answer: { records: () => metadataResponse([metadataRecord({ input: 0, output: 0 })]) },
    });
    assert.deepEqual(chunks.usage?.reportedUsage, { inputTokens: 0, outputTokens: 0 });
    assert.equal(chunks.generatorOffset, 1);
  });

  it('keeps sparse step observations on a reread without replacing the last positive billing reading', async () => {
    const { chunks } = await runTurn({
      answer: {
        steps: [
          trajectoryStepsResponse('answer', writeVarintField(3, 5)),
          trajectoryStepsResponse('answer', writeVarintField(2, 0)),
        ],
        records: () => metadataResponse([metadataRecord(null)]),
      },
    });
    assert.equal(chunks.usage?.outputTokens, 5);
    assert.deepEqual(chunks.usage?.reportedUsage, { inputTokens: 0, outputTokens: 5 });
  });

  it('control: valid usage bills only the records after the stored offset ([0,1])', async () => {
    const first = await runTurn({
      answer: {
        records: () => metadataResponse([metadataRecord({ input: 100, output: 10 })]),
      },
    });
    assert.deepEqual(first.offsets, [0], 'a fresh cascade asks from record 0');
    assert.equal(first.chunks.usage?.inputTokens, 100);
    assert.equal(first.chunks.generatorOffset, 1, 'the next window starts after the record just billed');

    const second = await runTurn({
      reuseEntry: { cascadeId: 'live', sessionId: 'live-session', stepOffset: 1, generatorOffset: first.chunks.generatorOffset },
      answer: {
        records: () => metadataResponse([metadataRecord({ input: 50, output: 5 })]),
      },
    });
    assert.deepEqual(second.offsets, [1], 'the reuse asks from the stored offset, not from 0');
    assert.equal(second.chunks.usage?.inputTokens, 50, 'only the new record is billed');
    assert.equal(second.chunks.usage?.outputTokens, 5);
    assert.equal(second.chunks.generatorOffset, 2);
  });

  it('no-usage records still advance the window: the next reuse asks from 2, not 0', async () => {
    const pool = await import('../src/conversation-pool.js');
    pool.poolClear();

    const first = await runTurn({
      answer: { records: () => metadataResponse([metadataRecord(null), metadataRecord(null)]) },
    });
    assert.deepEqual(first.offsets, [0]);
    assert.equal(first.chunks.usage, null, 'no aggregate usage may be claimed without usage records');
    assert.equal(first.chunks.generatorOffset, 2,
      'two records were consumed, so the next window starts at 2');

    // Round-trip through the real pool, the way the handler checks a turn in.
    const fp = 'fp-d5';
    pool.checkin(fp, {
      cascadeId: first.chunks.cascadeId,
      sessionId: first.chunks.sessionId,
      lsPort: 1,
      apiKey: 'test-api-key',
      stepOffset: first.chunks.stepOffset,
      generatorOffset: first.chunks.generatorOffset,
    }, 'api:d5:user:u1', 0);
    const entry = pool.checkout(fp, 'api:d5:user:u1');
    assert.ok(entry, 'precondition: the entry is reusable');
    assert.equal(entry.generatorOffset, 2, 'the pool must carry the count, not reset it');

    const second = await runTurn({
      reuseEntry: { ...entry, stepOffset: 1 },
      answer: { records: () => metadataResponse([metadataRecord({ input: 9, output: 1 })]) },
    });
    assert.deepEqual(second.offsets, [2], 'the next turn asks from the record count');
    assert.equal(second.chunks.usage?.inputTokens, 9, 'prior turns are not re-summed');
    assert.equal(second.chunks.generatorOffset, 3);
    pool.poolClear();
  });

  it('the pool keeps an unknown window start unknown instead of record 0', async () => {
    const pool = await import('../src/conversation-pool.js');
    pool.poolClear();
    const fp = 'fp-d5-unknown';
    pool.checkin(fp, {
      cascadeId: 'c-unknown',
      sessionId: 's-unknown',
      lsPort: 1,
      apiKey: 'test-api-key',
      stepOffset: 3,
      generatorOffset: null,
    }, 'api:d5:user:u2', 0);
    const entry = pool.checkout(fp, 'api:d5:user:u2');
    assert.ok(entry);
    assert.equal(entry.generatorOffset, null,
      'null means "unknown"; coercing it to 0 makes the next turn re-bill the whole cascade');
    pool.poolClear();
  });

  it('a failed metadata read abstains instead of restarting the window at 0', async () => {
    const { chunks, offsets } = await runTurn({
      answer: { fail: 'generator metadata unavailable' },
    });
    assert.deepEqual(offsets, [0], 'the only window asked for was this fresh turn');
    assert.equal(chunks.usage, null, 'no usage may be reported for a read that failed');
    assert.equal(chunks.generatorOffset, null,
      'an unknown window start must stay unknown, not become record 0');
  });
});
