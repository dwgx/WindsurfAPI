#!/usr/bin/env node
/**
 * devin-connect-calibrate.mjs — ONE command to discover every unknown wire tag.
 *
 * WHY: five tasks (#15/#28 paid selectors, #29 vision image tag, #46 cache/billing
 * tokens, #47 actual_model_uid, #49 native tool_calls) are all blocked on the SAME
 * thing — a wire TAG that a free capture physically never emits. Their decoders are
 * already shipped behind env flags (ready-to-fire); the only missing input is the
 * integer tag, which appears the instant a paid token / tool-using / cached / router
 * turn is captured. Until now that capture had to be wired up by hand each time.
 *
 * This harness collapses all of it into `npm run calibrate:devin`. Point it at ANY
 * token, it fires one completion with DEVIN_CONNECT_DEBUG_META on, aggregates EVERY
 * top-level + metadata tag the stream emitted, diffs them against the known free
 * baseline, classifies each NEW tag by wire shape into the likely field bucket, and
 * writes the calibrated `DEVIN_CONNECT_*` env lines to disk. A status table shows,
 * per target, whether it's calibrated, still pending, and which task it unblocks.
 *
 * BILLABLE? One tiny completion per run. OFF by default (CALIBRATE_REAL=1 to fire);
 * without it, the offline self-test proves collection + classification + persistence.
 *
 * Usage:
 *   CALIBRATE_REAL=1 CONNECT_SMOKE_TOKEN=<token> node scripts/devin-connect-calibrate.mjs
 * Env:
 *   CALIBRATE_REAL=1          actually fire (default: offline self-test)
 *   CALIBRATE_MODEL=<alias>   model to probe (default: swe-1.6-slow free default)
 *   CALIBRATE_PROMPT=<text>   prompt (default a tool-encouraging ask, to coax tool_calls)
 *   CALIBRATE_OUT=<path>      env output file (default ../.devin-connect-calibrated.env)
 *   CALIBRATE_TIMEOUT_MS      per-completion timeout (default 90000)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REAL = process.env.CALIBRATE_REAL === '1';
const TIMEOUT_MS = Number(process.env.CALIBRATE_TIMEOUT_MS || 90000);
// Default MUST be a resolved proto #21 selector (dashed), not the dotted alias:
// streamChat passes `model` RAW (alias resolution lives in the chat.js handler,
// not the transport), and the upstream returns "an internal error occurred
// (trace ID: ...)" for an UNRECOGNIZED selector. The dotted "swe-1.6-slow"
// looked like a dead-token/backend-fault for hours until this was isolated on
// free account <redacted> (dashed swe-1-6-slow → alive, dotted → error).
const DEFAULT_MODEL = process.env.CALIBRATE_MODEL || 'swe-1-6-slow';
const DEFAULT_PROMPT = process.env.CALIBRATE_PROMPT
  || 'Reply with exactly: PONG';

// ─── Known FREE baseline (re-dumped live 2026-06-30, free acct <redacted>,
//     selector swe-1-6-slow) ──
// A plain free TEXT turn (no tools) emits, per-frame: #1 bot-id, #2 content
// sub-message (present EVERY frame), #7 a second sub-message (present EVERY
// frame), #17 uuid. On terminal frames it adds #3 final-text, #4/#5 finish/stop
// enum, #9 reasoning delta, #28 a trailing standalone sub-message. #11 seen on
// some turns. ALL of these are normal free output — the previous baseline
// ({1,3,4,5,9,11,17}) was missing #2/#7/#28, so a clean free turn falsely
// surfaced them as tool_calls/billing candidates (every dump "discovered" them).
// Meta sub-message: #6 constant (=6) on free; #2/#3 varints appear on free text
// turns too (NOT paid-only billing — confirmed: present with no tools, no paid
// selector), so they are baseline, not credit_cost candidates.
export const FREE_BASELINE = {
  top: new Set([1, 2, 3, 4, 5, 7, 9, 11, 17, 28]),
  meta: new Set([2, 3, 6]),
};

// ─── Targets: the five blocked unknowns, each with the env var that arms its
// already-shipped decoder, the wire shape it appears as, and the task it unblocks.
export const TARGETS = [
  { key: 'actual_model_uid', env: 'DEVIN_CONNECT_ACTUAL_MODEL_TAG', scope: 'top', shape: 'string', task: '#47', note: 'concrete model behind a router turn' },
  { key: 'tool_calls', env: 'DEVIN_CONNECT_TOOL_CALL_TAGS', scope: 'top', shape: 'message', task: '#49', note: 'repeated ChatToolCall (delta_tool_calls)' },
  { key: 'billing', env: 'DEVIN_CONNECT_BILLING_TAGS', scope: 'meta', shape: 'varint', task: '#46', note: 'credit_cost / committed_*_cost' },
  { key: 'cache_tokens', env: 'DEVIN_CONNECT_BILLING_TAGS', scope: 'meta', shape: 'varint', task: '#46', note: 'cache_read_tokens / cache_write_tokens' },
  { key: 'image_tag', env: 'DEVIN_CONNECT_IMAGE_TAG', scope: 'request', shape: 'message', task: '#29', note: 'vision images field — needs the dedicated image-calibrate sweep' },
];

export function resolveToken(env = process.env) {
  if (env.CONNECT_SMOKE_TOKEN) return env.CONNECT_SMOKE_TOKEN.trim();
  for (const k of ['DEVIN_CONNECT_TOKEN', 'DEVIN_SESSION_TOKEN', 'WINDSURF_SESSION_TOKEN']) {
    if (env[k]) return env[k].trim();
  }
  try {
    const accountsUrl = env.CALIBRATE_ACCOUNTS_FILE
      ? new URL(`file://${env.CALIBRATE_ACCOUNTS_FILE.replace(/\\/g, '/')}`)
      : new URL('../accounts.json', import.meta.url);
    const accounts = JSON.parse(readFileSync(accountsUrl, 'utf8'));
    const first = accounts.find((a) => a.apiKey);
    if (first) return first.apiKey;
  } catch { /* none */ }
  return '';
}

