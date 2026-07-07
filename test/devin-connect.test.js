import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getConnectToken,
  buildGetChatMessageRequest,
  decodeFrame,
  mapFinishReason,
  classifyUpstreamError,
  isRetryable,
  streamChat,
  getImageFieldTag,
  getImageToolDefEnabled,
  getToolDefTags,
  extractInlineImages,
  expandVisionMessage,
  __setRequestImpl,
  __testing,
  mergeToolCallFragment,
} from '../src/devin-connect.js';
import {
  writeStringField, writeVarintField, writeMessageField,
  parseFields, getField, getAllFields,
} from '../src/proto.js';
import { wrapEnvelope, endOfStreamEnvelope } from '../src/connect.js';
import { EventEmitter } from 'node:events';

const ENV_KEYS = ['DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY', 'DEVIN_CONNECT_IMAGE_TAG',
  'DEVIN_CONNECT_IMAGE_TOOLDEF', 'DEVIN_CONNECT_IMAGE_INNER_TAGS', 'DEVIN_CONNECT_TOOL_DEF_TAGS'];
const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

const TOKEN = 'devin-session-token$test.jwt.sig';

describe('getConnectToken', () => {
  it('prefers DEVIN_CONNECT_TOKEN over WINDSURF_API_KEY', () => {
    assert.equal(
      getConnectToken({ DEVIN_CONNECT_TOKEN: 'a', WINDSURF_API_KEY: 'b' }),
      'a',
    );
  });
  it('falls back to WINDSURF_API_KEY', () => {
    assert.equal(getConnectToken({ WINDSURF_API_KEY: 'b' }), 'b');
  });
  it('returns empty string when neither is set', () => {
    assert.equal(getConnectToken({}), '');
  });
});

describe('generateFingerprint', () => {
  it('produces 732 hex chars (the server-required length)', () => {
    const fp = __testing.generateFingerprint();
    assert.equal(fp.length, 732);
    assert.match(fp, /^[0-9a-f]{732}$/);
  });
  it('is random per call', () => {
    assert.notEqual(__testing.generateFingerprint(), __testing.generateFingerprint());
  });
});

describe('messageText', () => {
  it('passes strings through', () => {
    assert.equal(__testing.messageText('hi'), 'hi');
  });
  it('joins text parts of array content', () => {
    assert.equal(
      __testing.messageText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
      'a\nb',
    );
  });
  it('handles null', () => {
    assert.equal(__testing.messageText(null), '');
  });
});

describe('buildGetChatMessageRequest', () => {
  it('throws without a token', () => {
    assert.throws(() => buildGetChatMessageRequest({ model: 'm', messages: [] }), /session token/);
  });
  it('throws without a model', () => {
    assert.throws(() => buildGetChatMessageRequest({ token: TOKEN, messages: [] }), /model selector/);
  });

  it('encodes the calibrated top-level field shape', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN,
      model: 'swe-1-6-slow',
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hello' },
      ],
    });
    const fields = parseFields(proto);

    // #1 ClientMetadata (message), #2 system_prompt (string), #3 ChatMessage,
    // #7 mode varint, #8 CompletionConfig, #15 ModelConfig, #16 session id,
    // #20 varint, #21 model selector.
    assert.ok(getField(fields, 1, 2), 'has ClientMetadata #1');
    assert.equal(getField(fields, 2, 2).value.toString('utf8'), 'be nice');
    assert.equal(getField(fields, 7, 0).value, 5);
    assert.ok(getField(fields, 8, 2), 'has CompletionConfig #8');
    assert.ok(getField(fields, 15, 2), 'has ModelConfig #15');
    assert.ok(getField(fields, 16, 2), 'has session id #16');
    assert.equal(getField(fields, 20, 0).value, 1);
    assert.equal(getField(fields, 21, 2).value.toString('utf8'), 'swe-1-6-slow');
    // #22 request_id — VERIFIED-FROM-WIRE (req022 carries #22 = a UUID string
    // after #21). The earlier "intentionally absent" note was wrong; the real
    // devin.exe CLI always sends it, so we now emit a fresh uuid per request.
    const rid = getField(fields, 22, 2);
    assert.ok(rid, 'has request_id #22');
    assert.match(rid.value.toString('utf8'), /^[0-9a-f-]{36}$/, '#22 is a uuid');
  });

  it('embeds the SINGLE token in ClientMetadata #3 (header doubling is separate)', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', messages: [{ role: 'user', content: 'x' }],
    });
    const meta = parseFields(getField(parseFields(proto), 1, 2).value);
    assert.equal(getField(meta, 3, 2).value.toString('utf8'), TOKEN);
  });

  it('uses a 732-hex fingerprint in ClientMetadata #31', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', messages: [{ role: 'user', content: 'x' }],
    });
    const meta = parseFields(getField(parseFields(proto), 1, 2).value);
    const fp = getField(meta, 31, 2).value.toString('utf8');
    assert.equal(fp.length, 732);
  });

  it('emits one ChatMessage per non-system turn with the right source enum', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN,
      model: 'm',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
    });
    const chats = getAllFields(parseFields(proto), 3).filter(f => f.wireType === 2);
    assert.equal(chats.length, 3);
    const sources = chats.map(c => getField(parseFields(c.value), 2, 0).value);
    assert.deepEqual(sources, [__testing.SOURCE.USER, __testing.SOURCE.ASSISTANT, __testing.SOURCE.USER]);
  });

  it('folds tool turns into user-visible text', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm',
      messages: [{ role: 'tool', tool_call_id: 'call_7', content: '42' }],
    });
    const chat = getAllFields(parseFields(proto), 3).find(f => f.wireType === 2);
    const text = getField(parseFields(chat.value), 3, 2).value.toString('utf8');
    assert.match(text, /tool result for call_7/);
    assert.match(text, /42/);
  });

  it('concatenates multiple system turns', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm',
      messages: [
        { role: 'system', content: 'a' },
        { role: 'system', content: 'b' },
        { role: 'user', content: 'x' },
      ],
    });
    assert.equal(getField(parseFields(proto), 2, 2).value.toString('utf8'), 'a\nb');
  });

  it('honours CompletionConfig overrides', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      completion: { maxTokens: 256 },
    });
    const comp = parseFields(getField(parseFields(proto), 8, 2).value);
    assert.equal(getField(comp, 3, 0).value, 256);
  });

  it('forwards all sampling controls (temperature/top_p/top_k/max_tokens)', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      completion: { maxTokens: 512, temperature: 0.7, topP: 0.5, topK: 100 },
    });
    const comp = parseFields(getField(parseFields(proto), 8, 2).value);
    assert.equal(getField(comp, 3, 0).value, 512);            // max_tokens
    assert.equal(getField(comp, 7, 0).value, 100);            // top_k
    assert.ok(Math.abs(getField(comp, 5, 1).value.readDoubleLE(0) - 0.7) < 1e-9); // temperature
    assert.ok(Math.abs(getField(comp, 8, 1).value.readDoubleLE(0) - 0.5) < 1e-9); // top_p
  });

  it('clamps temperature=0 to the epsilon floor (upstream rejects exact 0)', () => {
    // LIVE-VERIFIED: temperature=0 → upstream "internal error". A caller asking
    // for greedy decoding must get the nearest working value, not a hard failure.
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      completion: { temperature: 0 },
    });
    const comp = parseFields(getField(parseFields(proto), 8, 2).value);
    const temp = getField(comp, 5, 1).value.readDoubleLE(0);
    assert.ok(temp > 0 && temp <= 0.001, `expected clamped epsilon, got ${temp}`);
  });
});

