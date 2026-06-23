// update.sh should use the same language-server download policy as
// install-ls.sh. It must not drift back to a stale hardcoded asset URL.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPDATE_SH = readFileSync(join(__dirname, '..', 'update.sh'), 'utf8');
const INSTALL_LS = readFileSync(join(__dirname, '..', 'install-ls.sh'), 'utf8');

describe('update.sh language-server source selection', () => {
  test('delegates LS updates to install-ls.sh with the configured target path', () => {
    assert.match(UPDATE_SH, /LS_INSTALL_PATH="\$LS_PATH"\s+bash install-ls\.sh/);
    assert.doesNotMatch(UPDATE_SH, /RELEASE_URL=/);
    assert.doesNotMatch(
      UPDATE_SH,
      /github\.com\/dwgx\/WindsurfAPI\/releases\/latest\/download\/language_server_linux_x64/,
      'update.sh must not hardcode the stale WindsurfAPI language-server asset URL'
    );
  });

  test('does not abort code updates when LS download fails but an existing binary is present', () => {
    assert.match(UPDATE_SH, /if LS_INSTALL_PATH="\$LS_PATH"\s+bash install-ls\.sh; then/);
    assert.match(UPDATE_SH, /\[ -s "\$LS_PATH" \]/);
    assert.match(UPDATE_SH, /keeping existing binary/);
    assert.match(UPDATE_SH, /no existing binary exists/);
  });

  test('reads LS_BINARY_PATH from .env without GNU grep-only flags', () => {
    assert.match(UPDATE_SH, /\bawk\b/);
    assert.ok(UPDATE_SH.includes('(export[[:space:]]+)?LS_BINARY_PATH'));
    assert.ok(UPDATE_SH.includes('LS_BINARY_PATH[[:space:]]*=[[:space:]]*'));
    assert.ok(UPDATE_SH.includes('[[:space:]]+#.*'));
    assert.doesNotMatch(
      UPDATE_SH,
      /grep[^\n]*\s-[A-Za-z]*P(?:\s|$)/,
      'update.sh must not require GNU grep -P; macOS ships BSD grep'
    );
  });

  test('install-ls.sh defaults to the maintained public Windsurf LS mirror', () => {
    assert.match(
      INSTALL_LS,
      /dwgx\/windsurf-ls-release/,
      'install-ls.sh should default to the maintained public Windsurf LS release mirror'
    );
    assert.doesNotMatch(
      INSTALL_LS,
      /CaiJingLong\/windsurf-linux-server-release/,
      'install-ls.sh must not default to the stale third-party mirror'
    );
    assert.match(
      INSTALL_LS,
      /WINDSURFAPI_LS_RELEASE/,
      'install-ls.sh should allow operators to override the LS release mirror/source'
    );
    assert.match(
      INSTALL_LS,
      /Trying maintained Windsurf LS mirror: \$ws_url/,
      'install-ls.sh should print the fallback URL so large macOS downloads do not look hung'
    );
    assert.match(
      INSTALL_LS,
      /verify_release_asset_checksum "\$WINDSURF_LS_RELEASE" "\$ASSET" "\$TMP_TARGET"/,
      'downloads from the maintained mirror should be checked against SHA256SUMS when available'
    );
    assert.match(
      INSTALL_LS,
      /SHA256SUMS not available; skipping mirror checksum verification/,
      'custom or older mirrors without SHA256SUMS should remain usable'
    );
  });
});
