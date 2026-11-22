#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseEvidence(output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n');
  const plans = [...text.matchAll(/^Running test shard \d+\/\d+: (\d+)\/\d+ files$/gm)];
  if (plans.length !== 1 || Number(plans[0][1]) === 0) throw new Error('missing or empty release file plan');
  const expected = Number(plans[0][1]);
  const files = [...text.matchAll(/^- (test\/[^\n]+\.test\.js)$/gm)].map(m => m[1]);
  if (files.length !== expected || new Set(files).size !== expected) throw new Error('release file plan mismatch');
  const rows = new Map();
  // A file whose whole suite is skipped at the describe level reports zero tests
  // with a `suites N` line as its only count witness. The runner accepts that
  // shape (see parseFileSummary); the gate must accept exactly the same shape or
  // the gate can never pass on a suite that contains such a file.
  const suiteRows = new Map();
  // The shard adds one space after each prefix. Extra indentation belongs to
  // a child diagnostic, outside the shard's summary.
  for (const m of text.matchAll(/^((?:\[[^\]\r\n]+\] )+)(?:#|ℹ) (tests|pass|fail|skipped|cancelled|todo|suites) (\d+)$/gm)) {
    const names = [...m[1].matchAll(/\[([^\]]+)\]/g)].map(x => x[1].replace(/\\/g, '/'));
    const file = names[0];
    if (!names.every(name => name === file) || !files.includes(file)) throw new Error('unexpected release file');
    if (m[2] === 'suites') {
      if (suiteRows.has(file)) throw new Error('duplicate release summary');
      suiteRows.set(file, Number(m[3]));
      continue;
    }
    const row = rows.get(file) || {};
    if (Object.hasOwn(row, m[2])) throw new Error('duplicate release summary');
    row[m[2]] = Number(m[3]); rows.set(file, row);
  }
  if (rows.size !== expected) throw new Error(`release parsed ${rows.size}/${expected} files`);

  // The shard authors one unprefixed receipt per file; a child test's stdout is
  // prefixed with `[file] `, so a test cannot forge this line. It is the only
  // channel carrying the runner's suite-skip event: the counters alone cannot
  // distinguish a deliberately skipped suite from an empty one.
  const receipts = new Map();
  for (const m of text.matchAll(/^TEST_FILE_RESULT (\{.*\})$/gm)) {
    let receipt;
    try { receipt = JSON.parse(m[1]); } catch { throw new Error('malformed release file receipt'); }
    if (!receipt || typeof receipt.file !== 'string' || receipts.has(receipt.file)) {
      throw new Error('duplicate or malformed release file receipt');
    }
    receipts.set(receipt.file, receipt);
  }
  if (receipts.size !== expected) throw new Error(`release parsed ${receipts.size}/${expected} file receipts`);

  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0 };
  // Per-file skip census. Two shapes execute nothing while still declaring
  // work: a file whose every test skipped (zero pass+fail, tests counted), and
  // a suite skipped whole at the describe level (zero tests, with `suites N`
  // plus the receipt's explicit skip event as its witnesses). A load-time
  // throw is NOT one of them: measured on node v24.21.0 it fails the file
  // (`tests 1 / fail 1`, exit 1), which counts.fail already catches. Summing
  // per file lets the caller name the offenders instead of only reporting a
  // total it cannot act on.
  const inert = [];
  const failedFiles = [];
  for (const file of files) {
    const row = rows.get(file);
    if (!row || !Object.keys(totals).every(k => Number.isSafeInteger(row[k]))
        || row.tests !== row.pass + row.fail + row.skipped + row.cancelled + row.todo) {
      throw new Error('incomplete release summary');
    }
    const receipt = receipts.get(file);
    if (!receipt) throw new Error(`missing release file receipt: ${file}`);
    const counts = receipt.counts;
    if (!counts || !Object.keys(totals).every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0)
        || counts.tests !== counts.pass + counts.fail + counts.skipped + counts.cancelled + counts.todo) {
      throw new Error(`invalid release file receipt: ${file}`);
    }
    if (Object.keys(totals).some(k => counts[k] !== row[k])) {
      throw new Error(`release file receipt disagrees with its summary: ${file}`);
    }
    const suiteCount = suiteRows.get(file);
    if (counts.tests === 0) {
      if (!Number.isSafeInteger(suiteCount) || suiteCount < 1) throw new Error(`missing suite summary: ${file}`);
      // An empty suite and a deliberately skipped one have identical counters.
      // Only the runner's suite-skip event separates them; without it the file
      // is not evidence, and an allowlist declaration cannot supply the event.
      if (!receipt.suiteSkip) {
        throw new Error(`release file ${file} measured zero tests without an explicit suite skip`);
      }
      if (receipt.suites !== suiteCount) {
        throw new Error(`release file receipt disagrees with its suite summary: ${file}`);
      }
    } else if (!Number.isSafeInteger(receipt.suites) || receipt.suites < 0) {
      throw new Error(`invalid suite count in release file receipt: ${file}`);
    }
    if (receipt.ok !== true) failedFiles.push(file);
    if ((counts.tests > 0 && counts.pass + counts.fail === 0) || counts.tests === 0) {
      inert.push({ file, tests: counts.tests, suites: counts.tests === 0 ? suiteCount : 0 });
    }
    for (const key of Object.keys(totals)) totals[key] += counts[key];
  }
  return { files: rows.size, ...totals, inert, failedFiles };
}

