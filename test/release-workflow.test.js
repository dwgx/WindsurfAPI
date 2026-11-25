import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const { scripts: packageScripts, version: packageVersion } = JSON.parse(readFileSync('package.json', 'utf8'));

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
    assert.match(test, /\btimeout-minutes:\s*30\b/);
    assert.match(docker, /\bneeds:\s*test\b/);
    assert.match(docker, /\btimeout-minutes:\s*30\b/);
    // Release waits for docker image, Windows single-exe, AND macOS arm64.
    // x64 (macos-26-intel) is non-blocking — it doesn't appear in needs.
    assert.match(release, /\bneeds:\s*\[docker,\s*windows-exe,\s*macos-exe-arm64\]/);
  });

  it('builds a Windows single-exe and attaches it to the release', () => {
    const winExe = jobBlock('windows-exe');
    assert.match(winExe, /\bneeds:\s*test\b/);
    assert.match(winExe, /runs-on:\s*windows-latest/);
    // Must smoke-check the exe actually boots + serves the dashboard, so a
    // broken asset bundle fails the release rather than shipping a dead exe.
    assert.match(winExe, /\/health/);
    assert.match(winExe, /\/dashboard/);
    assert.match(winExe, /upload-artifact/);
    // Packages a zero-dependency zip (exe + tray launcher scripts) so Windows
    // users get a KiroStudio-style "unzip → double-click" distribution.
    assert.match(winExe, /windsurfapi-windows\.zip/);
    assert.match(winExe, /tray\.vbs/);
    // The extracted tray must retain its process-ownership helper. Omitting
    // it silently removes generation receipts even when the EXE itself boots.
    assert.match(winExe, /Copy-Item\s+deploy\\windows\\ownership\.psm1\s+\$stage\\/,
      'the flat Windows archive must copy the ownership module beside tray.ps1');
    assert.match(winExe, /\$must\s*=\s*@\([^\n]*'ownership\.psm1'/,
      'ZIP read-back must reject a missing ownership helper');
    const release = jobBlock('release');
    assert.match(release, /download-artifact/);
    // Both the bare exe and the tray zip are attached to the release.
    assert.match(release, /dist-windows\/windsurfapi\.exe/);
    assert.match(release, /dist-windows\/windsurfapi-windows\.zip/);
  });

  it('runs the provenance-aware bundle before every native package', () => {
    assert.equal(packageScripts['build:bundle'], 'node scripts/build-bundle.mjs');
    const targets = [
      ['windows-exe', 'build:exe', 'node22-win-x64'],
      ['macos-exe-arm64', 'build:exe:macos', 'node22-macos-arm64'],
      ['macos-exe-x64', 'build:exe:macos-x64', 'node22-macos-x64'],
    ];
    for (const [jobName, scriptName, target] of targets) {
      const pkgCommand = `pkg src/_bundle.cjs --config package.json --targets ${target} `;
      assert.ok(packageScripts[scriptName].startsWith(`npm run build:bundle && ${pkgCommand}`), scriptName);
      const lines = jobBlock(jobName).split('\n').map((line) => line.trim());
      const bundle = lines.indexOf('npm run build:bundle');
      const pkg = lines.findIndex((line) => line.startsWith(pkgCommand));
      assert.ok(bundle >= 0 && pkg > bundle, `${jobName} must bundle before invoking pkg`);
    }
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

  it('signs the pushed Docker image digest and publishes image-digest.txt', () => {
    const docker = jobBlock('docker');
    const release = jobBlock('release');

    // Policy T (D9 §5.3): keyless signing needs an OIDC token in the same job
    // that pushes the image, and the build step must expose its digest.
    assert.match(docker, /\bid-token:\s*write\b/,
      'the docker job needs id-token: write for keyless cosign signing');
    assert.match(docker, /\boutputs:\s*\n\s*digest:\s*\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}/,
      'the docker job must keep the image digest in its job output');
    assert.match(docker, /- name: Build and push\n\s+id: build\n\s+uses: docker\/build-push-action@(?:v7|[0-9a-f]{40})\b/,
      'the build-push step needs id: build so its digest output is addressable');

    const buildIndex = docker.indexOf('Build and push');
    const signIndex = docker.indexOf('cosign sign --yes');
    const digestIndex = docker.indexOf('image-digest.txt');
    assert.ok(buildIndex >= 0 && signIndex > buildIndex,
      'the image digest must be signed after the push');
    assert.ok(digestIndex > signIndex,
      'image-digest.txt must record the digest that was signed');
    assert.match(docker, /cosign sign --yes "\$\{IMAGE\}@\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}"/,
      'cosign must sign the image digest, not a mutable tag');
    assert.match(docker, /printf '%s\\n' "\$digest" > image-digest\.txt/,
      'image-digest.txt must contain the digest that was signed');
    assert.match(docker, /cosign sign-blob[\s\S]{0,200}image-digest\.txt/,
      'the digest file itself must carry a keyless signature bundle');
    assert.match(docker, /name:\s*image-digest\b[\s\S]*?image-digest\.txt\.sigstore\.json/,
      'the signed digest and its bundle must be uploaded as a job artifact');
  });

  it('generates and signs release-attestation.json and attaches both files', () => {
    const release = jobBlock('release');
    const generate = release.indexOf('Generate release attestation');
    const sign = release.indexOf('Sign the release attestation');
    const upload = release.indexOf('Create GitHub Release');

    assert.ok(generate > release.indexOf('Generate SHA256SUMS'),
      'the attestation must hash the assets after SHA256SUMS exists');
    assert.ok(generate < release.indexOf('Install cosign'),
      'the attestation must exist before the signing steps');
    assert.ok(sign > release.indexOf('Sign the published assets and SHA256SUMS'),
      'the attestation is signed with the same keyless identity as the assets');
    assert.ok(sign < upload, 'the signature must exist before the release upload');

    const generateStep = release.slice(generate, sign);
    assert.match(generateStep, /node scripts\/generate-release-attestation\.mjs/,
      'the release job must run the generator');
    assert.match(generateStep, /--tag "\$GITHUB_REF_NAME"/,
      'the attestation must name the release tag');
    assert.match(generateStep, /--commit "\$\(git rev-parse HEAD\)"/,
      'the attestation must name the tag commit');
    assert.match(generateStep, /--tree "\$\(git rev-parse 'HEAD\^\{tree\}'\)"/,
      'the attestation must name the commit tree');

    const signStep = release.slice(sign, upload);
    assert.match(signStep, /cosign sign-blob/,
      'the attestation must be signed as a blob');
    assert.match(signStep, /--bundle release-attestation\.json\.sigstore\.json/,
      'the signature must be a durable Sigstore bundle');

    const files = /files: \|([\s\S]*)$/.exec(release)[1];
    assert.match(files, /^\s+release-attestation\.json$/m,
      'release-attestation.json must be attached to the GitHub Release');
    assert.match(files, /^\s+release-attestation\.json\.sigstore\.json$/m,
      'the attestation bundle must be attached to the GitHub Release');
  });

  it('downloads and attaches the signed image digest artifact', () => {
    const release = jobBlock('release');
    assert.match(
      release,
      /- name: Download the signed image digest\n[\s\S]{0,400}?uses: actions\/download-artifact@(?:v7|[0-9a-f]{40})\b[\s\S]{0,200}?name: image-digest\b/,
      'the release job must download the docker job\'s signed digest artifact',
    );
    const files = /files: \|([\s\S]*)$/.exec(release)[1];
    assert.match(files, /^\s+image-digest\.txt$/m,
      'image-digest.txt must be attached to the GitHub Release');
    assert.match(files, /^\s+image-digest\.txt\.sigstore\.json$/m,
      'the image digest bundle must be attached to the GitHub Release');
  });

  it('publishes SHA256SUMS covering exactly the four release assets', () => {
    const release = jobBlock('release');
    // SEC-04: a tampered download must be distinguishable from a real one.
    // The manifest names the assets as they appear on the release page (flat),
    // because GitHub release assets have no directories. v3.9.53 shipped
    // build-tree paths and `sha256sum -c` failed for three of the four files.
    assert.match(
      release,
      /\( cd dist-windows && sha256sum windsurfapi\.exe windsurfapi-windows\.zip \) > SHA256SUMS[\s\S]*?\( cd dist-macos && sha256sum windsurfapi-macos-arm64 \) >> SHA256SUMS[\s\S]*?sha256sum windsurfapi-macos\.zip >> SHA256SUMS/,
      'the manifest must hash exactly the four published files using their flat release-asset names',
    );
    assert.doesNotMatch(
      release.slice(release.indexOf('Generate SHA256SUMS'), release.indexOf('Create GitHub Release')),
      /sha256sum[^\n]*dist-(?:windows|macos)\//,
      'manifest entries must not carry build-tree directory prefixes',
    );
    assert.match(release, /files: \|[\s\S]*\n\s+SHA256SUMS\s*$/,
      'SHA256SUMS must be attached to the GitHub Release');
    assert.ok(
      release.indexOf('Generate SHA256SUMS') < release.indexOf('softprops/action-gh-release'),
      'the manifest has to exist before the upload step',
    );
  });

  it('pins build-time esbuild instead of floating the latest version', () => {
    const releaseInstalls = workflow.split('\n').filter((line) => /npm i(?:nstall)? -g\b/.test(line));
    assert.equal(releaseInstalls.length, 3, 'release builds install pkg + esbuild on three runners');
    for (const [name, yaml] of [['release.yml', workflow], ['ci.yml', ciWorkflow]]) {
      for (const line of yaml.split('\n').filter((l) => /npm i(?:nstall)? -g\b/.test(l))) {
        assert.doesNotMatch(line, /(?:^|\s)esbuild(?:\s|$)/,
          `${name} installs an unpinned esbuild: ${line.trim()}`);
        assert.match(line, /esbuild@\d+\.\d+\.\d+/, `${name} must pin esbuild to an exact version: ${line.trim()}`);
      }
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