export function resolveOutPath(env = process.env) {
  return env.CALIBRATE_OUT || fileURLToPath(new URL('../.devin-connect-calibrated.env', import.meta.url));
}

/**
 * Classify one observed top-level/meta tag (not in the baseline) into the target
 * bucket its wire shape best fits. Pure + exported for the self-test.
 *   - meta varint  → billing / cache_tokens (#46)
 *   - top string   → actual_model_uid (#47)
 *   - top message  → tool_calls (#49)
 */
export function classifyTag({ scope, tag, kind, preview, topTag }) {
  if (scope === 'meta' && kind === 'varint') {
    return { bucket: 'billing/cache', targets: ['billing', 'cache_tokens'], task: '#46',
      detail: `meta varint #${tag}=${preview} — credit_cost / cache token candidate` };
  }
  if (scope === 'top' && kind === 'string') {
    return { bucket: 'actual_model_uid', targets: ['actual_model_uid'], task: '#47',
      detail: `top string #${tag}="${preview}" — actual_model_uid candidate` };
  }
  if (scope === 'top' && kind === 'message') {
    return { bucket: 'tool_calls', targets: ['tool_calls'], task: '#49',
      detail: `top sub-message #${tag} (${preview}) — delta_tool_calls (tool_calls) candidate` };
  }
  // Inner fields of a top-level sub-message (e.g. the recurring #28 trailer). A
  // varint inner field is the strongest billing/usage/stop-metadata signal — this
  // is where credit_cost / committed_*_cost / cache tokens most likely live when
  // they don't ride the #7 meta block. Strings inside are model-id / stop-reason.
  if (scope === 'sub' && kind === 'varint') {
    // Informational only (targets: []): the shipped billing decoder reads the #7
    // meta block, so a #28 inner varint must NOT auto-fill DEVIN_CONNECT_BILLING_TAGS.
    // It's surfaced for the operator to inspect, with a dedicated env hint below.
    return { bucket: 'sub-billing', targets: [], task: '#46',
      detail: `sub #${topTag}.${tag} varint=${preview} — billing/usage/stop-metadata candidate` };
  }
  if (scope === 'sub' && kind === 'string') {
    return { bucket: 'sub-metadata', targets: [], task: '#46/#47',
      detail: `sub #${topTag}.${tag} string="${preview}" — model-id / stop-reason candidate` };
  }
  if (scope === 'sub') {
    return { bucket: 'sub-nested', targets: [], task: '#46',
      detail: `sub #${topTag}.${tag} (${kind} ${preview}) — nested sub-message candidate` };
  }
  return { bucket: 'unknown', targets: [], task: '?', detail: `#${tag} (${kind}) — unrecognized shape` };
}

