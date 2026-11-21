import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnectSelector, FREE_TIER_SELECTOR } from '../src/devin-connect-models.js';

const SAVED_CONNECT_TOKEN = process.env.DEVIN_CONNECT_TOKEN;
const SAVED_WINDSURF_API_KEY = process.env.WINDSURF_API_KEY;

beforeEach(() => {
  delete process.env.DEVIN_CONNECT_TOKEN;
  delete process.env.WINDSURF_API_KEY;
});

afterEach(() => {
  if (SAVED_CONNECT_TOKEN === undefined) delete process.env.DEVIN_CONNECT_TOKEN;
  else process.env.DEVIN_CONNECT_TOKEN = SAVED_CONNECT_TOKEN;
  if (SAVED_WINDSURF_API_KEY === undefined) delete process.env.WINDSURF_API_KEY;
  else process.env.WINDSURF_API_KEY = SAVED_WINDSURF_API_KEY;
});

describe('resolveConnectSelector', () => {
  it('resolves the free-tier swe selector (dash and dot forms)', () => {
    assert.deepEqual(resolveConnectSelector('swe-1-6-slow'), { selector: 'swe-1-6-slow', mapped: true });
    assert.deepEqual(resolveConnectSelector('swe-1.6-slow'), { selector: 'swe-1-6-slow', mapped: true });
  });

  it('maps swe-2 _lookup aliases onto catalog selectors', () => {
    // Same names models.js _lookup accepts. Without these SELECTOR_MAP rows,
    // DEVIN_CONNECT=1 + STRICT_MODEL=1 400s them even though resolveModel succeeds.
    const cases = [
      ['swe-2', 'swe-2-medium'],
      ['swe-2.0', 'swe-2-medium'],
      ['swe-2-0', 'swe-2-medium'],
      ['swe2', 'swe-2-medium'],
      ['swe-2-medium', 'swe-2-medium'],
      ['swe-2-high', 'swe-2-high'],
      ['swe-2-max', 'swe-2-max'],
      ['swe-2.0-medium', 'swe-2-medium'],
      ['swe-2.0-high', 'swe-2-high'],
      ['swe-2.0-max', 'swe-2-max'],
    ];
    for (const [name, selector] of cases) {
      assert.deepEqual(resolveConnectSelector(name), { selector, mapped: true }, name);
    }
  });

  it('maps the dashed swe-2.0 effort spellings onto their swe-2 tiers', () => {
    // Live-catalog probe (2026-10-25): `swe-2-0-medium` / `swe-2-0-high` /
    // `swe-2-0-max` were the ONLY swe-2 spellings missing from SELECTOR_MAP —
    // they resolved to {selector:null, mapped:false} against a live catalog and
    // to the swe-1-6-slow degrade target against the frozen snapshot, while the
    // unsuffixed `swe-2-0` row and the dotted `swe-2.0-{medium,high,max}` rows
    // worked. Same model family, four spellings, one of them silently free-tier.
    // Targets are verified present in src/data/devin-catalog-snapshot.json.
    const cases = [
      ['swe-2-0-medium', 'swe-2-medium'],
      ['swe-2-0-high', 'swe-2-high'],
      ['swe-2-0-max', 'swe-2-max'],
    ];
    for (const [name, selector] of cases) {
      assert.deepEqual(resolveConnectSelector(name), { selector, mapped: true }, name);
    }
  });

  it('maps the compact gpt5-6-luna spelling (no dash after gpt)', () => {
    // Issue #244 carried `gpt5.6-luna`, which the map covers; the sibling
    // compact-dash spelling `gpt5-6-luna` was not covered and missed every
    // lookup, so a client asking for Luna got the free-tier degrade. The target
    // (gpt-5-6-luna-medium) is a real snapshot selector; keep all four
    // spellings in lockstep, the same way the gpt-5.5 family is kept.
    const cases = [
      ['gpt-5.6-luna', 'gpt-5-6-luna-medium'],
      ['gpt-5-6-luna', 'gpt-5-6-luna-medium'],
      ['gpt5.6-luna', 'gpt-5-6-luna-medium'],
      ['gpt5-6-luna', 'gpt-5-6-luna-medium'],
    ];
    for (const [name, selector] of cases) {
      assert.deepEqual(resolveConnectSelector(name), { selector, mapped: true }, name);
    }
  });

  it('maps claude friendly names to their captured upstream selectors', () => {
    assert.equal(resolveConnectSelector('claude-opus-4.8').selector, 'claude-opus-4-8-medium');
    // Dashed bare form is a real catalog selector (base model) → resolves to itself;
    // the dotted family alias keeps the curated -thinking default. Both are MAPPED:
    // O1 (evidence/ClientSandboxes.md §5.3) is this alias working as designed, so the
    // escape hatch is the explicit dashed spelling, not an alias change.
    assert.deepEqual(resolveConnectSelector('claude-sonnet-4-6'),
      { selector: 'claude-sonnet-4-6', mapped: true });
    assert.deepEqual(resolveConnectSelector('claude-sonnet-4.6'),
      { selector: 'claude-sonnet-4-6-thinking', mapped: true });
    // Retired upstream spellings (dropped from the live 306-model catalog) now
    // fail closed — never silently remapped to a different generation.
    assert.deepEqual(resolveConnectSelector('claude-sonnet-4.5'),
      { selector: FREE_TIER_SELECTOR, mapped: false });
    assert.deepEqual(resolveConnectSelector('claude-haiku-4-5'),
      { selector: FREE_TIER_SELECTOR, mapped: false });
  });

  it('keeps the base sonnet model reachable under its explicit spelling (O1)', () => {
    // O1 (evidence/ClientSandboxes.md §5.3): omp asked for the dotted alias and got
    // the thinking variant — that is the documented SELECTOR_MAP default, NOT a bug.
    // The base (non-thinking) model is a real catalog selector, so the escape hatch
    // must keep working: an explicit dashed spelling resolves to itself, mapped:true,
    // and is a DIFFERENT upstream selector from the dotted alias.
    const base = resolveConnectSelector('claude-sonnet-4-6');
    const dotted = resolveConnectSelector('claude-sonnet-4.6');
    assert.deepEqual(base, { selector: 'claude-sonnet-4-6', mapped: true });
    assert.deepEqual(dotted, { selector: 'claude-sonnet-4-6-thinking', mapped: true });
    assert.notEqual(base.selector, dotted.selector,
      'the two spellings intentionally select different variants');
  });

  it('maps gpt and gemini families', () => {
    assert.equal(resolveConnectSelector('gpt-5-4-high').selector, 'gpt-5-4-high');
    assert.equal(resolveConnectSelector('gemini-3-5-flash').selector, 'gemini-3-5-flash-medium');
  });

  it('is case-insensitive and strips a provider prefix', () => {
    assert.equal(resolveConnectSelector('Claude-Opus-4.8').selector, 'claude-opus-4-8-medium');
    assert.equal(resolveConnectSelector('anthropic/claude-sonnet-4-6').selector, 'claude-sonnet-4-6');
  });

  it('strips a hyphenated provider prefix (x-ai/, z-ai/) like a plain one', () => {
    // S3 (alias matrix 2026-10-25): the strip rule was `/^[a-z]+\//`, which cannot
    // match a hyphenated provider segment. Every `x-ai/...` spelling therefore
    // missed every lookup and resolved to {selector:null, mapped:false} on a live
    // catalog — a 400 model_not_found for a model the account can run — while
    // `xai/…` and `openai/…` resolved. 313 probed rows across 48 families.
    assert.deepEqual(resolveConnectSelector('x-ai/grok-4-6-low'),
      { selector: 'grok-4-6-low', mapped: true });
    assert.deepEqual(resolveConnectSelector('z-ai/glm-5.1'),
      { selector: 'glm-5-2', mapped: true });
    // Control: a plain prefix keeps working, and the strip stays SINGLE — in
    // `x/y/glm-5.1` the second segment is part of the name, not another provider.
    assert.deepEqual(resolveConnectSelector('xai/grok-4-6'),
      { selector: 'grok-4-6-medium', mapped: true });
    assert.deepEqual(resolveConnectSelector('x/y/glm-5.1'),
      { selector: FREE_TIER_SELECTOR, mapped: false });
  });

  it('resolves compact gpt5.x / gemini3.x spellings through the version separator', () => {
    // S4: only `gpt5.6-luna` carried a compact row (#244); every sibling shape
    // resolved to nothing. The class is normalized rather than row-by-row,
    // because v3.2.5 makes the map the ONLY alias entry point and speculative
    // rows are forbidden.
    assert.deepEqual(resolveConnectSelector('gpt5.5'), { selector: 'gpt-5-5-low', mapped: true });
    assert.deepEqual(resolveConnectSelector('gemini3.5-flash'),
      { selector: 'gemini-3-5-flash-medium', mapped: true });
    assert.deepEqual(resolveConnectSelector('gpt5.4'), { selector: 'gpt-5-4-medium', mapped: true });
    assert.deepEqual(resolveConnectSelector('gpt5.4-mini'),
      { selector: 'gpt-5-4-mini-medium', mapped: true });
    // Already-mapped compact spellings keep their target.
    assert.deepEqual(resolveConnectSelector('gpt5.6-luna'),
      { selector: 'gpt-5-6-luna-medium', mapped: true });
    assert.deepEqual(resolveConnectSelector('gpt5-6-luna'),
      { selector: 'gpt-5-6-luna-medium', mapped: true });
    // `claude5` is a FAMILY shorthand, not a compact version. Splitting it would
    // produce the nonexistent `claude-5` and silently degrade an alias that works
    // today, so the normalization requires the `.` after the major digit.
    assert.deepEqual(resolveConnectSelector('claude5'),
      { selector: 'claude-sonnet-5-medium', mapped: true });
    // Case-insensitively too: the exact lowercase key is shielded by the raw map
    // lookup, so only the uppercased spelling exercises the normalization step.
    // A rule without the `.` rewrites `Claude5` into `claude-5` and degrades it.
    assert.deepEqual(resolveConnectSelector('Claude5'),
      { selector: 'claude-sonnet-5-medium', mapped: true });
  });

  it('resolves enum selectors regardless of case or a provider prefix', () => {
    // S5: the enum passthrough tested `/^MODEL_[A-Z0-9_]+$/` against the RAW name
    // while the normalized fallthrough lowercases — so a lowercased or prefixed
    // enum matched neither path (96 probed rows). The existence check is what
    // keeps a bogus MODEL_* from being written raw to #21.
    // The live 306-model catalog carries no MODEL_* enum spellings, so enum
    // names now fail closed through the existence check — the exact property
    // this test exists to pin (no bogus MODEL_* written raw to #21).
    assert.deepEqual(resolveConnectSelector('openai/MODEL_GPT_5_2_LOW'),
      { selector: FREE_TIER_SELECTOR, mapped: false });
    assert.deepEqual(resolveConnectSelector('model_gpt_5_2_low'),
      { selector: FREE_TIER_SELECTOR, mapped: false });
    assert.deepEqual(resolveConnectSelector('MODEL_GPT_5_2_LOW'),
      { selector: FREE_TIER_SELECTOR, mapped: false });
    // An unknown enum still fails closed: it is never passed through raw.
    assert.deepEqual(resolveConnectSelector('openai/model_gpt_9_9_ultra'),
      { selector: FREE_TIER_SELECTOR, mapped: false });
  });

  it('resolves the live bare grok family names to their -medium tier', () => {
    // Family residue from the alias matrix: these two bare names 400'd because the
    // catalog exposes only tier selectors and the map had no row — while the
    // sibling families grok-4-6 / grok-4-7 carry exactly such a row. The bare
    // family alias defaulting to -medium is the map's existing convention
    // (claude-fable-5-1, deepseek-v4-flash, gemini-3-7-flash, ...). Targets are
    // real snapshot selectors.
    assert.deepEqual(resolveConnectSelector('grok-4-6'),
      { selector: 'grok-4-6-medium', mapped: true });
    // grok-4-5 and inkling left the live catalog in the 306-model refresh —
    // their bare names now fail closed rather than silently rerouting.
    assert.deepEqual(resolveConnectSelector('grok-4-5'),
      { selector: FREE_TIER_SELECTOR, mapped: false });
    assert.deepEqual(resolveConnectSelector('inkling'),
      { selector: FREE_TIER_SELECTOR, mapped: false });
  });

  it('pins the known prefix asymmetry for a dotted family alias (P2-1)', () => {
    // KNOWN ASYMMETRY, pinned deliberately. The alias map is consulted on the RAW
    // name before any normalization, so a dotted MAP KEY can carry a curated
    // target its prefixed spelling never reaches — the prefix then changes which
    // upstream model runs. `claude-sonnet-4.6` is such a key (curated -thinking);
    // `anthropic/claude-sonnet-4.6` misses the raw lookup, normalizes to
    // `claude-sonnet-4-6` (the base catalog selector), and runs the base model.
    // The dialect comment therefore must not claim "the prefix never changes the
    // model". Fixing the asymmetry is out of scope here; this test makes any
    // drift in either direction a deliberate change.
    assert.equal(resolveConnectSelector('claude-sonnet-4.6').selector,
      'claude-sonnet-4-6-thinking');
    assert.equal(resolveConnectSelector('anthropic/claude-sonnet-4.6').selector,
      'claude-sonnet-4-6');
  });

  it('enum-form selectors fail closed once the catalog drops them', () => {
    // The 306-model catalog has no MODEL_* spellings: the existence check
    // rejects them rather than writing a stale enum raw to upstream #21.
    assert.deepEqual(resolveConnectSelector('MODEL_CLAUDE_4_5_OPUS_THINKING'),
      { selector: FREE_TIER_SELECTOR, mapped: false });
  });

  it('degrades unknown names to the free-tier selector (mapped:false)', () => {
    assert.deepEqual(resolveConnectSelector('gpt-9-ultra'), { selector: FREE_TIER_SELECTOR, mapped: false });
    assert.deepEqual(resolveConnectSelector(''), { selector: FREE_TIER_SELECTOR, mapped: false });
    assert.deepEqual(resolveConnectSelector(null), { selector: FREE_TIER_SELECTOR, mapped: false });
  });

  it('resolves a dotted dash-form that normalizes to a real catalog selector', () => {
    // Regression: "gpt-5.5-medium" → norm "gpt-5-5-medium" IS a catalog selector
    // but not a SELECTOR_MAP alias. Before the norm→catalog check it silently
    // degraded to the free tier (mapped:false); it must now resolve mapped:true.
    const r = resolveConnectSelector('gpt-5.5-medium');
    assert.equal(r.selector, 'gpt-5-5-medium');
    assert.equal(r.mapped, true);
  });
});