describe('decodeFrame', () => {
  it('reads the final answer from field #3 (content)', () => {
    const payload = Buffer.concat([
      writeStringField(1, 'bot-123'),
      writeStringField(3, 'the answer'),
      writeStringField(9, 'thinking...'),
      writeStringField(17, 'uuid'),
    ]);
    const d = decodeFrame(payload);
    assert.equal(d.content, 'the answer');
    assert.equal(d.reasoning, 'thinking...');
  });

  it('does not confuse the nested #7.#9 model name with top-level #9 reasoning', () => {
    // #7 metadata carries its own #9 (model name); only top-level #9 is reasoning.
    const meta = Buffer.concat([writeVarintField(6, 6), writeStringField(9, 'swe-1-6-slow')]);
    const payload = Buffer.concat([
      writeStringField(1, 'bot-123'),
      writeMessageField(7, meta),
    ]);
    const d = decodeFrame(payload);
    assert.equal(d.reasoning, '');
    assert.equal(d.content, '');
  });

  it('reads token usage from the terminal #7 metadata frame', () => {
    const meta = Buffer.concat([
      writeVarintField(2, 386), // prompt_tokens
      writeVarintField(3, 48),  // completion_tokens
      writeVarintField(6, 6),
    ]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(7, meta)]);
    const d = decodeFrame(payload);
    assert.deepEqual(d.usage, { prompt: 386, completion: 48 });
  });

  it('omits usage when completion_tokens is absent (non-terminal frame)', () => {
    const meta = Buffer.concat([writeVarintField(2, 386), writeVarintField(6, 6)]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(7, meta)]);
    assert.equal(decodeFrame(payload).usage, null);
  });

  it('billing is null by default (no tag map configured)', () => {
    // The whole groundwork is opt-in: without DEVIN_CONNECT_BILLING_TAGS, even a
    // frame that happens to carry billing varints must NOT surface them — zero
    // regression on free tier / un-calibrated deployments.
    const meta = Buffer.concat([
      writeVarintField(2, 386), writeVarintField(3, 48),
      writeVarintField(6, 250), // a value that, IF mis-parsed as billing, would show
    ]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(7, meta)]);
    assert.equal(decodeFrame(payload).billing, null);
  });

  it('parses billing varints from the #7 metadata sub-message when tags are pinned', () => {
    // Operator calibrated: credit_cost=#10, committed_credit_cost=#11, committed_acu_cost=#12.
    const billingTags = { credit_cost: 10, committed_credit_cost: 11, committed_acu_cost: 12 };
    const meta = Buffer.concat([
      writeVarintField(2, 386), writeVarintField(3, 48),
      writeVarintField(10, 1500), // credit_cost
      writeVarintField(11, 1400), // committed_credit_cost
      writeVarintField(12, 3),    // committed_acu_cost
    ]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(7, meta)]);
    const d = decodeFrame(payload, { billingTags });
    assert.deepEqual(d.billing, { credit_cost: 1500, committed_credit_cost: 1400, committed_acu_cost: 3 });
    // usage still decodes alongside billing
    assert.deepEqual(d.usage, { prompt: 386, completion: 48 });
  });

  it('routes cache_*_tokens into usage (not billing) when their tags are pinned', () => {
    // cache_read_tokens / cache_write_tokens are ModelUsageStats fields → they
    // belong in usage, not billing. Same opt-in tag mechanism as cost fields.
    const tags = { cache_read_tokens: 14, cache_write_tokens: 15, credit_cost: 10 };
    const meta = Buffer.concat([
      writeVarintField(2, 386), writeVarintField(3, 48),
      writeVarintField(10, 1500), // credit_cost → billing
      writeVarintField(14, 1200), // cache_read_tokens → usage
      writeVarintField(15, 64),   // cache_write_tokens → usage
    ]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(7, meta)]);
    const d = decodeFrame(payload, { billingTags: tags });
    assert.deepEqual(d.usage, { prompt: 386, completion: 48, cache_read_tokens: 1200, cache_write_tokens: 64 });
    assert.deepEqual(d.billing, { credit_cost: 1500 });
  });

  it('dumpMeta exposes every metadata varint subfield for tag calibration', () => {
    // The DEVIN_CONNECT_DEBUG_META hook: surfaces {tag: value} for every varint
    // in the #7 sub-message so an operator can discover unknown tags from a real
    // capture. Off unless requested; never affects normal decode output.
    const meta = Buffer.concat([
      writeVarintField(2, 386), writeVarintField(3, 48), writeVarintField(6, 6),
      writeVarintField(14, 1200),
    ]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(7, meta)]);
    assert.equal(decodeFrame(payload).metaDump, undefined); // off by default
    const d = decodeFrame(payload, { dumpMeta: true });
    assert.deepEqual(d.metaDump, { 2: 386, 3: 48, 6: 6, 14: 1200 });
  });

  it('decodes actual_model_uid from #7.9 (nested in metadata) only when its tag is pinned', () => {
    // FRAME-VERIFIED 2026-07-05 (paid opus-4-8): actual_model_uid rides the #7
    // metadata sub-message at INNER tag 9, NOT a top-level field. Opt-in via
    // DEVIN_CONNECT_ACTUAL_MODEL_TAG (calibrated value = 9).
    const meta = Buffer.concat([
      writeVarintField(2, 777),                       // prompt_tokens
      writeVarintField(3, 180),                       // completion_tokens
      writeStringField(9, 'claude-opus-4-8-medium'),  // actual_model_uid at #7.9
    ]);
    const payload = Buffer.concat([
      writeStringField(1, 'bot-1'),
      writeMessageField(7, meta),
    ]);
    assert.equal(decodeFrame(payload).actualModel, undefined); // off by default
    assert.equal(decodeFrame(payload, { actualModelTag: 9 }).actualModel, 'claude-opus-4-8-medium');
    // wrong inner tag → nothing surfaced
    assert.equal(decodeFrame(payload, { actualModelTag: 99 }).actualModel, undefined);
  });

  it('coalesces native tool_call arguments fragmented across frames (#6.3)', () => {
    // FRAME-VERIFIED 2026-07-05: one logical call streams as {id,name} then
    // id-less argument fragments. Merging must reconstruct the full JSON.
    const acc = [];
    mergeToolCallFragment(acc, { id: 'toolu_1', name: 'grep_repo' });
    mergeToolCallFragment(acc, { arguments: '{"patter' });
    mergeToolCallFragment(acc, { arguments: 'n": "DEV' });
    mergeToolCallFragment(acc, { arguments: 'IN_CONNECT"}' });
    assert.equal(acc.length, 1);
    assert.deepEqual(acc[0], { id: 'toolu_1', name: 'grep_repo', arguments: '{"pattern": "DEVIN_CONNECT"}' });
    assert.equal(JSON.parse(acc[0].arguments).pattern, 'DEVIN_CONNECT');
  });

  it('coalesce keeps distinct tool_calls separate (each new id starts a call)', () => {
    const acc = [];
    mergeToolCallFragment(acc, { id: 'a', name: 'read_file', arguments: '{"p":' });
    mergeToolCallFragment(acc, { arguments: '"1"}' });
    mergeToolCallFragment(acc, { id: 'b', name: 'grep_repo', arguments: '{"q":"x"}' });
    assert.equal(acc.length, 2);
    assert.deepEqual(acc[0], { id: 'a', name: 'read_file', arguments: '{"p":"1"}' });
    assert.deepEqual(acc[1], { id: 'b', name: 'grep_repo', arguments: '{"q":"x"}' });
  });

  it('dumpMeta also surfaces top-level frame fields (e.g. actual_model_uid)', () => {
    // Top-level string fields like actual_model_uid (the concrete model that
    // served a router request) are discoverable via the same hook.
    const payload = Buffer.concat([
      writeStringField(1, 'bot-1'),
      writeStringField(11, 'claude-opus-4-8'), // pretend actual_model_uid at #11
      writeVarintField(5, 2),                  // stop_reason
    ]);
    assert.equal(decodeFrame(payload).frameDump, undefined); // off by default
    const d = decodeFrame(payload, { dumpMeta: true });
    assert.equal(d.frameDump[11], 'claude-opus-4-8');
    assert.equal(d.frameDump[5], 2);
    // binary / oversized fields are not stringified into the dump
    const big = Buffer.concat([writeStringField(1, 'x'.repeat(100))]);
    assert.equal(decodeFrame(big, { dumpMeta: true }).frameDump?.[1], undefined);
  });

  it('dumpMeta recursively decodes inner fields of non-printable top-level sub-messages (#28 calibration)', () => {
    // The recurring #28 trailer is a 186b usage/billing/stop-metadata block the
    // flat frameDump could only mark "<msg Nb>". subDump exposes its inner
    // {tag: {kind, preview}} so `calibrate:devin` surfaces the guts in one run.
    const trailer = Buffer.concat([
      writeStringField(1, 'stop'),   // inner string → stop-reason / model-id candidate
      writeVarintField(3, 1200),     // inner varint → billing/usage candidate
      writeVarintField(4, 34),       // inner varint → billing/usage candidate
    ]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(28, trailer)]);
    assert.equal(decodeFrame(payload).subDump, undefined); // off by default
    const d = decodeFrame(payload, { dumpMeta: true });
    // presence still marked in the flat dump (contract unchanged)
    assert.match(String(d.frameDump[28]), /^<msg \d+b>$/);
    // inner fields now decoded under subDump keyed by the top-level tag
    assert.deepEqual(d.subDump[28][1], { kind: 'string', preview: 'stop' });
    assert.deepEqual(d.subDump[28][3], { kind: 'varint', preview: 1200 });
    assert.deepEqual(d.subDump[28][4], { kind: 'varint', preview: 34 });
  });

  it('subDump recurses one level deeper into nested messages (#28.2 Response Statistics counters)', () => {
    // PAID-1 2026-07-03 capture: #28 is a "Response Statistics" container whose
    // real usage/billing counters live in a NESTED message at #28.2, one level
    // below the flat decode. subDump must descend and attach them under `.fields`.
    const stats = Buffer.concat([
      writeVarintField(3, 1200),   // e.g. completion tokens
      writeVarintField(4, 34),     // e.g. credit_cost
    ]);
    const trailer = Buffer.concat([
      writeStringField(1, 'Response Statistics'), // label string
      writeMessageField(2, stats),                // nested stats message
    ]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(28, trailer)]);
    const d = decodeFrame(payload, { dumpMeta: true });
    assert.deepEqual(d.subDump[28][1], { kind: 'string', preview: 'Response Statistics' });
    // #28.2 marked as a message AND its inner counters decoded under .fields
    assert.equal(d.subDump[28][2].kind, 'message');
    assert.deepEqual(d.subDump[28][2].fields[3], { kind: 'varint', preview: 1200 });
    assert.deepEqual(d.subDump[28][2].fields[4], { kind: 'varint', preview: 34 });
  });

  it('subDump retains the FULL raw-hex of every inner sub-message (D1: single-capture offline tag recovery)', () => {
    // The 48-char preview alone dropped the tail of #28.2's counter block on the
    // last capture. Retaining complete raw-hex means one text-only PAID capture is
    // enough to reverse ALL inner tags offline — no per-field probe loop.
    const stats = Buffer.concat([
      writeVarintField(3, 1200),
      writeVarintField(4, 34),
    ]);
    const trailer = Buffer.concat([
      writeStringField(1, 'Response Statistics'),
      writeMessageField(2, stats),
    ]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(28, trailer)]);
    const d = decodeFrame(payload, { dumpMeta: true });
    // the nested #28.2 message node carries the exact bytes, losslessly
    assert.equal(d.subDump[28][2].raw, stats.toString('hex'));
    // and the raw round-trips back to the same fields (offline re-decode works)
    assert.ok(d.subDump[28][2].raw.length > 0);
    assert.equal(Buffer.from(d.subDump[28][2].raw, 'hex').toString('hex'), stats.toString('hex'));
  });

  it('subDump recursion is depth-capped so a deeply nested / adversarial blob cannot recurse unbounded', () => {
    // Build 6 levels of nesting; SUB_DUMP_MAX_DEPTH (4) must stop decoding before
    // the deepest, leaving it as a presence-only "<msg Nb>" with no `.fields`.
    let buf = Buffer.concat([writeVarintField(1, 7)]);
    for (let i = 0; i < 6; i++) buf = Buffer.concat([writeMessageField(2, buf)]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(28, buf)]);
    const d = decodeFrame(payload, { dumpMeta: true });
    // walk down .fields; at some point a message node must lack `.fields` (capped)
    let node = d.subDump[28][2];
    let depth = 1;
    while (node && node.fields && node.fields[2]) { node = node.fields[2]; depth++; }
    assert.ok(depth <= 4, `recursion capped at <=4 levels, got ${depth}`);
  });

  it('subDump skips a sub-message that is not valid protobuf (opaque encrypted blob) without throwing', () => {
    // An opaque/encrypted trailer must never crash the hot decode path — it is
    // silently left as presence-only in the flat dump.
    const opaque = Buffer.from([0xff, 0xff, 0xff, 0x07, 0x80]); // not parseable as fields
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(28, opaque)]);
    const d = decodeFrame(payload, { dumpMeta: true });
    assert.match(String(d.frameDump[28]), /^<msg \d+b>$/); // presence noted
    assert.equal(d.subDump?.[28], undefined);              // inner not decoded, no throw
  });

  it('billing only includes keys whose tags are actually present in the frame', () => {
    // A free / partially-billed turn omits zero-valued fields entirely; decode
    // must surface only what's on the wire, never invent zeros.
    const billingTags = { credit_cost: 10, committed_credit_cost: 11, committed_acu_cost: 12 };
    const meta = Buffer.concat([
      writeVarintField(2, 386), writeVarintField(3, 48),
      writeVarintField(11, 1400), // only committed_credit_cost present
    ]);
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeMessageField(7, meta)]);
    assert.deepEqual(decodeFrame(payload, { billingTags }).billing, { committed_credit_cost: 1400 });
  });

  it('parseBillingTagMap: off when unset, parses pairs, rejects garbage and unknown keys', () => {
    const { parseBillingTagMap } = __testing;
    assert.equal(parseBillingTagMap({}), null);
    assert.equal(parseBillingTagMap({ DEVIN_CONNECT_BILLING_TAGS: '   ' }), null);
    assert.deepEqual(
      parseBillingTagMap({ DEVIN_CONNECT_BILLING_TAGS: 'credit_cost=10, committed_acu_cost=12' }),
      { credit_cost: 10, committed_acu_cost: 12 },
    );
    // unknown key dropped, non-int tag dropped, negative dropped → null (nothing valid)
    assert.equal(
      parseBillingTagMap({ DEVIN_CONNECT_BILLING_TAGS: 'bogus_key=5,credit_cost=abc,committed_acu_cost=-1' }),
      null,
    );
    // a typo'd tag is skipped but valid siblings survive
    assert.deepEqual(
      parseBillingTagMap({ DEVIN_CONNECT_BILLING_TAGS: 'credit_cost=10,committed_credit_cost=xx' }),
      { credit_cost: 10 },
    );
  });

  it('reads the finish signal from field #5', () => {
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeVarintField(5, 2)]);
    assert.equal(decodeFrame(payload).finish, 2);
  });

  it('returns empties for a metadata-only frame', () => {
    const payload = Buffer.concat([
      writeStringField(1, 'bot-123'),
      writeMessageField(7, writeVarintField(6, 6)),
    ]);
    const d = decodeFrame(payload);
    assert.equal(d.content, '');
    assert.equal(d.reasoning, '');
    assert.equal(d.finish, null);
    assert.equal(d.usage, null);
  });
});

