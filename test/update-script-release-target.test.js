import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve(process.cwd());

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeExecutable(path, source) {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-update-release-'));
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
  git(seed, ['add', '.']);
  git(seed, ['commit', '-m', 'release v3.9.21']);
  git(seed, ['tag', 'v3.9.21']);

  writeFileSync(join(seed, 'release-marker.txt'), 'v3.9.22\n', 'utf8');
  git(seed, ['add', 'release-marker.txt']);
  git(seed, ['commit', '-m', 'release v3.9.22']);
  const releaseCommit = git(seed, ['rev-parse', 'HEAD']);
  git(seed, ['tag', 'v3.9.22']);

  writeFileSync(join(seed, 'release-notes.md'), 'post-tag documentation\n', 'utf8');
  git(seed, ['add', 'release-notes.md']);
  git(seed, ['commit', '-m', 'docs: release notes']);
  const remoteHead = git(seed, ['rev-parse', 'HEAD']);

  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['push', '--set-upstream', 'origin', 'master']);
  git(seed, ['push', 'origin', '--tags']);
  git(root, ['clone', origin, deployment]);
  git(deployment, ['reset', '--hard', 'v3.9.21']);

  for (const command of ['pm2', 'pgrep', 'fuser', 'ss', 'sleep']) {
    writeExecutable(join(stubBin, command), '#!/usr/bin/env bash\nexit 0\n');
  }
  writeExecutable(join(stubBin, 'curl'), '#!/usr/bin/env bash\nprintf \'{"status":"ok"}\\n\'\n');

  return { root, deployment, stubBin, releaseCommit, remoteHead };
}

function runUpdate(fixture, extraEnv = {}) {
  return spawnSync('bash', ['update.sh'], {
    cwd: fixture.deployment,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${fixture.stubBin}${delimiter}${process.env.PATH || ''}`,
      LS_BINARY_PATH: join(fixture.root, 'language-server-fixture'),
    },
  });
}

describe('update.sh release target', () => {
  it('installs the newest release tag and leaves post-tag commits unpublished', () => {
    const fixture = makeFixture();
    try {
      const result = runUpdate(fixture);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(git(fixture.deployment, ['rev-parse', 'HEAD']), fixture.releaseCommit);
      assert.notEqual(fixture.releaseCommit, fixture.remoteHead);
      assert.match(result.stdout, /本次只安装 v3\.9\.22/);
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
});
