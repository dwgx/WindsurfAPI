// Registry guard: every DEFAULT-ON behaviour switch must have an off path someone tested.
//
// WHY
//
// A switch that defaults ON is a behaviour change already shipped to every deploy. Its
// off switch is the only thing standing between "we found a bad shape in production" and
// "roll back the release". #247 shipped as the sole default-on change in a five-PR batch
// with no kill switch at all, and its failure shape was content loss — the switch was
// added afterwards, by the maintainer, not by the PR.
//
// The gap this pins is narrower and more common than "no switch exists": the switch
// exists, and NOTHING EXERCISES IT OFF. Measured when this test was written, of the ten
// default-on switches in src/:
//
//   LS_AUTO_RESTART                              0 tests
//   LS_MEMORY_GUARD                              0 tests
//   RESPONSE_STORE_ENABLED                       0 tests
//   WINDSURFAPI_NLU_RETRY                        0 tests
//   WINDSURFAPI_BACKGROUND_MAINTENANCE_SKIP_BUSY tests exist, none set it to '0'
//
// An untested off path is a kill switch nobody has ever pulled. It is exactly the shape
// that fails when it is finally needed, at the worst moment, with no way to tell whether
// the switch or the incident broke the deploy.
//
// HOW THIS IS ENFORCED
//
// The list below is a LEDGER, not a discovery mechanism. A new default-on switch fails
// the completeness check until someone adds it here deliberately — the point is that
// shipping one is a decision, not an accident. Each entry is either:
//
//   tested: true   — a test sets it to '0' and asserts the off behaviour
//   waived: '<why>' — deliberately unguarded, with the reason recorded
//
// A waiver is not a free pass: it is a line in a file the next reviewer reads.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = join(process.cwd(), 'src');
const TEST_DIR = join(process.cwd(), 'test');

// ── the ledger ──────────────────────────────────────────────────────────────
// Keep alphabetical. `tested` claims a test drives the OFF path; the test below
// verifies that claim rather than trusting it.
// Switches that ARE default-on but whose spelling the patterns below cannot see, so
// they are registered by hand. Keep this as small as possible: every name here is a
// place where the automatic guard does not reach. A separate test asserts each is still
// referenced in src/, so an entry cannot outlive its code.
const HAND_REGISTERED = new Set(['DEVIN_CONNECT_RETRY_ON_EMPTY']);

