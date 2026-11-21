import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

test('the release guide and offline verifier help require Cosign v3 or newer for bundles', () => {
  const guide = read('docs/RELEASE-SIGNING.md');
  assert.match(guide, /Use Cosign v3 or newer/i);
  assert.match(guide, /v2\.4\.1/);
  const help = execFileSync(process.execPath, ['scripts/verify-release-assets.mjs', '--help'], { cwd: root, encoding: 'utf8' });
  assert.match(help, /one \.sigstore\.json bundle per signed file\. Verify with Cosign v3 or newer/i);
  assert.doesNotMatch(help, /plus \.sig, \.pem/);
});

test('legacy migration instructions identify the manual target and the existing numeric order', () => {
  const guide = read('docs/RELEASE-SIGNING.md');
  const section = guide.split('## Manual Git-source migration from v3.141 to v3.2.x\n')[1]?.split('\n## ')[0];
  assert.ok(section);
  assert.match(section, /select the target tag manually/i);
  const order = section.replace(/\s+/g, ' ').match(/`(v[\d.]+)` ranks above `(v[\d.]+)`/);
  assert.deepEqual(order?.slice(1), ['v3.141.592661', 'v3.2.11']);
  assert.ok(section.includes('releases/RELEASE_NOTES_3.2.11.md#signed-upgrade'));
  assert.match(read('docs/releases/RELEASE_NOTES_3.2.11.md'), /^## Signed upgrade$/m);
  assert.match(section, /\/health/);
  assert.match(section, /rollback/);
  if (process.platform !== 'win32') {
    const fn = read('update.sh').match(/^stable_tag_is_newer\(\) \{[\s\S]*?^\}/m);
    assert.ok(fn);
    execFileSync('bash', ['-c', fn[0] + '\nstable_tag_is_newer "$1" "$2" && ! stable_tag_is_newer "$2" "$1"', 'compare', ...order.slice(1)]);
  }
});
