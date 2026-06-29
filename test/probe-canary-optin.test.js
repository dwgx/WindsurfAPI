// Probe canary is opt-in — a plain probe must never spend prompt credits.
//
// Live incident (homecloud 2026-06-29): a force-probe fired Steps 2 & 3 of
// _probeAccountImpl, which send REAL cascadeChat('hi') calls per model. That
// canary sweep exhausted a working free account's allowance and flipped its
// tier free→expired. GetUserStatus (Step 1) already classifies every
// enum-keyed model for free, so the billable canary is now off by default and
// only runs when the caller opts in (canary:true / WINDSURFAPI_PROBE_CANARY=1).
//
// These are source-text assertions (the real probe needs a live LS/account),
// pinning that the billable steps are guarded by the canary flag.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_JS = readFileSync(join(__dirname, '..', 'src/auth.js'), 'utf8');
const DASH_JS = readFileSync(join(__dirname, '..', 'src/dashboard/api.js'), 'utf8');

describe('probe canary is opt-in (no credit burn by default)', () => {
  test('canary defaults OFF — env opt-in only', () => {
    assert.match(AUTH_JS, /function probeCanaryDefault\(\)/);
    assert.match(AUTH_JS, /process\.env\.WINDSURFAPI_PROBE_CANARY === '1'/,
      'default must be env=1 opt-in (off unless explicitly enabled)');
  });

  test('Step 2 canary sweep is gated by runCanary', () => {
    // The PROBE_CANARIES loop only builds work when runCanary is true.
    assert.match(AUTH_JS, /const needsProbe = !runCanary \? \[\] : PROBE_CANARIES\.filter/,
      'Step 2 must short-circuit to [] when canary is off');
  });

  test('Step 3 dynamic cloud probe is gated by runCanary', () => {
    assert.match(AUTH_JS, /if \(runCanary\) try \{/,
      'Step 3 billable cloud probe must be wrapped in `if (runCanary)`');
  });

  test('both entry points resolve the canary default via ??', () => {
    assert.match(AUTH_JS, /const useCanary = canary \?\? probeCanaryDefault\(\)/);
    assert.match(AUTH_JS, /const runCanary = canary \?\? probeCanaryDefault\(\)/);
  });

  test('dashboard probe route only enables canary on explicit deep probe', () => {
    assert.match(DASH_JS, /const canary = body\?\.canary === true \|\| body\?\.deep === true/,
      'dashboard must require explicit {canary:true} / {deep:true} to spend credit');
  });

  test('GetUserStatus (free, Step 1) still always runs before the gate', () => {
    // fetchUserStatus is the free, authoritative classifier — it must not be
    // behind the canary gate so a plain probe still resolves tier for free.
    const idx = AUTH_JS.indexOf('const status = await fetchUserStatus(account.id');
    const gate = AUTH_JS.indexOf('const needsProbe = !runCanary');
    assert.ok(idx > 0 && gate > idx,
      'fetchUserStatus must run before the canary gate (free tier resolution)');
  });
});