const LEDGER = {
  DEVIN_CLI_USE_ACCOUNT_POOL: { tested: true },
  // Log-only detector for the #236 prose tool-intent stall. Default ON because a
  // detector that must be armed before it can capture the shape it exists to
  // capture captures nothing; it changes no wire bytes, so the off path is purely
  // "stop emitting the line and the counter". Driven in
  // test/issue-236-prose-tool-intent.test.js.
  DEVIN_CONNECT_PROSE_INTENT_DETECT: { tested: true },
  DROUGHT_RESTRICT_PREMIUM: { tested: true },
  LS_AUTO_RESTART: {
    waived: 'supervisor restart policy — exercising off means asserting a crashed LS is '
      + 'NOT revived, which needs a real child process; covered by lsp-capacity-matrix at '
      + 'the layer above.',
  },
  // NOT discoverable by any pattern here, registered by hand. It reads the env into a
  // local and tests THAT against four off spellings:
  //   const v = String(env.DEVIN_CONNECT_RETRY_ON_EMPTY ?? '').trim().toLowerCase();
  //   return v !== '0' && v !== 'off' && v !== 'false' && v !== 'no';
  // Matching this shape needs dataflow, not a regex. A regex loose enough to chase it
  // is the one that reported env.DASHBOARD_PASSWORD as a switch. The honest position:
  // the patterns catch the common spellings, this ledger is still the source of truth,
  // and an unusual spelling must be added by the author. Off path IS tested
  // (devin-connect-openai.test.js, retry-rescue-budget-split.test.js).
  DEVIN_CONNECT_RETRY_ON_EMPTY: { tested: true },
  // ── Found only after the `=== '0'` pattern was added ──
  // These have no `'1'` literal at all: they are default-ON purely because only an
  // explicit '0' turns them off, which is why every earlier pattern missed them.
  // Off path IS tested now: client-invariants.test.js drives it to '0' and asserts the
  // caller's prompt comes back un-compacted, and test/mutations/client-invariants.json
  // re-introduces the dead switch to prove that assertion bites. This entry read
  // `waived: "No test drives it ... Worth one"` until that test existed.
  CASCADE_COMPACT_CLAUDE_SYSTEM: { tested: true },
  CASCADE_REUSE_HASH_SYSTEM: {
    waived: 'off stops hashing the system prompt into the reuse key (returns \'\'), which '
      + 'only changes cache-key granularity, not output. No test drives it.',
  },
  WINDSURFAPI_LS_PER_PROXY_USER: { tested: true },
  WINDSURFAPI_TOOL_HYGIENE: { tested: true },
  WINDSURFAPI_NLU_RECOVERY: { tested: true },
  // WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT is default-OFF (release-candidate
  // owner decision: no silent variant swap), so it leaves the ledger. Its '1'
  // opt-in path stays tested in test/v2085-auto-fallback.test.js.
  // Both found only after this file's discovery patterns were widened to accept `??`.
  RESPONSE_CACHE_ENABLED: {
    waived: 'off means "do not serve a cached response". No test drives it — the switch '
      + 'was invisible to this ledger until the ?? form was covered, so the gap is newly '
      + 'visible rather than newly created. Worth a test; recorded honestly until then.',
  },
  WINDSURFAPI_ENV_LIFT: { tested: true },
  LS_MEMORY_GUARD: {
    waived: 'the off path is "do not kill an LS over RSS" — proving that requires driving '
      + 'a real process past a memory threshold. Deliberately unguarded.',
  },
  LS_PREWARM_DEFAULT: { tested: true },
  // Both read at module load in handlers/chat.js (:834, :835), so a test would need to
  // re-import the module with the env set — the reason neither has one today.
  OPUS47_STRICT_REUSE: {
    waived: 'module-load constant in handlers/chat.js:835; off relaxes strict cascade '
      + 'reuse for opus-4.7. Same subsystem as issue #245 (reuse isolation) — worth a '
      + 'test when that is next touched. Known gap.',
  },
  OPUS47_TOOL_EMULATED_REUSE: {
    waived: 'module-load constant in handlers/chat.js:834, read as a default parameter by '
      + 'shouldUseCascadeReuse(:941) — that function IS reachable with an explicit '
      + 'allowToolReuse:false, so the behaviour is testable even though the switch is not. '
      + 'Known gap.',
  },
  RESPONSE_STORE_ENABLED: {
    waived: 'off means /v1/responses stops persisting; the store has its own spec '
      + '(response-store-four-defects.json) but nothing drives the disabled branch. '
      + 'Known gap — worth a test, not a blocker today.',
  },
  WINDSURFAPI_BACKGROUND_MAINTENANCE_SKIP_BUSY: {
    waived: 'off means maintenance runs even while requests are in flight — asserting '
      + 'that reliably needs a timing fixture. Known gap.',
  },
  // #250 — off means a leading think-tagged content span stays in the content
  // channel on the Cascade stream path (byte-identical egress, no reroute). The
  // off path IS tested: cascade-think-reroute.test.js drives it to '0' and
  // asserts the marker bytes stay verbatim in content.
  WINDSURFAPI_CASCADE_THINK_REROUTE: { tested: true },
  // Found by a hand audit, not by this ledger: it is spelled
  // `String(env.X || '1') === '0'` as an early return, which the two original
  // discovery patterns (both anchored on `!== '0'`) could not see. The third pattern
  // now anchors on the `|| '1'` fallback instead. Off path IS tested —
  // client-identity-neutralize.test.js drives it with '0' at three sites.
  WINDSURFAPI_NEUTRALIZE_CLIENT_ID: { tested: true },
  WINDSURFAPI_NLU_RETRY: {
    waived: 'off disables the narrative retry nudge; the behaviour is covered indirectly '
      + 'by nlu-negation-and-arg-slot.json but not via the switch. Known gap.',
  },
  WINDSURFAPI_REASONING_DEDUP: { tested: true },
  // WINDSURFAPI_STRICT_MODEL was deleted (release-candidate owner decision):
  // strict is the only behaviour — no switch left to register.
  // The six below are the runtime-config.js table-driven batch, invisible to the first four
  // discovery patterns because the switch name appears as a STRING in a declaration rather
  // than an `env.NAME` access. All six shipped default-on and unregistered.
  //
  // Four have genuine off-path coverage — driven to a disabling value with a behavioural
  // assertion. Note the tests reach them through the runtime-config FIELD name, not the env
  // var name, which is why a search for the env var suggests they are untested:
  //   BREAKER          (breakerEnabled)  devin-connect-breaker.test.js — 'WINDSURFAPI_BREAKER=0
  //                    disables escalation entirely': four reportError() rounds, asserts no
  //                    backoff cooldown lands.
  //   DEGRADED_SERVE   (degradedServe)   devin-connect-breaker.test.js 'L2 — degraded-serve
  //                    fallback': OFF ⇒ fully-throttled pool returns null → 429, ON ⇒ serves
  //                    the account flagged `_degraded`.
  //   QUOTA_COOLDOWN   (cooldownEnabled) quota-tunable-hotswap.test.js
  //   SPEND_ON_DEMAND  (spendOnDemand)   quota-tunable-hotswap.test.js, incl. env '0'
  WINDSURFAPI_BREAKER: { tested: true },
  WINDSURFAPI_DEGRADED_SERVE: { tested: true },
  WINDSURFAPI_QUOTA_COOLDOWN: { tested: true },
  WINDSURFAPI_SPEND_ON_DEMAND: { tested: true },
  // The remaining two are real gaps, recorded as gaps rather than papered over. Both are
  // asserted to DEFAULT to true (breaker-tunable-hotswap.test.js) — that is an on-path
  // assertion, and it is exactly the kind of coverage this ledger exists to distinguish
  // from an off-path one.
  WINDSURFAPI_LAST_ACCOUNT_EXEMPT: {
    waived:
      'off-path untested. Disabling it lets the breaker withdraw the SOLE remaining account, '
      + 'i.e. total outage — the failure mode is severe but it needs a pool driven to one '
      + 'account with an escalating breaker, and connect-error-blame.test.js notes the '
      + 'inverse (a peer must exist or this switch masks the eviction). Known gap.',
  },
  WINDSURFAPI_NEW_ACCOUNT_BASELINE: {
    waived:
      'off-path untested. Off means new accounts skip baseline establishment; the observable '
      + 'difference is in later quota attribution rather than an immediate branch, so there '
      + 'is no cheap behavioural seam. Known gap.',
  },
};

