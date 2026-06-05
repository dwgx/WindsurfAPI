import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectMemoryLimitBytes,
  detectMemoryCurrentBytes,
  detectHostMemAvailableBytes,
  estimateDefaultMaxLsInstances,
  classifyLanguageServerStderr,
  getLsStatus,
  sweepIdleLanguageServers,
} from '../src/langserver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_JS = readFileSync(join(__dirname, '..', 'src/auth.js'), 'utf8');

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
    assert.equal(typeof status.systemMemoryBytes, 'number');
    assert.equal(typeof status.detectedMemoryLimitBytes, 'number');
    assert.equal(typeof status.memoryGuard, 'object');
    assert.equal(typeof status.memoryGuard.minAvailableBytes, 'number');
    assert.ok(Array.isArray(status.instances));
  });

  test('idle sweep is a no-op on an empty pool and returns telemetry', () => {
    const result = sweepIdleLanguageServers(Date.now());
    assert.deepEqual(Object.keys(result).sort(), ['scanned', 'stopped', 'ttlMs']);
    assert.equal(result.scanned, 0);
    assert.equal(result.stopped, 0);
  });

  test('startup proxy prewarm is opt-in', () => {
    assert.match(AUTH_JS, /uniqueProxies\.set\('default', null\)/);
    assert.match(AUTH_JS, /process\.env\.LS_PREWARM_PROXIES === '1'/);
  });

  test('dashboard account-add LS warmup is opt-in', () => {
    const src = readFileSync(join(__dirname, '..', 'src/dashboard/api.js'), 'utf8');
    assert.match(src, /LS_PREWARM_ON_ACCOUNT_ADD === '1'/);
    assert.match(src, /function scheduleAccountWarmup/);
  });

  test('scheduled probes only reuse resident or pending LS instances', () => {
    assert.match(AUTH_JS, /const admission = getLsAdmissionForAccount\(a\.id\)/);
    assert.match(AUTH_JS, /!admission\.ok \|\| admission\.wouldStart/);
    assert.match(AUTH_JS, /Scheduled probe .*wouldStart=/);
  });

  test('predictive prewarm is admission-gated and reports structured failures', () => {
    assert.match(AUTH_JS, /const admission = getLsAdmissionForAccount\(nextAccount\.id\)/);
    assert.match(AUTH_JS, /!admission\.ok \|\| admission\.wouldStart/);
    assert.match(AUTH_JS, /ensureLsForAccount\(nextAccount\.id\)\)\.then\(r =>/);
    assert.match(AUTH_JS, /r\?\.errorType \|\| 'ls_start_failed'/);
  });
});
