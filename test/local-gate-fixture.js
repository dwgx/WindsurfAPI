import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gateSource = () => readFileSync(new URL('../scripts/local-gate.mjs', import.meta.url), 'utf8');

function countLines(file, counts) {
  return ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo']
    .map(key => `[${file}] # ${key} ${counts[key]}\n`).join('');
}

// The shard authors this line, unprefixed; a child test's stdout is prefixed
// with `[file] `, so a test cannot forge it. `suites` and `suiteSkip` are the
// runner evidence the gate requires before it accepts a zero-test file.
export function releaseReceipt(file, counts, extra = {}) {
  return 'TEST_FILE_RESULT ' + JSON.stringify({
    file,
    counts,
    suites: 0,
    suiteSkip: null,
    ok: true,
    problem: null,
    ...extra,
  }) + '\n';
}

export function releaseOutput(file, counts, extra = {}) {
  return `Running test shard 1/1: 1/1 files\n- ${file}\n`
    + countLines(file, counts)
    + (extra.suites ? `[${file}] # suites ${extra.suites}\n` : '')
    + releaseReceipt(file, counts, extra);
}

const countsOf = (tests, pass, fail, skipped, cancelled, todo) =>
  ({ tests, pass, fail, skipped, cancelled, todo });

/**
 * Run the real gate against a synthetic `test:release` output.
 *
 * The other steps are stubs: this exercises the gate's release-evidence
 * parsing and allowlist wiring, not the suite it is describing.
 */