// Shapes that mean "default ON, set to exactly '0' to disable".
//   process.env.X !== '0'
//   String(env.X || '1') !== '0'
const DEFAULT_ON_PATTERNS = [
  /(?:process\.)?env\.([A-Z][A-Z0-9_]+)\s*!==\s*'0'/g,
  /(?:process\.)?env\.([A-Z][A-Z0-9_]+)\s*\|\|\s*'1'\)\s*!==\s*'0'/g,
  // A `'1'` FALLBACK is what makes a switch default-ON, however the comparison is
  // then spelled. The two patterns above both require `!== '0'`, which missed three
  // live default-ON switches, each found by hand rather than by this ledger:
  //   String(env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID || '1') === '0'   // early return
  //   String(env.RESPONSE_CACHE_ENABLED ?? env.WINDSURFAPI_RESPONSE_CACHE ?? '1')
  //   String(env.WINDSURFAPI_ENV_LIFT ?? '1').trim().toLowerCase() === '0'
  // So anchor on the fallback itself, and accept BOTH `||` and `??` — the nullish
  // form is not a stylistic variant here, it is how two of the three are written.
  // The middle allows the chained form (`env.A ?? env.B ?? '1'`) to register every
  // name in the chain, since setting any of them changes behaviour — but it may only
  // skip over further `env.X ??` links, never arbitrary text. A looser `[^)]*?`
  // matched `env.DASHBOARD_PASSWORD || ''` by running past the end of its expression
  // to a `'1'` elsewhere on the line, reporting a credential as a default-on switch.
  /(?:process\.)?env\.([A-Z][A-Z0-9_]+)\s*(?:\|\||\?\?)\s*(?:(?:process\.)?env\.[A-Z][A-Z0-9_]+\s*(?:\|\||\?\?)\s*)*'1'/g,
  // `env.X === '0'` is ALSO default-ON: "off only when explicitly '0'" means unset is
  // on, with no `'1'` literal anywhere to anchor on. Anchoring the patterns above on
  // the fallback still missed three live switches written this way —
  // CASCADE_COMPACT_CLAUDE_SYSTEM, CASCADE_REUSE_HASH_SYSTEM (both early returns) and
  // DEVIN_CONNECT_RETRY_ON_EMPTY (`?? ''` then a multi-value off test). What makes a
  // switch default-ON is that ONLY an explicit off value changes behaviour, so match
  // the off-comparison itself — that is the invariant, not the fallback literal.
  /(?:process\.)?env\.([A-Z][A-Z0-9_]+)\s*===\s*'0'/g,
  // The fourth blind spot, and the first where the switch name never appears as a
  // property access at all. runtime-config.js declares its tunables in a table:
  //   breakerEnabled: { env: 'WINDSURFAPI_BREAKER', kind: 'bool', def: true },
  // Every pattern above requires a literal `env.NAME` adjacent to '0' or '1'. Here the
  // name is a STRING, and the default is the boolean `true` rather than a '1' — so all
  // four missed the same five live default-on switches (WINDSURFAPI_BREAKER,
  // _SPEND_ON_DEMAND, _LAST_ACCOUNT_EXEMPT, _NEW_ACCOUNT_BASELINE, _QUOTA_COOLDOWN),
  // and the completeness check stayed green while they shipped. Two of them matter:
  // BREAKER off means bad accounts are never withdrawn, SPEND_ON_DEMAND spends money.
  //
  // `kind: 'bool'` is required in the match, so int/float knobs (def: 3) are not
  // mistaken for switches — a numeric default is not an on/off state. Key order is
  // fixed by the table's own formatting, which the doc guard keeps aligned; a reorder
  // would drop the entry from discovery, so the assertion below pins the count.
  /\{\s*env:\s*'([A-Z][A-Z0-9_]+)'\s*,\s*kind:\s*'bool'\s*,\s*def:\s*true\s*\}/g,
];

