import { listModels } from '../models.js';
import { resolveConnectSelector, getLiveCatalog, __testing } from '../devin-connect-models.js';
import { getBackendSwitch } from '../runtime-config.js';

// GET /v1/models. On a DEVIN_CONNECT deployment (the production transport) only
// expose models that actually resolve to a real catalog selector — otherwise
// /v1/models advertises ~90 models the account can't reach (they'd 400 at chat).
// The MODELS table stays full for the Cascade transport; this is a per-transport
// view, not a catalog edit. Non-connect deployments see the full list unchanged.
export function handleModels(env = process.env) {
  let data = listModels();
  if (getBackendSwitch('devinConnect', env)) {
    // Existence = snapshot ∪ live (same source of truth as resolveConnectSelector,
    // audit 2026-07-12). Before this, the filter only consulted the frozen
    // CATALOG_SELECTORS snapshot, so live-synced selectors were dropped here even
    // though they run fine at /v1/chat/completions.
    const known = (selector) => __testing.CATALOG_SELECTORS.has(selector) || __testing._liveSelectors.has(selector);
    data = data.filter((m) => {
      const { selector, mapped } = resolveConnectSelector(m._windsurf_id);
      return mapped && known(selector);
    });
    // Synthesize entries for live-only selectors the upstream added AFTER the
    // frozen snapshot AND that aren't in the hardcoded MODELS table (gpt-5-6-*/
    // grok-4-5-*/nemotron etc.). Without this they run at chat but never appear
    // in /v1/models, so Codex/clients can't discover them. Keyed by the selector
    // itself; dedup against what listModels already emitted.
    const seen = new Set(data.map((m) => m.id));
    const ts = Math.floor(Date.now() / 1000);
    for (const row of getLiveCatalog()) {
      const id = row.selector;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      data.push({
        id,
        object: 'model',
        created: ts,
        owned_by: row.provider || 'windsurf',
        _windsurf_id: id,
        _source: 'live_catalog',
        ...(row.label ? { _label: row.label } : {}),
      });
    }
  }
  return { object: 'list', data };
}