describe('decodeFrame malformed-frame resilience (FRAME-1)', () => {
  // A malformed upstream frame must degrade to an empty delta, never throw:
  // decodeFrame runs inside res.on('data'), so a synchronous throw there escapes
  // the streamChat generator's try/finally → uncaughtException → process.exit(1),
  // taking down every concurrent tenant over one bad frame.
  const EMPTY = { content: '', reasoning: '', finish: null, usage: null, billing: null };

  it('returns an empty delta (no throw) on an unknown wire type at the top level', () => {
    // wire type 7 is illegal; parseFields throws "Unknown wire type 7".
    // tag = (field<<3)|7 = (1<<3)|7 = 15.
    const payload = Buffer.from([0x0f]);
    let d;
    assert.doesNotThrow(() => { d = decodeFrame(payload); });
    assert.deepEqual(d, EMPTY);
  });

  it('returns an empty delta (no throw) on a truncated varint at the top level', () => {
    // tag byte says field #1 varint (0x08), then a varint with the continuation
    // bit set but no following byte → "Truncated varint".
    const payload = Buffer.from([0x08, 0x80]);
    let d;
    assert.doesNotThrow(() => { d = decodeFrame(payload); });
    assert.deepEqual(d, EMPTY);
  });

  it('returns an empty delta (no throw) on a truncated length-delimited field', () => {
    // field #3 (content), wire type 2 → tag 0x1a; declared length 10 but only 3
    // bytes follow → "truncated len-delim field".
    const payload = Buffer.concat([Buffer.from([0x1a, 0x0a]), Buffer.from('abc')]);
    let d;
    assert.doesNotThrow(() => { d = decodeFrame(payload); });
    assert.deepEqual(d, EMPTY);
  });

  it('does not throw when the #7 metadata sub-message body is malformed protobuf', () => {
    // Outer frame parses fine, but the length-delimited #7 payload is itself an
    // illegal wire type (7) → the nested parseFields(meta.value) would throw.
    // Content still decodes; usage degrades to null.
    const payload = Buffer.concat([
      writeStringField(3, 'hello'),
      writeMessageField(7, Buffer.from([0x0f])),
    ]);
    let d;
    assert.doesNotThrow(() => { d = decodeFrame(payload); });
    assert.equal(d.content, 'hello');
    assert.equal(d.usage, null);
    assert.equal(d.billing, null);
  });

  it('processes valid fields following the same rules (well-formed frame unaffected)', () => {
    // Regression guard: the try/catch must not swallow good frames.
    const payload = Buffer.concat([writeStringField(3, 'ok'), writeVarintField(5, 2)]);
    const d = decodeFrame(payload);
    assert.equal(d.content, 'ok');
    assert.equal(d.finish, 2);
  });
});

describe('mapFinishReason', () => {
  it('maps the live-anchored stop enum (2) to "stop"', () => {
    assert.equal(mapFinishReason(2), 'stop');
  });
  it('returns null when no finish signal was seen', () => {
    assert.equal(mapFinishReason(null), null);
  });
  it('maps max_tokens-style truncation enums to "length"', () => {
    // best-effort defaults for the un-pinned named variants
    assert.equal(mapFinishReason(3), 'length');
    assert.equal(mapFinishReason(4), 'length');
  });
  it('handles BigInt finish values (proto varints decode as BigInt)', () => {
    assert.equal(mapFinishReason(2n), 'stop');
    assert.equal(mapFinishReason(3n), 'length');
  });
  it('falls back to "stop" for unknown values (never an error)', () => {
    assert.equal(mapFinishReason(99), 'stop');
  });
  it('honors DEVIN_CONNECT_STOP_REASON_MAP override (calibrated capture)', () => {
    const env = { DEVIN_CONNECT_STOP_REASON_MAP: '3=stop,7=length,8=content_filter' };
    assert.equal(mapFinishReason(3, env), 'stop');       // overridden from default 'length'
    assert.equal(mapFinishReason(7, env), 'length');
    assert.equal(mapFinishReason(8, env), 'content_filter');
    assert.equal(mapFinishReason(2, env), 'stop');       // anchor still holds
    // garbage in the override is ignored, defaults survive
    const env2 = { DEVIN_CONNECT_STOP_REASON_MAP: '3=bogus,xx=length' };
    assert.equal(mapFinishReason(3, env2), 'length');    // bad value ignored → default
  });
});

