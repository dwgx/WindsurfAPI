import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;

function jobBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `expected ${name} job in release workflow`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('release workflow', () => {
  it('runs tests before Docker and waits for Docker + Windows exe before GitHub Release', () => {
    const test = jobBlock('test');
    const docker = jobBlock('docker');
    const release = jobBlock('release');
    assert.match(test, /name:\s*Verify tag matches package version\s*\n\s*run:\s*node scripts\/verify-release-version\.mjs/);
    assert.ok(
      test.indexOf('node scripts/verify-release-version.mjs') < test.indexOf('npm ci'),
      'release identity must be checked before dependencies, tests, or builds run',
    );
    assert.match(test, /\brun:\s*npm run test:release\b/);
    assert.match(test, /\btimeout-minutes:\s*10\b/);
    assert.match(docker, /\bneeds:\s*test\b/);
    assert.match(docker, /\btimeout-minutes:\s*30\b/);
    // Release waits for docker image, Windows single-exe, AND macOS arm64.
    // x64 (macos-13) is non-blocking — it doesn't appear in needs.
    assert.match(release, /\bneeds:\s*\[docker,\s*windows-exe,\s*macos-exe-arm64\]/);
  });

  it('builds a Windows single-exe and attaches it to the release', () => {
    const winExe = jobBlock('windows-exe');
    assert.match(winExe, /\bneeds:\s*test\b/);
    assert.match(winExe, /runs-on:\s*windows-latest/);
    // esbuild bundles the ESM graph to one CJS file, then pkg wraps it (pkg
    // can't ingest the raw "type":"module" tree — emits CJS into ESM scope).
    assert.match(winExe, /npm run build:bundle/);
    assert.match(winExe, /pkg src\/_bundle\.cjs .*node22-win-x64/);
    // Must smoke-check the exe actually boots + serves the dashboard, so a
    // broken asset bundle fails the release rather than shipping a dead exe.
    assert.match(winExe, /\/health/);
    assert.match(winExe, /\/dashboard/);
    assert.match(winExe, /upload-artifact/);
    // Packages a zero-dependency zip (exe + tray launcher scripts) so Windows
    // users get a KiroStudio-style "unzip → double-click" distribution.
    assert.match(winExe, /windsurfapi-windows\.zip/);
    assert.match(winExe, /tray\.vbs/);
    const release = jobBlock('release');
    assert.match(release, /download-artifact/);
    // Both the bare exe and the tray zip are attached to the release.
    assert.match(release, /dist-windows\/windsurfapi\.exe/);
    assert.match(release, /dist-windows\/windsurfapi-windows\.zip/);
  });

  it('uses the bounded release test gate in CI', () => {
    assert.match(ciWorkflow, /\bmatrix:\s*\n\s*shard:\s*\[0, 1, 2, 3\]/);
    assert.match(ciWorkflow, /\brun:\s*npm run test:shard -- \$\{\{ matrix\.shard \}\} 4\b/);
  });

  it('injects build metadata into the Docker build', () => {
    const docker = jobBlock('docker');
    assert.match(docker, /echo "VERSION=\$\{GITHUB_REF_NAME#v\}"/);
    assert.match(docker, /git log -1 --pretty=%s/);
    assert.match(docker, /git log -1 --pretty=%cI/);
    for (const name of [
      'BUILD_VERSION',
      'BUILD_COMMIT',
      'BUILD_COMMIT_MESSAGE',
      'BUILD_COMMIT_DATE',
      'BUILD_BRANCH',
    ]) {
      assert.match(docker, new RegExp(`\\b${name}=`), `${name} build arg is missing`);
    }
  });

  it('accepts only the exact v-prefixed package version as a release tag', () => {
    const run = (tag) => spawnSync(process.execPath, ['scripts/verify-release-version.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REF_NAME: tag },
    });

    const matching = run(`v${packageVersion}`);
    assert.equal(matching.status, 0, matching.stderr);
    assert.match(matching.stdout, /Release identity verified/);

    const mismatching = run('v0.0.0-mismatch');
    assert.equal(mismatching.status, 1);
    assert.match(mismatching.stderr, /Release identity mismatch/);
    assert.match(mismatching.stderr, new RegExp(`package\\.json requires v${packageVersion.replace(/\./g, '\\.')}`));

    const missing = run('');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /tag is \(missing\)/);
  });
});
