import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');

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
    assert.match(test, /\brun:\s*npm run test:release\b/);
    assert.match(test, /\btimeout-minutes:\s*10\b/);
    assert.match(docker, /\bneeds:\s*test\b/);
    assert.match(docker, /\btimeout-minutes:\s*30\b/);
    // Release waits for BOTH the docker image and the Windows single-exe build
    // so the .exe is available to attach as a release asset.
    assert.match(release, /\bneeds:\s*\[docker,\s*windows-exe\]/);
  });

  it('builds a Windows single-exe and attaches it to the release', () => {
    const winExe = jobBlock('windows-exe');
    assert.match(winExe, /\bneeds:\s*test\b/);
    assert.match(winExe, /runs-on:\s*windows-latest/);
    assert.match(winExe, /pkg \. --targets node22-win-x64/);
    // Must smoke-check the exe actually boots + serves the dashboard, so a
    // broken asset bundle fails the release rather than shipping a dead exe.
    assert.match(winExe, /\/health/);
    assert.match(winExe, /\/dashboard/);
    assert.match(winExe, /upload-artifact/);
    const release = jobBlock('release');
    assert.match(release, /download-artifact/);
    assert.match(release, /files:\s*dist-windows\/windsurfapi\.exe/);
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
});