describe('classifyUpstreamError', () => {
  it('maps a free-tier /upgrade rejection to MODEL_BLOCKED', () => {
    const r = classifyUpstreamError('Please /upgrade to access claude-opus-4-8');
    assert.equal(r.code, 'MODEL_BLOCKED');
  });
  it('maps "upgrade to access" prose to MODEL_BLOCKED', () => {
    assert.equal(classifyUpstreamError('You must upgrade to access this model').code, 'MODEL_BLOCKED');
  });
  it('maps insufficient credit/quota to QUOTA_EXHAUSTED (account dry-well, not a tier wall)', () => {
    // Distinct from MODEL_BLOCKED: this account ran out of balance and must be
    // cooled down, not treated as a healthy free account hitting a paid model.
    assert.equal(classifyUpstreamError('insufficient credits remaining').code, 'QUOTA_EXHAUSTED');
    assert.equal(classifyUpstreamError('Your account quota has been exceeded').code, 'QUOTA_EXHAUSTED');
    assert.equal(classifyUpstreamError('credit exhausted for this billing cycle').code, 'QUOTA_EXHAUSTED');
  });
  it('still maps a paid-entitlement /upgrade wall to MODEL_BLOCKED (no penalty)', () => {
    assert.equal(classifyUpstreamError('insufficient entitlement for this model').code, 'MODEL_BLOCKED');
    assert.equal(classifyUpstreamError('this model requires a paid plan').code, 'MODEL_BLOCKED');
  });
  it('maps HTTP 401 to UNAUTHORIZED', () => {
    assert.equal(classifyUpstreamError('', null, 401).code, 'UNAUTHORIZED');
  });
  it('maps permission_denied code to UNAUTHORIZED', () => {
    assert.equal(classifyUpstreamError('nope', 'permission_denied').code, 'UNAUTHORIZED');
  });
  it('maps HTTP 429 to RATE_LIMITED', () => {
    assert.equal(classifyUpstreamError('', null, 429).code, 'RATE_LIMITED');
  });
  it('maps resource_exhausted text to RATE_LIMITED', () => {
    assert.equal(classifyUpstreamError('resource_exhausted: too many requests').code, 'RATE_LIMITED');
  });
  it('falls back to the upstream code, else UPSTREAM_ERROR', () => {
    assert.equal(classifyUpstreamError('boom', 'weird_code').code, 'weird_code');
    assert.equal(classifyUpstreamError('boom').code, 'UPSTREAM_ERROR');
  });
  it('prefers MODEL_BLOCKED even on a non-200 status', () => {
    // an /upgrade message returned with a 403 is still an entitlement issue
    assert.equal(classifyUpstreamError('/upgrade required', null, 403).code, 'MODEL_BLOCKED');
  });
  it('classifies high-demand capacity throttling as CAPACITY, NOT UNAUTHORIZED (P0 #56)', () => {
    // LIVE-OBSERVED: the upstream wraps a transient "model is busy" in a 401/403
    // auth-shell: HTTP 401 body "We're currently facing high demand for this
    // model. Please try again later." Misreading it as UNAUTHORIZED triggers an
    // auto re-login → fresh token is STILL busy → second UNAUTHORIZED gets
    // mislabeled MODEL_BLOCKED → the free model is cooled down forever over a
    // retryable hiccup. CAPACITY must win even with a 401/403 status.
    assert.equal(classifyUpstreamError("We're currently facing high demand for this model. Please try again later.", null, 401).code, 'CAPACITY');
    assert.equal(classifyUpstreamError("We're currently facing high demand for this model. Please try again later.", null, 403).code, 'CAPACITY');
    assert.equal(classifyUpstreamError('the model is currently overloaded', null, 503).code, 'CAPACITY');
    assert.equal(classifyUpstreamError('server is busy, try again later').code, 'CAPACITY');
    assert.equal(classifyUpstreamError('model is busy').code, 'CAPACITY');
  });
  it('does NOT let a real auth failure read as CAPACITY', () => {
    // permission_denied / invalid token with no capacity wording stays UNAUTHORIZED
    assert.equal(classifyUpstreamError('permission_denied', 'permission_denied').code, 'UNAUTHORIZED');
    assert.equal(classifyUpstreamError('invalid session token', null, 401).code, 'UNAUTHORIZED');
  });
});

describe('streamChat abort / preconditions', () => {
  it('throws AbortError when the signal is already aborted (no network leak)', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      (async () => {
        for await (const _ of streamChat({
          messages: [{ role: 'user', content: 'hi' }],
          model: 'swe-1-6-slow',
          token: 'devin-session-token$fake.jwt.sig',
          signal: ac.signal,
        })) { /* drain */ }
      })(),
      (err) => err.name === 'AbortError' || err.code === 'ABORT_ERR',
    );
  });

  it('throws NO_TOKEN before any network attempt when token is missing', async () => {
    await assert.rejects(
      (async () => {
        for await (const _ of streamChat({ messages: [], model: 'm', env: {} })) { /* drain */ }
      })(),
      (err) => err.code === 'NO_TOKEN',
    );
  });

  it('fires the absolute deadline against a hung-but-silent upstream (idle timer would never catch a trickle)', async () => {
    // Fake transport: accepts the request, never invokes the response callback,
    // never emits data — i.e. a socket that connected and then hung. The idle
    // timer is long; only the absolute deadline can end this.
    let destroyed = false;
    __setRequestImpl(() => {
      const req = {
        destroyed: false,
        on() { return req; },
        setTimeout() { return req; },   // swallow the idle timer (never fires)
        write() {},
        end() {},
        destroy() { destroyed = true; req.destroyed = true; },
      };
      return req;
    });
    try {
      const t0 = Date.now();
      await assert.rejects(
        (async () => {
          for await (const _ of streamChat({
            messages: [{ role: 'user', content: 'hi' }],
            model: 'swe-1-6-slow',
            token: 'devin-session-token$fake.jwt.sig',
            timeoutMs: 60000,   // idle timer far away
            deadlineMs: 50,     // absolute deadline must fire first
          })) { /* drain */ }
        })(),
        (err) => err.code === 'TIMEOUT' && /deadline/.test(err.message),
      );
      assert.ok(Date.now() - t0 < 5000, 'ended promptly via the absolute deadline');
      assert.equal(destroyed, true, 'destroyed the hung request');
    } finally {
      __setRequestImpl(null);
    }
  });
});

describe('isRetryable', () => {
  it('retries transient network codes', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'TIMEOUT', 'EPIPE']) {
      assert.equal(isRetryable({ code }), true, code);
    }
  });
  it('retries server "unavailable" but NOT RATE_LIMITED or internal', () => {
    assert.equal(isRetryable({ code: 'unavailable' }), true);
    // RATE_LIMITED: in-process retry would triple load on a throttled upstream
    // before the pool cooldown applies — let cooldown + failover handle it.
    assert.equal(isRetryable({ code: 'RATE_LIMITED' }), false);
    // internal: upstream returns it for PERMANENT client mistakes (bad
    // fingerprint / gzipped body) — retrying just burns attempts.
    assert.equal(isRetryable({ code: 'internal' }), false);
  });
  it('retries CAPACITY even though it arrives with a 401/403 status (P0 #56)', () => {
    // CAPACITY is "model busy, try again" — transient. The code is checked before
    // the status, so a 401/403-shelled capacity error is still retried in place
    // (same token) instead of triggering re-login.
    assert.equal(isRetryable({ code: 'CAPACITY' }), true);
    assert.equal(isRetryable({ code: 'CAPACITY', status: 401 }), true);
    assert.equal(isRetryable({ code: 'CAPACITY', status: 403 }), true);
  });
  it('retries HTTP 5xx (except 501) and not 4xx', () => {
    assert.equal(isRetryable({ status: 500 }), true);
    assert.equal(isRetryable({ status: 503 }), true);
    assert.equal(isRetryable({ status: 501 }), false);
    assert.equal(isRetryable({ status: 429 }), false); // status-only 429: code path handles it
    assert.equal(isRetryable({ status: 400 }), false);
  });
  it('does not retry terminal codes', () => {
    assert.equal(isRetryable({ code: 'MODEL_BLOCKED' }), false);
    assert.equal(isRetryable({ code: 'QUOTA_EXHAUSTED' }), false);
    assert.equal(isRetryable({ code: 'UNAUTHORIZED' }), false);
    assert.equal(isRetryable(null), false);
  });
});

