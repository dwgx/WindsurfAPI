import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogDiff } from '../src/dashboard/catalog-diff.js';
import { buildModelReconciliation } from '../src/dashboard/model-reconcile.js';
import { getSnapshotSelectors } from '../src/devin-connect-models.js';

const resolve = (name) => {
  if (name === 'alias-a' || name === 'sel-a') return { selector: 'sel-a', mapped: true };
  if (name === 'alias-b') return { selector: 'sel-b', mapped: false };
  return { selector: name, mapped: false };
};

describe('dashboard catalog diff', () => {
  it('computes added and missing sets against the snapshot', () => {
    const diff = buildCatalogDiff({
      live: ['sel-a', { selector: 'sel-b' }, 'sel-c'],
      snapshot: ['sel-a', 'sel-b', 'sel-old'],
      resolve,
    });
    assert.equal(diff.liveCount, 3);
    assert.equal(diff.snapshotCount, 3);
    assert.equal(diff.synced, true);
    assert.deepEqual(diff.added, ['sel-c']);
    assert.deepEqual(diff.missing, ['sel-old']);
  });

  it('deduplicates selectors and aliases, and reports mapping', () => {
    const diff = buildCatalogDiff({
      live: [
        { selector: 'sel-a', alias: 'alias-a' },
        { selector: 'sel-a', alias: 'alias-a' },
        { selector: 'sel-b', alias: 'alias-b' },
      ],
      snapshot: [],
      resolve,
    });
    assert.equal(diff.liveCount, 2);
    assert.equal(diff.aliasCount, 2);
    assert.deepEqual(diff.aliases.map((a) => [a.alias, a.mapped]), [
      ['alias-a', true],
      ['alias-b', false],
    ]);
    assert.deepEqual(diff.unmapped, ['sel-b']);
  });

  it('ignores malformed rows and handles an empty live catalog', () => {
    const diff = buildCatalogDiff({
      live: [null, 42, '', { selector: '  ' }],
      snapshot: ['sel-a'],
      resolve,
    });
    assert.equal(diff.liveCount, 0);
    assert.equal(diff.synced, false);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.missing, []);
    assert.equal(diff.snapshotCount, 1);
    assert.equal(diff.aliasCount, 0);
    assert.equal(diff.unmappedCount, 0);
  });

  it('reconciles against the committed selector snapshot', () => {
    const out = buildModelReconciliation({
      local: [],
      live: [],
      snapshot: getSnapshotSelectors(),
      toggleable: [],
      fedModels: null,
      orgConfigs: null,
      upstreamCatalog: null,
      sources: {},
    });
    assert.equal(out.snapshotCount, getSnapshotSelectors().length);
    assert.equal(out.synced, false);
    assert.deepEqual(out.missing, []);
  });
});