/**
 * Aggregate the per-frame dumps emitted over a stream into a stable tag inventory.
 * Each dump entry value tells us the wire kind: number→varint, "<msg Nb>"→message,
 * else→string. Returns { top:{tag:{kind,preview}}, meta:{tag:{kind,preview}} }.
 */
export function aggregateDumps(frameDumps, metaDumps, subDumps) {
  const classify = (v) => {
    if (typeof v === 'number') return { kind: 'varint', preview: v };
    if (typeof v === 'string' && /^<msg \d+b>$/.test(v)) return { kind: 'message', preview: v };
    return { kind: 'string', preview: String(v).slice(0, 48) };
  };
  const top = {}, meta = {}, sub = {};
  for (const d of frameDumps || []) for (const [tag, v] of Object.entries(d)) top[tag] = classify(v);
  for (const d of metaDumps || []) for (const [tag, v] of Object.entries(d)) meta[tag] = classify(v);
  // sub: { <topTag>: { <innerTag>: {kind, preview} } } — decodeSubMessage already
  // emits the {kind, preview} shape, so merge inner maps as-is (later frames win,
  // matching top/meta's last-writer semantics).
  for (const d of subDumps || []) for (const [topTag, inner] of Object.entries(d)) {
    sub[topTag] = { ...(sub[topTag] || {}), ...inner };
  }
  return { top, meta, sub };
}

/**
 * Given an aggregated inventory, return the NEW tags (not in baseline) classified
 * into target buckets. Returns { candidates:[{scope,tag,kind,preview,...classify}] }.
 */
export function findCandidates(inventory, baseline = FREE_BASELINE) {
  const candidates = [];
  for (const [tag, info] of Object.entries(inventory.top)) {
    if (baseline.top.has(Number(tag))) continue;
    candidates.push({ scope: 'top', tag: Number(tag), ...info, ...classifyTag({ scope: 'top', tag: Number(tag), kind: info.kind, preview: info.preview }) });
  }
  for (const [tag, info] of Object.entries(inventory.meta)) {
    if (baseline.meta.has(Number(tag))) continue;
    candidates.push({ scope: 'meta', tag: Number(tag), ...info, ...classifyTag({ scope: 'meta', tag: Number(tag), kind: info.kind, preview: info.preview }) });
  }
  // Inner fields of top-level sub-messages (e.g. #28). Every inner field is a
  // candidate — there is no free baseline for sub-message internals (a free
  // trailer's inner structure was never decoded before this harness existed), so
  // all are surfaced for operator inspection. Keyed by both the outer top tag and
  // the inner tag so the report reads "sub #28.3 varint=…".
  for (const [topTag, inner] of Object.entries(inventory.sub || {})) {
    for (const [tag, info] of Object.entries(inner)) {
      candidates.push({ scope: 'sub', topTag: Number(topTag), tag: Number(tag), ...info,
        ...classifyTag({ scope: 'sub', topTag: Number(topTag), tag: Number(tag), kind: info.kind, preview: info.preview }) });
    }
  }
  return { candidates };
}

/**
 * Run a calibration probe. `deps.streamChat` injectable for the self-test. It does
 * NOT decode with calibrated tags — it only collects raw dumps, so it works on a
 * token where the tags are still unknown. Returns the full report.
 */