const RED_DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('getImageFieldTag (vision gate)', () => {
  it('returns 0 (disabled) when unset', () => {
    assert.equal(getImageFieldTag({}), 0);
  });
  it('parses a positive integer tag', () => {
    assert.equal(getImageFieldTag({ DEVIN_CONNECT_IMAGE_TAG: '6' }), 6);
  });
  it('rejects non-numeric / non-positive / out-of-range values (→ 0)', () => {
    assert.equal(getImageFieldTag({ DEVIN_CONNECT_IMAGE_TAG: 'abc' }), 0);
    assert.equal(getImageFieldTag({ DEVIN_CONNECT_IMAGE_TAG: '0' }), 0);
    assert.equal(getImageFieldTag({ DEVIN_CONNECT_IMAGE_TAG: '-3' }), 0);
    assert.equal(getImageFieldTag({ DEVIN_CONNECT_IMAGE_TAG: '999999999' }), 0);
  });
});

describe('getToolDefTags (native tool-def gate)', () => {
  it('returns null (disabled → prompt emulation) when unset', () => {
    assert.equal(getToolDefTags({}), null);
    assert.equal(getToolDefTags({ DEVIN_CONNECT_TOOL_DEF_TAGS: '  ' }), null);
  });
  it('parses a 4-tuple "outer,name,description,schema" (parameters is the primary key, schema kept as back-compat alias)', () => {
    assert.deepEqual(
      getToolDefTags({ DEVIN_CONNECT_TOOL_DEF_TAGS: '10,1,2,3' }),
      { outer: 10, name: 1, description: 2, parameters: 3, schema: 3 },
    );
  });
  it('key=val form: outer defaults to the VFB #10 when omitted', () => {
    assert.deepEqual(
      getToolDefTags({ DEVIN_CONNECT_TOOL_DEF_TAGS: 'name=1,description=2,parameters=3' }),
      { outer: 10, name: 1, description: 2, parameters: 3, schema: 3 },
    );
  });
  it('key=val form: strict is optional and only kept when a valid tag is given', () => {
    const withStrict = getToolDefTags({ DEVIN_CONNECT_TOOL_DEF_TAGS: 'name=1,description=2,parameters=3,strict=6' });
    assert.equal(withStrict.strict, 6);
    const noStrict = getToolDefTags({ DEVIN_CONNECT_TOOL_DEF_TAGS: 'name=1,description=2,parameters=3' });
    assert.equal(noStrict.strict, undefined);
  });
  it('rejects Devin-proprietary keys (custom_tool/defer_loading) silently — they are never emitted', () => {
    // A stray proprietary key must not break the gate; it is ignored, and the
    // mandatory trio still resolves.
    const t = getToolDefTags({ DEVIN_CONNECT_TOOL_DEF_TAGS: 'name=1,description=2,parameters=3,custom_tool=4,defer_loading=5' });
    assert.deepEqual(t, { outer: 10, name: 1, description: 2, parameters: 3, schema: 3 });
  });
  it('key=val form fails closed when a mandatory inner tag is missing', () => {
    assert.equal(getToolDefTags({ DEVIN_CONNECT_TOOL_DEF_TAGS: 'name=1,description=2' }), null); // no parameters
    assert.equal(getToolDefTags({ DEVIN_CONNECT_TOOL_DEF_TAGS: 'outer=10,name=1' }), null);
  });
  it('fails closed (→ null) on wrong arity or garbage', () => {
    assert.equal(getToolDefTags({ DEVIN_CONNECT_TOOL_DEF_TAGS: '10,1,2' }), null);
    assert.equal(getToolDefTags({ DEVIN_CONNECT_TOOL_DEF_TAGS: '10,1,2,3,4' }), null);
    assert.equal(getToolDefTags({ DEVIN_CONNECT_TOOL_DEF_TAGS: '10,1,x,3' }), null);
    assert.equal(getToolDefTags({ DEVIN_CONNECT_TOOL_DEF_TAGS: '0,1,2,3' }), null);
  });
});

describe('native tool defs in the request (gated)', () => {
  const TOOLS = [{
    type: 'function',
    function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
  }];

  it('emits NO tools field by default (tag map unset → prompt emulation)', () => {
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', messages: [{ role: 'user', content: 'x' }], tools: TOOLS,
    });
    // #10 is the calibrated tools tag; with the gate off, none must be present.
    assert.equal(getAllFields(parseFields(proto), 10).length, 0);
  });

  it('encodes a ToolDef when the inner tags are calibrated', () => {
    const prev = process.env.DEVIN_CONNECT_TOOL_DEF_TAGS;
    process.env.DEVIN_CONNECT_TOOL_DEF_TAGS = '10,1,2,3';
    try {
      const proto = buildGetChatMessageRequest({
        token: TOKEN, model: 'm', messages: [{ role: 'user', content: 'x' }], tools: TOOLS,
      });
      const toolFields = getAllFields(parseFields(proto), 10).filter(f => f.wireType === 2);
      assert.equal(toolFields.length, 1, 'one ToolDef emitted at #10');
      const td = parseFields(toolFields[0].value);
      assert.equal(getField(td, 1, 2).value.toString('utf8'), 'get_weather');
      assert.equal(getField(td, 2, 2).value.toString('utf8'), 'Get weather');
      assert.deepEqual(JSON.parse(getField(td, 3, 2).value.toString('utf8')), TOOLS[0].function.parameters);
    } finally {
      if (prev === undefined) delete process.env.DEVIN_CONNECT_TOOL_DEF_TAGS;
      else process.env.DEVIN_CONNECT_TOOL_DEF_TAGS = prev;
    }
  });

  it('emits the strict varint only when the strict tag is calibrated AND function.strict is true', () => {
    const prev = process.env.DEVIN_CONNECT_TOOL_DEF_TAGS;
    process.env.DEVIN_CONNECT_TOOL_DEF_TAGS = 'name=1,description=2,parameters=3,strict=6';
    try {
      const strictTool = [{ type: 'function', function: { name: 'f', description: 'd', parameters: {}, strict: true } }];
      const proto = buildGetChatMessageRequest({
        token: TOKEN, model: 'm', messages: [{ role: 'user', content: 'x' }], tools: strictTool,
      });
      const td = parseFields(getAllFields(parseFields(proto), 10)[0].value);
      assert.equal(Number(getField(td, 6, 0).value), 1, 'strict=6 varint emitted as 1');

      // strict:false (or absent) → no #6 field
      const noStrict = buildGetChatMessageRequest({
        token: TOKEN, model: 'm', messages: [{ role: 'user', content: 'x' }],
        tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }],
      });
      const td2 = parseFields(getAllFields(parseFields(noStrict), 10)[0].value);
      assert.equal(getField(td2, 6, 0), null, 'no strict field when function.strict absent');
    } finally {
      if (prev === undefined) delete process.env.DEVIN_CONNECT_TOOL_DEF_TAGS;
      else process.env.DEVIN_CONNECT_TOOL_DEF_TAGS = prev;
    }
  });

  it('defaults outer to the VFB #10 when the gate omits it (key=val form)', () => {
    const prev = process.env.DEVIN_CONNECT_TOOL_DEF_TAGS;
    process.env.DEVIN_CONNECT_TOOL_DEF_TAGS = 'name=1,description=2,parameters=3';
    try {
      const proto = buildGetChatMessageRequest({
        token: TOKEN, model: 'm', messages: [{ role: 'user', content: 'x' }], tools: TOOLS,
      });
      // outer defaulted to 10 → ToolDef rides at #10 exactly as the positional form.
      assert.equal(getAllFields(parseFields(proto), 10).filter(f => f.wireType === 2).length, 1);
    } finally {
      if (prev === undefined) delete process.env.DEVIN_CONNECT_TOOL_DEF_TAGS;
      else process.env.DEVIN_CONNECT_TOOL_DEF_TAGS = prev;
    }
  });
});

describe('parseToolCallTagMap (native tool-call decode gate)', () => {
  it('returns null when unset', () => {
    assert.equal(__testing.parseToolCallTagMap({}), null);
  });
  it('parses key=tag pairs and requires the outer tag', () => {
    assert.deepEqual(
      __testing.parseToolCallTagMap({ DEVIN_CONNECT_TOOL_CALL_TAGS: 'outer=12,id=4,name=1,arguments_json=3' }),
      { outer: 12, id: 4, name: 1, arguments_json: 3 },
    );
    // no `outer` → unusable → null
    assert.equal(__testing.parseToolCallTagMap({ DEVIN_CONNECT_TOOL_CALL_TAGS: 'id=4,name=1' }), null);
  });
  it('ignores unknown keys and bad tags', () => {
    assert.deepEqual(
      __testing.parseToolCallTagMap({ DEVIN_CONNECT_TOOL_CALL_TAGS: 'outer=12,bogus=9,name=x' }),
      { outer: 12 },
    );
  });
  it('parses the CONFIRMED calibrated tags (static disasm 2026-07-04, all 7 subfields)', () => {
    // verified-from-binary: encode_raw @0x1442fe1f0 + merge_field jump table.
    // Locks the value shipped in .devin-connect-calibrated.env so a typo can't
    // silently ship the wrong outer tag (the old #2 guess was wrong; it's #6).
    assert.deepEqual(
      __testing.parseToolCallTagMap({
        DEVIN_CONNECT_TOOL_CALL_TAGS:
          'outer=6,id=1,name=2,arguments_json=3,invalid_json_str=4,invalid_json_err=5,is_custom_tool_call=6',
      }),
      { outer: 6, id: 1, name: 2, arguments_json: 3, invalid_json_str: 4, invalid_json_err: 5, is_custom_tool_call: 6 },
    );
  });
});

