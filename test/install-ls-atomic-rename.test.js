// install-ls.sh must do an atomic rename, not in-place overwrite.
//
// User report (2026-04-29): "LS 更新失败：curl -o /opt/windsurf/...
// 'Text file busy'". Linux refuses open(O_WRONLY|O_TRUNC) on a file
// currently being executed (ETXTBSY). Since the LS is running off
// the very binary install-ls.sh wants to replace, an in-place curl
// always fails on a live system.
//
// Fix: write to ${TARGET}.new.$$ then `mv -f` over the target.
// rename(2) just swaps the dirent to a new inode — running processes
// keep their old inode (now unlinked but still live), and the next
// exec reads the new inode. No service downtime, no ETXTBSY.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(__dirname, '..', 'install-ls.sh'), 'utf8');

describe('install-ls.sh atomic rename (LS file-busy fix)', () => {
  test('writes to a tmp sibling instead of the target directly', () => {
    // The downloads (curl -o) and copies (cp -f) all need to go to
    // the .new sibling, never directly to $TARGET.
    assert.match(SCRIPT, /TMP_TARGET="\$\{TARGET\}\.new\.\$\$"/,
      'must define TMP_TARGET as $TARGET.new.$$');
    // Every curl -o invocation should target $TMP_TARGET, not $TARGET.
    const curlMatches = SCRIPT.match(/curl [^\n]*--progress-bar[^\n]*-o "([^"]+)"/g) || [];
    assert.ok(curlMatches.length > 0, 'expected at least one curl -o call');
    for (const c of curlMatches) {
      assert.match(c, /\$TMP_TARGET/,
        `curl invocation must write to $TMP_TARGET, not $TARGET — found: ${c}`);
    }
    assert.match(SCRIPT, /curl -fsL -o "\$checksums_file" "\$checksums_url"/,
      'checksum downloads should write to the separate checksum tmp file');
    // cp -f branches likewise.
    const cpMatches = SCRIPT.match(/cp -f "[^"]+" "([^"]+)"/g) || [];
    for (const c of cpMatches) {
      assert.match(c, /\$TMP_TARGET/,
        `cp invocation must target $TMP_TARGET — found: ${c}`);
    }
  });

  test('atomic mv finalizes the install, after chmod', () => {
    // The chmod must happen on the tmp file (not target), then the
    // mv swaps the inode in one step. A reversed order would leave
    // the target without +x for a brief window.
    assert.match(SCRIPT, /chmod \+x "\$TMP_TARGET"\s*\n\s*mv -f "\$TMP_TARGET" "\$TARGET"/,
      'must chmod the tmp file then mv it onto $TARGET in that order');
  });

  test('cleans up the tmp file if the script aborts mid-run', () => {
    // trap the EXIT pseudo-signal so a curl failure doesn't strand
    // a half-downloaded $TARGET.new.$$ in the install dir. Then
    // disable the trap after the successful mv so we don't try to
    // delete a path that's now $TARGET (different inode but same name
    // would have surprising side effects if the trap chain fires later).
    assert.match(SCRIPT, /trap 'rm -f "\$TMP_TARGET" "\$TMP_CHECKSUMS"' EXIT/,
      'must register a trap to clean up tmp files on abort');
    assert.match(SCRIPT, /trap - EXIT/,
      'must clear the trap after the successful mv');
  });
});
