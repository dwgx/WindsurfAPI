// The local gate's baseline step: WHICH specs it measures, and that a stale pin
// actually turns the gate red.
//
// The bug this pins is a scope bug, not a comparison bug. `spec-baseline-check`
// already executed the covered specs and compared the measured count with
// `expectBaselinePass`; the gate still passed while two specs were stale (PR #281:
// 63->67, 72->76; wave 2: 55->60 and others) because the incremental gate measured
// the wrong set — it widened to EVERY spec on any src/ or scripts/ change, which
// made it slow on every branch, and a pin whose own test files had moved could sit
// stale until someone paid that cost. The split pinned here is:
//
//   incremental (`npm run gate`)        -> only the specs the diff can have moved
//   release     (`npm run gate:release`, release.yml) -> --all, every spec
//
// The second half of this file drives the REAL gate as a subprocess against a
// throwaway fixture: a deliberately drifted pin must fail it with the same
// sentence the mutation harness prints, and restoring the pin must pass again.

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { gateSteps, parseGateArgs, releaseEvidence } from '../scripts/local-gate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const plain = "import {it} from 'node:test';\nit('works',()=>{});\n";

function stepFor(steps, name) {
  const step = steps.find(([stepName]) => stepName === name);
  assert.ok(step, `${name} is not a gate step`);
  return step;
}

it('the incremental gate measures the change-scoped set, the release gate every spec', () => {
  const incremental = stepFor(gateSteps(), 'spec-baseline-check');
  assert.deepEqual(incremental[2], ['scripts/spec-baseline-check.mjs'],
    'the incremental gate must not pay the full-set cost');

  const release = stepFor(gateSteps({ release: true }), 'spec-baseline-check');
  assert.deepEqual(release[2], ['scripts/spec-baseline-check.mjs', '--all'],
    'the release gate must measure every spec against its pin');
});

it('--release and --all select the full scope; an unknown flag fails closed', () => {
  assert.deepEqual(parseGateArgs([]), { release: false });
  assert.deepEqual(parseGateArgs(['--release']), { release: true });
  assert.deepEqual(parseGateArgs(['--all']), { release: true });
  assert.throws(() => parseGateArgs(['--nope']), /unknown option/);
  assert.throws(() => parseGateArgs(['release']), /unknown option/);
});

it('the release workflow runs the FULL baseline measurement before the suite', () => {
  const yaml = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
  assert.match(yaml, /run: node scripts\/spec-baseline-check\.mjs --all\n/,
    'a tag checkout has no diff to scope by, so the release gate must pass --all');
  assert.ok(yaml.indexOf('spec-baseline-check.mjs --all') < yaml.indexOf('run: npm run test:release'),
    'the baselines must be measured before the release suite runs');
});

it('npm run gate:release is wired to the release scope', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['gate:release'], 'node scripts/local-gate.mjs --release');
});

