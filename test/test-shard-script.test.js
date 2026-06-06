import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, selectShard } from '../scripts/run-test-shard.mjs';

describe('test shard runner', () => {
  it('selects deterministic modulo shards', () => {
    const files = ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js', 'e.test.js'];
    assert.deepEqual(selectShard(files, 0, 2), ['a.test.js', 'c.test.js', 'e.test.js']);
    assert.deepEqual(selectShard(files, 1, 2), ['b.test.js', 'd.test.js']);
  });

  it('validates shard arguments and timeout', () => {
    assert.deepEqual(parseArgs(['1', '4', '--timeout-ms=120000']), {
      shardIndex: 1,
      shardTotal: 4,
      timeoutMs: 120000,
    });
    assert.throws(() => parseArgs(['4', '4']), /smaller than shard total/);
    assert.throws(() => parseArgs(['0', '0']), /Invalid shard total/);
    assert.throws(() => parseArgs(['0', '1', '--timeout-ms=1']), /Invalid per-file timeout/);
  });
});
