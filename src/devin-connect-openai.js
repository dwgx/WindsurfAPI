/**
 * DEVIN_CONNECT → OpenAI ChatCompletion adapter.
 *
 * Bridges the structured stream from devin-connect.js (content / reasoning /
 * finish / usage events) into the two OpenAI-compatible response shapes the rest
 * of the proxy already emits:
 *
 *   - non-stream: a single `chat.completion` object
 *   - stream:     a sequence of `chat.completion.chunk` SSE frames + [DONE]
 *
 * The output shape is matched field-for-field to the Cascade path in
 * handlers/chat.js (role-priming chunk, reasoning_content before content, a
 * finish_reason:'stop' chunk, then a usage-only chunk) so a client can't tell
 * which backend served the request. Reasoning maps to `reasoning_content`,
 * which OpenAI-style clients hide by default — see handlers/chat.js:737.
 *
 * Pure translation: no network of its own, it only consumes streamChat().
 */

import { randomUUID } from 'crypto';
import { streamChat as realStreamChat, isRetryable, messageText } from './devin-connect.js';
import { ToolCallStreamParser, parseToolCallsFromText, isWeakEmulationModel } from './handlers/tool-emulation.js';
import { log } from './config.js';
import { leakTraceEnabled, thinkMarkersIn, leakSample } from './leak-trace.js';
import { systemFingerprint } from './system-fingerprint.js';
import { applyStop, StopSequenceGate } from './stop-sequences.js';
import { normalizeToolCallArgs, recordArgRepair } from './handlers/cline-compat.js';

// Apply the Cline compat tool-arg shim when active: normalize an arguments
// string @ai-sdk/openai-compatible would reject (empty / whitespace / non-JSON)
// to "{}" so a parameterless tool call isn't silently dropped (vercel/ai#6687).
// A no-op passthrough when inactive → byte-identical for every non-Cline client.
function compatArgs(raw, active) {
  // Inactive → preserve the exact legacy expression (`raw || '{}'`) so the
  // default path is byte-identical.
  if (!active) return raw || '{}';
  // Active → normalize the RAW value (not the pre-coalesced one) so an empty
  // string, whitespace, or malformed JSON is counted as a real repair.
  const fixed = normalizeToolCallArgs(raw);
  const legacy = raw || '{}';
  if (fixed !== legacy) recordArgRepair();
  return fixed;
}

// streamChat is injectable so the adapter can be unit-tested without touching
// the network — mirrors the __set…ForTest convention in windsurf-api.js.
let streamChatImpl = realStreamChat;
export function __setStreamChatForTest(fn) {
  streamChatImpl = typeof fn === 'function' ? fn : realStreamChat;
}

