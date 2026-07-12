// audit 2026-07-12 (v3.2.4 regression fix): after v3.2.3 made resolveConnectSelector
// recognize live-synced selectors (snapshot ∪ live), the /v1/models handler still
// filtered against the frozen CATALOG_SELECTORS snapshot ONLY, and the 37 upstream-
// added selectors (gpt-5-6-*/grok-4-5-*/nemotron) aren't in the hardcoded MODELS
// table either — so they ran fine at /v1/chat/completions but were absent from
// /v1/models, leaving Codex/clients unable to discover them. handleModels now
// (a) filters on snapshot ∪ live and (b) synthesizes entries for live-only selectors.
//
// NOTE: handleModels imports devin-connect-models via a plain (cached) import, so
// these tests use the SAME cached singleton (no ?fresh= — that would give the
// handler a different instance than the one we seed). The live catalog is additive
// and cleared per test via setLiveCatalogSelectors, so cross-test leakage is bounded.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setLiveCatalogSelectors } from '../src/devin-connect-models.js';
import { handleModels } from '../src/handlers/models.js';

const ENV_ON = { DEVIN_CONNECT: '1' };

describe('/v1/models — live-catalog synthesis (audit v3.2.4)', () => {
  it('lists a live-only selector that is NOT in the MODELS table nor the snapshot', () => {
    // grok-4-5-medium: proven live-catalog-only 2026-07-12 (runs at chat, absent
    // from the 130-model MODELS table and the 105-model snapshot).
    setLiveCatalogSelectors([
      { selector: 'grok-4-5-medium', provider: 'xai', label: 'Grok 4.5 (medium)' },
      { selector: 'gpt-5-6-sol-medium', provider: 'openai', label: 'GPT-5.6 Sol (medium)' },
    ]);
    const { data } = handleModels(ENV_ON);
    const ids = new Set(data.map((m) => m.id));
    assert.ok(ids.has('grok-4-5-medium'), 'grok-4-5-medium must appear in /v1/models');
    assert.ok(ids.has('gpt-5-6-sol-medium'), 'gpt-5-6-sol-medium must appear in /v1/models');
    const grok = data.find((m) => m.id === 'grok-4-5-medium');
    assert.equal(grok.object, 'model');
    assert.equal(grok.owned_by, 'xai');
    assert.equal(grok._source, 'live_catalog');
  });

  it('does NOT duplicate a selector already emitted by the MODELS table', () => {
    setLiveCatalogSelectors([{ selector: 'swe-1-6-slow', provider: 'windsurf' }]);
    const { data } = handleModels(ENV_ON);
    const count = data.filter((m) => m.id === 'swe-1-6-slow').length;
    assert.ok(count <= 1, `swe-1-6-slow must not be duplicated (got ${count})`);
  });

  it('non-DEVIN_CONNECT deployment returns the full list without live synthesis', () => {
    setLiveCatalogSelectors([{ selector: 'grok-4-5-medium', provider: 'xai' }]);
    const { data } = handleModels({}); // devinConnect off
    assert.equal(data.some((m) => m._source === 'live_catalog'), false);
  });
});