function execute(command, args, root, env) {
  return new Promise(done => {
    let output = '', error = null;
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
    child.on('error', failure => { error = failure.message; });
    child.on('close', (code, signal) => done({ code: error || signal ? 2 : code ?? 2, output, error,
      untrustworthy: Boolean(error || signal || code === null) }));
  });
}

/**
 * Inert test files the operator has explicitly accepted for this host.
 *
 * Semicolon- or newline-separated repo-relative paths in GATE_INERT_SKIP_PATHS.
 * The environment variable is an OVERRIDE, never a default: an empty value
 * means "accept nothing", so the gate fails on every inert file. Pre-seeding a
 * default list would recreate the original defect with extra steps — a file
 * that becomes inert for a new reason would inherit acceptance it was never
 * reviewed for. Inert means it declared a suite or tests and executed none —
 * declare it or the gate is red; a file that declares nothing at all is no
 * evidence either. A load-time throw is not one of these: it fails the file
 * (`tests 1 / fail 1`, exit 1), which the fail count already catches.
 */
export function inertSkipAllowlist(env = process.env) {
  return new Set(String(env.GATE_INERT_SKIP_PATHS || '')
    .split(/[;\n]/)
    .map(p => p.trim().replace(/\\/g, '/'))
    .filter(Boolean));
}

/**
 * The gate's steps, in order.
 *
 * Two scopes, deliberately:
 *   - INCREMENTAL (`npm run gate`): the baseline check measures only the specs the
 *     diff can have moved. Fast enough to run on every branch, which is the only
 *     reason anyone runs it.
 *   - RELEASE (`npm run gate:release`, and the release workflow): `--all` measures
 *     EVERY spec against its pin. This is the mode that catches a pin moved by a
 *     change no spec's own test list names, and the tag checkout has no diff to
 *     scope by anyway.
 *
 * Exported so test/local-gate.test.js asserts the wiring without running a suite.
 */
export function gateSteps({ release = false } = {}) {
  return [
    ['spec-static-check', process.execPath, ['scripts/spec-static-check.mjs']],
    ['spec-baseline-check', process.execPath,
      ['scripts/spec-baseline-check.mjs', ...(release ? ['--all'] : [])]],
    ['secret-scan', process.execPath, ['scripts/secret-scan.mjs']],
    ['test:release', process.execPath, [process.env.npm_execpath, 'run', '--silent', 'test:release']],
    ['git diff --check', 'git', ['diff', '--check']],
    ['git diff --cached --check', 'git', ['diff', '--cached', '--check']],
  ];
}

