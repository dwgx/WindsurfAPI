import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { grpcFrame } from '../src/grpc.js';
import { writeBoolField, writeBytesField, writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';
import { buildSendCascadeMessageRequest } from '../src/windsurf.js';
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

  it('adds semantic SendUserCascadeMessage native tool config summaries', () => {
    process.env.WINDSURFAPI_PROTO_TRACE = '1';
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      nativeMode: true,
      nativeAllowlist: ['read_file', 'run_command', 'grep_v2', 'list_dir'],
      additionalSteps: [
        Buffer.concat([
          writeVarintField(1, 28),
          writeVarintField(4, 3),
          writeMessageField(28, writeStringField(23, 'printf test')),
        ]),
      ],
    });
    traceGrpcPayload({
      port: 42100,
      path: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
      direction: 'request',
      body: grpcFrame(proto),
      transport: 'grpc',
      framed: true,
    });

    const file = join(dir, `ls-proto-${process.pid}-SendUserCascadeMessage.jsonl`);
    const rec = JSON.parse(readFileSync(file, 'utf8').trim());
    assert.equal(rec.semantic.plannerMode, 1);
    assert.equal(rec.semantic.additionalStepCount, 1);
    assert.equal(rec.semantic.hasNativeToolConfig, true);
    assert.deepEqual(rec.semantic.nativeToolConfig.allowlist, ['read_file', 'run_command', 'grep_v2', 'list_dir']);
    assert.deepEqual(rec.semantic.nativeToolConfig.subconfigFields.sort((a, b) => a - b), [8, 10, 19, 33]);
    assert.deepEqual(rec.semantic.nativeToolConfig.subconfigs.map(c => c.kind), ['run_command', 'view_file', 'list_dir', 'grep_v2']);
    assert.deepEqual(rec.semantic.nativeToolConfig.subconfigs.map(c => c.bytes), [0, 0, 0, 0]);
  });

  it('summarizes native tool config subconfig child fields for IDE diffing', () => {
    process.env.WINDSURFAPI_PROTO_TRACE = '1';
    const toolConfig = Buffer.concat([
      writeMessageField(33, Buffer.concat([
        writeStringField(1, 'rg'),
        writeBoolField(7, true),
      ])),
      writeStringField(32, 'grep_v2'),
    ]);
    const planner = writeMessageField(13, toolConfig);
    const cascadeConfig = writeMessageField(1, planner);
    const proto = writeMessageField(5, cascadeConfig);

    traceGrpcPayload({
      port: 42100,
      path: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
      direction: 'request',
      body: grpcFrame(proto),
      transport: 'grpc',
      framed: true,
    });

    const file = join(dir, `ls-proto-${process.pid}-SendUserCascadeMessage.jsonl`);
    const rec = JSON.parse(readFileSync(file, 'utf8').trim());
    const grep = rec.semantic.nativeToolConfig.subconfigs[0];
    assert.equal(grep.field, 33);
    assert.equal(grep.kind, 'grep_v2');
    assert.deepEqual(grep.fieldNumbers, [1, 7]);
    assert.deepEqual(grep.fields.map(f => [f.field, f.wireType]), [[1, 2], [7, 0]]);
    assert.ok(grep.bytes > 0);
  });

  it('summarizes unknown native tool config fields for web matrix experiments', () => {
    process.env.WINDSURFAPI_PROTO_TRACE = '1';
    const toolConfig = Buffer.concat([
      writeMessageField(42, writeStringField(1, 'web')),
      writeBytesField(40, Buffer.alloc(0)),
      writeStringField(32, 'search_web'),
      writeStringField(32, 'read_url_content'),
    ]);
    const planner = writeMessageField(13, toolConfig);
    const cascadeConfig = writeMessageField(1, planner);
    const proto = writeMessageField(5, cascadeConfig);

    traceGrpcPayload({
      port: 42100,
      path: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
      direction: 'request',
      body: grpcFrame(proto),
      transport: 'grpc',
      framed: true,
    });

    const file = join(dir, `ls-proto-${process.pid}-SendUserCascadeMessage.jsonl`);
    const rec = JSON.parse(readFileSync(file, 'utf8').trim());
    assert.deepEqual(rec.semantic.nativeToolConfig.allowlist, ['search_web', 'read_url_content']);
    assert.deepEqual(rec.semantic.nativeToolConfig.subconfigFields, []);
    assert.deepEqual(rec.semantic.nativeToolConfig.unknownFields.map(f => f.field), [42, 40]);
    assert.deepEqual(rec.semantic.nativeToolConfig.unknownFields[0].summary.fieldNumbers, [1]);
    assert.equal(rec.semantic.nativeToolConfig.unknownFields[1].bytes, 0);
  });

  it('summarizes confirmed web native tool config fields as subconfigs', () => {
    process.env.WINDSURFAPI_PROTO_TRACE = '1';
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      nativeMode: true,
      nativeAllowlist: ['search_web', 'read_url_content'],
    });

    traceGrpcPayload({
      port: 42100,
      path: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
      direction: 'request',
      body: grpcFrame(proto),
      transport: 'grpc',
      framed: true,
    });

    const file = join(dir, `ls-proto-${process.pid}-SendUserCascadeMessage.jsonl`);
    const rec = JSON.parse(readFileSync(file, 'utf8').trim());
    assert.deepEqual(rec.semantic.nativeToolConfig.allowlist, ['search_web', 'read_url_content']);
    assert.deepEqual(rec.semantic.nativeToolConfig.subconfigFields, [13, 37]);
    assert.deepEqual(rec.semantic.nativeToolConfig.subconfigs.map(s => s.kind), ['search_web', 'read_url_content']);
    assert.deepEqual(rec.semantic.nativeToolConfig.unknownFields, []);
  });

  it('decodes web native tool subconfig enums without leaking URL allowlists', () => {
    process.env.WINDSURFAPI_PROTO_TRACE = '1';
    process.env.WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW =
      'search_web:120408011003;read_url_content:12180a1468747470733a2f2f6578616d706c652e636f6d2f1002';
    const proto = buildSendCascadeMessageRequest('k', 'cid', 'hi', 12345, 'MODEL_TEST', 'sess', {
      nativeMode: true,
      nativeAllowlist: ['search_web', 'read_url_content'],
    });

    traceGrpcPayload({
      port: 42100,
      path: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
      direction: 'request',
      body: grpcFrame(proto),
      transport: 'grpc',
      framed: true,
    });

    const file = join(dir, `ls-proto-${process.pid}-SendUserCascadeMessage.jsonl`);
    const line = readFileSync(file, 'utf8').trim();
    const rec = JSON.parse(line);
    const search = rec.semantic.nativeToolConfig.subconfigs.find(s => s.kind === 'search_web');
    const fetch = rec.semantic.nativeToolConfig.subconfigs.find(s => s.kind === 'read_url_content');
    assert.equal(search.decoded.thirdPartyConfig.provider.name, 'OPENAI');
    assert.equal(search.decoded.thirdPartyConfig.model.name, 'O4_MINI');
    assert.equal(fetch.decoded.autoWebRequestConfig.autoExecutionPolicy.name, 'ALLOWLIST');
    assert.equal(fetch.decoded.autoWebRequestConfig.allowlistCount, 1);
    assert.equal(fetch.decoded.autoWebRequestConfig.allowlist[0].bytes, 'https://example.com/'.length);
    assert.ok(!line.includes('https://example.com/'));
  });

  it('adds semantic GetCascadeTrajectorySteps native oneof summaries', () => {
    process.env.WINDSURFAPI_PROTO_TRACE = '1';
    const grepBody = Buffer.concat([
      writeStringField(2, 'Proxy workspace placeholder'),
      writeStringField(3, '/home/user/projects/workspace-test'),
      writeStringField(4, 'README.md'),
      writeStringField(15, 'README.md\n'),
    ]);
    const step = Buffer.concat([
      writeVarintField(1, 105),
      writeVarintField(4, 3),
      writeMessageField(105, grepBody),
    ]);
    const response = writeMessageField(1, step);
    traceGrpcPayload({
      port: 42100,
      path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
      direction: 'response',
      body: response,
      transport: 'grpc',
      framed: false,
    });

    const file = join(dir, `ls-proto-${process.pid}-GetCascadeTrajectorySteps.jsonl`);
    const rec = JSON.parse(readFileSync(file, 'utf8').trim());
    assert.equal(rec.semantic.stepCount, 1);
    assert.equal(rec.semantic.steps[0].type, 105);
    assert.equal(rec.semantic.steps[0].status, 3);
    assert.equal(rec.semantic.steps[0].nativeOneofs[0].field, 105);
    assert.equal(rec.semantic.steps[0].nativeOneofs[0].kind, 'grep_search_v2');
    assert.equal(rec.semantic.steps[0].nativeOneofs[0].body.rawOutputBytes, 'README.md\n'.length);
  });

  it('summarizes web trajectory payload shapes for protocol diffing', () => {
    process.env.WINDSURFAPI_PROTO_TRACE = '1';
    const doc = Buffer.concat([
      writeStringField(1, 'title'),
      writeStringField(2, 'https://example.com/'),
    ]);
    const searchBody = Buffer.concat([
      writeStringField(1, 'WindsurfAPI native bridge'),
      writeMessageField(2, doc),
      writeStringField(3, 'example.com'),
      writeStringField(5, 'summary'),
    ]);
    const fetchBody = Buffer.concat([
      writeStringField(1, 'https://example.com/'),
      writeMessageField(2, doc),
      writeStringField(5, 'body summary'),
    ]);
    const response = Buffer.concat([
      writeMessageField(1, Buffer.concat([
        writeVarintField(1, 42),
        writeVarintField(4, 3),
        writeMessageField(42, searchBody),
      ])),
      writeMessageField(1, Buffer.concat([
        writeVarintField(1, 40),
        writeVarintField(4, 3),
        writeMessageField(40, fetchBody),
      ])),
    ]);
    traceGrpcPayload({
      port: 42100,
      path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
      direction: 'response',
      body: response,
      transport: 'grpc',
      framed: false,
    });

    const file = join(dir, `ls-proto-${process.pid}-GetCascadeTrajectorySteps.jsonl`);
    const rec = JSON.parse(readFileSync(file, 'utf8').trim());
    const search = rec.semantic.steps[0].nativeOneofs[0];
    assert.equal(search.kind, 'search_web');
    assert.equal(search.body.webDocumentCount, 1);
    assert.deepEqual(search.body.fieldNumbers, [1, 2, 3, 5]);
    assert.equal(search.body.messageFields[0].field, 2);
    const fetch = rec.semantic.steps[1].nativeOneofs[0];
    assert.equal(fetch.kind, 'read_url_content');
    assert.deepEqual(fetch.body.fieldNumbers, [1, 2, 5]);
    assert.equal(fetch.body.messageFields[0].field, 2);
  });

  it('summarizes non-oneof step message fields for protocol diffing', () => {
    process.env.WINDSURFAPI_PROTO_TRACE = '1';
    const viewWrapper = Buffer.concat([
      writeStringField(2, 'file:///workspace/README.md'),
      writeMessageField(3, writeStringField(1, 'nested request')),
      writeStringField(4, 'observed content'),
    ]);
    const step = Buffer.concat([
      writeVarintField(1, 14),
      writeVarintField(4, 3),
      writeMessageField(19, viewWrapper),
    ]);
    const response = writeMessageField(1, step);
    traceGrpcPayload({
      port: 42100,
      path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
      direction: 'response',
      body: response,
      transport: 'grpc',
      framed: false,
    });

    const file = join(dir, `ls-proto-${process.pid}-GetCascadeTrajectorySteps.jsonl`);
    const rec = JSON.parse(readFileSync(file, 'utf8').trim());
    assert.equal(rec.semantic.steps[0].type, 14);
    assert.deepEqual(rec.semantic.steps[0].nativeOneofs, []);
    assert.equal(rec.semantic.steps[0].messageFields[0].field, 19);
    assert.deepEqual(rec.semantic.steps[0].messageFields[0].fieldNumbers, [2, 3, 4]);
  });

  it('summarizes read wrapper field 19 children without raw strings by default', () => {
    process.env.WINDSURFAPI_PROTO_TRACE = '1';
    const viewWrapper = Buffer.concat([
      writeStringField(1, 'file:///workspace/README.md'),
      writeStringField(2, '- Working directory: /tmp/project\nUse the Read tool exactly once.'),
      writeMessageField(3, writeStringField(1, './nested/README.md')),
      writeStringField(4, 'observed content'),
    ]);
    const step = Buffer.concat([
      writeVarintField(1, 14),
      writeVarintField(4, 3),
      writeMessageField(19, viewWrapper),
    ]);
    traceGrpcPayload({
      port: 42100,
      path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
      direction: 'response',
      body: writeMessageField(1, step),
      transport: 'grpc',
      framed: false,
    });

    const file = join(dir, `ls-proto-${process.pid}-GetCascadeTrajectorySteps.jsonl`);
    const rec = JSON.parse(readFileSync(file, 'utf8').trim());
    const summary = rec.semantic.steps[0].readWrapperField19;
    assert.deepEqual(summary.fieldNumbers, [1, 2, 3, 4]);
    const pathChild = summary.children.find(c => c.field === 1);
    const promptChild = summary.children.find(c => c.field === 2);
    const nestedChild = summary.children.find(c => c.field === 3);
    assert.equal(pathChild.type, 'string');
    assert.equal(pathChild.looksPathLike, true);
    assert.equal(pathChild.basename, 'README.md');
    assert.equal(pathChild.preview, undefined);
    assert.equal(promptChild.looksPromptLike, true);
    assert.equal(promptChild.hasNewline, true);
    assert.equal(promptChild.preview, undefined);
    assert.equal(nestedChild.type, 'message_or_bytes');
    assert.deepEqual(nestedChild.summary.fieldNumbers, [1]);
  });

  it('can include redacted read wrapper string previews behind a dedicated switch', () => {
    process.env.WINDSURFAPI_PROTO_TRACE = '1';
    process.env.WINDSURFAPI_PROTO_TRACE_READ_WRAPPER_STRINGS = '1';
    const viewWrapper = Buffer.concat([
      writeStringField(1, 'file:///workspace/README.md'),
      writeStringField(2, 'api_key=abcdefghijklmnopqrstuvwxyz1234567890abcdef Working directory: /tmp/project'),
    ]);
    const step = Buffer.concat([
      writeVarintField(1, 14),
      writeVarintField(4, 3),
      writeMessageField(19, viewWrapper),
    ]);
    traceGrpcPayload({
      port: 42100,
      path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
      direction: 'response',
      body: writeMessageField(1, step),
      transport: 'grpc',
      framed: false,
    });

    const file = join(dir, `ls-proto-${process.pid}-GetCascadeTrajectorySteps.jsonl`);
    const rec = JSON.parse(readFileSync(file, 'utf8').trim());
    const promptChild = rec.semantic.steps[0].readWrapperField19.children.find(c => c.field === 2);
    assert.match(promptChild.preview, /<redacted-secret>/);
    assert.doesNotMatch(promptChild.preview, /abcdefghijklmnopqrstuvwxyz1234567890abcdef/);
  });
});