export async function runCalibration({ token, model = DEFAULT_MODEL, prompt = DEFAULT_PROMPT, tools = null, env = process.env, real = false, deps = {} } = {}) {
  const frameDumps = [];
  const metaDumps = [];
  const subDumps = [];
  let modelAlive = false;
  let error = null;

  if (real) {
    const { streamChat = (await import('../src/devin-connect.js')).streamChat } = deps;
    const probeEnv = { ...env, DEVIN_CONNECT_DEBUG_META: '1' };
    // Capture the dumps directly off decodeFrame via a stream consumer. streamChat
    // logs them; we instead read the structured events it yields plus a frame hook.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const chatArgs = { token, model, messages: [{ role: 'user', content: prompt }], env: probeEnv, signal: ac.signal };
      if (tools) chatArgs.tools = tools;
      for await (const ev of streamChat(chatArgs)) {
        if (ev.type === 'frame-dump' && ev.frameDump) frameDumps.push(ev.frameDump);
        if (ev.type === 'frame-dump' && ev.metaDump) metaDumps.push(ev.metaDump);
        if (ev.type === 'frame-dump' && ev.subDump) subDumps.push(ev.subDump);
        if (ev.type === 'delta' || ev.type === 'finish') modelAlive = true;
      }
    } catch (e) {
      error = { code: e.code || 'ERR', message: String(e.message || '').slice(0, 80) };
    } finally {
      clearTimeout(timer);
    }
  } else {
    // self-test path provides dumps directly via deps
    if (deps.frameDumps) frameDumps.push(...deps.frameDumps);
    if (deps.metaDumps) metaDumps.push(...deps.metaDumps);
    if (deps.subDumps) subDumps.push(...deps.subDumps);
    modelAlive = deps.modelAlive !== false;
  }

  const inventory = aggregateDumps(frameDumps, metaDumps, subDumps);
  const { candidates } = findCandidates(inventory);

  // Build the env lines for any discovered candidates.
  const envLines = [];
  const byTarget = {};
  for (const c of candidates) for (const t of c.targets) (byTarget[t] ||= []).push(c);
  if (byTarget.actual_model_uid?.length) envLines.push(`DEVIN_CONNECT_ACTUAL_MODEL_TAG=${byTarget.actual_model_uid[0].tag}`);
  if (byTarget.tool_calls?.length) envLines.push(`# tool_calls outer candidate at tag ${byTarget.tool_calls[0].tag} — confirm subfields then set:\n# DEVIN_CONNECT_TOOL_CALL_TAGS="outer=${byTarget.tool_calls[0].tag},id=?,name=?,arguments_json=?"`);
  const billingTags = (byTarget.billing || byTarget.cache_tokens || []).map((c) => c.tag);
  if (billingTags.length) envLines.push(`# meta varint candidates at tags [${billingTags.join(',')}] — map to credit_cost/cache_*; then set DEVIN_CONNECT_BILLING_TAGS / cache via DEVIN_CONNECT_BILLING_TAGS`);
  // Sub-message inner varints (e.g. the #28 trailer): informational — the shipped
  // billing decoder reads the #7 meta block, so these are NOT auto-wired. Surface
  // them so the operator can decide whether #28 carries the billing/usage fields.
  const subVarints = candidates.filter((c) => c.scope === 'sub' && c.kind === 'varint');
  if (subVarints.length) {
    const byTop = {};
    for (const c of subVarints) (byTop[c.topTag] ||= []).push(`${c.tag}=${c.preview}`);
    for (const [topTag, fields] of Object.entries(byTop)) {
      envLines.push(`# sub-message #${topTag} inner varints: {${fields.join(', ')}} — inspect for credit_cost/cache/stop-metadata (NOT auto-wired; #7-meta drives billing decode today)`);
    }
  }

  return { modelAlive, error, inventory, candidates, envLines };
}

/** Status table: for each target, calibrated? pending? which task. */
export function statusTable(report, env = process.env) {
  const found = new Set(report.candidates.flatMap((c) => c.targets));
  return TARGETS.map((t) => {
    const already = env[t.env] && String(env[t.env]).trim().length > 0;
    const discovered = found.has(t.key);
    const state = already ? 'CALIBRATED (env set)' : discovered ? 'CANDIDATE FOUND' : 'pending';
    return { target: t.key, task: t.task, env: t.env, state, note: t.note };
  });
}