describe('decodeFrame native tool calls (gated)', () => {
  const tags = { outer: 12, id: 4, name: 1, arguments_json: 3 };
  function frameWithToolCall() {
    const tc = Buffer.concat([
      writeStringField(1, 'get_weather'),
      writeStringField(3, '{"city":"SF"}'),
      writeStringField(4, 'call_abc'),
    ]);
    return Buffer.concat([
      writeStringField(1, 'bot-1'),
      writeMessageField(12, tc),
    ]);
  }

  it('does NOT decode tool calls without the tag map (emulation stays)', () => {
    const d = decodeFrame(frameWithToolCall());
    assert.equal(d.toolCalls, undefined);
  });

  it('decodes repeated ChatToolCall when tags are calibrated', () => {
    const d = decodeFrame(frameWithToolCall(), { toolCallTags: tags });
    assert.deepEqual(d.toolCalls, [{ name: 'get_weather', arguments: '{"city":"SF"}', id: 'call_abc' }]);
  });

  it('decodes multiple tool calls from repeated fields', () => {
    const mk = (name, args, id) => writeMessageField(12, Buffer.concat([
      writeStringField(1, name), writeStringField(3, args), writeStringField(4, id),
    ]));
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), mk('a', '{}', 'c1'), mk('b', '{"k":1}', 'c2')]);
    const d = decodeFrame(payload, { toolCallTags: tags });
    assert.equal(d.toolCalls.length, 2);
    assert.equal(d.toolCalls[1].name, 'b');
    assert.equal(d.toolCalls[1].id, 'c2');
  });

  // ── Fault tolerance: response-side ChatToolCall structure (NW1 §2) ──────────
  // Tags below are EXAMPLES only (free tier never emits a tool call, so the real
  // wire tags are uncalibrated/UNVERIFIED). They exercise the decoder's tolerance
  // contract, not a calibrated layout.
  const ftags = {
    outer: 12, id: 4, arguments_json: 3,
    is_custom_tool_call: 5, invalid_json_str: 6, invalid_json_err: 7,
  };
  const tcField = (parts) => writeMessageField(12, Buffer.concat(parts));

  it('decodes is_custom_tool_call (bool) alongside id + arguments', () => {
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), tcField([
      writeStringField(4, 'call_x'),
      writeStringField(3, '{"q":1}'),
      writeVarintField(5, 1), // is_custom_tool_call = true
    ])]);
    const d = decodeFrame(payload, { toolCallTags: ftags });
    assert.equal(d.toolCalls.length, 1);
    assert.equal(d.toolCalls[0].id, 'call_x');
    assert.equal(d.toolCalls[0].arguments, '{"q":1}');
    assert.equal(d.toolCalls[0].isCustom, true);
  });

  it('falls back to {} when only invalid_json_str/err are present (upstream malformed-args contract)', () => {
    // arguments_json absent, the model emitted unparseable args the upstream kept
    // in invalid_json_str → emit {} placeholder, preserve the raw + error.
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), tcField([
      writeStringField(4, 'call_bad'),
      writeStringField(6, '{city:"SF"'),                 // invalid_json_str (no quotes/closing)
      writeStringField(7, 'expected property name'),      // invalid_json_err
    ])]);
    const d = decodeFrame(payload, { toolCallTags: ftags });
    assert.equal(d.toolCalls.length, 1);
    assert.equal(d.toolCalls[0].id, 'call_bad');
    assert.equal(d.toolCalls[0].arguments, '{}');          // safe placeholder
    assert.deepEqual(d.toolCalls[0].invalidJson, { str: '{city:"SF"', err: 'expected property name' });
  });

  it('downgrades unparseable arguments_json to {} when an invalid signal co-exists', () => {
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), tcField([
      writeStringField(4, 'call_dg'),
      writeStringField(3, 'not json at all'),  // arguments_json present but invalid
      writeStringField(7, 'unexpected token'), // invalid_json_err signal present
    ])]);
    const d = decodeFrame(payload, { toolCallTags: ftags });
    assert.equal(d.toolCalls[0].arguments, '{}');
    assert.equal(d.toolCalls[0].invalidJson.str, 'not json at all'); // raw kept
    assert.equal(d.toolCalls[0].invalidJson.err, 'unexpected token');
  });

  it('keeps raw arguments_json (never drops data) when unparseable and NO invalid signal', () => {
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), tcField([
      writeStringField(4, 'call_raw'),
      writeStringField(3, '{partial'),  // unparseable, but no invalid_json_* fields
    ])]);
    const d = decodeFrame(payload, { toolCallTags: ftags });
    assert.equal(d.toolCalls[0].arguments, '{partial'); // preserved verbatim
    assert.equal(d.toolCalls[0].invalidJson, undefined);
  });

  it('never throws on a malformed sub-message — skips the bad item, keeps the good one', () => {
    // First delta_tool_calls field carries truncated bytes (a len-delim header that
    // overruns); parseFields throws on it → decoder must swallow + continue.
    const broken = Buffer.from([ (3 << 3) | 2, 0x7f ]); // tag #3 wt2, len=127, no data
    const good = Buffer.concat([writeStringField(4, 'ok'), writeStringField(3, '{"a":1}')]);
    const payload = Buffer.concat([
      writeStringField(1, 'bot-1'),
      writeMessageField(12, broken),
      writeMessageField(12, good),
    ]);
    let d;
    assert.doesNotThrow(() => { d = decodeFrame(payload, { toolCallTags: ftags }); });
    assert.equal(d.toolCalls.length, 1);
    assert.equal(d.toolCalls[0].id, 'ok');
  });

  it('drops an empty sub-message (no phantom tool call manufactured)', () => {
    const payload = Buffer.concat([
      writeStringField(1, 'bot-1'),
      writeMessageField(12, writeVarintField(5, 0)), // only is_custom=false, nothing else
    ]);
    const d = decodeFrame(payload, { toolCallTags: ftags });
    // isCustom alone is not enough to count as a call → no toolCalls surfaced.
    assert.equal(d.toolCalls, undefined);
  });

  it('recovers the function name via single-tool reverse-lookup (response item carries no name)', () => {
    // Response-side ChatToolCall has no `name` (NW1 §2). When exactly one tool was
    // offered, the call is unambiguously that tool → opts.toolNames supplies it.
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), tcField([
      writeStringField(4, 'call_only'),
      writeStringField(3, '{"loc":"NYC"}'),
    ])]);
    const d = decodeFrame(payload, { toolCallTags: ftags, toolNames: ['get_weather'] });
    assert.equal(d.toolCalls[0].name, 'get_weather');
    assert.equal(d.toolCalls[0].id, 'call_only');
    // Ambiguous (more than one tool) → no name guessed, left for the 'unknown' default.
    const d2 = decodeFrame(payload, { toolCallTags: ftags, toolNames: ['a', 'b'] });
    assert.equal(d2.toolCalls[0].name, undefined);
  });
});