// ── retry-on-empty (fable capacity-jitter self-heal) ────────────────────────
// fable (and other capacity-jittered upstream models) occasionally return a
// COMPLETED turn that carries no answer at all: finish_reason 'stop',
// completion_tokens ≤ 2, and zero content / reasoning / tool_call deltas. This
// is PROBABILISTIC upstream capacity jitter — NOT a deterministic tool-count
// threshold (that theory was disproven; the code never trims tools) and NOT an
// outage (kimi's 502 path is a different fault). The correct heal is to simply
// re-issue the identical request a bounded number of times, since a fresh
// attempt usually lands a real answer.
//
// Because an empty reply yields ONLY a terminal finish event (no content), the
// wrapper below forwards every delta LIVE — zero buffering, zero added latency
// on the overwhelmingly common non-empty path — and merely holds the single
// finish event to decide, once the stream has drained, whether anything real
// was produced. It retries ONLY when the turn emitted literally nothing, so it
// is safe for both the streaming and non-stream callers (which each just
// iterate this wrapper instead of the raw primitive). It deliberately does NOT
// merge into isRetryable() (UPSTREAM_INTERNAL stays non-retryable by design) and
// never trims tools.
function retryOnEmptyEnabled(env = process.env) {
  // Default ON: an empty completion is always a degenerate result and the retry
  // is bounded + only fires when the turn yielded nothing. Only an explicit
  // off-switch disables it.
  const v = String(env.DEVIN_CONNECT_RETRY_ON_EMPTY ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'off' && v !== 'false' && v !== 'no';
}
function retryOnEmptyMax(env = process.env) {
  const raw = Number(env.DEVIN_CONNECT_RETRY_ON_EMPTY_MAX);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}
function retryOnEmptyBaseMs(env = process.env) {
  const raw = Number(env.DEVIN_CONNECT_RETRY_ON_EMPTY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 350;
}

/**
 * Decide whether a drained stream was the pathological empty completion.
 * @param {object} finishEv  the terminal finish event (may be null if none seen)
 * @param {boolean} sawContent  true if any non-empty content/reasoning delta arrived
 */
function isEmptyCompletion(finishEv, sawContent) {
  // The AUTHORITATIVE signal is that the turn produced ZERO usable output:
  // no content delta, no reasoning delta, no tool call. `sawContent` already
  // captures "any non-empty content/reasoning arrived", so if it's true the
  // turn is not empty. This is what actually breaks OpenCode/agent loops.
  if (sawContent || !finishEv) return false;
  // A native/emulated tool call is a real answer even with no visible text.
  if (finishEv.toolCalls && finishEv.toolCalls.length) return false;
  // Only a clean 'stop' (or an absent finish reason — a clean drain with no
  // signal) counts. 'length' / 'tool_calls' / 'content_filter' are real
  // terminal states we must not paper over with a retry.
  if (finishEv.reason != null && finishEv.reason !== 'stop') return false;
  // NOTE: completion_tokens is deliberately NOT used as a gate. Live paid probes
  // (2026-07-08, fable-5-medium + 11–14 tools) showed genuine empty replies with
  // completion_tokens of 3/5/8/9 — an earlier `ct <= 2` gate silently vetoed the
  // retry on every one of them (15/15 empty, zero heals). The empty OUTPUT
  // (sawContent === false with a clean stop) is the real signature; ct only rides
  // the log line below for diagnostics.
  return true;
}

/**
 * Transparent wrapper around streamChatImpl that heals probabilistic empty
 * completions by re-issuing the identical request, and rescues thinking-only
 * traps (swe-1-7 declaring tool intent in reasoning without emitting the call)
 * by appending a corrective user nudge and dropping empty assistant turns.
 * Yields the same event stream as streamChat; on a non-empty turn it is a pass-through.
 */
// There used to be a `rescueThinkingOnly` option here. It was removed in v3.9.20 because it
// had become dead configuration: #241 moved the real gate INSIDE this function (`hasTools`,
// derived from the request), after which both call sites passed a literal `true` and nothing —
// production or test — ever passed `false`. A knob with one reachable value is worse than no
// knob: it reads as a variation point that a reviewer must reason about, and any mutation
// guard aimed at it guards code that cannot be reached (the exact shape of the v3.9.13 medium
// defect). If a caller ever genuinely needs to opt out, add the option back THEN, with a test
// that passes `false` — that test is what makes it a knob rather than decoration.
async function* streamChatWithEmptyRetry(params, { env = process.env } = {}, opts = {}) {
  // Weak models (fable) return DETERMINISTIC empties on complex multi-turn / large
  // system — paid E2E (2026-07-08, 27/27) proved retry never heals them, it only
  // triples the upstream load and burns the account into a 3h rate limit. So for
  // weak models we do NOT retry on empty (short-circuit). Non-weak models keep the
  // bounded retry, where an empty is more likely genuine capacity jitter.
  const weak = isWeakEmulationModel(params?.model || '');
  const max = (retryOnEmptyEnabled(env) && !weak) ? retryOnEmptyMax(env) : 0;
  // Same sanitisation as every sibling knob in this file. Without it `Infinity` and
  // `1e9` both defeated the `rescueAttempt < rescueMax` bound — and the loop uses
  // `continue`, so one client request became an unbounded sequence of upstream calls
  // that burns the account into a rate limit. A non-numeric value produced NaN,
  // which silently turned the whole feature OFF with no log line.
  //
  // The rescue also honours the empty-retry master off switch: an operator who set
  // DEVIN_CONNECT_RETRY_ON_EMPTY=0 to stop speculative re-issues on a rate-limited
  // account meant that, and it would be a surprise for a new speculative re-issue to
  // ignore it. RESCUE_MAX=0 remains the way to disable just this one.
  // Number.isFinite alone is not enough: 1e9 passes it and still hangs the request
  // for hours of upstream calls (measured — the probe had to be killed). A rescue is
  // a speculative re-issue against a live account, so its ceiling is hard.
  const RESCUE_MAX_CEILING = 5;
  const rescueRaw = Number(env.DEVIN_CONNECT_RESCUE_MAX);
  const rescueConfigured = Number.isFinite(rescueRaw) && rescueRaw >= 0
    ? Math.min(rescueRaw, RESCUE_MAX_CEILING)
    : 2;
  // Weak models are excluded for the same measured reason the empty-retry is: paid
  // E2E proved retrying the fable family never heals it and only triples upstream
  // load into a 3h rate limit. Whether fable produces reasoning-only finishes is
  // unproven either way, so this errs toward the documented account-protection.
  const rescueMax = (retryOnEmptyEnabled(env) && !weak) ? rescueConfigured : 0;
  // Cap for the reasoning digest: the nudge quotes only the END of the reasoning,
  // sliced once at nudge time (the consumers already hold the full reasoning text,
  // so per-chunk trimming would only churn the GC). 0 disables the digest; NaN
  // (a genuinely non-numeric value like `abc`) falls back to the default.
  //
  // EMPTY STRING IS NOT NaN: Number('') === 0, so `…MAX_CHARS=` with nothing after
  // the `=` disables the digest rather than falling back. That is the SAME convention
  // the three sibling knobs in this file already have (RETRY_ON_EMPTY_MAX → 0 retries,
  // RETRY_ON_EMPTY_MS → 0 backoff, RESCUE_MAX → rescue off), all measured, so it is
  // left consistent rather than special-cased here — but it is written down because
  // the previous version of this comment claimed the opposite.
  //
  // The ceiling exists for the reason RESCUE_MAX_CEILING does (see rescueConfigured above):
  // Number.isFinite lets `1e9` through. Measured — reasoning of 50000 chars with `1e9` set
  // produced a 50089-byte nudge, i.e. no cap at all, on EVERY rescue of that request.
  // Unlike RESCUE_MAX this cannot hang the request (it is one slice, not an unbounded loop),
  // so the ceiling is not an account-protection bound; it bounds how large a single upstream
  // body one env typo can produce. 32000 is a JUDGEMENT (16x the default, far above any
  // plausible tuning), NOT a measured upstream limit — the real upstream body limit has
  // never been probed.
  //
  // Math.floor is load-bearing, not tidiness. The single consumer is `slice(-n)`, and for
  // 0 < n < 1 slice truncates the argument toward zero: `slice(-0.5)` === `slice(0)` ===
  // THE WHOLE STRING. So a fractional cap under 1 inverted into "no cap at all" — measured,
  // MAX_CHARS=0.5 shipped all 50000 chars, the exact failure the ceiling was added to stop.
  // Clamping alone did not cover it because Math.min(0.5, 32000) is correctly 0.5.
  const DIGEST_MAX_CEILING = 32000;
  const digestRaw = Number(env.DEVIN_CONNECT_RESCUE_REASONING_MAX_CHARS);
  const reasoningDigestMaxChars = Number.isFinite(digestRaw) && digestRaw >= 0
    ? Math.floor(Math.min(digestRaw, DIGEST_MAX_CEILING))
    : 2000;
  let attemptParams = params;
  // Two speculative arms, two budgets (#240). They used to share the loop counter: the
  // rescue arm has always had its own `rescueAttempt`/`rescueMax` pair, but reaching the
  // next iteration via `continue` also advanced the `for (…; ; attempt++)` counter, and
  // `attempt` was what the EMPTY arm's budget was measured against. So a rescue chain
  // silently spent the empty arm's budget — one-way, since the empty arm never touched
  // `rescueAttempt`. Measured at the defaults (max 2, rescue 2): two rescues followed by
  // an empty completion delivered the empty answer to the client with ZERO retries, while
  // the same empty with no preceding rescue healed on the first retry.
  //
  // That the rescue arm carries its own counter is the evidence this was never a "one
  // shared pot" policy — a shared pot would not need the second counter. It was an
  // artifact of counting in the for-header.
  //
  // The TOTAL ceiling is deliberately unchanged: 1 + max + rescueMax upstream calls per
  // client request. That ceiling is the account protection (the fable paid-E2E lesson —
  // retries that never heal only triple upstream load into a rate limit), and it was
  // already reachable before this change in the empty-first order. Splitting the counters
  // makes the empty budget independent of ORDER; it does not raise what may be spent.
  let rescueAttempt = 0;
  let emptyAttempt = 0;
  for (;;) {
    let sawContent = false;
    let sawText = false;
    let sawReasoning = false;
    let sawReasoningText = '';
    let finishEv = null;
    for await (const ev of streamChatImpl(attemptParams)) {
      if (ev.type === 'content' || ev.type === 'reasoning') {
        if (ev.text) {
          sawContent = true;
          if (ev.type === 'content') sawText = true;
          if (ev.type === 'reasoning') {
            sawReasoning = true;
            sawReasoningText += ev.text;
          }
        }
        if (leakTraceEnabled(env)) {
          log.info('LEAK_TRACE stream-event', {
            channel: ev.type,
            think: thinkMarkersIn(ev.text),
            sample: leakSample(ev.text),
            len: ev.text ? ev.text.length : 0,
            reqId: opts?.reqId ?? null,
            account: opts?.account ?? null,
          });
        }
        yield ev;
      } else if (ev.type === 'finish') {
        finishEv = ev; // hold: decide retry after the stream drains
      } else {
        yield ev;
      }
    }
    // swe-1-7 (Kimi K2 fine-tune) intermittently spends the whole turn in reasoning
    // declaring tool intent without emitting the call; a corrective nudge measurably
    // (24/24 live probe) forces emission; empty assistant turns poison upstream into
    // repeating empty turns.
    // NOTE: Rescue triggers only when tools are present in the request (params.tools?.length > 0).
    // Plain chat requests without tools legitimately end in reasoning/text, so rescue is skipped.
    const isStopOrNull = finishEv && (finishEv.reason == null || finishEv.reason === 'stop');
    const hasNoToolCalls = !finishEv?.toolCalls || finishEv.toolCalls.length === 0;
    const hasTools = Boolean(params?.tools?.length);
    if (hasTools && rescueAttempt < rescueMax && isStopOrNull && hasNoToolCalls && sawReasoning && !sawText) {
      rescueAttempt++;
      log.warn(`DEVIN_CONNECT: thinking-only completion (reasoning-only, finish=${finishEv?.reason ?? 'null'}) — rescue retry ${rescueAttempt}/${rescueMax} (nudge appended)`);
      const backoff = retryOnEmptyBaseMs(env) * rescueAttempt;
      if (backoff) await new Promise((r) => setTimeout(r, backoff));
      // Rebuild from the ORIGINAL request every rescue: `params` is never mutated (each
      // rescue constructs a fresh attemptParams below), so it always holds the client's
      // messages. Building from attemptParams instead accumulated — previous rescues'
      // nudges are role:'user' so the filter keeps them, and with a capped digest each
      // stale nudge is ~2.1KB at the 2000-char default: five rescues stacked ~10.4KB
      // of old nudges into the upstream call, each quoting reasoning the model already
      // moved past.
      // One rescue = exactly one fresh nudge.
      const origMsgs = params?.messages || [];
      const filteredMsgs = origMsgs.filter((msg) => {
        if (msg.role !== 'assistant') return true;
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return true;
        return messageText(msg.content).trim() !== '';
      });
      let nudgeText = 'Stop reasoning. Emit the tool call markup now.';
      const digest = reasoningDigestMaxChars > 0 ? sawReasoningText.slice(-reasoningDigestMaxChars).trim() : '';
      if (digest) {
        nudgeText = `Your previous reasoning ended with: """${digest}"""\nStop reasoning. Emit the tool call markup now.`;
      }
      const rescued = [
        ...filteredMsgs,
        { role: 'user', content: nudgeText },
      ];
      attemptParams = { ...attemptParams, messages: rescued };
      // Tell the consumer to discard what it accumulated: the next attempt REPLACES
      // this one, it does not continue it. Without this every rescue attempt's
      // reasoning was concatenated into a single answer — measured
      // "PASS1. PASS2. PASS3. " for three attempts, i.e. the user was shown all
      // three tries glued together. The outer retry loops in toChatCompletion /
      // streamChatCompletion reset their accumulators per THEIR OWN attempt, but the
      // rescue loop lives in here, so they never saw an attempt boundary.
      yield { type: 'attempt_reset' };
      continue;
    }

    if (emptyAttempt < max && isEmptyCompletion(finishEv, sawContent)) {
      emptyAttempt++;
      log.warn(`DEVIN_CONNECT: empty completion (finish=${finishEv.reason ?? 'null'}, completion_tokens=${finishEv.usage?.completion_tokens ?? 'n/a'}) — retry ${emptyAttempt}/${max}`);
      // Backoff still grows with the number of EMPTY retries (base×1, base×2, …), which is
      // what it did before when `attempt` happened to equal that count. Keying it to the
      // shared counter instead would make an unrelated rescue lengthen the next empty wait.
      const backoff = retryOnEmptyBaseMs(env) * emptyAttempt;
      if (backoff) await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    if (weak && finishEv && isEmptyCompletion(finishEv, sawContent)) {
      log.warn(`DEVIN_CONNECT: weak model ${params.model} empty completion (finish=${finishEv.reason ?? 'null'}) — NOT retrying (deterministic, retry would amplify rate limit)`);
    }
    if (finishEv) yield finishEv;
    return;
  }
}

const OBJECT_COMPLETION = 'chat.completion';
const OBJECT_CHUNK = 'chat.completion.chunk';

function newId() {
  return `chatcmpl-${randomUUID().replace(/-/g, '')}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Collect a full DEVIN_CONNECT completion and shape it as a non-streaming
 * `chat.completion` object.
 *
 * @param {object} params  forwarded to streamChat (messages, model, token, …)
 * @param {object} [opts]
 * @param {string} [opts.id]            response id (default chatcmpl-…)
 * @param {number} [opts.created]       unix seconds (default now)
 * @param {string} [opts.displayModel]  model name echoed back to the client
 * @param {boolean} [opts.emulateTools] when true, parse <tool_call> markup out of
 *                                      the buffered answer and surface OpenAI
 *                                      tool_calls (text-emulation, swe-1.6 etc).
 * @returns {Promise<{status:number, body:object}>}
 */
export async function toChatCompletion(params, opts = {}) {
  const { id = newId(), created = nowSeconds(), displayModel, maxRetries = 2, retryBaseMs = 400, emulateTools = false, stop = null, clineCompat = false } = opts;
  const model = displayModel || params.model;

  // Non-stream path buffers the whole answer, so a transient failure (network
  // blip, 5xx, rate limit) can be retried cleanly — a discarded partial buffer
  // never duplicates tokens. Terminal errors (MODEL_BLOCKED / UNAUTHORIZED)
  // are not retryable and throw straight through for the handler to map.
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = null;
  // Per-request billing detail (credit / ACU cost) when the operator has calibrated
  // DEVIN_CONNECT_BILLING_TAGS. devin-connect.js has always yielded this on the
  // finish event; it stopped here because the adapter never forwarded it, so the
  // dashboard's lifetime-credit column could only ever render 0.
  let billing = null;
  // Native tool calls (DEVIN_CONNECT_TOOL_CALL_TAGS calibrated) ride the terminal
  // finish event as ev.toolCalls (devin-connect.js:927). Null/empty on free tier
  // and un-calibrated deployments, where prompt emulation owns tool calls.
  let nativeToolCalls = [];
  for (let attempt = 0; ; attempt++) {
    try {
      content = ''; reasoning = ''; finishReason = 'stop'; usage = null; nativeToolCalls = [];
      for await (const ev of streamChatWithEmptyRetry(params, undefined, opts)) {
        // A rescue attempt REPLACES the previous one; drop what it produced or the
        // client is handed every attempt concatenated.
        if (ev.type === 'attempt_reset') { content = ''; reasoning = ''; nativeToolCalls = []; billing = null; continue; }
        if (ev.type === 'content') content += ev.text;
        else if (ev.type === 'reasoning') reasoning += ev.text;
        else if (ev.type === 'finish') {
          if (ev.reason) finishReason = ev.reason;
          if (ev.usage) usage = ev.usage;
          if (ev.billing) billing = ev.billing;
          if (ev.toolCalls && ev.toolCalls.length) nativeToolCalls = ev.toolCalls;
        }
      }
      break;
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) throw err;
      const backoff = retryBaseMs * 2 ** attempt;
      log.warn(`DEVIN_CONNECT: retryable error (${err.code || err.message}); retry ${attempt + 1}/${maxRetries} in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  // Tool calls come from one of two sources, never both. Native decode wins:
  // when DEVIN_CONNECT_TOOL_CALL_TAGS is calibrated, streamChat surfaces real
  // ChatToolCall structs ({id, name, arguments}) on the finish event, so the
  // text never carries <tool_call> markup to parse. Otherwise (free tier /
  // un-calibrated) the connect models have no native function-calling slot, so
  // tool defs were injected into the prompt (normalizeMessagesForCascade) and
  // the model answers with <tool_call>…</tool_call> markup we pull back out,
  // mirroring the Cascade non-stream path (handlers/chat.js buildToolCalls).
  // proto-openai-03: enforce the client's `stop` locally (the Devin wire has no
  // native stop field). Truncate at the earliest stop-sequence hit and report
  // finish_reason:'stop'. Only meaningful for plain-text answers — a hit means
  // the model was mid-prose, so we also skip tool-call extraction below (a
  // truncated <tool_call> block would be malformed anyway).
  let stopHit = false;
  if (!nativeToolCalls.length) {
    const stopped = applyStop(content, stop);
    if (stopped.hit) { content = stopped.text; finishReason = 'stop'; stopHit = true; }
  }

  let toolCalls = [];
  if (nativeToolCalls.length) {
    // arguments is the raw JSON string off the wire (decodeToolCalls); map it to
    // the same shape parseToolCallsFromText produces so the message builder below
    // is source-agnostic.
    toolCalls = nativeToolCalls.map((tc) => ({
      id: tc.id, name: tc.name, argumentsJson: tc.arguments,
    }));
    finishReason = 'tool_calls';
  } else if (emulateTools && !stopHit) {
    const parsed = parseToolCallsFromText(content, {
      modelKey: params.model, provider: null, route: 'devin_connect',
    });
    if (parsed.toolCalls.length) {
      content = parsed.text;
      toolCalls = parsed.toolCalls;
    }
  }

  // Fallback promotion: promote reasoning to content when no tool calls and no content exist
  // so plain prompts never return an empty visible answer to clients.
  //
  // MOVED, not copied. Emitting the same text as both `content` and
  // `reasoning_content` made every client that renders reasoning show the answer
  // twice — and on the Anthropic route it produced a `thinking` block and a `text`
  // block with byte-identical content, which is exactly what the reporter's own
  // client (kimi CLI) displays. Nothing is lost by dropping the duplicate: the
  // text is still delivered, just once, in the field the client will actually
  // render as the answer.
  // The promoted text must go through the SAME tool-call extraction the content
  // path just ran. The rescue nudge literally asks the model to "Emit the tool call
  // markup now", so a model that complies but keeps writing into the reasoning
  // channel produces exactly this shape — and promoting it unparsed delivered raw
  // `<tool_call>` XML to the client as the visible answer with finish_reason='stop'.
  // The agent loop does not advance and the user sees markup, which is worse than
  // the empty turn the promotion exists to prevent.
  let promotedReasoning = !toolCalls.length && !content && !!reasoning;
  if (promotedReasoning) {
    if (emulateTools && !stopHit) {
      const promotedParse = parseToolCallsFromText(reasoning, {
        modelKey: params.model, provider: null, route: 'devin_connect',
      });
      if (promotedParse.toolCalls.length) {
        // It was a tool call all along. Deliver it as one; keep any surrounding prose
        // as content, and leave reasoning_content in place since nothing was moved
        // out of it into the answer.
        toolCalls = promotedParse.toolCalls;
        content = promotedParse.text;
        finishReason = 'tool_calls';
        promotedReasoning = false;
      } else {
        content = reasoning;
      }
    } else {
      content = reasoning;
    }
  }

  // OpenAI convention: content is a string (may be empty), never undefined.
  const message = { role: 'assistant', content: content || '' };
  if (reasoning && !promotedReasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((tc, i) => ({
      id: tc.id || `call_${i}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: tc.name || 'unknown', arguments: compatArgs(tc.argumentsJson || tc.arguments, clineCompat) },
    }));
    // content is null when the turn is a tool call (the inline text is usually
    // a hallucinated preview the caller shouldn't show).
    message.content = null;
    finishReason = 'tool_calls';
  }

  const body = {
    id,
    object: OBJECT_COMPLETION,
    created,
    model,
    system_fingerprint: systemFingerprint(model),
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage) body.usage = usage;
  // Private field: per-request credit/ACU cost, absent unless the billing tags are
  // calibrated. Under the _windsurf prefix so it can't be mistaken for an OpenAI
  // field by a downstream relay that metering reads.
  if (billing) body._windsurf_billing = billing;
  return { status: 200, body };
}

/**
 * Stream a DEVIN_CONNECT completion as OpenAI `chat.completion.chunk` SSE
 * frames. `send` is the SSE writer used in handlers/chat.js — a function taking
 * a JS object that it JSON-encodes onto the `data:` line. This helper does NOT
 * write `data: [DONE]` or close the response; the caller owns the socket
 * lifecycle (heartbeat, unregister, res.end) exactly as the Cascade path does.
 *
 * Emission order mirrors the Cascade stream:
 *   1. role-priming chunk (delta {role, content:''}) — DEFERRED until the first
 *      real delta (or the finish tail) so a pre-open transient/dead-token error
 *      leaves the caller's first-connect recovery armed (see `prime` below)
 *   2. reasoning_content deltas as they arrive
 *   3. content deltas as they arrive
 *   4. finish chunk (delta {}, finish_reason)
 *   5. usage-only chunk (choices [], usage) when usage is known
 *
 * @returns {Promise<{content:string, reasoning:string, finish_reason:string, usage:object|null}>}
 *          the assembled result, so callers can cache it after streaming.
 */
export async function streamChatCompletion(params, send, opts = {}) {
  const { id = newId(), created = nowSeconds(), displayModel, emulateTools = false, includeUsage = false, stop = null, clineCompat = false } = opts;
  const model = displayModel || params.model;
  const base = { id, object: OBJECT_CHUNK, created, model, system_fingerprint: systemFingerprint(model) };

  // 1. Role-priming chunk. This USED to fire eagerly here, before streamChat
  //    opened the upstream — but the very first send() flips `emitted=true` in
  //    the caller (handlers/chat.js), which disarms every !emitted-gated
  //    first-connect recovery branch (transient replay / re-login / failover).
  //    A transient 5xx/reset or a dead token — which the non-stream path retries
  //    / re-logs-in / fails over — then surfaced as a hard client error on the
  //    stream path. So we DEFER the prime behind `primed` until the first REAL
  //    delta (content / reasoning / tool_call) actually arrives, i.e. until the
  //    upstream has demonstrably opened. The empty / immediate-finish path primes
  //    from the finish tail below, so a legitimately empty response is still a
  //    well-formed OpenAI stream (role → finish → optional usage). Operators who
  //    relied on the eager role chunk can restore it with DEVIN_CONNECT_EAGER_PRIME=1.
  let primed = false;
  const prime = () => {
    if (primed) return;
    primed = true;
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  };
  if (String(process.env.DEVIN_CONNECT_EAGER_PRIME || '') === '1') prime();

  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = null;
  // Same billing passthrough as the non-stream path.
  let streamBilling = null;
  // Native tool calls (DEVIN_CONNECT_TOOL_CALL_TAGS calibrated) ride the terminal
  // finish event, not the content stream — captured here, emitted after the loop.
  let nativeToolCalls = [];
  // proto-openai-03: stream-side stop enforcement. The gate holds back a short
  // tail so a stop sequence straddling two content chunks is still caught; on a
  // hit we emit the safe prefix, flip finish_reason:'stop', and stop the stream.
  const stopGate = new StopSequenceGate(stop);
  let stopHit = false;
  // Emit content through the stop gate. Returns true when the stream should end.
  const sendContent = (text) => {
    if (!text) return false;
    if (!stopGate.active) {
      send({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      return false;
    }
    const { emit, hit } = stopGate.push(text);
    if (emit) send({ ...base, choices: [{ index: 0, delta: { content: emit }, finish_reason: null }] });
    if (hit) { finishReason = 'stop'; stopHit = true; }
    return hit;
  };

  // Tool emulation: run content deltas through the same streaming parser the
  // Cascade path uses. It strips <tool_call> markup from the text deltas and
  // surfaces fully-closed calls; we emit each as an OpenAI tool_calls delta
  // (whole arguments at once, keyed by index — matching Cascade, not
  // token-by-token argument streaming). finish_reason flips to tool_calls.
  const toolParser = emulateTools
    ? new ToolCallStreamParser({ modelKey: params.model, provider: null, route: 'devin_connect' })
    : null;
  const collectedToolCalls = [];
  const emitToolCalls = (calls) => {
    for (const tc of calls || []) {
      prime(); // a tool_call is a real delta — open the message before it
      const idx = collectedToolCalls.length;
      collectedToolCalls.push(tc);
      send({ ...base, choices: [{ index: 0, delta: {
        tool_calls: [{
          index: idx,
          id: tc.id || `call_${idx}_${Date.now().toString(36)}`,
          type: 'function',
          function: { name: tc.name || 'unknown', arguments: compatArgs(tc.argumentsJson, clineCompat) },
        }],
      }, finish_reason: null }] });
    }
  };

  for await (const ev of streamChatWithEmptyRetry(params, undefined, opts)) {
    // A rescue attempt REPLACES the previous one. The deltas already sent cannot be
    // retracted (documented at the promotion site below), but the accumulators must
    // not keep the abandoned attempt — otherwise `content` ends up holding every
    // attempt concatenated, and the promotion re-sends that pile as the answer.
    if (ev.type === 'attempt_reset') {
      reasoning = '';
      content = '';
      collectedToolCalls.length = 0;
      nativeToolCalls = [];
      continue;
    }
    if (ev.type === 'reasoning') {
      prime(); // first real delta: emit the deferred role chunk first
      reasoning += ev.text;
      send({ ...base, choices: [{ index: 0, delta: { reasoning_content: ev.text }, finish_reason: null }] });
    } else if (ev.type === 'content') {
      prime(); // first real delta: emit the deferred role chunk first
      content += ev.text;
      if (toolParser) {
        const { text, toolCalls } = toolParser.feed(ev.text);
        emitToolCalls(toolCalls);
        if (sendContent(text)) break;
      } else {
        if (sendContent(ev.text)) break;
      }
    } else if (ev.type === 'finish') {
      if (ev.reason) finishReason = ev.reason;
      if (ev.usage) usage = ev.usage;
      if (ev.billing) streamBilling = ev.billing;
      if (ev.toolCalls && ev.toolCalls.length) nativeToolCalls = ev.toolCalls;
    }
  }

  // Drain any tool_call still buffered at end-of-stream, plus the trailing text.
  // Skip when a stop sequence already ended the stream (stopHit) — the tail after
  // the stop must not leak out.
  if (toolParser && !stopHit) {
    const { text, toolCalls } = toolParser.flush();
    emitToolCalls(toolCalls);
    sendContent(text);
    if (collectedToolCalls.length) finishReason = 'tool_calls';
  }
  // proto-openai-03: release the gate's held tail (the last few chars it was
  // withholding in case they started a stop sequence). No-op after a hit.
  if (!stopHit && stopGate.active) {
    const tail = stopGate.flush();
    if (tail) send({ ...base, choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] });
  }

  // Native tool calls win over text emulation (the two are mutually exclusive:
  // when native decode is calibrated the text carries no <tool_call> markup).
  // Only emit native if emulation produced nothing, so a call is never counted
  // twice. Native arrives whole on the finish event, so it's emitted here rather
  // than inline — same wire shape as the emulated deltas above.
  if (nativeToolCalls.length && !collectedToolCalls.length) {
    emitToolCalls(nativeToolCalls.map((tc) => ({
      id: tc.id, name: tc.name, argumentsJson: tc.arguments,
    })));
    finishReason = 'tool_calls';
  }

  // Fallback promotion: promote reasoning to content when no tool calls and no content exist
  // so plain prompts never return an empty visible answer to clients.
  //
  // KNOWN AND ACCEPTED COST, unlike the non-stream path above where the duplicate
  // is simply removed. Here the reasoning deltas have ALREADY gone out on the wire
  // as `reasoning_content`, and a stream cannot retract what it emitted — so a
  // client that renders reasoning will show this text twice. The alternatives were
  // weighed and are worse:
  //
  //   - Buffer reasoning and decide at end-of-stream: kills the reason streaming
  //     exists (watching the model think in real time) for EVERY turn, to spare a
  //     duplicate on the minority that end up reasoning-only.
  //   - Emit a short marker instead of the text: a strict client
  //     (kimi CLI: "response containing only thinking content") is satisfied by
  //     any text, but the user then loses the actual answer — the reasoning IS the
  //     answer on a plain prompt, which is the whole case this branch serves.
  //   - Don't promote on the stream path at all: leaves the original bug in place
  //     for streaming clients, which is the common configuration.
  //
  // So the duplicate is the price of rescuing a strict client mid-stream. It is
  // recorded here rather than left to look like an oversight; if a future change
  // can dedupe at the translator layer (messages.js already knows whether the
  // text block equals the thinking block), that is the place to do it.
  if (!content && !collectedToolCalls.length && !nativeToolCalls.length && reasoning && !stopHit) {
    // Same extraction the content path uses, for the same reason as the non-stream
    // path: the rescue nudge asks for tool markup, so a model that complies while
    // still writing into the reasoning channel would otherwise have raw
    // `<tool_call>` XML streamed to it as the visible answer.
    const promotedParse = emulateTools
      ? parseToolCallsFromText(reasoning, { modelKey: params.model, provider: null, route: 'devin_connect' })
      : { toolCalls: [], text: reasoning };
    if (promotedParse.toolCalls.length) {
      if (promotedParse.text) sendContent(promotedParse.text);
      emitToolCalls(promotedParse.toolCalls.map((tc) => ({
        id: tc.id, name: tc.name, argumentsJson: tc.argumentsJson ?? tc.arguments,
      })));
      content = promotedParse.text;
      finishReason = 'tool_calls';
    } else {
      sendContent(reasoning);
      content = reasoning;
    }
  }

  // 4. Terminal finish chunk. Reaching here means streamChat drained cleanly
  //    (the upstream opened and completed); if it had thrown before any delta,
  //    the exception would have propagated with `primed` — and therefore the
  //    caller's `emitted` — still false, leaving first-connect recovery armed.
  //    An empty / immediate-finish response yielded no delta to prime from, so
  //    prime here to keep the stream well-formed: role → finish → optional usage.
  prime();
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });

  // 5. Usage-only chunk (OpenAI streams usage in a trailing choices:[] frame).
  //    O1: only when the caller opted in via stream_options.include_usage;
  //    OpenAI omits this frame by default.
  if (usage && includeUsage) {
    send({ ...base, choices: [], usage });
  }

  return { content, reasoning, finish_reason: finishReason, usage, billing: streamBilling, toolCalls: collectedToolCalls };
}

export const __testing = {
  newId, nowSeconds, OBJECT_COMPLETION, OBJECT_CHUNK,
  isEmptyCompletion, streamChatWithEmptyRetry,
  retryOnEmptyEnabled, retryOnEmptyMax,
};
