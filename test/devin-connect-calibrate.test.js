// devin-connect-calibrate.test.js — CI coverage for the unified tag calibrator.
//
// The harness itself ships a runnable offline self-test (selfTest()), but that
// only runs when the script is invoked. This pins its behavior in `npm test`:
//   - the offline self-test exits clean with no token / network / billing,
//   - the pure classify/aggregate/findCandidates/status functions behave,
//   - a real run is gated behind CALIBRATE_REAL + a token (never fires here).
//
// Mirrors the structure of devin-connect-paid-verify.test.js (spawn for the
// self-test gate, direct import for the pure logic).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyTag, aggregateDumps, findCandidates, runCalibration, statusTable,
  FREE_BASELINE, TARGETS,
} from '../scripts/devin-connect-calibrate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const script = join(root, 'scripts', 'devin-connect-calibrate.mjs');

function runScript(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('devin-connect calibrate harness — gating', () => {
  it('runs its offline self-test clean with no token, no network, no billing', async () => {
    const { code, stdout } = await runScript({ CALIBRATE_REAL: '' });
    assert.equal(code, 0, `self-test exit 0\n${stdout}`);
    assert.match(stdout, /SELFTEST\] OK/);
    assert.match(stdout, /no token, no network, no billing/);
  });

  it('does not fire a probe unless CALIBRATE_REAL=1', async () => {
    const { stdout } = await runScript({ CALIBRATE_REAL: '' });
    assert.match(stdout, /running offline self-test only/);
    assert.doesNotMatch(stdout, /firing one DEBUG_META probe/);
  });
});

describe('classifyTag — wire-shape → target bucket', () => {
  it('routes a meta varint to billing/cache (#46)', () => {
    const r = classifyTag({ scope: 'meta', tag: 14, kind: 'varint', preview: 1500 });
    assert.equal(r.bucket, 'billing/cache');
    assert.equal(r.task, '#46');
    assert.deepEqual(r.targets.sort(), ['billing', 'cache_tokens']);
  });

  it('routes a top-level string to actual_model_uid (#47)', () => {
    const r = classifyTag({ scope: 'top', tag: 8, kind: 'string', preview: 'claude-opus-4-8' });
    assert.equal(r.bucket, 'actual_model_uid');
    assert.equal(r.task, '#47');
  });

  it('routes a top-level sub-message to tool_calls (#49)', () => {
    const r = classifyTag({ scope: 'top', tag: 12, kind: 'message', preview: '<msg 47b>' });
    assert.equal(r.bucket, 'tool_calls');
    assert.equal(r.task, '#49');
  });

  it('marks an unrecognized shape as unknown with no targets', () => {
    const r = classifyTag({ scope: 'meta', tag: 99, kind: 'message', preview: '<msg 5b>' });
    assert.equal(r.bucket, 'unknown');
    assert.equal(r.targets.length, 0);
  });
});

describe('aggregateDumps — per-frame dumps → tag inventory', () => {
  it('infers wire kind from the dump value and dedupes across frames', () => {
    const inv = aggregateDumps(
      [{ 1: 'bot', 3: 'PONG', 8: 'claude-opus-4-8', 12: '<msg 40b>' }, { 3: 'more' }],
      [{ 6: 6, 14: 1500 }],
    );
    assert.equal(inv.top[8].kind, 'string');
    assert.equal(inv.top[12].kind, 'message');
    assert.equal(inv.top[3].kind, 'string');
    assert.equal(inv.meta[14].kind, 'varint');
    assert.equal(inv.meta[14].preview, 1500);
  });
});

describe('findCandidates — diff against the free baseline', () => {
  it('flags only tags absent from the known free baseline', () => {
    const inv = aggregateDumps(
      [{ 1: 'bot', 3: 'PONG', 8: 'claude-opus-4-8', 12: '<msg 47b>' }],
      [{ 6: 6, 14: 1500, 15: 200 }],
    );
    const { candidates } = findCandidates(inv);
    // #1/#3 (top) and #6 (meta) are baseline → never flagged.
    assert.ok(!candidates.some((c) => c.scope === 'top' && [1, 3].includes(c.tag)));
    assert.ok(!candidates.some((c) => c.scope === 'meta' && c.tag === 6));
    // #8/#12 (top) and #14/#15 (meta) are new → flagged with the right bucket.
    assert.ok(candidates.some((c) => c.scope === 'top' && c.tag === 8 && c.bucket === 'actual_model_uid'));
    assert.ok(candidates.some((c) => c.scope === 'top' && c.tag === 12 && c.bucket === 'tool_calls'));
    assert.equal(candidates.filter((c) => c.scope === 'meta' && c.bucket === 'billing/cache').length, 2);
  });

  it('a pure-free capture yields zero candidates (no false positives)', async () => {
    const report = await runCalibration({
      real: false,
      deps: { frameDumps: [{ 1: 'b', 3: 'PONG', 4: 2, 9: 't', 17: 'u' }], metaDumps: [{ 6: 6 }] },
    });
    assert.equal(report.candidates.length, 0);
    assert.equal(report.envLines.length, 0);
  });
});

describe('runCalibration — env-line generation', () => {
  it('emits the calibrated DEVIN_CONNECT_* lines for discovered candidates', async () => {
    const report = await runCalibration({
      real: false,
      deps: {
        frameDumps: [{ 1: 'b', 3: 'PONG', 8: 'claude-opus-4-8', 12: '<msg 47b>' }],
        metaDumps: [{ 6: 6, 14: 1500, 15: 200 }],
      },
    });
    assert.ok(report.envLines.some((l) => l === 'DEVIN_CONNECT_ACTUAL_MODEL_TAG=8'));
    assert.ok(report.envLines.some((l) => /outer=12/.test(l)));
    assert.ok(report.envLines.some((l) => /14,15/.test(l)));
  });

  it('surfaces a probe error without throwing', async () => {
    // No real path, no deps dumps → empty inventory, modelAlive defaults true.
    const report = await runCalibration({ real: false, deps: {} });
    assert.equal(report.candidates.length, 0);
    assert.equal(report.error, null);
  });
});

describe('statusTable — per-target state', () => {
  it('reports CANDIDATE FOUND for a discovered tag and pending otherwise', async () => {
    const report = await runCalibration({
      real: false,
      deps: { frameDumps: [{ 8: 'claude-opus-4-8' }], metaDumps: [] },
    });
    const tbl = statusTable(report, {});
    assert.equal(tbl.find((r) => r.target === 'actual_model_uid').state, 'CANDIDATE FOUND');
    assert.equal(tbl.find((r) => r.target === 'tool_calls').state, 'pending');
  });

  it('reports CALIBRATED when the target env var is already set', () => {
    const tbl = statusTable({ candidates: [] }, { DEVIN_CONNECT_ACTUAL_MODEL_TAG: '8' });
    assert.ok(tbl.find((r) => r.target === 'actual_model_uid').state.startsWith('CALIBRATED'));
  });

  it('covers every declared target', () => {
    const tbl = statusTable({ candidates: [] }, {});
    assert.equal(tbl.length, TARGETS.length);
  });
});

describe('FREE_BASELINE — sanity', () => {
  it('holds the known free top + meta tags', () => {
    assert.ok(FREE_BASELINE.top.has(3)); // content
    assert.ok(FREE_BASELINE.meta.has(6)); // provider constant
  });
});
