import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cleanBuildCommit } from '../scripts/build-bundle.mjs';
import { packageAssetDigest } from '../src/package-assets.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wa-build-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src', 'data'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module', version: '1.2.3', pkg: { assets: ['package.json', 'src/data/*.json'] },
  }));
  writeFileSync(join(root, '.gitignore'), 'src/_bundle.cjs\n*.ignored.json\n');
  writeFileSync(join(root, 'src/index.js'), 'export {};\n');
  writeFileSync(join(root, 'src/data/dashboard.json'), '{"fixture":true}');
  return root;
}

it('records the clean checkout actually built, including linked worktrees, independently of CI hints', t => {
  const root = fixture(t);
  assert.equal(cleanBuildCommit(root), '', 'source archive has no Git metadata');
  if (spawnSync('git', ['--version'], { stdio: 'ignore' }).error?.code === 'ENOENT') return t.skip('git unavailable');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid.example', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const previousHint = process.env.GITHUB_SHA;
  try {
    process.env.GITHUB_SHA = 'f'.repeat(40);
    assert.equal(cleanBuildCommit(root), head, 'a stale CI hint cannot identify this build');
  } finally {
    if (previousHint == null) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previousHint;
  }
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = root;
    assert.equal(cleanBuildCommit(root), '', 'Git executable missing from the build host');
  } finally { process.env.PATH = originalPath; }
  const linked = mkdtempSync(join(tmpdir(), 'wa-build-linked-'));
  t.after(() => rmSync(linked, { recursive: true, force: true }));
  git('worktree', 'add', '--quiet', '--detach', linked, 'HEAD');
  assert.equal(cleanBuildCommit(linked), head);
  assert.equal(cleanBuildCommit(join(linked, 'src')), '', 'do not borrow a parent repository');
  writeFileSync(join(linked, 'src/_bundle.cjs'), 'previous generated output');
  assert.equal(cleanBuildCommit(linked), head);
  writeFileSync(join(linked, 'src/data/extra.ignored.json'), '{}');
  assert.equal(cleanBuildCommit(linked), '', 'ignored files can enter pkg asset globs');
  writeFileSync(join(root, 'src/index.js'), 'export default false;\n');
  assert.equal(cleanBuildCommit(root), '', 'unstaged change');
  git('add', 'src/index.js');
  assert.equal(cleanBuildCommit(root), '', 'staged change');
});

it('distinguishes embedded, injected and unavailable commits, and rejects stale packaged assets', async t => {
  const root = fixture(t);
  const digest = packageAssetDigest(root);
  const source = readFileSync(new URL('../src/version.js', import.meta.url), 'utf8');
  copyFileSync(new URL('../src/package-assets.js', import.meta.url), join(root, 'src/package-assets.js'));
  const commit = '1234567890abcdef1234567890abcdef12345678';
  async function version(name, buildIdentity) {
    const path = join(root, 'src', name + '.mjs');
    writeFileSync(path, 'const __WA_BUILD_IDENTITY__ = ' + JSON.stringify(buildIdentity) + ';\n' + source);
    return (await import(pathToFileURL(path).href)).getVersionInfo();
  }
  const id = { commit, assets: digest };
  const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
  manifest.type = 'commonjs';
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest, null, 2));
  assert.equal(packageAssetDigest(root), digest, 'pkg rewrites ESM manifests to formatted CommonJS metadata');
  manifest.type = 'module';
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  const good = await version('good', id);
  assert.equal(good.commit, commit.slice(0, 12));
  assert.equal(good.source, 'build-git');
  const unknown = await version('unidentified', null);
  assert.equal(unknown.source, 'package');
  assert.equal(unknown.commit, '');
  writeFileSync(join(root, 'src/data/dashboard.json'), '{"changed":true}');
  const stale = await version('stale', id);
  assert.equal(stale.commit, '');
  assert.equal(stale.source, 'package');
  const previous = process.env.WINDSURFAPI_BUILD_COMMIT;
  try {
    process.env.WINDSURFAPI_BUILD_COMMIT = 'a'.repeat(40);
    const injected = await version('override', id);
    assert.equal(injected.commit, 'a'.repeat(12));
    assert.equal(injected.source, 'build-env');
  } finally {
    if (previous == null) delete process.env.WINDSURFAPI_BUILD_COMMIT;
    else process.env.WINDSURFAPI_BUILD_COMMIT = previous;
  }
});