describe('resolveConnectSelector — live catalog (audit 2026-07-12 snapshot staleness)', () => {
  // The committed snapshot never live-synced, so selectors the upstream added
  // after it was captured (proven on a live account 2026-07-12: qwen-3, glm-5,
  // kimi-k2.5, deepseek-v3, minimax-*) were absent from CATALOG_SELECTORS and
  // got mapped:false → 400'd by the strict gate despite being runnable. The live
  // catalog set (populated from GetCliModelConfigs) becomes authoritative after
  // every active contributor has a successful sync; the snapshot remains the
  // cold-start and partial-sync fallback.
  const STALE = ['qwen-3', 'glm-5', 'kimi-k2.5', 'deepseek-v3'];

  it('cold start (no live sync): a genuinely-runnable-but-unsnapshotted selector is mapped:false', async () => {
    // Fresh import so _liveSelectors starts empty (module-level Set).
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-a`);
    assert.equal(m.hasLiveCatalog(), false, 'no live sync yet');
    // qwen-3 is not in the frozen snapshot → without live catalog it degrades.
    assert.equal(m.resolveConnectSelector('qwen-3').mapped, false);
  });

  it('after live sync: the same selectors resolve mapped:true to themselves', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-b`);
    // Simulate a GetCliModelConfigs sync feeding the decoded catalog shape.
    m.setLiveCatalogSelectors(STALE.map(s => ({ selector: s })));
    assert.equal(m.hasLiveCatalog(), true);
    for (const s of STALE) {
      const r = m.resolveConnectSelector(s);
      assert.equal(r.mapped, true, `${s} must be recognized after live sync`);
      assert.equal(r.selector, s, `${s} resolves to itself`);
    }
  });

  it('live sync recognizes the canonical selector but does NOT pass a family alias through raw (ultracode fix 2026-07-12)', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-c`);
    // Real regression shape: <family>-medium is the upstream-accepted selector;
    // the bare family name is its alias and is NOT in the hand-maintained
    // SELECTOR_MAP. (Use a future family so this guard stays valid as the map
    // grows; gpt-5.6-sol is mapped now.)
    m.setLiveCatalogSelectors([{ selector: 'gpt-7-future-medium', alias: 'gpt-7-future' }]);
    // The canonical full selector IS recognized from the live catalog.
    assert.equal(m.resolveConnectSelector('gpt-7-future-medium').mapped, true);
    // The family alias must NOT resolve mapped:true off the live set — folding it
    // in made the gateway pass the bare family form to upstream #21 → UPSTREAM_INTERNAL
    // (burns the account). Aliases are the SELECTOR_MAP's job; an unknown one fails
    // closed (degrades to free / 400 under strict), it does NOT pass through raw.
    const r = m.resolveConnectSelector('gpt-7-future');
    assert.equal(r.mapped, false, 'family alias not in SELECTOR_MAP must NOT be treated as a runnable selector');
    assert.notEqual(r.selector, 'gpt-7-future', 'must never emit the bare family alias as the upstream selector');
  });

  it('a known SELECTOR_MAP alias still resolves correctly (regression guard)', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-c2`);
    m.setLiveCatalogSelectors([{ selector: 'glm-5-2', alias: 'glm-5.2' }]);
    // glm-5.2 is in the hand-maintained SELECTOR_MAP → still resolves to glm-5-2,
    // independent of the (now removed) alias fold.
    assert.equal(m.resolveConnectSelector('glm-5-2').mapped, true);
    assert.equal(m.resolveConnectSelector('glm-5.2').selector, 'glm-5-2');
  });

  it('resolves the dashed glm-5-1 spelling onto the same selector as glm-5.1', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-glm51`);
    // Live catalog in which the only GLM row is glm-5-2 — the shape a real account
    // reports. Before this fix the map carried `glm-5.1` but NOT `glm-5-1`, so the
    // dashed spelling missed every map lookup, was absent from the live set, and the
    // authoritative catalog left no degrade target → {selector:null, mapped:false},
    // which the handler answers with 400 model_not_found. Dotted worked, dashed did
    // not, for the same model.
    m.setLiveCatalogSelectors([{ selector: 'glm-5-2' }]);
    assert.deepEqual(m.resolveConnectSelector('glm-5-1'), { selector: 'glm-5-2', mapped: true },
      'dashed glm-5-1 must resolve to the live glm-5-2 selector, not fail model_not_found');
    assert.deepEqual(m.resolveConnectSelector('glm-5.1'), { selector: 'glm-5-2', mapped: true },
      'dotted glm-5.1 keeps resolving to the same selector');
  });

  it('retires a snapshot alias when its target is absent from a complete live catalog', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-c3`);
    m.setLiveCatalogSelectors([
      { selector: 'claude-opus-4-8-medium', alias: 'claude-opus-4.8' },
    ]);

    assert.equal(m.resolveConnectSelector('claude-opus-4.8').mapped, true,
      'precondition: an alias targeting a live selector remains valid');
    const retired = m.resolveConnectSelector('gpt-5.5', { warnOnFallback: false });
    // #258 residual: this used to degrade to FREE_TIER_SELECTOR. On a complete
    // live sync that selector is not callable either (it is absent from the live
    // catalog and 502s as "quota exhausted"), so "retired" must mean RETIRED —
    // null forces the handler to answer model_not_found instead of routing the
    // caller to a dead model and reporting its quota error as if it were theirs.
    assert.deepEqual(retired, { selector: null, mapped: false },
      'chat preflight must not keep a snapshot-only alias routable after complete live sync, '
      + 'and must not redirect it to a selector the live catalog proved absent');
  });

  it('keeps snapshot aliases during an explicitly incomplete mixed-pool sync', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-partial`);
    m.setLiveCatalogSelectors([
      { selector: 'claude-opus-4-8-medium' },
    ], { includeSnapshotFallback: true });

    assert.deepEqual(
      m.resolveConnectSelector('gpt-5.5', { warnOnFallback: false }),
      { selector: 'gpt-5-5-low', mapped: true },
      'an account without LKG rows still contributes the frozen snapshot fallback',
    );
  });

  it('keeps snapshot aliases for the process env-token fallback beside live rows', async () => {
    const savedToken = process.env.DEVIN_CONNECT_TOKEN;
    const savedKey = process.env.WINDSURF_API_KEY;
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-env-token`);
    try {
      delete process.env.WINDSURF_API_KEY;
      process.env.DEVIN_CONNECT_TOKEN = 'env-token-fallback-test';
      m.setLiveCatalogSelectors([{ selector: 'claude-opus-4-8-medium' }]);
      assert.deepEqual(
        m.resolveConnectSelector('gpt-5.5', { warnOnFallback: false }),
        { selector: 'gpt-5-5-low', mapped: true },
      );
    } finally {
      if (savedToken === undefined) delete process.env.DEVIN_CONNECT_TOKEN;
      else process.env.DEVIN_CONNECT_TOKEN = savedToken;
      if (savedKey === undefined) delete process.env.WINDSURF_API_KEY;
      else process.env.WINDSURF_API_KEY = savedKey;
    }
  });

  it('keeps catalog-independent synthetic selectors valid after live sync', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-synthetic`);
    m.setLiveCatalogSelectors([{ selector: 'claude-opus-4-8-medium' }]);

    assert.deepEqual(
      m.resolveConnectSelector('subagent-default'),
      { selector: 'subagent-default', mapped: true },
    );
  });

  it('a bad/empty sync never blanks out a good live set', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-d`);
    m.setLiveCatalogSelectors([{ selector: 'qwen-3' }]);
    assert.equal(m.resolveConnectSelector('qwen-3').mapped, true);
    m.setLiveCatalogSelectors([]);          // empty → no-op
    m.setLiveCatalogSelectors(null);        // garbage → no-op
    assert.equal(m.resolveConnectSelector('qwen-3').mapped, true, 'prior good set survives a bad sync');
  });

  it('normalizes string-only seam rows into the readable live catalog', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-strings`);
    m.setLiveCatalogSelectors(['  qwen-3  ', '']);

    assert.deepEqual(m.getLiveCatalog(), [{ selector: 'qwen-3' }]);
    assert.deepEqual(m.resolveConnectSelector('qwen-3'), { selector: 'qwen-3', mapped: true });
  });

  it('normalizes object selectors without dropping their catalog metadata', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-objects`);
    m.setLiveCatalogSelectors([
      { selector: '  qwen-3  ', label: 'Qwen 3', provider: 'alibaba' },
    ]);

    assert.deepEqual(m.getLiveCatalog(), [
      { selector: 'qwen-3', label: 'Qwen 3', provider: 'alibaba' },
    ]);
    assert.deepEqual(m.resolveConnectSelector('qwen-3'), { selector: 'qwen-3', mapped: true });
  });

  it('genuine junk still degrades even with a live catalog present', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-e`);
    m.setLiveCatalogSelectors([{ selector: 'qwen-3' }]);
    assert.equal(m.resolveConnectSelector('totally-fake-model-xyz').mapped, false);
  });

  it('resolves the new alias spellings against an authoritative live catalog (P3-d)', async () => {
    // The S3/S4/S5 spellings must work once a sync lands, not only against the
    // frozen snapshot: a live set retires the snapshot, so a target missing from
    // it is a 400. The live set is set EXPLICITLY to exactly the targets these
    // spellings need, so a resolution that still leaned on the snapshot (or on a
    // map target the account cannot reach) would fail here.
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-p3d`);
    m.setLiveCatalogSelectors([
      { selector: 'grok-4-6-low', provider: 'xai' },
      { selector: 'grok-4-6-medium', provider: 'xai' },
      { selector: 'glm-5-2', provider: 'zhipu' },
      { selector: 'gpt-5-5-low', provider: 'openai' },
      { selector: 'gemini-3-5-flash-medium', provider: 'google' },
      { selector: 'muse-wonder-1-0-medium', provider: 'thinking_machines' },
      { selector: 'MODEL_GPT_5_2_LOW', provider: 'openai' },
    ]);
    assert.equal(m.hasLiveCatalog(), true);
    const cases = [
      ['x-ai/grok-4-6-low', 'grok-4-6-low'],
      ['grok-4-6', 'grok-4-6-medium'],
      ['z-ai/glm-5.1', 'glm-5-2'],
      ['gpt5.5', 'gpt-5-5-low'],
      ['gemini3.5-flash', 'gemini-3-5-flash-medium'],
      ['muse-wonder-1-0', 'muse-wonder-1-0-medium'],
      ['openai/MODEL_GPT_5_2_LOW', 'MODEL_GPT_5_2_LOW'],
    ];
    for (const [name, selector] of cases) {
      assert.deepEqual(m.resolveConnectSelector(name, { warnOnFallback: false }),
        { selector, mapped: true }, name);
    }
  });
});

