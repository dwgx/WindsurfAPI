import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelReconciliation, mapToggleableVersion } from '../src/dashboard/model-reconcile.js';
import {
  clearLiveCatalogSelectors,
  getSnapshotSelectors,
  setLiveCatalogSelectors,
} from '../src/devin-connect-models.js';

const TOGGLEABLE = [
  'devin-gpt-6-1-sol',
  'devin-gpt-6-sol',
  'devin-gpt-6-astra',
  'devin-fable-5-1',
  'devin-opus-5-5',
  'devin-swe-2-high',
  'devin-swe-2-max',
  'devin-swe-2-lightning-high',
  'devin-swe-2-lightning-max',
  'devin-2-5',
  'devin-auto',
  'devin-fast-opus',
  'devin_lite',
  'devin-ultra',
  'devin-swe-2-low',
  'devin-swe-2-priority-low',
  'devin-swe-2-priority-high',
  'devin-swe-2-priority-max',
  'devin-swe-2-lightning-low',
];

const MAPPED_SELECTORS = [
  'gpt-6-1-sol-medium',
  'gpt-6-sol-medium',
  'gpt-6-astra-medium',
  'claude-fable-5-1-medium',
  'claude-opus-5-5-medium',
  'swe-2-high',
  'swe-2-max',
  'swe-2-high-lightning',
  'swe-2-max-lightning',
];

function localRows(selectors) {
  return selectors.map((selector) => ({ id: selector, _windsurf_id: selector }));
}

function base(over = {}) {
  return {
    local: localRows(MAPPED_SELECTORS.slice(0, 8)), // omit swe-2-max-lightning
    live: [],
    snapshot: getSnapshotSelectors(),
    toggleable: TOGGLEABLE,
    fedModels: { tiers: {}, helpers: [], models: {}, allowlist: null },
    orgConfigs: {
      enterpriseTeamConfig: { teamId: 'team-test-value', allowMcpServers: true, maxUnclaimedSites: 5 },
      enterpriseControlConfig: { extensionModelLabels: ['Base Model', 'Claude 3.7 Sonnet'], teamId: 'team-test-value' },
    },
    upstreamCatalog: { groups: [], sections: [] },
    sources: {
      catalog: { ok: true, stale: false, fetchedAt: 1 },
      fed: { ok: true, stale: false, fetchedAt: 1 },
      toggleable: { ok: true, stale: false, fetchedAt: 1 },
      orgConfig: { ok: true, stale: false, fetchedAt: 1 },
    },
    now: 42,
    ...over,
  };
}

describe('mapToggleableVersion', () => {
  it('follows the deterministic mapping ladder', () => {
    assert.deepEqual(mapToggleableVersion('devin-gpt-6-1-sol'), { selector: 'gpt-6-1-sol-medium', mapped: true });
    assert.deepEqual(mapToggleableVersion('devin-fable-5-1'), { selector: 'claude-fable-5-1-medium', mapped: true });
    assert.deepEqual(mapToggleableVersion('devin-swe-2-lightning-high'), { selector: 'swe-2-high-lightning', mapped: true });
    assert.deepEqual(mapToggleableVersion('devin-2-5'), { selector: null, mapped: false });
    assert.deepEqual(mapToggleableVersion(''), { selector: null, mapped: false });
  });

  // The ladder is catalog-driven, not a hardcoded table: the same upstream
  // version maps or stays unmapped depending on what the live catalog exposes.
  // This is the difference between "we know this is swe-2-low" and "we guessed".
  it('maps the effort-reordered families only when the live catalog has them', () => {
    try {
      setLiveCatalogSelectors([
        'swe-2-low',
        'swe-2-low-priority',
        'swe-2-high-priority',
        'swe-2-low-lightning',
        'auto',
      ]);
      assert.deepEqual(mapToggleableVersion('devin-swe-2-low'), { selector: 'swe-2-low', mapped: true });
      assert.deepEqual(mapToggleableVersion('devin-swe-2-priority-low'),
        { selector: 'swe-2-low-priority', mapped: true },
        'upstream writes the effort tier last: <family>-<effort>-priority');
      assert.deepEqual(mapToggleableVersion('devin-swe-2-priority-high'),
        { selector: 'swe-2-high-priority', mapped: true });
      assert.deepEqual(mapToggleableVersion('devin-swe-2-lightning-low'),
        { selector: 'swe-2-low-lightning', mapped: true });
      assert.deepEqual(mapToggleableVersion('devin-auto'), { selector: 'auto', mapped: true },
        'a catalog that exposes `auto` is the only evidence that `auto` is callable');
      // Still unmapped: no token-preserving selector exists for these, so the row
      // must say so rather than point at a different model.
      assert.deepEqual(mapToggleableVersion('devin-2-5'), { selector: null, mapped: false });
      assert.deepEqual(mapToggleableVersion('devin-fast-opus'), { selector: null, mapped: false });
      assert.deepEqual(mapToggleableVersion('devin_lite'), { selector: null, mapped: false });
    } finally {
      clearLiveCatalogSelectors();
    }
  });

  it('keeps unmapped versions visible in the reconciliation rows', () => {
    try {
      setLiveCatalogSelectors(['swe-2-low']);
      const out = buildModelReconciliation(base({ live: ['swe-2-low'] }));
      const low = out.toggleable.rows.find((r) => r.version === 'devin-swe-2-low');
      assert.deepEqual(low, { version: 'devin-swe-2-low', selector: 'swe-2-low', mapped: true });
      const auto = out.toggleable.rows.find((r) => r.version === 'devin-auto');
      assert.deepEqual(auto, { version: 'devin-auto', selector: null, mapped: false },
        'an unmapped version still gets a row — hiding it is what makes a gap invisible');
      assert.equal(out.toggleable.unmappedCount, out.toggleable.total - out.toggleable.mappedCount);
    } finally {
      clearLiveCatalogSelectors();
    }
  });
});

