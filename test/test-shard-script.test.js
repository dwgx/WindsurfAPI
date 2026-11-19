import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { listTopLevelTestFiles, parseArgs, selectShard } from '../scripts/run-test-shard.mjs';
import { releaseEvidence } from '../scripts/local-gate.mjs';
import { runGateWithReleaseOutput, verifyLocalGateFixture } from './local-gate-fixture.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHARD = join(ROOT, 'scripts/run-test-shard.mjs');
const DENY = join(ROOT, 'scripts/mutation-network-deny.mjs');

describe('test shard runner', () => {
  it('selects deterministic modulo shards', async () => {
    const files = ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js', 'e.test.js'];
    assert.deepEqual(selectShard(files, 0, 2), ['a.test.js', 'c.test.js', 'e.test.js']);
    assert.deepEqual(selectShard(files, 1, 2), ['b.test.js', 'd.test.js']);
    await verifyLocalGateFixture();
  });

  it('validates shard arguments and timeout', () => {
    assert.deepEqual(parseArgs(['1', '4', '--timeout-ms=120000']), {
      shardIndex: 1,
      shardTotal: 4,
      timeoutMs: 120000,
    });
    assert.throws(() => parseArgs(['4', '4']), /smaller than shard total/);
    assert.throws(() => parseArgs(['0', '0']), /Invalid shard total/);
    assert.throws(() => parseArgs(['0', '1', '--timeout-ms=1']), /Invalid per-file timeout/);
  });
});