// ── the real gate, in a disposable fixture ──────────────────────────────────

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-gate-baseline-'));
  const env = { ...process.env, NO_COLOR: '1', npm_execpath: join(root, 'npm-fixture.mjs') };
  delete env.NODE_TEST_CONTEXT;
  delete env.GATE_INERT_SKIP_PATHS;
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];

  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  mkdirSync(join(root, 'scripts'));
  for (const name of ['local-gate.mjs', 'spec-baseline-check.mjs', 'spec-baseline-evidence.mjs',
    'spec-baseline-platform-skips.json', 'mutation-network-deny.mjs']) {
    writeFileSync(join(root, 'scripts', name), readFileSync(join(ROOT, 'scripts', name)));
  }
  write('scripts/spec-static-check.mjs', '');
  write('scripts/secret-scan.mjs', '');
  write('test/setup-env.mjs', '// synthetic fixture: no product imports\n');
  write('test/fixture.test.js', plain);
  write('package.json', '{"type":"module"}');
  write('test/mutations/fixture.json', JSON.stringify({
    tests: ['test/fixture.test.js'],
    expectBaselinePass: 1,
    mutations: [{ name: 'fixture', file: 'source.js', anchor: 'guarded = true', replacement: 'guarded = false' }],
  }));
  write('npm-fixture.mjs',
    `console.log(${JSON.stringify('Running test shard 1/1: 1/1 files\n- test/fixture.test.js\n'
      + ['tests 1', 'pass 1', 'fail 0', 'skipped 0', 'cancelled 0', 'todo 0']
        .map(line => `[test/fixture.test.js] # ${line}\n`).join('')
      + 'TEST_FILE_RESULT {"file":"test/fixture.test.js","counts":'
      + '{"tests":1,"pass":1,"fail":0,"skipped":0,"cancelled":0,"todo":0},'
      + '"suites":0,"suiteSkip":null,"ok":true,"problem":null}\n')});\n`);

  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'baseline');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');

  return {
    root,
    run: (args = []) => spawnSync(process.execPath, ['scripts/local-gate.mjs', ...args],
      { cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 }),
    pin: (n) => write('test/mutations/fixture.json', JSON.stringify({
      tests: ['test/fixture.test.js'],
      expectBaselinePass: n,
      mutations: [{ name: 'fixture', file: 'source.js', anchor: 'guarded = true', replacement: 'guarded = false' }],
    })),
    // Swap the checker for a recorder so the ARGUMENTS the gate passes are visible
    // without executing any suite.
    recordArgs() {
      write('scripts/spec-baseline-check.mjs',
        "import {writeFileSync} from 'node:fs';\n"
        + "writeFileSync(new URL('../baseline-args.json', import.meta.url), JSON.stringify(process.argv.slice(2)));\n");
      return () => JSON.parse(readFileSync(join(root, 'baseline-args.json'), 'utf8'));
    },
    restoreChecker: () => writeFileSync(join(root, 'scripts/spec-baseline-check.mjs'),
      readFileSync(join(ROOT, 'scripts/spec-baseline-check.mjs'))),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withFixture(fn) {
  const f = fixture();
  try { return fn(f); } finally { f.cleanup(); }
}

it('the incremental gate passes no --all; the release gate passes it', () => withFixture(f => {
  const recorded = f.recordArgs();
  let result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(recorded(), [], 'incremental: change-scoped selection');
  assert.match(result.stdout, /INCREMENTAL GATE: PASS/);
  assert.doesNotMatch(result.stdout, /RELEASE GATE/);

  result = f.run(['--release']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(recorded(), ['--all'], 'release: every spec');
  assert.match(result.stdout, /RELEASE GATE: PASS/);
}));

it('a drifted pin fails the gate with the mutation harness sentence, and restoring it passes', () => withFixture(f => {
  // The pin says 2; the suite executes 1.
  f.pin(2);
  let result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL spec-baseline-check exit=1/);
  // The same sentence scripts/mutate-verify.mjs refuses a run with.
  assert.match(result.stdout, /baseline pass=1 but spec expects 2\./);
  assert.match(result.stdout, /Either the suite changed or the spec is stale/);
  assert.match(result.stdout, /INCREMENTAL GATE: FAIL exit=1/);

  // Restore the pin: the same fixture must pass again, so the failure above was the
  // drift and not a one-way latch.
  f.pin(1);
  result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /INCREMENTAL GATE: PASS/);
}));

it('a drifted pin also fails the release gate, which measures specs the diff never touched', () => withFixture(f => {
  // No diff at all in this fixture, so this is the synchronized-checkout shape: the
  // release scope must still measure the spec rather than claim "no affected specs".
  f.pin(3);
  const result = f.run(['--release']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL spec-baseline-check exit=1/);
  assert.match(result.stdout, /baseline pass=1 but spec expects 3\./);
  assert.match(result.stdout, /RELEASE GATE: FAIL exit=1/);
}));

// ── release evidence: the shard's receipt is the per-file verdict ───────────

const evidenceReceipt = (file, counts, extra = {}) => 'TEST_FILE_RESULT ' + JSON.stringify({
  file, counts, suites: 0, suiteSkip: null, ok: true, problem: null, ...extra,
}) + '\n';
const evidencePlan = file => `Running test shard 1/1: 1/1 files\n- ${file}\n`;
const evidenceCounts = (tests, pass, fail, skipped, cancelled, todo) =>
  ({ tests, pass, fail, skipped, cancelled, todo });
const evidenceRows = (file, c, suites) => ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo']
  .map(key => `[${file}] # ${key} ${c[key]}\n`).join('')
  + (suites ? `[${file}] # suites ${suites}\n` : '');

