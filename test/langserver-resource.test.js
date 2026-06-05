import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectMemoryLimitBytes,
  estimateDefaultMaxLsInstances,
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

  test('status exposes resource guard configuration even before LS starts', () => {
    const status = getLsStatus();
    assert.equal(typeof status.maxInstances, 'number');
    assert.ok(status.maxInstances >= 1);
    assert.equal(typeof status.idleTtlMs, 'number');
    assert.equal(typeof status.idleSweepMs, 'number');
    assert.equal(status.estimatedRssBytesPerInstance, 700 * 1024 * 1024);
    assert.equal(typeof status.systemMemoryBytes, 'number');
    assert.equal(typeof status.detectedMemoryLimitBytes, 'number');
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
});
