import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectMemoryLimitBytes,
  detectMemoryCurrentBytes,
  detectHostMemAvailableBytes,
  estimateDefaultMaxLsInstances,
  classifyLanguageServerStderr,
  getLsStatus,
  getLsAdmissionStatus,
  hasLsPoolCapacityForStart,
  isLanguageServerRunning,
  shouldPrewarmDefaultLs,
  stopLanguageServerAndWait,
  sweepIdleLanguageServers,
} from '../src/langserver.js';
import { addAccountByKey, getLsAdmissionForAccount } from '../src/auth.js';
import { probeOutcomeEntry } from '../src/dashboard/fleet-jobs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const readSrc = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

/** Run `fn` with one env var pinned (or unset when `value` is undefined), then restore. */
function withEnv(name, value, fn) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe('language server resource policy', () => {
  test('default max instances scales down on small hosts', () => {
    const mb = 1024 * 1024;
    assert.equal(estimateDefaultMaxLsInstances(512 * mb, 700 * mb), 2);
    assert.equal(estimateDefaultMaxLsInstances(2 * 1024 * mb, 700 * mb), 2);
    assert.equal(estimateDefaultMaxLsInstances(16 * 1024 * mb, 700 * mb), 20);
    assert.equal(estimateDefaultMaxLsInstances(0, 700 * mb), 2);
  });

  test('adaptive default keeps a non-default proxy slot even on tiny cgroups', () => {
    const mb = 1024 * 1024;
    assert.equal(estimateDefaultMaxLsInstances(1024 * mb, 700 * mb), 2);
  });

  test('memory limit detection respects cgroup limits when present', () => {
    const files = new Map([
      ['/sys/fs/cgroup/memory.max', String(1536 * 1024 * 1024)],
    ]);
    const readFile = (path) => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(path);
    };
    assert.equal(detectMemoryLimitBytes(readFile, 8 * 1024 * 1024 * 1024), 1536 * 1024 * 1024);
  });

  test('memory limit detection ignores unlimited cgroup sentinels', () => {
    const files = new Map([
      ['/sys/fs/cgroup/memory.max', 'max'],
      ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '9223372036854771712'],
    ]);
    const readFile = (path) => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(path);
    };
    assert.equal(detectMemoryLimitBytes(readFile, 4 * 1024 * 1024 * 1024), 4 * 1024 * 1024 * 1024);
  });

  test('memory current detection reads cgroup usage', () => {
    const files = new Map([
      ['/sys/fs/cgroup/memory.current', String(300 * 1024 * 1024)],
    ]);
    const readFile = (path) => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(path);
    };
    assert.equal(detectMemoryCurrentBytes(readFile), 300 * 1024 * 1024);
  });

  test('host memory available detection parses /proc/meminfo', () => {
    const readFile = () => 'MemTotal: 2048000 kB\nMemAvailable: 512000 kB\n';
    assert.equal(detectHostMemAvailableBytes(readFile, 1), 512000 * 1024);
  });

  test('LS stderr classifier keeps normal startup lines out of warn', () => {
    assert.equal(classifyLanguageServerStderr('I0605 00:00:00.000000 server started'), 'info');
    assert.equal(classifyLanguageServerStderr('listening on 42100'), 'info');
    assert.equal(classifyLanguageServerStderr('W0605 00:00:00.000000 slow startup'), 'warn');
    assert.equal(classifyLanguageServerStderr('E0605 00:00:00.000000 failed to bind'), 'error');
    assert.equal(classifyLanguageServerStderr('panic: crash'), 'error');
  });

  test('status exposes resource guard configuration even before LS starts', () => {
    const status = getLsStatus();
    assert.equal(typeof status.maxInstances, 'number');
    assert.ok(status.maxInstances >= 1);
    assert.equal(typeof status.poolWaitMs, 'number');
    assert.equal(typeof status.idleTtlMs, 'number');
    assert.equal(typeof status.idleSweepMs, 'number');
    assert.equal(status.estimatedRssBytesPerInstance, 700 * 1024 * 1024);
    assert.equal(typeof status.effectiveEstimatedRssBytesPerInstance, 'number');
    assert.equal(typeof status.systemMemoryBytes, 'number');
    assert.equal(typeof status.detectedMemoryLimitBytes, 'number');
    assert.equal(typeof status.memoryGuard, 'object');
    assert.equal(typeof status.memoryGuard.minAvailableBytes, 'number');
    assert.equal(typeof status.memoryGuard.estimatedRssBytesPerInstance, 'number');
    assert.equal(typeof status.memoryGuard.minAvailableBytesSource, 'string');
    assert.equal(typeof status.pool, 'object');
    assert.equal(typeof status.pool.occupancy, 'number');
    assert.equal(typeof status.pool.effectiveOccupancy, 'number');
    assert.equal(typeof status.pool.ready, 'number');
    assert.equal(typeof status.pool.starting, 'number');
    assert.equal(typeof status.pool.pending, 'number');
    assert.equal(typeof status.pool.reservedPendingStarts, 'number');
    assert.equal(typeof status.pool.stopping, 'number');
    assert.equal(typeof status.pool.maintenanceRequests, 'number');
    assert.equal(typeof status.pool.canStartNewNonDefault, 'boolean');
    assert.equal(typeof status.pool.idleEvictableCount, 'number');
    assert.equal(typeof status.pool.memoryGuard, 'object');
    assert.equal(typeof status.admissionStats, 'object');
    assert.equal(typeof status.admissionStats.startAttempts, 'number');
    assert.equal(typeof status.admissionStats.startSuccesses, 'number');
    assert.equal(typeof status.admissionStats.startFailures, 'number');
    assert.equal(typeof status.admissionStats.poolWaits, 'number');
    assert.equal(typeof status.admissionStats.memoryWaits, 'number');
    assert.equal(typeof status.admissionStats.poolExhausted, 'number');
    assert.equal(typeof status.admissionStats.memoryGuardBlocks, 'number');
    assert.equal(typeof status.admissionStats.evictions, 'number');
    assert.ok(Array.isArray(status.instances));
  });

  test('idle sweep is a no-op on an empty pool and returns telemetry', () => {
    const result = sweepIdleLanguageServers(Date.now());
    assert.deepEqual(Object.keys(result).sort(), ['scanned', 'stopped', 'ttlMs']);
    assert.equal(result.scanned, 0);
    assert.equal(result.stopped, 0);
  });
});

