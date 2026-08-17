import { listModels } from '../models.js';
import {
  resolveConnectSelector, getLiveCatalog, FREE_REACHABLE_SELECTORS,
} from '../devin-connect-models.js';
import { getBackendSwitch } from '../runtime-config.js';
import { hasConnectEntitledAccount, getAccountCount } from '../auth.js';

// GET /v1/models. On a DEVIN_CONNECT deployment (the production transport) only
// expose models that actually resolve to a real catalog selector — otherwise
// /v1/models advertises ~90 models the account can't reach (they'd 400 at chat).
// The MODELS table stays full for the Cascade transport; this is a per-transport
// view, not a catalog edit. Non-connect deployments see the full list unchanged.
/**
 * Should /v1/models skip the per-account entitlement filter entirely?
 *
 * Mirrors the chat path's exemption (handlers/chat.js, the
 * `hasEnvToken && !hasConnectEntitledAccount` guard) on purpose: chat exempts a
 * deployment whose token comes from the environment WITHOUT looking at pool size,
 * so discovery has to do the same. A token+free-account mixed deployment would
 * otherwise advertise zero rows while chat happily serves paid selectors.
 *
 * The empty-pool arm is separate and required: hasConnectEntitledAccount returns
 * false on an empty pool (Array.some over nothing), so filtering a pool-less
 * deployment would strip every row rather than fail open.
 */
function shouldSkipEntitlementFilter(env, accountCount) {
  const hasEnvToken = !!(env.DEVIN_CONNECT_TOKEN || env.WINDSURF_API_KEY);
  return hasEnvToken || accountCount === 0;
}

/**
 * Build the "can this deployment actually serve that model id" predicate.
 *
 * Exported because the Dashboard needs the SAME answer and must not re-derive it.
 * Before this existed, `/v1/models` resolved through the Connect namespace while the
 * Dashboard's model panel resolved through the Cascade one, and on a free-only
 * DEVIN_CONNECT pool the two views had **zero overlap**: the panel listed 163 models the
 * account could not call and omitted `swe-1-6-slow`, the only one it could (#234's
 * remaining acceptance criterion). Two callers deriving one rule from two namespaces is
 * this repo's most frequent defect shape — six occurrences on record — so there is one
 * rule and both sides call it.
 *
 * Returns a `{ reachable, selector }` mapper. When devinConnect is off, everything in the
 * Cascade table is reachable by definition and `selector` is null: the Connect namespace
 * simply does not apply to that transport.
 *
 * @param {object} [env] environment used for transport selection (must be the SAME
 *   effective env the caller routes with — passing process.env while serving a
 *   per-request env is how these two views diverged in the first place)
 */
export function buildConnectReachability(env = process.env) {
  const effectiveEnv = env === process.env ? env : { ...process.env, ...env };
  if (!getBackendSwitch('devinConnect', effectiveEnv)) {
    return () => ({ reachable: true, selector: null });
  }
  const skipEntitlement = shouldSkipEntitlementFilter(effectiveEnv, getAccountCount().total);
  const entitled = (selector) => skipEntitlement || hasConnectEntitledAccount(selector);
  // Do not short-circuit on the RESOLVED free selector. With STRICT_MODEL=0 an
  // unmapped paid name resolves to `swe-1-6-slow` with mapped:false; treating the
  // selector alone as reachable would re-advertise every unsupported paid name.
  // The real free floor is synthesized by both callers after this predicate runs.
  return (windsurfId) => {
    // Discovery probes every MODELS row, including intentionally unsupported
    // Cascade-only names. They are not paid requests and must not consume the
    // resolver's one-time downgrade warning; a later real chat request still will.
    const { selector, mapped } = resolveConnectSelector(windsurfId, { warnOnFallback: false });
    return {
      // resolveConnectSelector already validates aliases and direct selectors
      // against the authoritative catalog. Keep entitlement as the second,
      // independent gate; re-checking existence here would duplicate policy.
      reachable: !!(mapped && entitled(selector)),
      selector: mapped ? selector : null,
    };
  };
}