it('release evidence requires a receipt and a runner skip event for zero-test files', () => {
  const file = 'test/fixture.test.js';
  const healthy = evidencePlan(file) + evidenceRows(file, evidenceCounts(1, 1, 0, 0, 0, 0))
    + evidenceReceipt(file, evidenceCounts(1, 1, 0, 0, 0, 0));
  const evidence = releaseEvidence(healthy);
  assert.equal(evidence.pass, 1);
  assert.deepEqual(evidence.inert, []);
  assert.deepEqual(evidence.failedFiles, []);
  assert.throws(() => releaseEvidence(evidencePlan(file) + evidenceRows(file, evidenceCounts(1, 1, 0, 0, 0, 0))),
    /receipt/);
  const empty = evidencePlan(file) + evidenceRows(file, evidenceCounts(0, 0, 0, 0, 0, 0), 1)
    + evidenceReceipt(file, evidenceCounts(0, 0, 0, 0, 0, 0), { suites: 1 });
  assert.throws(() => releaseEvidence(empty), /explicit suite skip/);
  const skipped = evidencePlan(file) + evidenceRows(file, evidenceCounts(0, 0, 0, 0, 0, 0), 1)
    + evidenceReceipt(file, evidenceCounts(0, 0, 0, 0, 0, 0), { suites: 1, suiteSkip: 'platform reason' });
  assert.deepEqual(releaseEvidence(skipped).inert, [{ file, tests: 0, suites: 1 }]);
});

it('release evidence exposes TODO, cancelled and file-level failures', () => {
  const file = 'test/fixture.test.js';
  for (const [c, extra] of [
    [evidenceCounts(2, 1, 0, 0, 0, 1), { ok: false, problem: '1 todo' }],
    [evidenceCounts(1, 0, 0, 0, 1, 0), { ok: false, problem: '1 cancelled' }],
    [evidenceCounts(1, 0, 1, 0, 0, 0), { ok: false, problem: 'exit 1; 1 failed' }],
  ]) {
    const evidence = releaseEvidence(evidencePlan(file) + evidenceRows(file, c) + evidenceReceipt(file, c, extra));
    assert.equal(evidence.todo + evidence.cancelled + evidence.fail, c.todo + c.cancelled + c.fail);
    assert.deepEqual(evidence.failedFiles, [file]);
  }
});

it('release evidence rejects a receipt that disagrees with the visible summary', () => {
  const file = 'test/fixture.test.js';
  const output = evidencePlan(file) + evidenceRows(file, evidenceCounts(1, 1, 0, 0, 0, 0))
    + evidenceReceipt(file, evidenceCounts(1, 0, 1, 0, 0, 0));
  assert.throws(() => releaseEvidence(output), /disagrees/);
});

it('release evidence keeps the file failure when its diagnostic includes an indented child summary', () => {
  const file = 'test/smoke-matrix.test.js';
  const counts = evidenceCounts(1, 0, 1, 0, 0, 0);
  const plan = evidencePlan(file);
  const outer = evidenceRows(file, counts);
  const receipt = evidenceReceipt(file, counts, { ok: false, problem: 'exit 1; 1 failed' });
  const nested = `[${file}]   ℹ tests 47\n[${file}]   ℹ pass 46\n[${file}]   ℹ fail 1\n`;
  const evidence = releaseEvidence(plan + outer + nested + receipt);
  assert.equal(evidence.tests, 1);
  assert.equal(evidence.fail, 1);
  assert.deepEqual(evidence.failedFiles, [file]);
  assert.throws(() => releaseEvidence(plan + nested + receipt), /parsed 0\/1 files/);
  assert.throws(() => releaseEvidence(plan + outer + outer + receipt), /duplicate release summary/);
});