describe('decodeFrame thinking signature (gated)', () => {
  // delta_signature is a top-level string at an UNKNOWN tag (free tier never
  // emits it). Pick #8 here only as an example tag — NOT a calibrated value.
  const SIG_TAG = 8, TYPE_TAG = 10, TID_TAG = 11;
  const SIG = 'ErUBCkYIBxg...base64-opaque...=='; // shape of an Anthropic signature

  function frameWithSignature({ sig = SIG, type, tid } = {}) {
    const parts = [writeStringField(1, 'bot-1'), writeStringField(SIG_TAG, sig)];
    if (type != null) parts.push(writeVarintField(TYPE_TAG, type));
    if (tid != null) parts.push(writeStringField(TID_TAG, tid));
    return Buffer.concat(parts);
  }

  it('does NOT decode a signature without the tag map (zero regression)', () => {
    const d = decodeFrame(frameWithSignature());
    assert.equal(d.signature, undefined);
  });

  it('decodes delta_signature verbatim when the tag is calibrated', () => {
    const d = decodeFrame(frameWithSignature(), { signatureTags: { signature: SIG_TAG } });
    assert.deepEqual(d.signature, { text: SIG });
  });

  it('preserves the opaque payload byte-for-byte (no printable filter on signature)', () => {
    // A real signature is base64 of encrypted bytes; the printable check used for
    // actual_model_uid must NOT be applied here or a round-trip would corrupt it.
    const binSig = Buffer.from([0xff, 0x00, 0x41, 0x80, 0x42]).toString('utf8');
    const d = decodeFrame(
      Buffer.concat([writeStringField(1, 'bot-1'), writeStringField(SIG_TAG, binSig)]),
      { signatureTags: { signature: SIG_TAG } },
    );
    assert.equal(d.signature.text, binSig);
  });

  it('decodes optional signature_type and thinking_id when their tags are pinned', () => {
    const d = decodeFrame(
      frameWithSignature({ type: 1, tid: 'think-abc' }),
      { signatureTags: { signature: SIG_TAG, type: TYPE_TAG, thinkingId: TID_TAG } },
    );
    assert.equal(d.signature.text, SIG);
    assert.equal(d.signature.signatureType, 1);
    assert.equal(d.signature.thinkingId, 'think-abc');
  });

  it('a frame without the signature field yields no signature even when calibrated', () => {
    const payload = Buffer.concat([writeStringField(1, 'bot-1'), writeStringField(3, 'hi')]);
    assert.equal(decodeFrame(payload, { signatureTags: { signature: SIG_TAG } }).signature, undefined);
  });

  it('parseSignatureTagMap: off when unset, requires the signature tag, parses optional tags', () => {
    const { parseSignatureTagMap } = __testing;
    assert.equal(parseSignatureTagMap({}), null);
    // optional tags alone (no signature tag) → null (nothing to surface)
    assert.equal(parseSignatureTagMap({ DEVIN_CONNECT_SIGNATURE_TYPE_TAG: '10' }), null);
    assert.deepEqual(parseSignatureTagMap({ DEVIN_CONNECT_SIGNATURE_TAG: '8' }), { signature: 8 });
    assert.deepEqual(
      parseSignatureTagMap({
        DEVIN_CONNECT_SIGNATURE_TAG: '8',
        DEVIN_CONNECT_SIGNATURE_TYPE_TAG: '10',
        DEVIN_CONNECT_SIGNATURE_THINKING_ID_TAG: '11',
      }),
      { signature: 8, type: 10, thinkingId: 11 },
    );
    // garbage signature tag → null
    assert.equal(parseSignatureTagMap({ DEVIN_CONNECT_SIGNATURE_TAG: 'abc' }), null);
    assert.equal(parseSignatureTagMap({ DEVIN_CONNECT_SIGNATURE_TAG: '-1' }), null);
  });
});

describe('streamChat signature surface (gated, mock transport)', () => {
  const SIG_TAG = 8;

  // Build a fake https.request that streams the given response frames (each a
  // raw GetChatMessageResponse payload) followed by the success trailer.
  function mockTransport(framePayloads) {
    return (opts, cb) => {
      const req = new EventEmitter();
      req.destroyed = false;
      req.setTimeout = () => req;
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        setImmediate(() => {
          for (const p of framePayloads) res.emit('data', wrapEnvelope(p, { compress: false }));
          res.emit('data', endOfStreamEnvelope());
          res.emit('end');
        });
        cb(res);
      };
      req.destroy = () => { req.destroyed = true; };
      return req;
    };
  }

  async function collect(env) {
    const events = [];
    for await (const ev of streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-opus-4-8',
      token: 'devin-session-token$fake.jwt.sig',
      env,
    })) events.push(ev);
    return events;
  }

  it('does NOT yield a signature event when the tag is uncalibrated (zero regression)', async () => {
    __setRequestImpl(mockTransport([
      Buffer.concat([writeStringField(1, 'bot-1'), writeStringField(SIG_TAG, 'sig-xyz')]),
      Buffer.concat([writeStringField(3, 'hello'), writeVarintField(5, 2)]),
    ]));
    try {
      const events = await collect({ DEVIN_CONNECT_TOKEN: 'devin-session-token$fake.jwt.sig' });
      assert.equal(events.find(e => e.type === 'signature'), undefined);
      const finish = events.find(e => e.type === 'finish');
      assert.equal(finish.reasoning_signature, null);
      assert.equal(finish.signature, null);
    } finally { __setRequestImpl(null); }
  });

  it('surfaces a signature delta event + accumulates onto the finish event when calibrated', async () => {
    __setRequestImpl(mockTransport([
      Buffer.concat([writeStringField(SIG_TAG, 'Er')]),
      Buffer.concat([writeStringField(SIG_TAG, 'UBCg')]),
      Buffer.concat([writeStringField(3, 'hello'), writeVarintField(5, 2)]),
    ]));
    try {
      const events = await collect({
        DEVIN_CONNECT_TOKEN: 'devin-session-token$fake.jwt.sig',
        DEVIN_CONNECT_SIGNATURE_TAG: String(SIG_TAG),
      });
      const sigEvents = events.filter(e => e.type === 'signature');
      assert.equal(sigEvents.length, 2);
      assert.deepEqual(sigEvents.map(e => e.reasoning_signature), ['Er', 'UBCg']);
      // Terminal finish carries the FULL concatenated signature, name-aligned with
      // what messages.js round-trips (delta.reasoning_signature → signature_delta).
      const finish = events.find(e => e.type === 'finish');
      assert.equal(finish.reasoning_signature, 'ErUBCg');
      assert.equal(finish.signature.text, 'ErUBCg');
    } finally { __setRequestImpl(null); }
  });
});

describe('streamChat malformed-frame resilience (FRAME-1, mock transport)', () => {
  // End-to-end proof of the FRAME-1 fix: a malformed data frame arriving mid-stream
  // must NOT propagate out of res.on('data') as an uncaughtException. Before the fix
  // decodeFrame threw synchronously inside the data callback, crashing the process
  // and every concurrent tenant; now the bad frame is skipped and the good frames
  // (before and after it) still stream to completion.
  function mockTransportRaw(rawFrames) {
    return (opts, cb) => {
      const req = new EventEmitter();
      req.destroyed = false;
      req.setTimeout = () => req;
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        setImmediate(() => {
          for (const f of rawFrames) res.emit('data', f);
          res.emit('data', endOfStreamEnvelope());
          res.emit('end');
        });
        cb(res);
      };
      req.destroy = () => { req.destroyed = true; };
      return req;
    };
  }

  it('skips a malformed data frame and still yields the surrounding content', async () => {
    // frame 1: valid content. frame 2: an unknown wire type (0x0f) that makes
    // parseFields throw. frame 3: valid content + finish. All wrapped uncompressed.
    const good1 = wrapEnvelope(writeStringField(3, 'before'), { compress: false });
    const bad = wrapEnvelope(Buffer.from([0x0f]), { compress: false });
    const good2 = wrapEnvelope(
      Buffer.concat([writeStringField(3, 'after'), writeVarintField(5, 2)]),
      { compress: false });
    __setRequestImpl(mockTransportRaw([good1, bad, good2]));
    try {
      const events = [];
      // The whole point: this loop must complete normally (no throw/crash).
      for await (const ev of streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'claude-opus-4-8',
        token: 'devin-session-token$fake.jwt.sig',
        env: { DEVIN_CONNECT_TOKEN: 'devin-session-token$fake.jwt.sig' },
      })) events.push(ev);
      const text = events.filter(e => e.type === 'content').map(e => e.text).join('');
      assert.equal(text, 'beforeafter');
      const finish = events.find(e => e.type === 'finish');
      assert.ok(finish, 'stream reached its terminal finish event despite the bad frame');
    } finally { __setRequestImpl(null); }
  });
});

