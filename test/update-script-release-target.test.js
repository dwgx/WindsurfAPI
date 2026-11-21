import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { describe, it as nodeIt } from 'node:test';
import {
  isolatedGitEnv, REAL_GIT, SAFE_TMP_ROOT, SKIP_REASON, trustedFixturePath,
} from './git-fixture-env.js';

// Register every integration case even when unavailable; skipping a describe would
// remove its children from Node's test/skip counts. The source-only check uses nodeIt.
const it = (name, fn) => nodeIt(name, { skip: REAL_GIT ? false : SKIP_REASON }, fn);
const ROOT = resolve(process.cwd());
function git(cwd, args) {
  if (!cwd) throw new Error('git fixture cwd is required');
  return execFileSync(REAL_GIT, args, { cwd, env: isolatedGitEnv(), encoding: 'utf8' }).trim();
}

function assertSafeFixture(fixture) {
  assert.ok(fixture && typeof fixture === 'object', 'update fixture is required');
  for (const field of ['root', 'origin', 'seed', 'deployment', 'stubBin']) {
    assert.equal(typeof fixture[field], 'string', `fixture.${field} is required`);
    assert.ok(fixture[field], `fixture.${field} must not be empty`);
    assert.ok(existsSync(fixture[field]), `fixture.${field} must exist`);
  }

  const rootPath = resolve(fixture.root);
  const rootStat = lstatSync(rootPath);
  assert.ok(!rootStat.isSymbolicLink(), 'fixture.root must not be a symlink');
  assert.ok(rootStat.isDirectory(), 'fixture.root must be a directory');
  const root = realpathSync(rootPath);
  const assertBelowRoot = (field) => {
    const childPath = resolve(fixture[field]);
    const childStat = lstatSync(childPath);
    assert.ok(!childStat.isSymbolicLink(), `fixture.${field} must not be a symlink`);
    assert.ok(childStat.isDirectory(), `fixture.${field} must be a directory`);
    const child = realpathSync(childPath);
    const rel = relative(root, child);
    assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
      `fixture.${field} must be contained by fixture.root (real path)`);
  };
  for (const field of ['origin', 'seed', 'deployment', 'stubBin']) assertBelowRoot(field);

  const deploymentOrigin = git(fixture.deployment, ['remote', 'get-url', 'origin']);
  assert.equal(
    realpathSync(resolve(fixture.deployment, deploymentOrigin)),
    realpathSync(resolve(fixture.origin)),
    'fixture deployment origin must be the explicit temporary bare repository');
}

