import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defaultLsBinaryPath } from '../src/config.js';
import { defaultLsDataRoot } from '../src/langserver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_LS = readFileSync(join(__dirname, '..', 'install-ls.sh'), 'utf8');
const SETUP = readFileSync(join(__dirname, '..', 'setup.sh'), 'utf8');

describe('platform-specific language server paths', () => {
  test('runtime defaults match install-ls.sh defaults', () => {
    assert.equal(
      defaultLsBinaryPath('darwin', 'arm64', '/Users/alice'),
      '/Users/alice/.windsurf/language_server_macos_arm'
    );
    assert.equal(
      defaultLsBinaryPath('darwin', 'x64', '/Users/alice'),
      '/Users/alice/.windsurf/language_server_macos_x64'
    );
    assert.equal(
      defaultLsBinaryPath('linux', 'x64', '/home/alice'),
      '/opt/windsurf/language_server_linux_x64'
    );
    assert.equal(
      defaultLsBinaryPath('linux', 'arm64', '/home/alice'),
      '/opt/windsurf/language_server_linux_arm'
    );

    assert.match(INSTALL_LS, /DEFAULT_PATH="\$HOME\/\.windsurf\/\$\{ASSET\}"/);
    assert.match(INSTALL_LS, /DEFAULT_PATH="\/opt\/windsurf\/\$\{ASSET\}"/);
  });

  test('macOS language server data defaults to a user-writable directory', () => {
    assert.equal(defaultLsDataRoot('darwin', '/Users/alice'), '/Users/alice/.windsurf/data');
    assert.equal(defaultLsDataRoot('linux', '/home/alice'), '/opt/windsurf/data');
  });

  test('setup.sh writes platform-specific LS_BINARY_PATH and LS_DATA_DIR', () => {
    assert.match(SETUP, /Darwin:arm64\).*LS_PATH="\$HOME\/\.windsurf\/language_server_macos_arm"/s);
    assert.match(SETUP, /Linux:aarch64\|Linux:arm64\).*LS_PATH="\/opt\/windsurf\/language_server_linux_arm"/s);
    assert.match(SETUP, /LS_BINARY_PATH=\$LS_PATH/);
    assert.match(SETUP, /LS_DATA_DIR=\$LS_DATA_DIR/);
  });
});