describe('extractInlineImages', () => {
  it('returns [] for string / non-array content', () => {
    assert.deepEqual(extractInlineImages('hi'), []);
    assert.deepEqual(extractInlineImages(null), []);
  });
  it('extracts an Anthropic-style base64 image block', () => {
    const imgs = extractInlineImages([
      { type: 'text', text: 'see this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT } },
    ]);
    assert.deepEqual(imgs, [{ base64_data: RED_DOT, mime_type: 'image/png' }]);
  });
  it('extracts an OpenAI image_url data URL', () => {
    const imgs = extractInlineImages([
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${RED_DOT}` } },
    ]);
    assert.deepEqual(imgs, [{ base64_data: RED_DOT, mime_type: 'image/jpeg' }]);
  });
  it('skips PDF image blocks (text-extracted upstream, not sent as image)', () => {
    const imgs = extractInlineImages([
      { type: 'image', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } },
    ]);
    assert.deepEqual(imgs, []);
  });
  it('ignores remote https image_url (needs async fetch, out of scope for the builder)', () => {
    const imgs = extractInlineImages([
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
    ]);
    assert.deepEqual(imgs, []);
  });
});

describe('encodeImageData', () => {
  it('encodes { base64_data=#1, mime_type=#2 } (Cascade-proven ImageData shape)', () => {
    const buf = __testing.encodeImageData({ base64_data: 'AAAA', mime_type: 'image/png' });
    const f = parseFields(buf);
    assert.equal(getField(f, 1, 2).value.toString('utf8'), 'AAAA');
    assert.equal(getField(f, 2, 2).value.toString('utf8'), 'image/png');
  });
  it('defaults mime_type to image/png', () => {
    const buf = __testing.encodeImageData({ base64_data: 'AAAA' });
    assert.equal(getField(parseFields(buf), 2, 2).value.toString('utf8'), 'image/png');
  });
});

describe('buildGetChatMessageRequest — vision (gated)', () => {
  const visionMsg = {
    role: 'user',
    content: [
      { type: 'text', text: 'what color?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_DOT}` } },
    ],
  };
  // Decode every #3 ChatMessage (there are now several per vision turn) and the
  // top-level #10 ToolDef list.
  const cmsOf = (proto) => getAllFields(parseFields(proto), 3).map(f => parseFields(f.value));
  const topToolDefs = (proto) => getAllFields(parseFields(proto), 10).map(f => parseFields(f.value));
  const roleOf = (cm) => Number(getField(cm, 2, 0)?.value);

  it('does NOT restructure or emit any image when DEVIN_CONNECT_IMAGE_TAG is unset', () => {
    delete process.env.DEVIN_CONNECT_IMAGE_TAG;
    const proto = buildGetChatMessageRequest({ token: TOKEN, model: 'm', messages: [visionMsg] });
    const cms = cmsOf(proto);
    // Gate off → one plain user ChatMessage, image dropped, no restructure leak.
    assert.equal(cms.length, 1, 'single ChatMessage when gate off');
    assert.equal(getField(cms[0], 3, 2).value.toString('utf8'), 'what color?');
    assert.equal(cms[0].filter(f => f.wireType === 2 && f.field > 3).length, 0, 'no image sub-message');
    assert.ok(!cms.some(cm => roleOf(cm) === 4), 'no role=4 tool_result when gate off');
    assert.ok(!cms.some(cm => getField(cm, 7, 2)), 'no #7 tool_call_id when gate off');
    assert.equal(topToolDefs(proto).length, 0, 'no top-level #10 ToolDef leaked when gate off');
  });

  it('gate ON: image rides a role=4 tool_result paired to a role=2 read tool_call', () => {
    // NOTE: the byte STRUCTURE below is VERIFIED-FROM-WIRE (req022 CM#4/CM#5).
    // Whether upstream ACCEPTS this SYNTHETIC minimal structure (no genuine prior
    // tool_call) is UNVERIFIED — pending one paid probe.
    process.env.DEVIN_CONNECT_IMAGE_TAG = '10';
    const proto = buildGetChatMessageRequest({ token: TOKEN, model: 'm', messages: [visionMsg] });
    const cms = cmsOf(proto);
    const call = cms.find(cm => roleOf(cm) === 2 && getField(cm, 6, 2));
    const result = cms.find(cm => roleOf(cm) === 4);
    assert.ok(call && result, 'emits a role=2 tool_call and a role=4 tool_result');
    const tc = parseFields(getField(call, 6, 2).value);
    assert.equal(getField(tc, 2, 2).value.toString('utf8'), 'read', '#6.2 tool name');
    // linkage: #6.1 id === tool_result #7 (mirrors CM#4<->CM#5).
    const callId = getField(tc, 1, 2).value.toString('utf8');
    assert.equal(callId, getField(result, 7, 2).value.toString('utf8'), '#6.1 == #7 linkage');
    assert.match(callId, /^functions\.read:\d+$/, 'synthetic id format');
    const args = JSON.parse(getField(tc, 3, 2).value.toString('utf8'));
    assert.ok(typeof args.file_path === 'string' && args.file_path.length, '#6.3 args has non-empty file_path');
    assert.equal(getField(result, 3, 2).value.toString('utf8'), '[Image 1]');
    const img = parseFields(getField(result, 10, 2).value);
    assert.equal(getField(img, 1, 2).value.toString('utf8'), RED_DOT);
    assert.equal(getField(img, 2, 2).value.toString('utf8'), 'image/png');
    // user text lands on its own role=1 message, BEFORE the pair (order fidelity).
    const userIdx = cms.findIndex(cm => roleOf(cm) === 1 && getField(cm, 3, 2)?.value.toString('utf8') === 'what color?');
    assert.ok(userIdx >= 0 && userIdx < cms.indexOf(call) && cms.indexOf(call) < cms.indexOf(result),
      'order: user text < tool_call < tool_result');
    // sub-gate default ON → synthetic top-level #10 read ToolDef present.
    assert.ok(topToolDefs(proto).some(s => getField(s, 1, 2)?.value.toString('utf8') === 'read'),
      'synthetic read ToolDef injected at top-level #10');
  });

  it('text-only turns are unaffected by the gate being on', () => {
    process.env.DEVIN_CONNECT_IMAGE_TAG = '10';
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', messages: [{ role: 'user', content: 'plain text' }],
    });
    const cms = cmsOf(proto);
    assert.equal(cms.length, 1);
    assert.equal(getField(cms[0], 3, 2).value.toString('utf8'), 'plain text');
    assert.equal(getField(cms[0], 6, 2), null, 'no tool_call on a text-only turn');
    assert.equal(getField(cms[0], 10, 2), null, 'no image on a text-only turn');
    assert.ok(!cms.some(cm => roleOf(cm) === 4), 'no tool_result on a text-only turn');
    assert.equal(topToolDefs(proto).length, 0, 'no synthetic ToolDef when no image pairs');
  });

  it('multi-image: one read pair per image with sequential [Image N] placeholders', () => {
    process.env.DEVIN_CONNECT_IMAGE_TAG = '10';
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', messages: [{
        role: 'user', content: [
          { type: 'text', text: 'compare' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_DOT}` } },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${RED_DOT}` } },
        ],
      }],
    });
    const cms = cmsOf(proto);
    const calls = cms.filter(cm => roleOf(cm) === 2 && getField(cm, 6, 2));
    const results = cms.filter(cm => roleOf(cm) === 4);
    assert.equal(calls.length, 2, 'two tool_calls');
    assert.equal(results.length, 2, 'two tool_results');
    const ids = calls.map(c => getField(parseFields(getField(c, 6, 2).value), 1, 2).value.toString('utf8'));
    assert.deepEqual(ids, ['functions.read:0', 'functions.read:1'], 'distinct sequential ids');
    assert.equal(getField(results[0], 3, 2).value.toString('utf8'), '[Image 1]');
    assert.equal(getField(results[1], 3, 2).value.toString('utf8'), '[Image 2]');
    // each result #7 matches its paired call #6.1
    results.forEach((r, i) => {
      assert.equal(getField(r, 7, 2).value.toString('utf8'), ids[i], `pair ${i} linkage`);
    });
  });

  it('role:tool image message echoes the caller tool_call_id verbatim (never regenerates)', () => {
    process.env.DEVIN_CONNECT_IMAGE_TAG = '10';
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', messages: [{
        role: 'tool', tool_call_id: 'toolu_ABC123',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT } }],
      }],
    });
    const cms = cmsOf(proto);
    const call = cms.find(cm => roleOf(cm) === 2 && getField(cm, 6, 2));
    const result = cms.find(cm => roleOf(cm) === 4);
    const callId = getField(parseFields(getField(call, 6, 2).value), 1, 2).value.toString('utf8');
    assert.equal(callId, 'toolu_ABC123', '#6.1 echoes caller id verbatim');
    assert.equal(getField(result, 7, 2).value.toString('utf8'), 'toolu_ABC123', '#7 echoes caller id verbatim');
  });

  it('sub-gate OFF (DEVIN_CONNECT_IMAGE_TOOLDEF=0): pair still emitted but no synthetic ToolDef', () => {
    process.env.DEVIN_CONNECT_IMAGE_TAG = '10';
    process.env.DEVIN_CONNECT_IMAGE_TOOLDEF = '0';
    const proto = buildGetChatMessageRequest({ token: TOKEN, model: 'm', messages: [visionMsg] });
    const cms = cmsOf(proto);
    assert.ok(cms.some(cm => roleOf(cm) === 4), 'tool_result still emitted');
    assert.ok(!topToolDefs(proto).some(s => getField(s, 1, 2)?.value.toString('utf8') === 'read'),
      'no synthetic read ToolDef when sub-gate off');
    assert.equal(getImageToolDefEnabled({ DEVIN_CONNECT_IMAGE_TOOLDEF: '0' }), false);
    assert.equal(getImageToolDefEnabled({}), true);
  });

  it('does not duplicate the read ToolDef when the native tool-def path already declares read', () => {
    process.env.DEVIN_CONNECT_IMAGE_TAG = '10';
    process.env.DEVIN_CONNECT_TOOL_DEF_TAGS = 'outer=10,name=1,description=2,parameters=3';
    const proto = buildGetChatMessageRequest({
      token: TOKEN, model: 'm', messages: [visionMsg],
      tools: [{ type: 'function', function: { name: 'read', description: 'user read', parameters: { type: 'object' } } }],
    });
    const readDefs = topToolDefs(proto).filter(s => getField(s, 1, 2)?.value.toString('utf8') === 'read');
    assert.equal(readDefs.length, 1, 'exactly one read ToolDef (native wins, synthetic skipped)');
  });
});
