import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MATRIX, startOfflineConnectStub } from './helpers/smoke-matrix-upstream.mjs';
import { wrapEnvelope } from '../src/connect.js';
import { writeStringField } from '../src/proto.js';

const run = promisify(execFile);
const program = fileURLToPath(new URL('../scripts/load-connect-offline.mjs', import.meta.url));

async function load(scenario, count, concurrency, env = process.env) {
  const { stdout } = await run(process.execPath, [program, scenario, count, concurrency], { env, timeout: 45000, windowsHide: true });
  const lines = stdout.split(/\r?\n/).filter(l => l.startsWith('OFFLINE_CONNECT_LOAD '));
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0].slice('OFFLINE_CONNECT_LOAD '.length));
  assert.equal(report.ok, true);
  return report;
}

test('the offline load runner covers isolated buffered and streamed HTTP turns', async t => {
  const diag = mkdtempSync(join(tmpdir(), 'windsurfapi-load-diag-'));
  t.after(() => rmSync(diag, { recursive: true, force: true }));
  const report = await load('ok', '4', '2', { ...process.env, WINDSURFAPI_TRACE: '1', WINDSURFAPI_TRACE_DIR: diag,
    DEVIN_CONNECT_WIRE_DUMP: '1', DEVIN_CONNECT_WIRE_DUMP_DIR: diag });
  assert.deepEqual(readdirSync(diag), []);
  assert.equal(report.attempts.length, 4);
  assert.deepEqual(report.turns.map(t => t.stream), [false, true, false, true]);
  assert.ok(report.turns.every(t => t.status === 200 && t.answer === MATRIX.text + ' #' + t.index &&
    t.error === null && t.terminal === 'stop' && (!t.stream || t.done)));
  assert.deepEqual(report.samples.toSorted((a, b) => a - b), [0, 1, 2, 3]);
  assert.equal(report.peak, 2);
  assert.ok(report.p95Ms >= report.p50Ms);
});

test('pre-commit upstream refusal fails over once, then delivers one complete turn', async () => {
  const report = await load('precommit', '1', '1');
  assert.equal(report.attempts.length, 2);
  assert.notEqual(report.attempts[0], report.attempts[1]);
  assert.deepEqual(report.samples, [0, 0]);
  assert.equal(report.turns[0].answer, MATRIX.text + ' #0');
  assert.equal(report.turns[0].error, null);
});

test('post-commit upstream refusal preserves the partial turn without replay', async () => {
  const report = await load('postcommit', '1', '1');
  assert.equal(report.attempts.length, 1);
  assert.deepEqual(report.samples, [0]);
  assert.equal(report.turns[0].terminal, 'error');
  assert.deepEqual([report.turns[0].answer, report.turns[0].error], ['partial fixture', 'RATE_LIMITED']);
});

test('a well-framed payload without the expected model and message counts as no attempt', async t => {
  const stub = await startOfflineConnectStub({ tokens: ['fixture'], scenario: 'ok', model: 'swe-1-6-slow' });
  t.after(() => stub.close());
  const status = await new Promise((resolve, reject) => {
    const req = stub.request({ method: 'POST', path: '/exa.api_server_pb.ApiServerService/GetChatMessage',
      headers: { authorization: 'Basic fixture-fixture' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(wrapEnvelope(writeStringField(1, 'unrelated field')));
  });
  assert.equal(status, 400);
  assert.deepEqual(stub.attempts, []);
});