/** Parse the CLI flags. An unknown flag is a hard error, never a silently ignored one. */
export function parseGateArgs(argv) {
  const options = { release: false };
  for (const arg of argv) {
    if (arg === '--release' || arg === '--all') { options.release = true; continue; }
    throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

export async function runGate(root = process.cwd(), options = {}) {
  // npm exposes the actual JS CLI path on Windows too. Launch it through Node rather
  // than spawning npm.cmd or interpolating command strings through a shell.
  // gateSteps reads the same variable for the test:release step.
  if (!process.env.npm_execpath) {
    console.error('GATE: FAIL exit=2 — invoke this entry point with npm run gate');
    return 2;
  }
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR; delete env.NODE_TEST_CONTEXT;
  const steps = gateSteps(options);
  const results = [];
  for (const [name, command, args] of steps) {
    console.log(`\n=== ${name} ===`);
    const result = await execute(command, args, root, env);
    // Git uses exit 2 for whitespace errors. Only evidence-producing scripts
    // reserve that status for untrustworthy evidence; preserve every raw code.
    result.untrustworthy ||= result.code === 2 && ['spec-static-check', 'spec-baseline-check', 'test:release'].includes(name);
    let detail = result.error || '';
    if (name === 'test:release') {
      try {
        const counts = releaseEvidence(result.output);
        detail = `${counts.pass} pass / ${counts.fail} fail / ${counts.skipped} skip (${counts.files} files)`;
        if (counts.todo || counts.cancelled) detail += ` — todo ${counts.todo}, cancelled ${counts.cancelled}`;
        if (counts.failedFiles.length) detail += ` — not ok: ${counts.failedFiles.join(', ')}`;
        // TODO and cancelled results are red even when the child exits 0: node
        // 22 has reported `pass=99 fail=0 cancelled=95` with exit 0, so the
        // gate cannot infer the verdict from the child status alone.
        if ((counts.fail || counts.cancelled || counts.todo || counts.failedFiles.length) && result.code === 0) {
          result.code = 1;
        }
        // A file that declares tests and executes none is invisible in the
        // verdict. The shard summary folds it into a skip total, so on a host
        // where 4813 tests ran and 6 files did not, the gate still says PASS
        // and the only trace is "79 skip" in a detail line. Naming the files is
        // the point — a total cannot be acted on, a path can.
        //
        // Note what this is NOT guarding against. An earlier version of this
        // comment claimed a module that throws while loading shows up as
        // N skipped / exit 0. Measured on node 24.19.0 that is false: a
        // top-level throw in an imported module makes the FILE fail
        // (`fail 1`, `✖ test failed`), which counts.fail already catches. The
        // real exposure is the opposite case — deliberate, reason-carrying
        // skips that a reader can mistake for coverage.
        //
        // Those skips are legitimate: the real-Git fixtures skip on any host
        // without git at a trusted absolute POSIX path, by design
        // (test/git-fixture-env.js:22-24, asserted in
        // git-fixture-availability.test.js:38-40), and wire-byte-identity skips
        // without WIRE_BASE_TREE because it is a CI-only comparison. So the
        // requirement is acknowledgement, not permission: an operator states
        // which paths this host is not running, and the gate says so in the
        // verdict. GATE_INERT_SKIP_PATHS has no default, so a file that starts
        // skipping for a new reason is reported rather than inherited.
        //
        // The allowlist is read even when no file is inert: a declaration that
        // matches nothing is a stale claim about the host, and reporting it
        // must not depend on some other file happening to be inert.
        if (result.code === 0) {
          const accepted = inertSkipAllowlist(env);
          const inert = counts.inert.map(f => f.file.replace(/\\/g, '/'));
          const undeclared = counts.inert.filter(f => !accepted.has(f.file.replace(/\\/g, '/')));
          const unused = [...accepted].filter(p => !inert.includes(p));
          if (accepted.size) {
            detail += ` — ${counts.inert.length} inert file(s), ${accepted.size} declared`
              + (unused.length ? ` (unused: ${unused.join(', ')})` : '');
          }
          if (undeclared.length) {
            result.code = 1;
            detail += ` — ${undeclared.length} ran no tests and are not declared inert: `
              + undeclared.map(f => `${f.file} (${f.tests > 0 ? f.tests : `0 tests, suites ${f.suites}`})`).join(', ')
              + (accepted.size ? '' : ' (set GATE_INERT_SKIP_PATHS to accept deliberate platform gates)');
          }
        }
      } catch (error) {
        // A real failing child stays a failure. Missing evidence on exit zero is exit two.
        if (result.code === 0) { result.code = 2; result.untrustworthy = true; }
        detail = `evidence unavailable: ${error.message}`;
      }
    }
    results.push({ name, code: result.code, untrustworthy: result.untrustworthy, detail });
  }
  console.log('\n=== Local gate summary ===');
  for (const row of results) console.log(`${row.code === 0 ? 'PASS' : 'FAIL'} ${row.name} exit=${row.code}${row.detail ? ` — ${row.detail}` : ''}`);
  console.log('SKIP mutation EXECUTION — this gate checks spec shape, anchors and baseline'
    + ' values, but does not run the mutants themselves; the Linux full-gate recipe runs the sweep.');
  const code = results.some(row => row.untrustworthy) ? 2 : results.some(row => row.code !== 0) ? 1 : 0;
  const mode = options.release ? 'RELEASE' : 'INCREMENTAL';
  console.log(`${mode} GATE: ${code ? 'FAIL' : 'PASS'} exit=${code}`);
  return code;
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  try { process.exitCode = await runGate(process.cwd(), parseGateArgs(process.argv.slice(2))); }
  catch (error) { console.error(`GATE: FAIL exit=2 — ${error.message}`); process.exitCode = 2; }
}