describe('buildModelReconciliation', () => {
  it('reports the committed snapshot row count and an unsynced live catalog', () => {
    const out = buildModelReconciliation(base());
    assert.equal(out.snapshotCount, getSnapshotSelectors().length);
    assert.equal(out.liveCount, 0);
    assert.equal(out.synced, false);
    assert.deepEqual(out.added, []);
    assert.deepEqual(out.missing, [], 'an unsynced account must not report snapshot missing rows');
    assert.equal(out.upstreamCatalog.empty, true);
    assert.equal(out.upstreamCatalog.groupCount, 0);
    assert.equal(out.fedModels.present, false);
    assert.equal(out.fedModels.allowedLiveCount, null);
    assert.equal(out.fedModels.blockedLiveCount, null);
    assert.equal(out.fetchedAt, 42);
  });

  it('maps toggleable versions 9/19 and compares them with the local selectors', () => {
    const out = buildModelReconciliation(base());
    assert.equal(out.toggleable.total, 19);
    assert.equal(out.toggleable.mappedCount, 9);
    assert.equal(out.toggleable.unmappedCount, 10);
    assert.equal(out.toggleable.rows.length, 19);
    const sol = out.toggleable.rows.find((r) => r.version === 'devin-gpt-6-1-sol');
    assert.deepEqual(sol, { version: 'devin-gpt-6-1-sol', selector: 'gpt-6-1-sol-medium', mapped: true });
    const auto = out.toggleable.rows.find((r) => r.version === 'devin-2-5');
    assert.deepEqual(auto, { version: 'devin-2-5', selector: null, mapped: false });
    assert.equal(out.toggleable.localPresentCount, 8);
    assert.equal(out.toggleable.localMissingCount, 1);
    assert.equal(
      out.toggleable.localPresentCount + out.toggleable.localMissingCount,
      out.toggleable.mappedCount,
    );
  });

  it('counts unique local ids, not duplicate rows', () => {
    const out = buildModelReconciliation(base({
      local: [...localRows(['swe-2-high', 'swe-2-high']), { id: 'swe-2-high', _windsurf_id: 'swe-2-high' }],
    }));
    assert.equal(out.localCount, 1);
  });

  it('applies the fed-models overlay only when present', () => {
    const out = buildModelReconciliation(base({
      live: ['gpt-6-1-sol-medium', 'other-live-selector'],
      fedModels: {
        tiers: {},
        helpers: [],
        models: { 'gpt-6-1-sol-medium': {} },
        allowlist: ['gpt-6-1-sol-medium'],
      },
    }));
    assert.equal(out.synced, true);
    assert.equal(out.liveCount, 2);
    assert.equal(out.fedModels.present, true);
    assert.equal(out.fedModels.modelCount, 1);
    assert.equal(out.fedModels.allowlistPresent, true);
    assert.equal(out.fedModels.allowlistCount, 1);
    assert.equal(out.fedModels.allowedLiveCount, 1);
    assert.equal(out.fedModels.blockedLiveCount, 1);
    assert.deepEqual(out.added, ['other-live-selector']);
  });

  it('reports the snapshot difference when synced', () => {
    const out = buildModelReconciliation(base({
      live: ['gpt-6-1-sol-medium'],
      snapshot: ['gpt-6-1-sol-medium', 'snapshot-only-selector'],
    }));
    assert.equal(out.synced, true);
    assert.deepEqual(out.missing, ['snapshot-only-selector']);
    assert.equal(out.snapshotCount, 2);
  });

  it('redacts teamId and caps extension model labels', () => {
    const labels = Array.from({ length: 25 }, (_, i) => `label-${i}`);
    labels[0] = 'L'.repeat(200);
    const out = buildModelReconciliation(base({
      orgConfigs: {
        enterpriseTeamConfig: { teamId: 'team-test-value' },
        enterpriseControlConfig: { extensionModelLabels: labels, teamId: 'team-test-value' },
      },
    }));
    assert.equal(out.orgConfig.teamIdPresent, true);
    assert.equal(JSON.stringify(out).includes('team-test-value'), false);
    assert.equal(out.orgConfig.extensionModelLabels.length, 20);
    assert.equal(out.orgConfig.extensionModelLabels[0].length, 80);
  });

  it('degrades per source without failing the card', () => {
    const out = buildModelReconciliation(base({
      sources: {
        catalog: { ok: false, error: 'forbidden', status: 403 },
        fed: { ok: true, stale: false, fetchedAt: 1 },
        toggleable: { ok: false, error: 'timeout' },
        orgConfig: { ok: true, stale: false, fetchedAt: 1 },
      },
    }));
    assert.equal(out.partial, true);
    assert.deepEqual(out.degraded.map((d) => [d.source, d.kind]), [['catalog', 'forbidden'], ['toggleable', 'timeout']]);
    assert.equal(out.snapshotCount, getSnapshotSelectors().length);
  });

  it('caps toggleable rows at 50 while counting all of them', () => {
    const many = Array.from({ length: 60 }, (_, i) => `devin-version-${i}`);
    const out = buildModelReconciliation(base({ toggleable: many }));
    assert.equal(out.toggleable.total, 60);
    assert.equal(out.toggleable.rows.length, 50);
  });
});
