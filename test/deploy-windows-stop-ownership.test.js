// Windows Stop ownership tests (web-takeover windows-stop lane).
//
// These tests never touch real processes. Every scenario runs in a dedicated
// `powershell.exe -NoProfile` child that:
//   1. builds synthetic Win32_Process rows in memory,
//   2. overrides every process-enumeration / action entry point
//      (Get-CimInstance, Stop-Process, taskkill, schtasks, Start-Sleep)
//      BEFORE dot-sourcing the product script, and
//   3. operates only inside a throwaway synthetic install directory with
//      spaces in its path (quoted-path launch forms exercised for real).
//
// The child environment is hermetic: only OS executable-resolution variables
// survive, profile/APPDATA/LOCALAPPDATA/TEMP point at a private temp tree,
// and XDG_* variables are dropped. The PowerShell child makes no network
// calls (pure in-memory computation over synthetic rows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HARNESS = join(REPO_ROOT, 'test', 'stop-ownership-harness.ps1');
const POWERSHELL = process.env.WINDSURFAPI_TEST_POWERSHELL || 'powershell.exe';

// Scenario list mirrored by test/stop-ownership-harness.ps1; the harness
// exits non-zero for an unknown scenario name, so drift is caught.
const SCENARIOS = [
  'selector-owned-forms',
  'selector-foreign-rows',
  'selector-normalization',
  'pid-verdicts',
  'stop-trusted-source',
  'stop-legacy-owned',
  'stop-stale-pid-unowned',
  'stop-foreign-node-legacy',
  'stop-reuse-during-grace',
  'stop-escalates-when-same-generation',
  'stop-absent-pid',
  'stop-exe-mode',
  'stop-schtasks-own',
  'stop-schtasks-foreign',
  'task-action-contract',
  'ticket-generation-contract',
  'ticket-replacement-cleanup',
  'stop-force-failure',
  'stop-query-failure',
  'stop-concurrent-ticket',
  'tray-stop-contract',
];

function hermeticChildEnv() {
  const profile = mkdtempSync(join(tmpdir(), 'wa-stop-owner-profile-'));
  const env = {
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    ComSpec: process.env.ComSpec,
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    TEMP: join(profile, 'tmp'),
    TMP: join(profile, 'tmp'),
    USERPROFILE: join(profile, 'home'),
    APPDATA: join(profile, 'home', 'AppData', 'Roaming'),
    LOCALAPPDATA: join(profile, 'home', 'AppData', 'Local'),
    WINDSURFAPI_SKIP_DOTENV: '1',
  };
  return { env, profile };
}

if (process.platform !== 'win32') {
  test('windows stop ownership requires windows', { skip: 'windows-only suite' }, () => {});
} else {
  for (const scenario of SCENARIOS) {
    test(`stop ownership harness: ${scenario}`, { timeout: 180_000 }, () => {
      const { env, profile } = hermeticChildEnv();
      try {
        const res = spawnSync(
          POWERSHELL,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HARNESS, '-Scenario', scenario],
          { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 170_000, windowsHide: true },
        );
        if (res.error) throw res.error;
        if (res.status !== 0) {
          throw new Error(
            `scenario ${scenario} failed (exit=${res.status}, signal=${res.signal})\n` +
            `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
          );
        }
        assert.match(res.stdout, /SCENARIO DONE/);
      } finally {
        try { rmSync(profile, { recursive: true, force: true }); } catch {}
      }
    });
  }
}
