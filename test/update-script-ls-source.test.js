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
  test('fails closed on local state and gates destructive reset behind an explicit flag', () => {
    const pullStage = UPDATE_SH.slice(
      UPDATE_SH.indexOf('git fetch --quiet --no-tags origin master'),
      UPDATE_SH.indexOf('AFTER=$(git rev-parse HEAD)'),
    );
    assert.match(pullStage, /git status --porcelain/);
    assert.match(pullStage, /git rev-list --count/);
    assert.match(pullStage, /WINDSURFAPI_UPDATE_FORCE_RESET/);
    assert.match(pullStage, /exit 1/);

    const stashAt = pullStage.indexOf('git stash push --include-untracked');
    const resetAt = pullStage.indexOf('git reset --hard "$RESET_TARGET"');
    assert.ok(stashAt >= 0, 'forced reset must preserve local changes in a stash');
    assert.ok(resetAt > stashAt, 'stash must happen before hard reset');
    assert.match(pullStage, /RESET_TARGET="\$TARGET"/);
    assert.match(pullStage, /MERGE_ARGS=\(--ff-only --quiet\)/);
    assert.match(pullStage, /git merge "\$\{MERGE_ARGS\[@\]\}" "\$TARGET"/);
    assert.doesNotMatch(pullStage, /git pull --ff-only/);
    assert.doesNotMatch(pullStage, /if ! git pull[\s\S]*git reset --hard/);
  });

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

  test('install-ls.sh resolves the pinned upstream manifest and fails closed', () => {
    assert.match(
      INSTALL_LS,
      /https:\/\/windsurf-stable\.codeium\.com\/api\/versions/,
      'install-ls.sh must default to the upstream versions manifest'
    );
    assert.match(
      INSTALL_LS,
      /WINDSURFAPI_LS_MANIFEST_URL/,
      'operators must be able to override the manifest URL'
    );
    assert.match(
      INSTALL_LS,
      /WINDSURFAPI_LS_VERSION/,
      'operators must be able to pin an exact version'
    );
    assert.match(
      INSTALL_LS,
      /ls-pins\.json/,
      'the reviewed pins file is the trust anchor'
    );
    assert.match(
      INSTALL_LS,
      /Archive checksum mismatch/,
      'archive hash mismatches must be fatal'
    );
    assert.match(
      INSTALL_LS,
      /Binary checksum mismatch/,
      'inner binary hash mismatches must be fatal'
    );
    assert.doesNotMatch(
      INSTALL_LS,
      /EXAFUNCTION|Exafunction/,
      'the silent Exafunction fallback must be gone'
    );
    assert.doesNotMatch(
      INSTALL_LS,
      /releases\/latest\/download/,
      'the installer must not follow a mutable latest tag'
    );
    assert.match(
      INSTALL_LS,
      /windsurf-ls-release\/releases\/download/,
      'the pinned 3.5.17 rollback mirror remains available'
    );
    assert.match(
      INSTALL_LS,
      /--allow-mirror/,
      'mirror pins require an explicit opt-in'
    );
    assert.match(
      INSTALL_LS,
      /Refusing to fall back to the stale mirror/,
      'an unreachable manifest must not silently install the old mirror'
    );
  });
});