function writeExecutable(path, source) {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function makeFixture({
  stableTags = true,
  ignoredCollision = false,
  rollbackIgnoredCollision = false,
} = {}) {
  const root = mkdtempSync(join(SAFE_TMP_ROOT, 'wa-update-release-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const deployment = join(root, 'deployment');
  const stubBin = join(root, 'bin');

  mkdirSync(seed, { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  git(root, ['init', '--bare', origin]);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
  git(seed, ['init', '--initial-branch=master']);
  git(seed, ['config', 'user.name', 'WindsurfAPI Test']);
  git(seed, ['config', 'user.email', 'test@example.invalid']);
  git(seed, ['config', 'commit.gpgsign', 'false']);

  mkdirSync(join(seed, 'src'), { recursive: true });
  copyFileSync(join(ROOT, 'update.sh'), join(seed, 'update.sh'));
  chmodSync(join(seed, 'update.sh'), 0o755);
  writeExecutable(join(seed, 'install-ls.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(join(seed, 'src', 'index.js'), '// service fixture\n', 'utf8');
  writeFileSync(join(seed, 'release-marker.txt'), 'v3.9.21\n', 'utf8');
  if (ignoredCollision || rollbackIgnoredCollision) {
    writeFileSync(join(seed, '.gitignore'), 'victim.txt\nruntime-only.txt\n', 'utf8');
  }
  if (rollbackIgnoredCollision) {
    writeFileSync(join(seed, 'victim.txt'), 'tracked pre-update content\n', 'utf8');
  }
  git(seed, ['add', '.']);
  if (rollbackIgnoredCollision) git(seed, ['add', '-f', 'victim.txt']);
  git(seed, ['commit', '-m', 'release v3.9.21']);
  const initialCommit = git(seed, ['rev-parse', 'HEAD']);
  if (stableTags) git(seed, ['tag', 'v3.9.21']);

  writeFileSync(join(seed, 'release-marker.txt'), 'v3.9.22\n', 'utf8');
  git(seed, ['add', 'release-marker.txt']);
  if (ignoredCollision) {
    const victimName = ignoredCollision === 'casefold' ? 'Victim.txt' : 'victim.txt';
    writeFileSync(join(seed, victimName), 'tracked release content\n', 'utf8');
    git(seed, ['add', '-f', victimName]);
  }
  if (rollbackIgnoredCollision) {
    rmSync(join(seed, 'victim.txt'));
    git(seed, ['add', '-u', 'victim.txt']);
  }
  git(seed, ['commit', '-m', 'release v3.9.22']);
  const releaseCommit = git(seed, ['rev-parse', 'HEAD']);
  if (stableTags) {
    git(seed, ['tag', '-a', '-m', '3.9.22', 'v3.9.22']);
  }
  // These sort ahead of the matching final under version:refname but are not
  // stable OTA releases. The script must ignore them in both fixture modes.
  git(seed, ['tag', 'v3.9.22-rc6']);
  git(seed, ['tag', 'v999-backup']);
  git(seed, ['tag', 'v04.00.1']);
  git(seed, ['tag', 'v3.09.24']);

  writeFileSync(join(seed, 'release-notes.md'), 'post-tag documentation\n', 'utf8');
  git(seed, ['add', 'release-notes.md']);
  git(seed, ['commit', '-m', 'docs: release notes']);
  const remoteHead = git(seed, ['rev-parse', 'HEAD']);

  git(seed, ['push', origin, 'master']);
  git(seed, ['push', origin, '--tags']);
  git(root, ['clone', origin, deployment]);
  git(deployment, ['reset', '--hard', initialCommit]);

  for (const command of ['pm2', 'pgrep', 'fuser', 'ss', 'sleep']) {
    writeExecutable(join(stubBin, command), '#!/usr/bin/env bash\nexit 0\n');
  }
  writeExecutable(join(stubBin, 'pm2'), '#!/usr/bin/env bash\npid_file=.git/windsurfapi-fixture-pm2-pid\nif [ "$1" = "start" ]; then printf \'%s\\n\' "$PPID" > "$pid_file"; fi\nif [ "$1" = "stop" ] || [ "$1" = "delete" ]; then rm -f "$pid_file"; fi\nif [ "$1" = "pid" ]; then [ -r "$pid_file" ] && cat "$pid_file"; fi\nexit 0\n');
  writeExecutable(join(stubBin, 'curl'), '#!/usr/bin/env bash\ncommit="$(git rev-parse --short=12 HEAD)" || exit 22\npid="$(cat .git/windsurfapi-fixture-pm2-pid)" || exit 22\nprintf \'{"status":"ok","commit":"%s","pid":%s}\\n\' "$commit" "$pid"\n');

  const fixture = { root, origin, seed, deployment, stubBin, initialCommit, releaseCommit, remoteHead };
  assertSafeFixture(fixture);
  return fixture;
}

function runUpdate(fixture, extraEnv = {}) {
  assertSafeFixture(fixture);
  return spawnSync('bash', ['update.sh'], {
    cwd: fixture.deployment,
    encoding: 'utf8',
    timeout: 20_000,
    env: isolatedGitEnv({
      ...extraEnv,
      PATH: trustedFixturePath(fixture.stubBin),
      LS_BINARY_PATH: join(fixture.root, 'language-server-fixture'),
    }),
  });
}

describe('update.sh release target', () => {
  nodeIt('publishes the process pid in /health for OTA service identity checks', () => {
    const source = readFileSync(join(ROOT, 'src', 'server.js'), 'utf8');
    assert.match(source, /\bpid:\s*process\.pid\b/);
  });

  it('rejects incomplete or out-of-root fixtures before spawning update.sh', () => {
    const fixture = makeFixture();
    try {
      assert.throws(() => runUpdate({ ...fixture, deployment: undefined }), /fixture\.deployment is required/);
      assert.throws(() => runUpdate({ ...fixture, origin: ROOT }), /fixture\.origin must be contained/);
      assert.throws(() => runUpdate({ ...fixture, origin: fixture.seed }), /explicit temporary bare repository/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects fixture children that are symlinks escaping the temporary root', () => {
    const fixture = makeFixture();
    try {
      for (const field of ['origin', 'seed', 'deployment', 'stubBin']) {
        const externalRoot = mkdtempSync(join(SAFE_TMP_ROOT, `wa-update-escape-${field}-`));
        const externalPath = join(externalRoot, field);
        mkdirSync(externalPath);
        const link = join(fixture.root, `escape-${field}`);
        symlinkSync(externalPath, link, 'dir');
        try {
          assert.throws(
            () => assertSafeFixture({ ...fixture, [field]: link }),
            /symlink|contained|resolve/i,
            `fixture.${field} symlink escape must be rejected`,
          );
        } finally {
          // unlinkSync, not rmSync: `link` is a symlink to a directory, and
          // rmSync on it throws ERR_FS_EISDIR on Node 24.11.1.
          try { unlinkSync(link); } catch { rmSync(link, { force: true }); }
          rmSync(externalRoot, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails before fetch or installation when pm2 is unavailable', () => {
    const fixture = makeFixture();
    try {
      const result = spawnSync('bash', ['-c', `
command() {
  if [ "$1" = "-v" ] && [ "\${2:-}" = "pm2" ]; then return 1; fi
  builtin command "$@"
}
source ./update.sh
`], {
        cwd: fixture.deployment,
        encoding: 'utf8',
        timeout: 20_000,
        env: isolatedGitEnv({
          PATH: trustedFixturePath(fixture.stubBin),
          LS_BINARY_PATH: join(fixture.root, 'language-server-fixture'),
        }),
      });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /pm2 is required for a safe update/i);
      assert.doesNotMatch(result.stdout, /=== \[1\/5\]/,
        'pm2 preflight must fail before release refs or worktree state can be mutated');
      assert.equal(existsSync(join(fixture.deployment, '.git', 'windsurfapi-update.lock')), false,
        'the failed preflight must release its repository mutex');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses every malformed successful rev-list count before any mutation', () => {
    for (const malformedProbe of [1, 2, 3, 4]) {
      const fixture = makeFixture();
      const counter = join(fixture.root, 'rev-list-count.txt');
      try {
        writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "rev-list" ] && [ "$2" = "--count" ]; then
  n=0
  if [ -f ${JSON.stringify(counter)} ]; then n=$(cat ${JSON.stringify(counter)}); fi
  n=$((n + 1))
  printf '%s\\n' "$n" > ${JSON.stringify(counter)}
  if [ "$n" -eq "${malformedProbe}" ]; then
    printf 'not-a-count\\n'
    exit 0
  fi
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
        const result = runUpdate(fixture);
        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
        assert.match(result.stdout, /invalid .*count/i, `${result.stdout}\n${result.stderr}`);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('refuses an unsafe oversized successful rev-list count before any mutation', () => {
    for (const unsafeCount of ['9007199254740992', '10000000000000000']) {
      const fixture = makeFixture();
      const counter = join(fixture.root, 'rev-list-count.txt');
      try {
        writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "rev-list" ] && [ "$2" = "--count" ]; then
  n=0
  if [ -f ${JSON.stringify(counter)} ]; then n=$(cat ${JSON.stringify(counter)}); fi
  n=$((n + 1))
  printf '%s\\n' "$n" > ${JSON.stringify(counter)}
  if [ "$n" -eq 1 ]; then
    printf '${unsafeCount}\\n'
    exit 0
  fi
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
        const result = runUpdate(fixture);
        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
        assert.match(result.stdout, /invalid .*count/i, `${result.stdout}\n${result.stderr}`);
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /integer expected/i);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('installs the newest release tag and leaves post-tag commits unpublished', () => {
    const fixture = makeFixture();
    try {
      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit);
      assert.notEqual(git(fixture.deployment, ['rev-parse', 'v3.9.22']), fixture.releaseCommit,
        'fixture must exercise a real annotated tag object');
      assert.notEqual(fixture.releaseCommit, fixture.remoteHead);
      assert.match(result.stdout, /本次只安装 v3\.9\.22/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('never pattern-kills unrelated processes whose command line contains src/index.js', () => {
    const fixture = makeFixture();
    try {
      const marker = join(fixture.root, 'broad-pgrep-was-called');
      writeExecutable(join(fixture.stubBin, 'pgrep'), `#!/usr/bin/env bash
printf 'called\\n' > ${JSON.stringify(marker)}
printf '424242\\n'
`);

      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(existsSync(marker), false,
        'update.sh must not use pgrep -f src/index.js because that matches other projects and checkouts');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('keeps the failed target checked out when rollback cannot prove PM2 and the port are stopped', () => {
    const portFixture = makeFixture();
    try {
      writeExecutable(join(portFixture.stubBin, 'ss'), `#!/usr/bin/env bash
printf 'LISTEN 0 128 0.0.0.0:${3003} 0.0.0.0:*\\n'
`);
      writeExecutable(join(portFixture.stubBin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');

      const result = runUpdate(portFixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(portFixture.deployment, ['rev-parse', 'HEAD']), portFixture.releaseCommit,
        'Git must not move underneath an unverified listener from the failed target');
      assert.match(result.stdout, /port .* remains occupied/i);
      assert.match(result.stdout, /rollback refused before changing Git/i);
      assert.doesNotMatch(result.stdout, /✓ Rolled back/);
    } finally {
      rmSync(portFixture.root, { recursive: true, force: true });
    }

    const pm2Fixture = makeFixture();
    try {
      writeExecutable(join(pm2Fixture.stubBin, 'pm2'), `#!/usr/bin/env bash
pid_file=.git/windsurfapi-fixture-pm2-pid
started_file=.git/windsurfapi-fixture-pm2-started
stale_file=.git/windsurfapi-fixture-pm2-stale
if [ "$1" = "start" ]; then
  : > "$started_file"
  printf '%s\\n' "$PPID" > "$pid_file"
fi
if [ "$1" = "stop" ]; then rm -f "$pid_file"; fi
if [ "$1" = "delete" ]; then
  rm -f "$pid_file"
  [ ! -e "$started_file" ] || : > "$stale_file"
fi
if [ "$1" = "pid" ]; then
  if [ -e "$stale_file" ]; then printf '99999999\\n';
  elif [ -r "$pid_file" ]; then cat "$pid_file"; fi
fi
exit 0
`);
      writeExecutable(join(pm2Fixture.stubBin, 'curl'), '#!/usr/bin/env bash\nexit 22\n');

      const result = runUpdate(pm2Fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(pm2Fixture.deployment, ['rev-parse', 'HEAD']), pm2Fixture.releaseCommit,
        'a positive PM2 pid record is not absence, even after that OS pid has died');
      assert.match(result.stdout, /could not prove .* PM2 app .* is absent/i);
      assert.match(result.stdout, /rollback refused before changing Git/i);
      assert.doesNotMatch(result.stdout, /✓ Rolled back|✓ Update complete/);
    } finally {
      rmSync(pm2Fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed when no usable listener probe is available', () => {
    const fixture = makeFixture();
    try {
      // Keep ss on PATH but unusable. Deleting the stub uncovers host ss
      // via the trusted fixture PATH, then follows the live :3003 listener.
      writeExecutable(join(fixture.stubBin, 'ss'), '#!/usr/bin/env bash\nexit 127\n');
      writeExecutable(join(fixture.stubBin, 'lsof'), '#!/usr/bin/env bash\nexit 127\n');
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit,
        'an unknown listener state must leave the failed target checkout untouched');
      assert.match(result.stdout, /could not verify whether service port .* is free/i);
      assert.match(result.stdout, /rollback refused before changing Git/i);
      assert.doesNotMatch(result.stdout, /✓ Update complete|✓ Rolled back/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('reports rollback PM2 restart failure instead of claiming the service is healthy', () => {
    const fixture = makeFixture();
    try {
      writeExecutable(join(fixture.stubBin, 'pm2'), `#!/usr/bin/env bash
if [ "$1" = "start" ]; then exit 42; fi
exit 0
`);

      const result = runUpdate(fixture, { WINDSURFAPI_UPDATE_FORCE_RESET: '1' });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /PM2 restart failed with exit 42/i);
      assert.doesNotMatch(result.stdout, /✓ Rolled back/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a 200 health response from the wrong commit and verifies the rollback service', () => {
    const fixture = makeFixture();
    try {
      const counter = join(fixture.deployment, '.git', 'windsurfapi-health-commit-count');
      writeExecutable(join(fixture.stubBin, 'curl'), `#!/usr/bin/env bash
if [ ! -e ${JSON.stringify(counter)} ]; then
  : > ${JSON.stringify(counter)}
  pid="$(cat .git/windsurfapi-fixture-pm2-pid)" || exit 22
  printf '{"status":"ok","commit":"000000000000","pid":%s}\\n' "$pid"
  exit 0
fi
commit="$(git rev-parse HEAD)" || exit 22
pid="$(cat .git/windsurfapi-fixture-pm2-pid)" || exit 22
printf '{"status":"ok","commit":"%s","pid":%s}\\n' "$commit" "$pid"
`);

      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /did not identify the expected running commit/i);
      assert.match(result.stdout, /✓ Rolled back/);
      assert.doesNotMatch(result.stdout, /✓ Update complete/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a 200 health response from an unrelated process pid', () => {
    const fixture = makeFixture();
    try {
      const counter = join(fixture.deployment, '.git', 'windsurfapi-health-pid-count');
      writeExecutable(join(fixture.stubBin, 'curl'), `#!/usr/bin/env bash
commit="$(git rev-parse --short=7 HEAD)" || exit 22
if [ ! -e ${JSON.stringify(counter)} ]; then
  : > ${JSON.stringify(counter)}
  printf '{"status":"ok","commit":"%s","pid":%s}\\n' "$commit" "$$"
  exit 0
fi
pid="$(cat .git/windsurfapi-fixture-pm2-pid)" || exit 22
printf '{"status":"ok","commit":"%s","pid":%s}\\n' "$commit" "$pid"
`);

      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /did not identify the expected running commit/i);
      assert.match(result.stdout, /✓ Rolled back/);
      assert.doesNotMatch(result.stdout, /✓ Update complete/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('stops/deletes the failed PM2 target before rollback so duplicate names and stale PIDs cannot survive Git reset', () => {
    const fixture = makeFixture();
    const eventLog = join(fixture.root, 'pm2-events.log');
    const pidFile = join(fixture.deployment, '.git', 'windsurfapi-fixture-pm2-pid');
    const curlCount = join(fixture.deployment, '.git', 'windsurfapi-rollback-curl-count');
    try {
      // This fixture models PM2's real duplicate-name behaviour: a second
      // start is rejected while the old named app still owns a live PID.
      // Each accepted start gets a distinct long-lived process identity.
      writeExecutable(join(fixture.stubBin, 'pm2'), `#!/usr/bin/env bash
pid_file=.git/windsurfapi-fixture-pm2-pid
log=${JSON.stringify(eventLog)}
printf '%s\\n' "$1" >> "$log"
if [ "$1" = "start" ]; then
  if [ -r "$pid_file" ]; then exit 42; fi
  /bin/sleep 60 &
  printf '%s\\n' "$!" > "$pid_file"
fi
if [ "$1" = "stop" ] || [ "$1" = "delete" ]; then
  if [ -r "$pid_file" ]; then kill "$(cat "$pid_file")" 2>/dev/null || true; fi
  rm -f "$pid_file"
fi
if [ "$1" = "pid" ] && [ -r "$pid_file" ]; then cat "$pid_file"; fi
exit 0
`);
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "reset" ] && [ "$2" = "--hard" ]; then printf 'reset\\n' >> ${JSON.stringify(eventLog)}; fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      writeExecutable(join(fixture.stubBin, 'curl'), `#!/usr/bin/env bash
if [ ! -e ${JSON.stringify(curlCount)} ]; then
  : > ${JSON.stringify(curlCount)}
  commit="$(git rev-parse --short=12 HEAD)" || exit 22
  pid="$(cat .git/windsurfapi-fixture-pm2-pid)" || exit 22
  printf '{"status":"ok","commit":"000000000000","pid":%s}\\n' "$pid"
  exit 0
fi
commit="$(git rev-parse --short=12 HEAD)" || exit 22
pid="$(cat .git/windsurfapi-fixture-pm2-pid)" || exit 22
printf '{"status":"ok","commit":"%s","pid":%s}\\n' "$commit" "$pid"
`);

      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      const events = readFileSync(eventLog, 'utf8').trim().split('\n');
      const resetIndex = events.lastIndexOf('reset');
      const rollbackDeleteIndex = events.lastIndexOf('delete');
      assert.ok(events.filter((event) => event === 'delete').length >= 2,
        'rollback must issue its own delete instead of relying on the initial stop phase');
      assert.ok(rollbackDeleteIndex >= 0 && rollbackDeleteIndex < resetIndex,
        'rollback must delete the failed named app before Git reset');
      assert.ok(events.filter((event) => event === 'start').length >= 2,
        'the old service must be started again after rollback');
      assert.match(result.stdout, /✓ Rolled back/);
      assert.equal(existsSync(pidFile), true, 'the verified rollback app owns a live PID');
    } finally {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
        }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails when rollback health answers 200 for a different commit', () => {
    const fixture = makeFixture();
    try {
      const counter = join(fixture.deployment, '.git', 'windsurfapi-rollback-health-count');
      writeExecutable(join(fixture.stubBin, 'curl'), `#!/usr/bin/env bash
if [ ! -e ${JSON.stringify(counter)} ]; then
  : > ${JSON.stringify(counter)}
  exit 22
fi
pid="$(cat .git/windsurfapi-fixture-pm2-pid)" || exit 22
printf '{"status":"ok","commit":"000000000000","pid":%s}\\n' "$pid"
`);

      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /rollback \/health did not identify the expected commit/i);
      assert.match(result.stdout, /Rollback also failed/i);
      assert.doesNotMatch(result.stdout, /✓ Rolled back|✓ Update complete/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rolls back when pm2 start exits zero but the named app has no live pid', () => {
    const fixture = makeFixture();
    try {
      const counter = join(fixture.deployment, '.git', 'windsurfapi-pm2-pid-count');
      writeExecutable(join(fixture.stubBin, 'pm2'), `#!/usr/bin/env bash
pid_file=.git/windsurfapi-fixture-pm2-pid
if [ "$1" = "start" ]; then printf '%s\\n' "$PPID" > "$pid_file"; fi
if [ "$1" = "stop" ] || [ "$1" = "delete" ]; then rm -f "$pid_file"; fi
if [ "$1" = "pid" ]; then
  count=0
  [ ! -r ${JSON.stringify(counter)} ] || IFS= read -r count < ${JSON.stringify(counter)}
  count=$((count + 1))
  printf '%s\\n' "$count" > ${JSON.stringify(counter)}
  if [ "$count" -eq 1 ]; then printf '0\\n'; else cat "$pid_file"; fi
fi
exit 0
`);

      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /named app has no live process/i);
      assert.match(result.stdout, /✓ Rolled back/);
      assert.doesNotMatch(result.stdout, /✓ Update complete/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails when rollback pm2 start exits zero but the named app has no live pid', () => {
    const fixture = makeFixture();
    try {
      const counter = join(fixture.deployment, '.git', 'windsurfapi-rollback-pm2-pid-count');
      writeExecutable(join(fixture.stubBin, 'pm2'), `#!/usr/bin/env bash
pid_file=.git/windsurfapi-fixture-pm2-pid
if [ "$1" = "start" ]; then printf '%s\\n' "$PPID" > "$pid_file"; fi
if [ "$1" = "stop" ] || [ "$1" = "delete" ]; then rm -f "$pid_file"; fi
if [ "$1" = "pid" ]; then
  count=0
  [ ! -r ${JSON.stringify(counter)} ] || IFS= read -r count < ${JSON.stringify(counter)}
  count=$((count + 1))
  printf '%s\\n' "$count" > ${JSON.stringify(counter)}
  if [ "$count" -eq 1 ]; then cat "$pid_file"; else printf '0\\n'; fi
fi
exit 0
`);
      writeExecutable(join(fixture.stubBin, 'curl'), '#!/usr/bin/env bash\nexit 22\n');

      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /named PM2 app has no live process/i);
      assert.doesNotMatch(result.stdout, /✓ Rolled back|✓ Update complete/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rolls back verified code and restores its exact stash when the first pm2 start fails', () => {
    const fixture = makeFixture();
    try {
      const ownerEdit = 'owner edit requiring restore after pm2 failure\n';
      writeFileSync(join(fixture.deployment, 'release-marker.txt'), ownerEdit, 'utf8');
      const startCounter = join(fixture.deployment, '.git', 'windsurfapi-pm2-start-count');
      writeExecutable(join(fixture.stubBin, 'pm2'), `#!/usr/bin/env bash
pid_file=.git/windsurfapi-fixture-pm2-pid
if [ "$1" = "stop" ] || [ "$1" = "delete" ]; then rm -f "$pid_file"; fi
if [ "$1" = "pid" ]; then [ -r "$pid_file" ] && cat "$pid_file"; exit 0; fi
if [ "$1" = "start" ]; then
  count=0
  [ ! -r ${JSON.stringify(startCounter)} ] || IFS= read -r count < ${JSON.stringify(startCounter)}
  count=$((count + 1))
  printf '%s\\n' "$count" > ${JSON.stringify(startCounter)}
  [ "$count" -ne 1 ] || exit 42
  printf '%s\\n' "$PPID" > "$pid_file"
fi
exit 0
`);

      const result = runUpdate(fixture, { WINDSURFAPI_UPDATE_FORCE_RESET: '1' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit,
        'a failed first start must roll code back to the verified pre-update commit');
      assert.equal(readFileSync(join(fixture.deployment, 'release-marker.txt'), 'utf8'), ownerEdit,
        'the exact protective stash must be applied after rollback correspondence is proven');
      assert.equal(readFileSync(startCounter, 'utf8').trim(), '2',
        'pm2 must be retried only after the old code has been restored');
      assert.match(result.stdout, /pm2 start failed with exit 42; entering verified rollback/i);
      assert.match(result.stdout, /restoring exact protective stash/i);
      assert.match(result.stdout, /✓ Rolled back/);
      assert.match(git(fixture.deployment, ['stash', 'list']), /windsurfapi-pre-update-/,
        'exact stash apply must leave the owned backup recoverable');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('follows the untagged branch head only with WINDSURFAPI_UPDATE_FORCE=1', () => {
    const fixture = makeFixture();
    try {
      const result = runUpdate(fixture, { WINDSURFAPI_UPDATE_FORCE: '1' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.remoteHead);
      assert.match(result.stdout, /改为跟随 origin\/master/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('force-reset cleans tracked changes without downgrading a checkout past the tag', () => {
    const fixture = makeFixture();
    try {
      git(fixture.deployment, ['reset', '--hard', fixture.remoteHead]);
      writeFileSync(join(fixture.deployment, 'release-marker.txt'), 'dirty local edit\n', 'utf8');

      const result = runUpdate(fixture, { WINDSURFAPI_UPDATE_FORCE_RESET: '1' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.remoteHead);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses a normal fast-forward that would overwrite ignored owner data', () => {
    const fixture = makeFixture({ ignoredCollision: true });
    try {
      const victim = join(fixture.deployment, 'victim.txt');
      writeFileSync(victim, 'owner runtime data\n', 'utf8');
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.equal(readFileSync(victim, 'utf8'), 'owner runtime data\n');
      assert.match(result.stdout, /overwrite ignored runtime data/i);
      assert.match(result.stdout, /victim\.txt/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses force-reset when the target collides with ignored owner data', () => {
    const fixture = makeFixture({ ignoredCollision: true });
    try {
      const victim = join(fixture.deployment, 'victim.txt');
      writeFileSync(victim, 'owner runtime data\n', 'utf8');
      const result = runUpdate(fixture, { WINDSURFAPI_UPDATE_FORCE_RESET: '1' });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.equal(readFileSync(victim, 'utf8'), 'owner runtime data\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('allows unrelated ignored runtime data that cannot collide with the target tree', () => {
    const fixture = makeFixture({ ignoredCollision: true });
    try {
      writeFileSync(join(fixture.deployment, 'runtime-only.txt'), 'unrelated runtime data\n', 'utf8');
      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit);
      assert.equal(readFileSync(join(fixture.deployment, 'runtime-only.txt'), 'utf8'), 'unrelated runtime data\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('case-folds ignored target collisions even when core.ignorecase is false', () => {
    const fixture = makeFixture({ ignoredCollision: 'casefold' });
    try {
      git(fixture.deployment, ['config', 'core.ignorecase', 'false']);
      const victim = join(fixture.deployment, 'victim.txt');
      writeFileSync(victim, 'owner lower-case data\n', 'utf8');
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.equal(readFileSync(victim, 'utf8'), 'owner lower-case data\n');
      assert.match(result.stdout, /victim\.txt/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed when only prerelease or arbitrary tags exist', () => {
    const fixture = makeFixture({ stableTags: false });
    try {
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /no stable release tag/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('allows explicit force mode to follow branch HEAD without a stable tag', () => {
    const fixture = makeFixture({ stableTags: false });
    try {
      const result = runUpdate(fixture, { WINDSURFAPI_UPDATE_FORCE: '1' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.remoteHead);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed when the release-distance rev-list probe fails', () => {
    const fixture = makeFixture();
    try {
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "rev-list" ] && [ ! -e .git/windsurfapi-rev-list-failed ]; then
  : > .git/windsurfapi-rev-list-failed
  exit 17
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /could not verify commits after the latest release/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed when release-tag enumeration emits partial output then exits nonzero', () => {
    const fixture = makeFixture();
    try {
      const tagObject = git(fixture.seed, ['rev-parse', 'refs/tags/v3.9.22']);
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "ls-remote" ]; then
  printf '%s\\trefs/tags/v3.9.22\\n%s\\trefs/tags/v3.9.22^{}\\n' ${JSON.stringify(tagObject)} ${JSON.stringify(fixture.releaseCommit)}
  exit 42
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /could not verify published release tags/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed when successful remote-tag output violates the ls-remote protocol', () => {
    const fixture = makeFixture();
    try {
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "ls-remote" ]; then
  printf 'not-an-object-id refs/tags/v3.9.22\\n'
  exit 0
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /malformed record/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed when ls-remote output contains an empty field via repeated tabs', () => {
    const fixture = makeFixture();
    try {
      const tagObject = git(fixture.seed, ['rev-parse', 'refs/tags/v3.9.22']);
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "ls-remote" ]; then
  printf '%s\\t\\trefs/tags/v3.9.22\\n%s\\trefs/tags/v3.9.22^{}\\n' ${JSON.stringify(tagObject)} ${JSON.stringify(fixture.releaseCommit)}
  exit 0
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /malformed record/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('ignores a revoked remote tag without pruning the stale local tag', () => {
    const fixture = makeFixture();
    try {
      const localTagObject = git(fixture.deployment, ['rev-parse', 'refs/tags/v3.9.22']);
      git(fixture.seed, ['push', fixture.origin, ':refs/tags/v3.9.22']);

      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit,
        'the revoked v3.9.22 commit must not be installed');
      assert.equal(git(fixture.deployment, ['rev-parse', 'refs/tags/v3.9.22']), localTagObject,
        'remote authority must not delete or rewrite local tags');
      assert.doesNotMatch(result.stdout, /本次只安装 v3\.9\.22/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('skips a newer stable tag that is not reachable from origin/master', () => {
    const fixture = makeFixture();
    try {
      git(fixture.seed, ['checkout', '-b', 'off-branch-release', fixture.initialCommit]);
      writeFileSync(join(fixture.seed, 'off-branch.txt'), 'not a master release\n', 'utf8');
      git(fixture.seed, ['add', 'off-branch.txt']);
      git(fixture.seed, ['commit', '-m', 'off-branch release']);
      git(fixture.seed, ['tag', 'v9.0.0']);
      git(fixture.seed, ['push', fixture.origin, 'refs/tags/v9.0.0']);
      git(fixture.seed, ['checkout', 'master']);

      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit);
      assert.match(result.stdout, /本次只安装 v3\.9\.22/);
      assert.doesNotMatch(result.stdout, /本次只安装 v9\.0\.0/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed when the fetched tag object differs from the advertised remote ref', () => {
    const fixture = makeFixture();
    try {
      git(fixture.seed, ['tag', '-a', '-m', 'non-stable shadow tag', 'v3.9.22-shadow', fixture.releaseCommit]);
      git(fixture.seed, ['push', fixture.origin, 'refs/tags/v3.9.22-shadow']);
      const publishedObject = git(fixture.seed, ['rev-parse', 'refs/tags/v3.9.22']);
      const shadowObject = git(fixture.seed, ['rev-parse', 'refs/tags/v3.9.22-shadow']);
      assert.notEqual(shadowObject, publishedObject, 'fixture requires two annotated tag objects for one commit');
      assert.equal(git(fixture.seed, ['rev-parse', 'refs/tags/v3.9.22-shadow^{}']), fixture.releaseCommit);
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "fetch" ] && [ "$5" = "refs/tags/v3.9.22" ]; then
  exec ${JSON.stringify(REAL_GIT)} fetch --quiet --no-tags origin refs/tags/v3.9.22-shadow
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /changed during verification/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed when an annotated tag peels to a commit other than the advertised peeled OID', () => {
    const fixture = makeFixture();
    try {
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "rev-parse" ] && [ "$2" = "FETCH_HEAD^{commit}" ]; then
  printf '%s\\n' ${JSON.stringify(fixture.initialCommit)}
  exit 0
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /peeled-commit correspondence/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses to continue when a post-merge hook leaves the verified target tracked-dirty', () => {
    const fixture = makeFixture();
    try {
      const hook = join(fixture.deployment, '.git', 'hooks', 'post-merge');
      writeExecutable(hook, '#!/usr/bin/env bash\nprintf "hook dirt\\n" >> release-marker.txt\n');
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit,
        'fixture must prove HEAD can move even though the update is rejected');
      assert.match(git(fixture.deployment, ['status', '--porcelain', '--untracked-files=no']), /release-marker\.txt/);
      assert.match(result.stdout, /did not reach the expected clean target/i);
      assert.doesNotMatch(result.stdout, /=== \[2\/5\]/,
        'LS install and service restart must not begin after a partial Git state');
      assert.doesNotMatch(result.stdout, /Update complete/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('accepts a nonzero merge exit only after the exact target is independently clean', () => {
    const fixture = makeFixture();
    try {
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "merge" ]; then
  ${JSON.stringify(REAL_GIT)} "$@"
  exit 42
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit);
      assert.equal(git(fixture.deployment, ['status', '--porcelain', '--untracked-files=no']), '');
      assert.match(result.stdout, /Git returned exit 42 after reaching the verified clean target/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('never pops an older user stash when status-to-stash races to no local changes', () => {
    const fixture = makeFixture();
    try {
      const marker = join(fixture.deployment, '.git', 'windsurfapi-status-race-fired');
      const releaseMarker = join(fixture.deployment, 'release-marker.txt');
      writeFileSync(releaseMarker, 'pre-existing user stash payload\n', 'utf8');
      git(fixture.deployment, ['stash', 'push', '-m', 'pre-existing user stash']);
      const oldStash = git(fixture.deployment, ['rev-parse', 'refs/stash']);
      writeFileSync(releaseMarker, 'racing local edit\n', 'utf8');

      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "status" ] && [ "$2" = "--porcelain" ] && [ ! -e ${JSON.stringify(marker)} ]; then
  : > ${JSON.stringify(marker)}
  ${JSON.stringify(REAL_GIT)} checkout -- release-marker.txt
  printf ' M release-marker.txt\\n'
  exit 0
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      writeExecutable(join(fixture.stubBin, 'curl'), '#!/usr/bin/env bash\nexit 22\n');
      const result = runUpdate(fixture, { WINDSURFAPI_UPDATE_FORCE_RESET: '1' });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.equal(git(fixture.deployment, ['rev-parse', 'refs/stash']), oldStash,
        'the pre-existing stash must remain the stack tip');
      assert.equal(readFileSync(releaseMarker, 'utf8'), 'v3.9.21\n',
        'the old stash payload must not be applied during health rollback');
      assert.match(result.stdout, /no protective stash was created/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('reports an incomplete health rollback when its exact stash cannot be applied', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(join(fixture.deployment, 'release-marker.txt'), 'owner edit requiring restore\n', 'utf8');
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "stash" ] && [ "$2" = "apply" ]; then
  exit 42
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      const curlCounter = join(fixture.deployment, '.git', 'windsurfapi-curl-count');
      writeExecutable(join(fixture.stubBin, 'curl'), `#!/usr/bin/env bash
if [ ! -e ${JSON.stringify(curlCounter)} ]; then
  : > ${JSON.stringify(curlCounter)}
  exit 22
fi
commit="$(git rev-parse --short=12 HEAD)" || exit 22
pid="$(cat .git/windsurfapi-fixture-pm2-pid)" || exit 22
printf '{"status":"ok","commit":"%s","pid":%s}\\n' "$commit" "$pid"
`);
      const result = runUpdate(fixture, { WINDSURFAPI_UPDATE_FORCE_RESET: '1' });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /local changes were NOT restored/i);
      assert.match(result.stdout, /manual recovery/i);
      assert.match(git(fixture.deployment, ['stash', 'list']), /windsurfapi-pre-update-/,
        'the exact backup must remain available for manual recovery');
      assert.doesNotMatch(result.stdout, /✓ Rolled back/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses an automatic health rollback that would overwrite newly-created ignored owner data', () => {
    const fixture = makeFixture({ rollbackIgnoredCollision: true });
    try {
      const victim = join(fixture.deployment, 'victim.txt');
      writeExecutable(join(fixture.stubBin, 'curl'), `#!/usr/bin/env bash
printf 'owner runtime data\\n' > ${JSON.stringify(victim)}
exit 22
`);
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit,
        'the failed release must remain checked out when rollback would destroy owner data');
      assert.equal(readFileSync(victim, 'utf8'), 'owner runtime data\n');
      assert.match(result.stdout, /Automatic rollback refused/i);
      assert.match(result.stdout, /overwrite ignored runtime data/i);
      assert.doesNotMatch(result.stdout, /✓ Rolled back/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('accepts a nonzero rollback reset only after independently verifying the exact clean target', () => {
    const fixture = makeFixture();
    try {
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "reset" ] && [ "$2" = "--hard" ] && [ "$3" = ${JSON.stringify(fixture.initialCommit)} ]; then
  ${JSON.stringify(REAL_GIT)} "$@"
  exit 42
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      const curlCounter = join(fixture.deployment, '.git', 'windsurfapi-curl-count');
      writeExecutable(join(fixture.stubBin, 'curl'), `#!/usr/bin/env bash
if [ ! -e ${JSON.stringify(curlCounter)} ]; then
  : > ${JSON.stringify(curlCounter)}
  exit 22
fi
commit="$(git rev-parse --short=12 HEAD)" || exit 22
pid="$(cat .git/windsurfapi-fixture-pm2-pid)" || exit 22
printf '{"status":"ok","commit":"%s","pid":%s}\\n' "$commit" "$pid"
`);
      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.equal(git(fixture.deployment, ['status', '--porcelain', '--untracked-files=no']), '');
      assert.match(result.stdout, /exit 42 after reaching the verified clean rollback target/i);
      assert.match(result.stdout, /✓ Rolled back/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('never restores its stash when health rollback leaves HEAD on the failed release', () => {
    const fixture = makeFixture();
    try {
      const applyMarker = join(fixture.deployment, '.git', 'windsurfapi-stash-apply-ran');
      writeFileSync(join(fixture.deployment, 'release-marker.txt'), 'owner edit requiring restore\n', 'utf8');
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "reset" ] && [ "$2" = "--hard" ] && [ "$3" = ${JSON.stringify(fixture.initialCommit)} ]; then
  exit 42
fi
if [ "$1" = "stash" ] && [ "$2" = "apply" ]; then
  : > ${JSON.stringify(applyMarker)}
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      writeExecutable(join(fixture.stubBin, 'curl'), '#!/usr/bin/env bash\nexit 22\n');

      const result = runUpdate(fixture, { WINDSURFAPI_UPDATE_FORCE_RESET: '1' });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit,
        'a failed rollback reset must leave the failed release visible, not pretend success');
      assert.equal(existsSync(applyMarker), false,
        'the owned stash must not be applied until exact rollback HEAD is verified');
      assert.match(git(fixture.deployment, ['stash', 'list']), /windsurfapi-pre-update-/,
        'the exact protective stash must remain recoverable');
      assert.match(result.stdout, /did not reach the expected clean target/i);
      assert.doesNotMatch(result.stdout, /✓ Rolled back/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('never restores its stash when health rollback reaches the target with tracked dirt', () => {
    const fixture = makeFixture();
    try {
      const applyMarker = join(fixture.deployment, '.git', 'windsurfapi-stash-apply-ran');
      writeFileSync(join(fixture.deployment, 'release-marker.txt'), 'owner edit requiring restore\n', 'utf8');
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "reset" ] && [ "$2" = "--hard" ] && [ "$3" = ${JSON.stringify(fixture.initialCommit)} ]; then
  ${JSON.stringify(REAL_GIT)} "$@" || exit $?
  printf 'post-reset tracked dirt\n' >> release-marker.txt
  exit 0
fi
if [ "$1" = "stash" ] && [ "$2" = "apply" ]; then
  : > ${JSON.stringify(applyMarker)}
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      writeExecutable(join(fixture.stubBin, 'curl'), '#!/usr/bin/env bash\nexit 22\n');

      const result = runUpdate(fixture, { WINDSURFAPI_UPDATE_FORCE_RESET: '1' });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(git(fixture.deployment, ['status', '--porcelain', '--untracked-files=no']),
        /release-marker\.txt/, 'the sabotage must leave tracked dirt after reset');
      assert.equal(existsSync(applyMarker), false,
        'the owned stash must not be applied until a clean tracked tree is verified');
      assert.match(git(fixture.deployment, ['stash', 'list']), /windsurfapi-pre-update-/,
        'the exact protective stash must remain recoverable');
      assert.match(result.stdout, /did not reach the expected clean target/i);
      assert.doesNotMatch(result.stdout, /✓ Rolled back/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses to start while another script updater holds the repository lock', () => {
    const fixture = makeFixture();
    try {
      mkdirSync(join(fixture.deployment, '.git', 'windsurfapi-update.lock'));
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.match(result.stdout, /already in progress/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('treats kill-denied plus a present ps row as a live lock owner', () => {
    const fixture = makeFixture();
    try {
      assertSafeFixture(fixture);
      const lockDir = join(fixture.deployment, '.git', 'windsurfapi-update.lock');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner'), '424242 live-owner-token\n', 'utf8');
      writeFileSync(join(lockDir, 'pid'), '424242\n', 'utf8');
      writeExecutable(join(fixture.stubBin, 'ps'), '#!/usr/bin/env bash\nprintf "424242\\n"\n');
      const result = spawnSync('bash', ['-c', 'kill() { return 1; }; source ./update.sh'], {
        cwd: fixture.deployment,
        encoding: 'utf8',
        timeout: 20_000,
        env: isolatedGitEnv({
          PATH: trustedFixturePath(fixture.stubBin),
          LS_BINARY_PATH: join(fixture.root, 'language-server-fixture'),
        }),
      });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.equal(existsSync(lockDir), true, 'a live-but-inaccessible owner lock must not be recovered');
      assert.match(result.stdout, /already in progress/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('does not delete a replacement lock when cleanup ownership no longer matches', () => {
    const fixture = makeFixture();
    try {
      writeExecutable(join(fixture.stubBin, 'git'), `#!/usr/bin/env bash
if [ "$1" = "fetch" ]; then
  read -r owner_pid owner_token < .git/windsurfapi-update.lock/owner
  printf '%s replacement-owner-token\\n' "$owner_pid" > .git/windsurfapi-update.lock/owner
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`);
      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const lockDir = join(fixture.deployment, '.git', 'windsurfapi-update.lock');
      assert.equal(existsSync(lockDir), true, 'old cleanup authority must leave a replacement lock intact');
      assert.match(readFileSync(join(lockDir, 'owner'), 'utf8'), /replacement-owner-token/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('recovers a repository lock whose recorded owner PID is gone', () => {
    const fixture = makeFixture();
    try {
      const lockDir = join(fixture.deployment, '.git', 'windsurfapi-update.lock');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), '99999999\n', 'utf8');
      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit);
      assert.equal(existsSync(lockDir), false, 'recovered lock must be cleaned after update');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed when a stale lock already has a competing recovery claim', () => {
    const fixture = makeFixture();
    try {
      const lockDir = join(fixture.deployment, '.git', 'windsurfapi-update.lock');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner'), '99999999 stale-token\n', 'utf8');
      writeFileSync(join(lockDir, 'pid'), '99999999\n', 'utf8');
      writeFileSync(join(lockDir, 'recovery'), '88888888 competing-claim\n', 'utf8');
      const result = runUpdate(fixture);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.initialCommit);
      assert.equal(existsSync(lockDir), true);
      assert.match(result.stdout, /already in progress/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