// ─── Admission seam ─────────────────────────────────────────────────────────
// `getLsAdmissionStatus` is the object every probe/restart decision branches on
// (`residentProbeSkip`, the scheduled probe loop, predictive prewarm, the
// dashboard probe routes). Asserting the seam's own output replaces the
// former source-text greps: a changed branch now has to change an observable
// reason code instead of a string in a file.
describe('LS admission seam', () => {
  test('a cold default key is admitted and is never reported resident', () => {
    const adm = getLsAdmissionStatus(null);
    assert.equal(adm.ok, true);
    assert.equal(adm.wouldStart, true);
    assert.equal(adm.reason, 'can_start');
    assert.equal(adm.pending, false);
    assert.equal(adm.key, 'default');
    assert.equal(adm.maxInstances, getLsStatus().maxInstances);
    // The whole point of the probe guard: nothing resident ⇒ a non-forcing
    // probe has no idle instance to reuse.
    assert.notEqual(adm.reason, 'already_running');
  });

  test('a cold non-default proxy is never reported resident', () => {
    // `getLsAdmissionStatus` keys off a proxy object, not a key string: a
    // string has no `.host`, so it silently degrades to the default key.
    const adm = getLsAdmissionStatus({ host: 'lsres-proxy.example', port: 8080 });
    assert.equal(adm.key, 'px_lsres_proxy_example_8080');
    assert.notEqual(adm.reason, 'already_running');
    assert.equal(adm.pending, false);
    // Only these three can come back from a cold pool; each of them makes
    // residentProbeSkip() return `skipped: true`.
    assert.ok(
      ['can_start', 'memory_guard', 'pool_full_no_idle'].includes(adm.reason),
      `unexpected cold-pool reason: ${adm.reason}`,
    );
    assert.equal(adm.idleEvictableCount, 0);
    assert.equal(adm.wouldStart, true);
  });

  test('an account with no resident LS is not admitted as resident', () => {
    const account = addAccountByKey(`sk-lsres-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'lsres');
    const adm = getLsAdmissionForAccount(account.id);
    assert.equal(adm.accountId, account.id);
    assert.notEqual(adm.reason, 'already_running');
    assert.equal(adm.ok, true);
    // Cold-path admissions carry no instance counters at all — that is exactly
    // why the guard reads `(admission.activeRequests || 0) > 0`.
    assert.equal(adm.activeRequests, undefined);
    assert.equal(adm.maintenanceRequests, undefined);
  });

  test('an unknown account can never be admitted', () => {
    const missing = getLsAdmissionForAccount('does-not-exist');
    assert.equal(missing.ok, false);
    assert.equal(missing.errorType, 'account_not_found');
    assert.equal(missing.reason, 'account_not_found');
  });

  test('default and restart paths share one admission budget', () => {
    const def = getLsAdmissionStatus(null);
    const proxy = getLsAdmissionStatus({ host: 'lsres-restart.example', port: 8081 });
    assert.equal(proxy.key, 'px_lsres_restart_example_8081');
    // Same ceiling and same memory guard object shape ⇒ the restart path is not
    // exempted from the budget the default path obeys (the #174 regression).
    assert.equal(def.maxInstances, proxy.maxInstances);
    assert.deepEqual(Object.keys(def.memoryGuard).sort(), Object.keys(proxy.memoryGuard).sort());
    assert.equal(def.memoryGuard.estimatedRssBytesPerInstance, getLsStatus().memoryGuard.estimatedRssBytesPerInstance);
  });

  test('stopLanguageServerAndWait settles on an empty pool without burning the timeout', async () => {
    const started = Date.now();
    await stopLanguageServerAndWait({ perProcessTimeoutMs: 1500 });
    assert.equal(isLanguageServerRunning(), false);
    assert.equal(getLsStatus().pool.occupancy, 0);
    assert.equal(getLsStatus().pool.stopping, 0);
    // No child to reap ⇒ resolves immediately; the 1500ms ceiling is for the
    // child, not for the call.
    assert.ok(Date.now() - started < 1500, 'stopLanguageServerAndWait should not block with no children');
  });

  test('LS capacity formula counts pending starts before admitting cold proxies', () => {
    assert.equal(hasLsPoolCapacityForStart(1, 2, 0), true);
    assert.equal(hasLsPoolCapacityForStart(2, 2, 0), false);
    assert.equal(hasLsPoolCapacityForStart(2, 2, 1), true);
    assert.equal(hasLsPoolCapacityForStart(3, 2, 1), false);
    assert.equal(hasLsPoolCapacityForStart(3, 2, 2), true);
  });

  test('admission telemetry is zeroed, complete and exposed to health + dashboard', () => {
    const { admissionStats } = getLsStatus();
    const counters = [
      'startAttempts', 'startSuccesses', 'startFailures',
      'poolWaits', 'memoryWaits', 'poolExhausted', 'memoryGuardBlocks', 'evictions',
    ];
    assert.deepEqual(
      Object.keys(admissionStats).filter((k) => !k.startsWith('last')).sort(),
      counters.slice().sort(),
    );
    for (const key of counters) {
      assert.equal(typeof admissionStats[key], 'number', `${key} must be a counter`);
      assert.ok(admissionStats[key] >= 0, `${key} must never go negative`);
    }
    // Nothing has started in this process, so every counter is still at its seed.
    for (const key of counters) assert.equal(admissionStats[key], 0, `${key} should start at 0`);
    for (const key of ['lastAttempt', 'lastSuccess', 'lastFailure', 'lastWait', 'lastEviction']) {
      assert.ok(key in admissionStats, `${key} slot must exist for the dashboard`);
    }
  });

  test('pool summary reports the eviction surface the dashboard reads', () => {
    const { pool } = getLsStatus();
    assert.deepEqual(pool.pendingKeys, []);
    assert.deepEqual(pool.stoppingInstances, []);
    assert.equal(pool.idleEvictable, false);
    assert.equal(pool.evictionCandidateKey, null);
    assert.equal(pool.defaultRunning, false);
    assert.equal(pool.nonDefaultInstances, 0);
    assert.equal(pool.size, 0);
    assert.ok(pool.blockReason === null || typeof pool.blockReason === 'string', 'blockReason is null or a reason code');
  });
});

// ─── Probe outcome classification ───────────────────────────────────────────
describe('probe outcome classification', () => {
  test('a skipped probe stays visible as skipped, never as ok', () => {
    assert.deepEqual(
      probeOutcomeEntry('acct-1', { skipped: true, reason: 'ls_not_idle_resident', tier: 'pro' }),
      { id: 'acct-1', ok: false, skipped: true, reason: 'ls_not_idle_resident', tier: 'pro' },
    );
    // A skip with no reason still must not read as success.
    assert.deepEqual(
      probeOutcomeEntry('acct-2', { skipped: true }),
      { id: 'acct-2', ok: false, skipped: true, reason: 'probe_skipped', tier: 'unknown' },
    );
  });

  test('a completed probe is ok and a missing account is an error', () => {
    assert.deepEqual(probeOutcomeEntry('acct-3', { ok: true, tier: 'free' }), { id: 'acct-3', ok: true, tier: 'free' });
    assert.deepEqual(probeOutcomeEntry('acct-4', null), { id: 'acct-4', ok: false, error: 'ERR_ACCOUNT_NOT_FOUND' });
  });
});

// ─── Prewarm gate ───────────────────────────────────────────────────────────
describe('default LS prewarm gate', () => {
  test('prewarm is opt-out, not opt-in', () => {
    withEnv('LS_PREWARM_DEFAULT', undefined, () => {
      assert.equal(shouldPrewarmDefaultLs(), getLsStatus().maxInstances > 1);
    });
    withEnv('LS_PREWARM_DEFAULT', '1', () => {
      assert.equal(shouldPrewarmDefaultLs(), getLsStatus().maxInstances > 1);
    });
  });

  test('LS_PREWARM_DEFAULT=0 disables prewarm on any host', () => {
    withEnv('LS_PREWARM_DEFAULT', '0', () => {
      assert.equal(shouldPrewarmDefaultLs(), false);
    });
  });

  test('a single-instance pool has no proxy slot, so prewarm is off even unset', () => {
    // MAX_LS_INSTANCES is frozen at module load, so the floor can only be
    // exercised in a fresh process.
    const env = { ...process.env, LS_MAX_INSTANCES: '1', LS_PREWARM_DEFAULT: '' };
    // A plain child must not inherit the runner's test context or options.
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e',
        "import('./src/langserver.js').then(m => process.stdout.write(`${m.shouldPrewarmDefaultLs()}|${m.getLsStatus().maxInstances}`))"],
      {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.equal(out, 'false|1');
  });
});

// ─── Residual wiring ────────────────────────────────────────────────────────
// Everything below is source-text on purpose. Each assertion pins a call site
// inside a module-private function (or a side-effecting entrypoint) that has no
// importable seam: reaching it needs a live upstream account, a spawned LS
// binary, or importing src/index.js (which boots the server). They are kept as
// one-assertion-per-fact wiring guards, not as behaviour claims.
describe('wiring with no reachable seam', () => {
  test('startup proxy prewarm stays behind LS_PREWARM_PROXIES=1', () => {
    const auth = readSrc('src/auth.js');
    // Private prewarm block in auth.js: imports langserver lazily and warms
    // every configured proxy. Needs a configured proxy list + a real LS binary.
    assert.match(auth, /process\.env\.LS_PREWARM_PROXIES === '1'/);
    assert.match(auth, /uniqueProxies\.set\('default', null\)/);
  });

  test('the auth prewarm path consults the shared kill switch', () => {
    // Same private block as above; the *decision function* is covered
    // behaviourally in the prewarm-gate suite.
    assert.match(readSrc('src/auth.js'), /shouldPrewarmDefaultLs\(\)/);
  });

  test('the entrypoint configures the LS and honours the kill switch', () => {
    // src/index.js is a side-effecting entrypoint: importing it boots the
    // HTTP server, so its wiring can only be inspected as text.
    const index = readSrc('src/index.js');
    assert.match(index, /configureLanguageServer\(lsConfig\)/);
    assert.match(index, /shouldPrewarmDefaultLs\(\)/);
    assert.match(index, /LS default prewarm disabled/);
  });

  test('dashboard account-add warmup stays opt-in', () => {
    // scheduleAccountWarmup() is module-private in the dashboard router and
    // fires on POST /accounts, which needs a real upstream login.
    const api = readSrc('src/dashboard/api.js');
    assert.match(api, /LS_PREWARM_ON_ACCOUNT_ADD === '1'/);
    assert.match(api, /function scheduleAccountWarmup/);
  });

  test('scheduled probes run with allowLsStart=false', () => {
    // The scheduled-probe loop is private and driven by a timer against live
    // accounts; the admission decision it reads is covered behaviourally above.
    const auth = readSrc('src/auth.js');
    assert.match(auth, /probeAccount\(a\.id, \{ allowLsStart: false \}\)/);
    assert.match(auth, /Scheduled probe .*wouldStart=/);
  });

  test('background maintenance skips busy accounts by default', () => {
    // refreshAllCredits()/refreshAllFirebaseTokens() are exported, but their
    // busy-skip branch is only observable with accounts that have live inflight
    // requests; the switch itself lives in a private helper.
    const auth = readSrc('src/auth.js');
    assert.match(auth, /WINDSURFAPI_BACKGROUND_MAINTENANCE_SKIP_BUSY !== '0'/);
    assert.match(auth, /const skipBusyMaintenance = shouldSkipBusyBackgroundMaintenance\(\)/);
    assert.match(auth, /refreshAllCredits\(\{ skipBusy: skipBusyMaintenance \}\)/);
    assert.match(auth, /refreshAllFirebaseTokens\(\{ skipBusy: skipBusyMaintenance \}\)/);
  });

  test('predictive prewarm reports a structured failure instead of throwing', () => {
    // Runs after a real turn completes, against the next account's proxy.
    const auth = readSrc('src/auth.js');
    assert.match(auth, /ensureLsForAccount\(nextAccount\.id\)\)\.then\(r =>/);
    assert.match(auth, /r\?\.errorType \|\| 'ls_start_failed'/);
  });

  test('dashboard probe routes pass the force flag through', () => {
    // The routes need an HTTP server + a live account; the classification they
    // delegate to is covered behaviourally by probeOutcomeEntry.
    const api = readSrc('src/dashboard/api.js');
    const fleet = readSrc('src/dashboard/fleet-jobs.js');
    assert.match(api, /const force = body\?\.force === true \|\| body\?\.allowLsStart === true/);
    assert.match(fleet, /probeAccount\(account\.id, \{ allowLsStart: force \}\)/);
    assert.match(api, /probeAccount\(accountProbe\[1\], \{ allowLsStart: force, canary \}\)/);
  });

  test('probe maintenance has a second resident-only guard before ensureLs', () => {
    // residentProbeSkip() and fetchUserStatus() are private/network-bound; the
    // admission object they branch on is asserted behaviourally above.
    const auth = readSrc('src/auth.js');
    assert.match(auth, /function residentProbeSkip/);
    assert.match(auth, /if \(!allowLsStart\) \{/);
    assert.match(auth, /if \(allowLsStart\) await ensureLs\(proxy\)/);
    assert.match(auth, /reason: busyReason \|\| admission\.errorType \|\| admission\.reason \|\| 'ls_not_idle_resident'/);
  });

  test('LS start admission is serialized through one lock', () => {
    // withStartAdmissionLock() wraps a real spawn; the observable half (pending
    // reservations counting toward effectiveOccupancy) is asserted above.
    const ls = readSrc('src/langserver.js');
    assert.match(ls, /function withStartAdmissionLock/);
    assert.match(ls, /pendingStartReservationCount/);
    assert.match(ls, /poolOccupancyWithPendingReservations/);
    assert.match(ls, /countIdleNonDefaultEvictionCandidates/);
  });

  test('a stale LS exit never tears down its replacement', () => {
    // Fires from a real child `exit` event after a restart.
    const ls = readSrc('src/langserver.js');
    assert.match(ls, /const ownsEntry = current\?\.process === proc/);
    assert.match(ls, /Ignoring stale LS exit/);
    assert.match(ls, /markIntentionalShutdown\(entry\)/);
  });

  test('restart records the stopping window so the port is not reused early', () => {
    const ls = readSrc('src/langserver.js');
    assert.match(ls, /_stopping\.set\(key, \{ at: Date\.now\(\), pid: entry\?\.process\?\.pid \|\| null, reason: 'restart' \}\)/);
    assert.match(ls, /await waitProcessExit\(entry\?\.process, 1500\)/);
  });

  test('neither wait loop short-circuits the default key', () => {
    // Negative guards: the #174 regression was a `key === 'default'` early
    // return inside these two private waiters. No export exposes them, so the
    // absence is asserted as text.
    const ls = readSrc('src/langserver.js');
    assert.doesNotMatch(ls, /function waitForPoolCapacity[\s\S]{0,120}key === 'default'\) return/);
    assert.doesNotMatch(ls, /function waitForMemoryHeadroom[\s\S]{0,120}key === 'default'\) return/);
  });

  test('pool keys are redacted before they leave the process', () => {
    // publicLsKey() is private and only observable with a populated pool
    // (`px_…_u<user>` must never reach the dashboard).
    const ls = readSrc('src/langserver.js');
    assert.match(ls, /function publicLsKey/);
    assert.match(ls, /_u_redacted/);
    assert.match(ls, /pendingKeys = Array\.from\(_pending\.keys\(\)\)\.map\(publicLsKey\)/);
  });

  test('the dashboard restart path waits for the child instead of firing and forgetting', () => {
    const api = readSrc('src/dashboard/api.js');
    assert.match(api, /await stopLanguageServerAndWait\(\{ perProcessTimeoutMs: 1500 \}\)/);
    assert.doesNotMatch(api, /stopLanguageServer\(\);\s*setTimeout/);
  });
});

// ─── Process-level resilience (audit F) ─────────────────────────────────────
// src/index.js registers these handlers as a side effect of being imported, so
// they cannot be exercised without booting the server; text is the only surface.
describe('process-level resilience (audit F)', () => {
  const INDEX_JS = readSrc('src/index.js');

  test('registers global unhandledRejection / uncaughtException safety nets', () => {
    // F-1: the long-lived process must not die on a stray async rejection.
    assert.match(INDEX_JS, /process\.on\('unhandledRejection'/);
    assert.match(INDEX_JS, /process\.on\('uncaughtException'/);
    // uncaughtException should exit non-zero so the supervisor restarts clean.
    assert.match(INDEX_JS, /uncaughtException[\s\S]*?process\.exit\(1\)/);
  });

  test('SIGTERM shutdown awaits LS children exiting (no orphan-port race)', () => {
    // F-2: reuse stopLanguageServerAndWait so children release pool ports
    // before process.exit, instead of the fire-and-forget stopLanguageServer.
    // The callee itself is covered behaviourally above.
    assert.match(INDEX_JS, /stopLanguageServerAndWait\(\{ perProcessTimeoutMs: \d+ \}\)/);
    assert.match(INDEX_JS, /import \{[^}]*stopLanguageServerAndWait[^}]*\} from '\.\/langserver\.js'/);
  });
});