export function handleModels(env = process.env) {
  const effectiveEnv = env === process.env ? env : { ...process.env, ...env };
  // listModels receives the same effective environment used for transport
  // selection so a DEVIN_CONNECT request is never pre-filtered by the
  // unrelated Cascade cloud catalog.
  let data = listModels({ env: effectiveEnv });
  if (getBackendSwitch('devinConnect', effectiveEnv)) {
    const liveCatalog = getLiveCatalog();
    const imageCapabilityBySelector = new Map(
      liveCatalog
        .filter((row) => typeof row?.selector === 'string' && typeof row?.supportsImages === 'boolean')
        .map((row) => [row.selector, row.supportsImages]),
    );
    // Row producer #1: the MODELS table, filtered to what this deployment can serve.
    //
    // The rule (existence = authoritative live catalog, with snapshot as cold-start
    // fallback, plus per-account entitlement and the FREE_REACHABLE floor) now lives in
    // buildConnectReachability because the Dashboard needs the identical answer. Existence
    // alone used to be the only test here, so a
    // free-only pool advertised every paid selector the upstream publishes and the client
    // got a 403 at chat (#234 / #231 in the connect namespace). #232 fixed that for the
    // Cascade namespace, but its filters early-return unfiltered when devinConnect is on
    // (models.js isModelAllowedByCloudCatalog / filterModelKeysByCloudCatalog), which is
    // correct as a namespace boundary and is why the check has to be redone here.
    const isReachable = buildConnectReachability(effectiveEnv);
    // Discovery is a selector catalog, not an alias catalog. Several public names can
    // resolve to the same upstream selector (for example `claude-opus-4.6` and
    // `claude-opus-4-6`). Keep the first stable client-facing name and suppress the
    // rest, otherwise one entitled upstream model appears two or three times.
    const representedSelectors = new Set();
    data = data.flatMap((m) => {
      const reachability = isReachable(m._windsurf_id);
      if (!reachability.reachable || representedSelectors.has(reachability.selector)) return [];
      representedSelectors.add(reachability.selector);
      const supportsImages = imageCapabilityBySelector.get(reachability.selector);
      return [typeof supportsImages === 'boolean' ? { ...m, supports_images: supportsImages } : m];
    });
    // Producers #2 and #3 below are keyed by SELECTOR, not by a MODELS id, so they cannot
    // go through isReachable — it resolves its argument through resolveConnectSelector.
    // They keep the entitlement check directly.
    const skipEntitlement = shouldSkipEntitlementFilter(effectiveEnv, getAccountCount().total);
    const entitled = (selector) => skipEntitlement || hasConnectEntitledAccount(selector);
    // Synthesize entries for live-only selectors the upstream added AFTER the
    // frozen snapshot AND that aren't in the hardcoded MODELS table (gpt-5-6-*/
    // grok-4-5-*/nemotron etc.). Without this they run at chat but never appear
    // in /v1/models, so Codex/clients can't discover them. Keyed by the selector
    // itself; dedup against what listModels already emitted.
    const seen = new Set(data.map((m) => m.id));
    const ts = Math.floor(Date.now() / 1000);
    // SECOND row producer. The entitlement filter above only governs rows that
    // came from listModels; this loop synthesizes its own, so filtering just the
    // first one left a free-only pool still advertising every live-only paid
    // selector (measured: 86 rows survived a filter applied to producer #1 alone).
    for (const row of liveCatalog) {
      const id = row.selector;
      if (!id || seen.has(id) || representedSelectors.has(id)) continue;
      if (!entitled(id)) continue;
      seen.add(id);
      representedSelectors.add(id);
      data.push({
        id,
        object: 'model',
        created: ts,
        owned_by: row.provider || 'windsurf',
        _windsurf_id: id,
        _source: 'live_catalog',
        ...(row.label ? { _label: row.label } : {}),
        ...(typeof row.supportsImages === 'boolean' ? { supports_images: row.supportsImages } : {}),
      });
    }
    // THIRD producer — the rebuild, not a filter.
    //
    // Entitlement filtering alone takes a free-only pool to ZERO rows, and zero
    // rows is worse than the over-advertising it fixes: Codex and Cline refuse to
    // start against an empty model list, so the proxy goes from "lists models that
    // 403" to "unusable". Measured: 56 advertised / 0 reachable before, 0 rows after
    // filtering.
    //
    // The gap exists because the free-reachable selector is in NEITHER row source —
    // `swe-1-6-slow` is absent from the frozen snapshot, absent from all 105 live
    // catalog rows, and has no MODELS entry — yet chat routes it fine and
    // FREE_REACHABLE_SELECTORS declares it callable by any account. So discovery has
    // to synthesize it rather than find it.
    //
    // This is a floor, not a widening: every selector added here is one that
    // isConnectSelectorAllowedForAccount already admits for ANY account, so it can
    // never advertise something the pool cannot run.
    for (const selector of FREE_REACHABLE_SELECTORS) {
      if (seen.has(selector)) continue;
      seen.add(selector);
      data.push({
        id: selector,
        object: 'model',
        created: ts,
        owned_by: 'windsurf',
        _windsurf_id: selector,
        _source: 'free_reachable',
      });
    }
  }
  return { object: 'list', data };
}