function readTree(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readTree(p));
    else if (entry.name.endsWith('.js')) out.push([p, readFileSync(p, 'utf8')]);
  }
  return out;
}

function discoverDefaultOnSwitches() {
  const found = new Set();
  for (const [, src] of readTree(SRC_DIR)) {
    for (const re of DEFAULT_ON_PATTERNS) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) found.add(m[1]);
    }
  }
  return found;
}

const testSources = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(TEST_DIR, f), 'utf8'));

// The table-driven switches in runtime-config.js are reachable two ways: the env var, and
// the runtime-config FIELD it maps to (setBreakerTunables({ degradedServe: false })). Their
// off-path tests use the field, because that is the hot-swap API operators actually hit —
// so a search for the env var alone concludes "untested" for switches that are covered.
// That conclusion was drawn once in this repo and nearly cost a duplicate test file.
//
// The mapping is READ FROM THE TABLE, never hand-listed: a hand-written alias map is one
// more thing that rots when a field is renamed, and it would rot silently here (an entry
// going stale makes a real test invisible, which reads as "add another test").
const FIELD_ALIASES = (() => {
  const out = new Map();
  const table = readTree(SRC_DIR)
    .filter(([p]) => p.endsWith('runtime-config.js'))
    .map(([, s]) => s)
    .join('\n');
  for (const m of table.matchAll(
    /([a-zA-Z][a-zA-Z0-9]*)\s*:\s*\{\s*env:\s*'([A-Z][A-Z0-9_]+)'/g,
  )) {
    out.set(m[2], m[1]);
  }
  // An empty or shrunken map does not fail anything on its own — it just makes real off-path
  // tests invisible again, i.e. it re-creates the bug this alias lookup fixes, silently and
  // in the safe-looking direction. Pin it.
  assert.ok(
    out.size >= 20,
    `runtime-config env→field aliases parsed: ${out.size} (expected ~23). The table's shape `
      + 'changed and the lookup went stale — off-path tests reached via the field name are '
      + 'now invisible to this ledger.',
  );
  return out;
})();

// Does any test set this knob to a disabling value? Covers X: '0', X = '0', X=0 and unquoted
// forms for the env var, plus `field: false` / `field: 0` for the table-driven aliases.
function hasOffPathTest(knob) {
  const names = [knob];
  const field = FIELD_ALIASES.get(knob);
  if (field) names.push(field);
  return names.some((n) => {
    const re = new RegExp(`${n}["']?\\s*[:=]\\s*["']?(?:0|false)["']?`);
    return testSources.some((src) => re.test(src));
  });
}

describe('default-on switch registry', () => {
  const discovered = discoverDefaultOnSwitches();
  const srcText = readTree(SRC_DIR).map(([, s]) => s).join('\n');

  it('every default-on switch found in src/ is present in the ledger', () => {
    const missing = [...discovered].filter((k) => !(k in LEDGER)).sort();
    assert.deepEqual(missing, [],
      'a new default-on switch shipped without a ledger entry. Shipping one is a decision: '
      + 'add it to LEDGER with tested:true (and a test driving the OFF path) or waived:"<why>". '
      + `Missing: ${missing.join(', ')}`);
  });

  it('the ledger has no stale entries', () => {
    // A knob that stopped being default-on (removed, or flipped to default-off) should
    // leave the ledger, or the ledger becomes decoration that outlives the code.
    //
    // HAND_REGISTERED is the narrow exception: a switch that IS default-on but whose
    // spelling no regex here can see (see DEVIN_CONNECT_RETRY_ON_EMPTY's note). Without
    // this set, registering such a switch makes it look stale, and the only ways out are
    // to leave a real switch unregistered or to loosen the patterns until they produce
    // false positives. Both are worse. Every name here must still be present in src/ —
    // asserted below — so the entry cannot outlive the code it documents.
    const stale = Object.keys(LEDGER)
      .filter((k) => !discovered.has(k) && !HAND_REGISTERED.has(k))
      .sort();
    assert.deepEqual(stale, [],
      `ledger names switches that are no longer default-on in src/: ${stale.join(', ')}`);
  });

  it('every hand-registered switch is still referenced in src/', () => {
    // The exemption above skips pattern discovery, so this is what stops a
    // hand-registered entry from outliving its code: the name must still appear
    // somewhere in src/. Cheaper than dataflow, and enough to catch a deletion.
    const vanished = [...HAND_REGISTERED]
      .filter((k) => !srcText.includes(k))
      .sort();
    assert.deepEqual(vanished, [],
      'hand-registered switches no longer present in src/ — delete the ledger entry: '
      + `${vanished.join(', ')}`);
  });

  it('every switch claiming tested:true really has a test that sets it to 0', () => {
    const lying = Object.entries(LEDGER)
      .filter(([, v]) => v.tested)
      .map(([k]) => k)
      .filter((k) => !hasOffPathTest(k))
      .sort();
    assert.deepEqual(lying, [],
      'these claim an off-path test but no test file sets them to \'0\' — the claim is the '
      + `only thing guarding a kill switch: ${lying.join(', ')}`);
  });

  it('every waiver carries a reason', () => {
    const empty = Object.entries(LEDGER)
      .filter(([, v]) => !v.tested)
      .filter(([, v]) => typeof v.waived !== 'string' || v.waived.trim().length < 20)
      .map(([k]) => k);
    assert.deepEqual(empty, [],
      `waived without a usable reason: ${empty.join(', ')}`);
  });
});