// ─── Offline self-test: proves collection + classify + persistence with fake
// dumps that mimic a paid/tool/cached/router capture — no token, no network.
async function selfTest() {
  const assert = (c, m) => { if (!c) { console.error(`[SELFTEST FAIL] ${m}`); process.exitCode = 1; } };

  // classifyTag buckets
  assert(classifyTag({ scope: 'meta', tag: 10, kind: 'varint', preview: 42 }).bucket === 'billing/cache', 'meta varint → billing/cache');
  assert(classifyTag({ scope: 'top', tag: 8, kind: 'string', preview: 'claude-opus' }).bucket === 'actual_model_uid', 'top string → actual_model_uid');
  assert(classifyTag({ scope: 'top', tag: 12, kind: 'message', preview: '<msg 40b>' }).bucket === 'tool_calls', 'top message → tool_calls');
  assert(classifyTag({ scope: 'sub', topTag: 28, tag: 3, kind: 'varint', preview: 42 }).bucket === 'sub-billing', 'sub varint → sub-billing');
  assert(classifyTag({ scope: 'sub', topTag: 28, tag: 3, kind: 'varint', preview: 42 }).targets.length === 0, 'sub varint NOT auto-wired');
  assert(classifyTag({ scope: 'sub', topTag: 28, tag: 1, kind: 'string', preview: 'stop' }).bucket === 'sub-metadata', 'sub string → sub-metadata');

  // aggregate + findCandidates against the free baseline
  const frameDumps = [
    { 1: 'bot-x', 9: 'thinking', 17: 'uuid' },              // all baseline → no candidates
    { 1: 'bot-x', 3: 'PONG', 4: 2, 8: 'claude-opus-4-8', 12: '<msg 47b>' }, // #8 actual_model, #12 tool_calls
  ];
  const metaDumps = [{ 6: 6, 14: 1500, 15: 200 }];          // #14/#15 new varints → billing/cache
  // #28 trailer inner fields — the recurring usage/billing/stop-metadata block.
  // (Shape: some varints = candidate billing/usage counters, a string = model/stop.)
  const subDumps = [{ 28: { 1: { kind: 'string', preview: 'stop' }, 3: { kind: 'varint', preview: 1200 }, 4: { kind: 'varint', preview: 34 } } }];
  const report = await runCalibration({ real: false, deps: { frameDumps, metaDumps, subDumps } });

  const buckets = report.candidates.map((c) => c.bucket).sort();
  assert(report.candidates.some((c) => c.scope === 'top' && c.tag === 8 && c.bucket === 'actual_model_uid'), 'found actual_model_uid #8');
  assert(report.candidates.some((c) => c.scope === 'top' && c.tag === 12 && c.bucket === 'tool_calls'), 'found tool_calls #12');
  assert(report.candidates.filter((c) => c.scope === 'meta' && c.bucket === 'billing/cache').length === 2, 'found 2 billing/cache meta varints');
  assert(!report.candidates.some((c) => c.tag === 6), 'baseline meta #6 not flagged');
  assert(!report.candidates.some((c) => c.scope === 'top' && [1, 3, 4, 9, 17].includes(c.tag)), 'baseline top tags not flagged');
  // sub-message inner fields surfaced (the #28 decode — the previous session's blocker)
  assert(report.candidates.filter((c) => c.scope === 'sub' && c.topTag === 28 && c.kind === 'varint').length === 2, 'found 2 sub #28 inner varints');
  assert(report.candidates.some((c) => c.scope === 'sub' && c.topTag === 28 && c.tag === 1 && c.bucket === 'sub-metadata'), 'found sub #28 string field');

  // env line generation
  assert(report.envLines.some((l) => l === 'DEVIN_CONNECT_ACTUAL_MODEL_TAG=8'), 'emits actual_model env line');
  assert(report.envLines.some((l) => /outer=12/.test(l)), 'emits tool_call outer candidate');
  assert(report.envLines.some((l) => /14,15/.test(l)), 'emits billing meta candidates');
  assert(report.envLines.some((l) => /sub-message #28 inner varints/.test(l) && /3=1200/.test(l) && /4=34/.test(l)), 'emits sub #28 informational env hint');

  // status table reflects discoveries + already-set env
  const tbl = statusTable(report, {});
  assert(tbl.find((r) => r.target === 'actual_model_uid').state === 'CANDIDATE FOUND', 'status: actual_model candidate');
  const tbl2 = statusTable({ candidates: [] }, { DEVIN_CONNECT_ACTUAL_MODEL_TAG: '8' });
  assert(tbl2.find((r) => r.target === 'actual_model_uid').state.startsWith('CALIBRATED'), 'status: env-set → CALIBRATED');

  // a pure-free capture yields zero candidates (proves no false positives)
  const freeOnly = await runCalibration({ real: false, deps: { frameDumps: [{ 1: 'b', 3: 'PONG', 4: 2, 9: 't', 17: 'u' }], metaDumps: [{ 6: 6 }] } });
  assert(freeOnly.candidates.length === 0, 'pure-free capture → no candidates');

  if (process.exitCode) console.error('\n[SELFTEST] FAILED — do not trust the harness until fixed.');
  else console.log('[SELFTEST] OK — collect + classify + env-gen + status wiring verified (no token, no network, no billing).');
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const model = DEFAULT_MODEL;
  console.log(`[calibrate] model=${model} real=${REAL}`);

  if (!REAL) {
    console.log('CALIBRATE_REAL is not 1 — running offline self-test only (no token, no network).');
    console.log('To calibrate against a real (ideally paid/tool-using/router) token:');
    console.log('  CALIBRATE_REAL=1 CONNECT_SMOKE_TOKEN=<token> node scripts/devin-connect-calibrate.mjs\n');
    await selfTest();
    process.exit(process.exitCode || 0);
  }

  const token = resolveToken();
  if (!token) {
    console.error('CALIBRATE_REAL=1 but no token — set CONNECT_SMOKE_TOKEN or persist an account.');
    process.exit(2);
  }

  console.log(`[calibrate] firing one DEBUG_META probe (timeout ${TIMEOUT_MS}ms)\n`);
  const report = await runCalibration({ token, model, real: true });

  if (report.error) console.log(`  probe error: ${report.error.code} ${report.error.message}`);
  console.log(`  model alive: ${report.modelAlive}`);
  console.log(`  top tags seen:  ${Object.keys(report.inventory.top).join(', ') || '(none)'}`);
  console.log(`  meta tags seen: ${Object.keys(report.inventory.meta).join(', ') || '(none)'}`);

  console.log(`\n─── NEW candidate tags (not in free baseline) ───`);
  if (!report.candidates.length) {
    console.log('  none — this token/turn emitted only known free fields.');
    console.log('  (paid selectors, a tool-using turn, a router model, or a cached turn are needed to surface the rest.)');
  } else {
    for (const c of report.candidates) console.log(`  ${c.detail}  [${c.task}]`);
  }

  console.log(`\n─── Calibration status ───`);
  for (const r of statusTable(report)) {
    console.log(`  ${r.target.padEnd(18)} ${r.task.padEnd(4)} ${r.state.padEnd(22)} ${r.env}`);
  }

  if (report.envLines.length) {
    const outPath = resolveOutPath();
    const banner = `# DEVIN_CONNECT calibration — ${new Date().toISOString()}\n# Review each candidate before pinning in production.\n`;
    writeFileSync(outPath, banner + report.envLines.join('\n') + '\n', 'utf8');
    console.log(`\nWrote candidate env lines → ${outPath}`);
    console.log('Review, confirm subfields where noted, then copy the DEVIN_CONNECT_* lines into prod env + memory.');
  }
  process.exit(0);
}

const isEntry = import.meta.main
  ?? (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href);
if (isEntry) await main();
