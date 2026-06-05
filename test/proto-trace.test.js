import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { grpcFrame } from '../src/grpc.js';
import { writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';
import {
  _resetProtoTraceForTests,
  summarizeProtoForTrace,
  traceGrpcPayload,
  unwrapTracePayload,
} from '../src/proto-trace.js';

const OLD_ENV = { ...process.env };

describe('proto trace', () => {
  let dir;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    dir = mkdtempSync(join(tmpdir(), 'wa-proto-trace-'));
    process.env.WINDSURFAPI_PROTO_TRACE_DIR = dir;
    _resetProtoTraceForTests();
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    rmSync(dir, { recursive: true, force: true });
  });

  it('summarizes nested protobuf messages without raw string previews by default', () => {
    const inner = Buffer.concat([
      writeStringField(1, 'devin-session-token-secret-value'),
      writeVarintField(2, 7),
    ]);
    const top = writeMessageField(3, inner);

    const summary = summarizeProtoForTrace(top);
    assert.equal(summary[0].field, 3);
    assert.equal(summary[0].type, 'message');
    assert.equal(summary[0].fields[0].field, 1);
    assert.equal(summary[0].fields[0].type, 'string');
    assert.equal(summary[0].fields[0].bytes, 'devin-session-token-secret-value'.length);
    assert.equal(summary[0].fields[0].preview, undefined);
    assert.equal(summary[0].fields[1].value, 7);
  });

  it('unwraps a gRPC frame before tracing', () => {
    const proto = writeStringField(1, 'hello');
    assert.deepEqual(unwrapTracePayload(grpcFrame(proto), 'grpc'), proto);
  });

  it('writes JSONL trace records only when enabled and redacts raw text', () => {
    process.env.WINDSURFAPI_PROTO_TRACE = '1';
    const proto = writeStringField(1, 'api_key=super-secret-token-value-1234567890');
    traceGrpcPayload({
      port: 42100,
      path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      direction: 'request',
      body: grpcFrame(proto),
      transport: 'grpc',
      framed: true,
    });

    const file = join(dir, `ls-proto-${process.pid}-GetUserStatus.jsonl`);
    const line = readFileSync(file, 'utf8').trim();
    const rec = JSON.parse(line);
    assert.equal(rec.direction, 'request');
    assert.equal(rec.method, 'GetUserStatus');
    assert.equal(rec.fields[0].type, 'string');
    assert.ok(!line.includes('super-secret-token-value'));
  });
});