export function runGateWithReleaseOutput(output, { inertPaths = '', exitCode = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wa-gate-release-'));
  const env = { ...process.env, NO_COLOR: '1', npm_execpath: join(root, 'npm-fixture.mjs') };
  delete env.NODE_TEST_CONTEXT;
  delete env.GATE_INERT_SKIP_PATHS;
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  if (inertPaths) env.GATE_INERT_SKIP_PATHS = inertPaths;
  try {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/local-gate.mjs'), gateSource());
    for (const name of ['spec-static-check.mjs', 'spec-baseline-check.mjs', 'secret-scan.mjs']) {
      writeFileSync(join(root, 'scripts', name), '');
    }
    writeFileSync(join(root, 'npm-fixture.mjs'),
      `console.log(${JSON.stringify(output)}); process.exitCode = ${exitCode};\n`);
    execFileSync('git', ['init', '-q'], { cwd: root, env, stdio: 'pipe' });
    const result = spawnSync(process.execPath, ['scripts/local-gate.mjs'],
      { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// Called by an existing test-shard-script case, not a hidden standalone test file.
export async function verifyLocalGateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-local-gate-'));
  const env = { ...process.env, npm_execpath: join(root, 'npm-fixture.mjs') };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  // This fixture owns GATE_INERT_SKIP_PATHS outright. Inheriting whatever the
  // operator happens to have exported would decide these assertions for them:
  // a declared path makes the gate skip the "not declared inert" branch, so the
  // case that is supposed to prove the default FAILS would silently pass.
  delete env.GATE_INERT_SKIP_PATHS;
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  const source = gateSource();
  try {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/local-gate.mjs'), source);
    writeFileSync(join(root, 'scripts/spec-static-check.mjs'), '');
    writeFileSync(join(root, 'scripts/spec-baseline-check.mjs'), '');
    writeFileSync(join(root, 'scripts/secret-scan.mjs'), '');
    const healthy = releaseOutput('test/fixture.test.js', countsOf(2, 1, 0, 1, 0, 0));
    const setReporter = (text, code = 0) => writeFileSync(join(root, 'npm-fixture.mjs'),
      `console.log(${JSON.stringify(text)}); process.exitCode = ${code};\n`);
    setReporter(healthy);
    git('init', '-q');
    const run = (overrides = {}) => spawnSync(process.execPath, ['scripts/local-gate.mjs'], { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000 });
    let result = run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS test:release exit=0 — 1 pass \/ 0 fail \/ 1 skip/);
    assert.match(result.stdout, /SKIP mutation EXECUTION/, 'the gate must still say what it does not run');
    // A declaration that matches nothing is a stale claim about the host, and
    // it must be reported whether or not some other file is inert — with no
    // inert files at all the report used to be skipped, which is exactly when
    // a stale entry is the only signal there is.
    result = run({ GATE_INERT_SKIP_PATHS: 'test/other.test.js' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /0 inert file\(s\), 1 declared \(unused: test\/other\.test\.js\)/);
    assert.match(result.stdout, /INCREMENTAL GATE: PASS/, 'a stale declaration is reported, not fatal');
    setReporter('reporter changed without a summary');
    result = run(); assert.equal(result.status, 2); assert.match(result.stdout, /FAIL test:release/);
    assert.doesNotMatch(result.stdout, /INCREMENTAL GATE: PASS/);
    // A file that declares tests but executes none is not evidence: node --test
    // hands back `skipped N` with exit 0, so a suite that never ran would
    // otherwise be certified green. (The shape is NOT a load-time throw — that
    // fails the file, `tests 1 / fail 1`, exit 1, measured on node v24.21.0 —
    // this census guards deliberate skips.) A PARTIAL skip stays legal —
    // platforms legitimately gate fixtures — so the discriminator is
    // pass+fail==0 on a file that declared tests, not the skip total.
    const inert = releaseOutput('test/fixture.test.js', countsOf(2, 0, 0, 2, 0, 0));
    setReporter(inert);
    // Default is FAIL: an undeclared inert file is the defect, not the norm.
    result = run(); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /FAIL test:release exit=1/);
    assert.match(result.stdout, /ran no tests and are not declared inert/);
    assert.match(result.stdout, /test\/fixture\.test\.js \(2\)/, 'and say how many tests it declared');
    assert.match(result.stdout, /GATE_INERT_SKIP_PATHS/, 'and name the knob that accepts it');
    assert.doesNotMatch(result.stdout, /INCREMENTAL GATE: PASS/);
    // Declared inert: the real-Git fixtures skip by design on any host without
    // git at a trusted absolute POSIX path, so the gate must let an operator say
    // so explicitly rather than go permanently red and invite a bypass.
    result = run({ GATE_INERT_SKIP_PATHS: 'test/fixture.test.js' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /1 inert file\(s\), 1 declared/);
    assert.match(result.stdout, /PASS test:release exit=0/);
    // A stale entry is reported rather than silently ignored: an allowlist that
    // no longer matches anything is a claim about the host that has gone stale.
    result = run({ GATE_INERT_SKIP_PATHS: 'test/other.test.js' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /unused: test\/other\.test\.js/);
    // Windows-style separators in the declaration still match.
    result = run({ GATE_INERT_SKIP_PATHS: 'test\\fixture.test.js' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // The other zero-execution shape: a suite skipped whole at the describe
    // level reports `tests 0` with `suites 1` as its only witness and no
    // skipped test entries. The gate now also requires the runner's explicit
    // skip event (carried on the receipt), so an empty suite cannot pass by
    // presenting the same counters.
    const skippedSuite = releaseOutput('test/fixture.test.js', countsOf(0, 0, 0, 0, 0, 0),
      { suites: 1, suiteSkip: 'platform reason' });
    setReporter(skippedSuite);
    result = run(); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /FAIL test:release exit=1/);
    assert.match(result.stdout, /ran no tests and are not declared inert/);
    assert.match(result.stdout, /test\/fixture\.test\.js \(0 tests, suites 1\)/,
      'the suite witness must be shown, not a bare (0)');
    result = run({ GATE_INERT_SKIP_PATHS: 'test/fixture.test.js' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /1 inert file\(s\), 1 declared/);
    // An empty suite has the same counters but no skip event. The allowlist
    // acknowledges a deliberate skip; it cannot manufacture the evidence.
    const emptySuite = releaseOutput('test/fixture.test.js', countsOf(0, 0, 0, 0, 0, 0),
      { suites: 1, ok: false, problem: 'zero tests without an explicit suite skip' });
    setReporter(emptySuite);
    result = run({ GATE_INERT_SKIP_PATHS: 'test/fixture.test.js' });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /FAIL test:release exit=2/);
    assert.match(result.stdout, /evidence unavailable/);
    // TODO and cancelled results are red even when the child exits 0: node 22
    // has reported `pass=99 fail=0 cancelled=95` with exit 0, so the gate may
    // not infer the verdict from the child status alone.
    const todo = releaseOutput('test/fixture.test.js', countsOf(2, 1, 0, 0, 0, 1),
      { ok: false, problem: '1 todo' });
    setReporter(todo);
    result = run(); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /FAIL test:release exit=1/);
    assert.match(result.stdout, /todo 1/);
    const cancelled = releaseOutput('test/fixture.test.js', countsOf(1, 0, 0, 0, 1, 0),
      { ok: false, problem: '1 cancelled' });
    setReporter(cancelled);
    result = run(); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /FAIL test:release exit=1/);
    assert.match(result.stdout, /cancelled 1/);
    // The gate cannot accept a receipt that disagrees with the visible summary,
    // or a summary with no receipt at all: either is untrustworthy evidence.
    const mismatched = releaseOutput('test/fixture.test.js', countsOf(2, 1, 0, 1, 0, 0))
      .replace('"pass":1', '"pass":0').replace('"fail":0', '"fail":1');
    setReporter(mismatched);
    result = run(); assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /evidence unavailable/);
    const noReceipt = releaseOutput('test/fixture.test.js', countsOf(2, 1, 0, 1, 0, 0))
      .split('\n').filter(line => !line.startsWith('TEST_FILE_RESULT ')).join('\n');
    setReporter(noReceipt);
    result = run({ GATE_INERT_SKIP_PATHS: 'test/fixture.test.js' });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /evidence unavailable/);
    // A real failing child stays a failure.
    setReporter(releaseOutput('test/fixture.test.js', countsOf(2, 0, 1, 1, 0, 0),
      { ok: false, problem: 'exit 1; 1 failed' }), 1);
    result = run(); assert.equal(result.status, 1); assert.match(result.stdout, /FAIL test:release exit=1/);
    setReporter(healthy);
    writeFileSync(join(root, 'scripts/secret-scan.mjs'), 'process.exitCode = 1;');
    result = run(); assert.equal(result.status, 1); assert.match(result.stdout, /FAIL secret-scan exit=1/);
    assert.match(result.stdout, /PASS git diff --check/, 'later checks still produce a summary');
    writeFileSync(join(root, 'scripts/secret-scan.mjs'), '');
    writeFileSync(join(root, 'whitespace.txt'), 'bad whitespace \n'); git('add', 'whitespace.txt');
    result = run(); assert.equal(result.status, 1); assert.match(result.stdout, /FAIL git diff --cached --check/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