describe('resolveConnectSelector — live free fallback (#258 residual)', () => {
  // #258 residual: the static `swe-1-6-slow` degrade target is absent from a
  // synced catalog and answers with "Your daily usage quota has been exhausted",
  // so an unmapped name surfaced as a FAKE QUOTA ERROR. A degrade target has to
  // be callable, and the caller that holds live pricing data says which are.

  it('refuses the frozen fallback once a live catalog proves it absent', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-fb1`);
    m.setLiveCatalogSelectors([{ selector: 'swe-1-7' }, { selector: 'glm-5-2' }]);
    assert.deepEqual(
      m.resolveConnectSelector('totally-fake-model-xyz', { warnOnFallback: false }),
      { selector: null, mapped: false },
      'no callable target: the caller must answer model_not_found, not route to a dead selector',
    );
    assert.deepEqual(
      m.resolveConnectSelector('', { warnOnFallback: false }),
      { selector: null, mapped: false },
      'the omitted-model path has the same constraint',
    );
  });

  it('degrades to a live free selector supplied by the caller', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-fb2`);
    m.setLiveCatalogSelectors([{ selector: 'swe-1-7' }, { selector: 'glm-5-2' }]);
    assert.deepEqual(
      m.resolveConnectSelector('totally-fake-model-xyz', {
        warnOnFallback: false,
        freeFallback: ['glm-5-2', 'swe-1-7'],
      }),
      { selector: 'glm-5-2', mapped: false },
      'caller order is the preference order',
    );
  });

  it('skips a free selector the catalog does not expose and takes the next', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-fb3`);
    m.setLiveCatalogSelectors([{ selector: 'swe-1-7' }]);
    assert.deepEqual(
      m.resolveConnectSelector('totally-fake-model-xyz', {
        warnOnFallback: false,
        // swe-2-medium is free on a promo deployment but this catalog does not
        // carry it — routing there would be the same dead-target defect.
        freeFallback: ['swe-2-medium', 'swe-1-7'],
      }),
      { selector: 'swe-1-7', mapped: false },
    );
  });

  it('a live free selector outranks the static floor on cold start', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-fb4`);
    assert.equal(m.hasLiveCatalog(), false);
    assert.deepEqual(
      m.resolveConnectSelector('totally-fake-model-xyz', {
        warnOnFallback: false,
        freeFallback: ['swe-1-7'],
      }),
      { selector: 'swe-1-7', mapped: false },
    );
  });

  it('keeps the static floor while no live catalog has arrived', async () => {
    const m = await import(`../src/devin-connect-models.js?fresh=${Date.now()}-fb5`);
    assert.deepEqual(
      m.resolveConnectSelector('totally-fake-model-xyz', { warnOnFallback: false }),
      { selector: 'swe-1-6-slow', mapped: false },
      'cold start: nothing has contradicted the documented floor yet, so it applies',
    );
  });
});