describe('test inventory coverage', () => {
  it('recurses and selects every test file exactly once', () => {
    const root = mkdtempSync(join(tmpdir(), 'wa-discovery-'));
    try {
      mkdirSync(join(root, 'test/nested'), { recursive: true });
      for (const file of ['a.test.js', 'b.test.js', 'nested/c.test.js']) writeFileSync(join(root, 'test', file), '');
      writeFileSync(join(root, 'test/nested/helper.js'), '');
      const files = listTopLevelTestFiles(root);
      assert.deepEqual(files, ['test/a.test.js', 'test/b.test.js', 'test/nested/c.test.js']);
      assert.equal(files.length, 3);
      assert.equal(new Set(files).size, files.length);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the repository inventory equals all top-level files plus any nested test outside _research', () => {
    const topLevel = readdirSync('test', { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.test.js')).length;
    const files = listTopLevelTestFiles();
    const nested = files.filter(f => f.slice('test/'.length).includes('/'));
    // `_research/` is excluded on purpose (see the walker): its files are captured-evidence
    // notebooks, and the one that lives there has stale expectations. Everything else that
    // is nested MUST be discovered — that is the point of the recursive inventory, and the
    // count below is the tripwire for a file quietly landing in a subdirectory again.
    assert.deepEqual(nested.filter(f => !f.includes('/_research/')), [],
      'a nested test file exists outside _research and needs an explicit inventory review');
    assert.equal(files.length, topLevel, 'the inventory must equal the top-level count when _research is skipped');
    assert.equal(new Set(files).size, files.length);
  });
});

// ── verdict accounting against real synthetic suites ────────────────────────

const SUITES = {
  passing: "import { it } from 'node:test';\nit('ok', () => {});\n",
  empty: "import { describe } from 'node:test';\ndescribe('empty', () => {});\n",
  skipped: "import { describe, it } from 'node:test';\n"
    + "describe('skipped', { skip: 'platform reason' }, () => { it('inside', () => {}); });\n",
  skippedBare: "import { describe, it } from 'node:test';\n"
    + "describe('skipped', { skip: true }, () => { it('inside', () => {}); });\n",
  passTodo: "import { it } from 'node:test';\nit('ok', () => {});\n"
    + "it('later', { todo: true }, () => {});\n",
  todoOnly: "import { it } from 'node:test';\nit('later', { todo: true }, () => {});\n",
  cancelled: "import { it } from 'node:test';\nconst ac = new AbortController();\n"
    + "it('later', { signal: ac.signal }, async () => { ac.abort(new Error('synthetic cancel'));"
    + " await new Promise(r => setTimeout(r, 10)); });\n",
  loadThrow: "throw new Error('load boom');\n",
  plannedFail: "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "it('boom', () => { assert.fail('planned'); });\n",
  partialSkip: "import { it } from 'node:test';\nit('leaf', { skip: 'platform' }, () => {});\n"
    + "it('ok', () => {});\n",
};

/**
 * A disposable shard root: the runner discovers `test/*.test.js` here and
 * resolves `test/setup-env.mjs` from its own cwd, so the fixture supplies both.
 * The private environment starts from an allowlist and inherits only the
 * absolute network-deny preload, never the operator's shell.
 */
function runShardFixture(suiteName, source) {
  const root = mkdtempSync(join(tmpdir(), 'wa-shard-verdict-'));
  try {
    mkdirSync(join(root, 'test'), { recursive: true });
    for (const dir of ['home', 'home/AppData/Roaming', 'home/AppData/Local',
      'home/.config', 'home/.local/share', 'home/.cache', 'tmp']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, 'test/setup-env.mjs'), 'process.env.WINDSURFAPI_SKIP_DOTENV = "1";\n');
    writeFileSync(join(root, 'test', suiteName), source);
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC,
      PATHEXT: process.env.PATHEXT,
      TEMP: join(root, 'tmp'),
      TMP: join(root, 'tmp'),
      TMPDIR: join(root, 'tmp'),
      USERPROFILE: join(root, 'home'),
      APPDATA: join(root, 'home/AppData/Roaming'),
      LOCALAPPDATA: join(root, 'home/AppData/Local'),
      XDG_CONFIG_HOME: join(root, 'home/.config'),
      XDG_DATA_HOME: join(root, 'home/.local/share'),
      XDG_CACHE_HOME: join(root, 'home/.cache'),
      NO_COLOR: '1',
      NODE_OPTIONS: `--import=${pathToFileURL(DENY).href}`,
    };
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    const result = spawnSync(process.execPath, [SHARD, '0', '1'],
      { cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function gateOn(run, inertPaths = '') {
  return runGateWithReleaseOutput(run.stdout, { inertPaths });
}

function singleFileReceipt(run) {
  const lines = run.stdout.split(/\r?\n/).filter(line => line.startsWith('TEST_FILE_RESULT '));
  assert.equal(lines.length, 1, run.stdout + run.stderr);
  return JSON.parse(lines[0].slice('TEST_FILE_RESULT '.length));
}

describe('test shard verdicts', () => {
  it('rejects an empty suite even when its path is declared inert', () => {
    const run = runShardFixture('empty.test.js', SUITES.empty);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /zero tests without an explicit suite skip/);
    assert.throws(() => releaseEvidence(run.stdout), /explicit suite skip|incomplete release summary/);
    const gate = gateOn(run, 'test/empty.test.js');
    assert.equal(gate.status, 2, gate.stdout + gate.stderr);
    assert.match(gate.stdout, /evidence unavailable/);
  });

  it('accepts an explicit whole-suite skip only with its runner evidence and a declaration', () => {
    const run = runShardFixture('skipped.test.js', SUITES.skipped);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const evidence = releaseEvidence(run.stdout);
    assert.deepEqual(evidence.inert, [{ file: 'test/skipped.test.js', tests: 0, suites: 1 }]);
    let gate = gateOn(run);
    assert.equal(gate.status, 1, gate.stdout + gate.stderr);
    assert.match(gate.stdout, /ran no tests and are not declared inert/);
    gate = gateOn(run, 'test/skipped.test.js');
    assert.equal(gate.status, 0, gate.stdout + gate.stderr);
    assert.match(gate.stdout, /1 inert file\(s\), 1 declared/);
    // The gate must not accept the same counters when the shard's evidence is
    // absent: a declaration acknowledges a skip, it cannot supply one.
    const stripped = run.stdout.split('\n')
      .filter(line => !line.startsWith('TEST_FILE_RESULT ')).join('\n');
    gate = runGateWithReleaseOutput(stripped, { inertPaths: 'test/skipped.test.js' });
    assert.equal(gate.status, 2, gate.stdout + gate.stderr);
    assert.match(gate.stdout, /evidence unavailable/);
  });

  it('accepts a bare explicit suite skip as runner evidence', () => {
    const run = runShardFixture('skipped-bare.test.js', SUITES.skippedBare);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(releaseEvidence(run.stdout).inert,
      [{ file: 'test/skipped-bare.test.js', tests: 0, suites: 1 }]);
    const gate = gateOn(run, 'test/skipped-bare.test.js');
    assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  });

  it('rejects SKIP text in escaped suite names even when the path is declared inert', () => {
    for (const [kind, name] of [
      ['hash', 'fake # SKIP title'],
      ['backslashes', 'C:\\fixtures\\# SKIP title'],
    ]) {
      const file = 'escaped-name-' + kind + '.test.js';
      // Node escapes the title's hash in real TAP. It is not a skip directive.
      const source = "import { describe } from 'node:test';\n"
        + 'describe(' + JSON.stringify(name) + ', () => {});\n';
      const run = runShardFixture(file, source);
      assert.equal(run.status, 1, run.stdout + run.stderr);
      const receipt = singleFileReceipt(run);
      assert.equal(receipt.counts.tests, 0);
      assert.equal(receipt.suiteSkip, null, 'an escaped title cannot supply runner skip evidence');
      assert.equal(receipt.ok, false);
      const gate = gateOn(run, 'test/' + file);
      assert.equal(gate.status, 2, gate.stdout + gate.stderr);
      assert.match(gate.stdout, /explicit suite skip/);
    }
  });

  it('accepts a real skip directive after escaped suite names and keeps its actual reason', () => {
    for (const [kind, name, skip] of [
      ['hash', 'fake # SKIP title', 'platform reason'],
      ['backslashes', 'C:\\fixtures\\# SKIP title', 'platform reason'],
      ['bare', '中文 # SKIP title', true],
    ]) {
      const file = 'escaped-skip-' + kind + '.test.js';
      const source = "import { describe } from 'node:test';\n"
        + 'describe(' + JSON.stringify(name) + ', { skip: ' + JSON.stringify(skip) + ' }, () => {});\n';
      const run = runShardFixture(file, source);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const receipt = singleFileReceipt(run);
      assert.equal(receipt.suiteSkip, skip, 'only the real directive supplies the reason');
      assert.equal(receipt.ok, true);
      assert.deepEqual(releaseEvidence(run.stdout).inert,
        [{ file: 'test/' + file, tests: 0, suites: 1 }]);
      const undeclared = gateOn(run);
      assert.equal(undeclared.status, 1, undeclared.stdout + undeclared.stderr);
      const declared = gateOn(run, 'test/' + file);
      assert.equal(declared.status, 0, declared.stdout + declared.stderr);
    }
  });

  it('rejects TODO results in an otherwise passing file', () => {
    const run = runShardFixture('pass-todo.test.js', SUITES.passTodo);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /1 todo/);
    const evidence = releaseEvidence(run.stdout);
    assert.equal(evidence.todo, 1);
    assert.deepEqual(evidence.failedFiles, ['test/pass-todo.test.js']);
    // The fake child exits 0 here: the gate must not infer the verdict from
    // the shard's exit status.
    const gate = runGateWithReleaseOutput(run.stdout);
    assert.equal(gate.status, 1, gate.stdout + gate.stderr);
    assert.match(gate.stdout, /FAIL test:release exit=1/);
  });

  it('rejects a TODO-only file', () => {
    const run = runShardFixture('todo-only.test.js', SUITES.todoOnly);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /1 todo/);
    const gate = runGateWithReleaseOutput(run.stdout);
    assert.equal(gate.status, 1, gate.stdout + gate.stderr);
  });

  it('rejects a cancelled leaf', () => {
    const run = runShardFixture('cancelled.test.js', SUITES.cancelled);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /1 cancelled/);
    const evidence = releaseEvidence(run.stdout);
    assert.equal(evidence.cancelled, 1);
    assert.deepEqual(evidence.failedFiles, ['test/cancelled.test.js']);
    const gate = runGateWithReleaseOutput(run.stdout);
    assert.equal(gate.status, 1, gate.stdout + gate.stderr);
  });

  it('rejects a wrapper failure and a planned assertion failure alike', () => {
    for (const [file, source] of [['load-throw.test.js', SUITES.loadThrow],
      ['planned-fail.test.js', SUITES.plannedFail]]) {
      const run = runShardFixture(file, source);
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, new RegExp(`${file.replace('.', '\\.')}: exit 1; 1 failed`));
      const evidence = releaseEvidence(run.stdout);
      assert.equal(evidence.fail, 1);
      assert.deepEqual(evidence.failedFiles, [`test/${file}`]);
      const gate = runGateWithReleaseOutput(run.stdout);
      assert.equal(gate.status, 1, gate.stdout + gate.stderr);
      assert.match(gate.stdout, /FAIL test:release exit=1/);
    }
  });

  it('keeps a legitimate passing suite green', () => {
    const run = runShardFixture('passing.test.js', SUITES.passing);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const evidence = releaseEvidence(run.stdout);
    assert.equal(evidence.pass, 1);
    assert.deepEqual(evidence.inert, []);
    assert.deepEqual(evidence.failedFiles, []);
    const gate = runGateWithReleaseOutput(run.stdout);
    assert.equal(gate.status, 0, gate.stdout + gate.stderr);
    assert.match(gate.stdout, /PASS test:release exit=0/);
  });

  it('keeps an allowed partial platform skip green without an inert declaration', () => {
    const run = runShardFixture('partial-skip.test.js', SUITES.partialSkip);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const evidence = releaseEvidence(run.stdout);
    assert.equal(evidence.pass, 1);
    assert.equal(evidence.skipped, 1);
    assert.deepEqual(evidence.inert, []);
    const gate = runGateWithReleaseOutput(run.stdout);
    assert.equal(gate.status, 0, gate.stdout + gate.stderr);
    assert.match(gate.stdout, /PASS test:release exit=0/);
  });
});
