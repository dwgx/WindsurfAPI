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
import { filterToolCallsByAllowlist } from './handlers/chat.js';
import { streamChat as realStreamChat, isRetryable, messageText, applyOutputCap } from './devin-connect.js';
import { ToolCallStreamParser, parseToolCallsFromText, isWeakEmulationModel } from './handlers/tool-emulation.js';
import { log } from './config.js';
import { safeLogValue } from './log-safety.js';
import { leakTraceEnabled, thinkMarkersIn, leakSample } from './leak-trace.js';
import { systemFingerprint } from './system-fingerprint.js';
import { applyStop, StopSequenceGate } from './stop-sequences.js';
import { normalizeToolCallArgs, recordArgRepair } from './handlers/cline-compat.js';
import { ThinkTextClassifier } from './response-classifier.js';
import { budgetExceededError } from './request-budget.js';
import { bumpConnect } from './devin-connect-metrics.js';
import { toClientToolCallId, restoreUpstreamToolIds } from './tool-ids.js';

// Gate for the leading think-tag reroute (Item 1, loop break). The classifier
// lives HERE, in the connect layer, so the DEVIN_CONNECT_ prefix is accurate:
// only the connect backend's streams are reclassified. Default OFF — the
// reroute is a behavior change and must be opted into per deployment.
function thinkTextRerouteEnabled() {
  return String(process.env.DEVIN_CONNECT_THINKTEXT_REROUTE || '') === '1';
}

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

// ── #236 prose tool-intent detector (log-only) ─────────────────────────────
// The rescue gate below requires `sawReasoning && !sawText`. A reasoning-effort
// `-none` selector (glm-5-2-none and its siblings) can NEVER satisfy it: the
// upstream emits no reasoning events at all, so a stalled turn in that family
// arrives as TEXT or as nothing, never as reasoning. The reported shape is the
// same trap one channel over — the model narrates the tool call in visible text,
// finishes with `stop` and zero tool calls, and the client waits for a call that
// never comes.
//
// We deliberately do NOT retry on it. "The model answered in prose" and "the
// model stalled mid-intent" are indistinguishable without a capture of a real
// stall, and a false-positive nudge would rewrite a legitimate answer (#236
// thread, 2026-08-03: 60+ direct turns, zero stalls, so the trigger is not even
// established). What that thread is missing is the capture — so this detector
// produces one. It logs and counts; it never alters the wire.
//
// The criterion is narrow on purpose, and its last two conditions are what keep
// ordinary final answers out of the log:
//   - the request declared tools (a request without tools has nothing to stall on);
//   - finish is `stop`/null with ZERO tool calls (a real call, or a `length` /
//     `content_filter` terminal state, is not this shape);
//   - the turn does not END like a finished sentence. A completed answer ends in
//     `.`/`!`/`?` (or the CJK equivalents); a turn that stops mid-intent ends in
//     `:`, an ellipsis, or nothing at all. This is what separates
//     "Let me read the file:" (stall) from "I used read_file to inspect it."
//     (a normal summary) — the latter names a tool too, and would otherwise
//     dominate the signal;
//   - and the tail then names one of THIS request's tools, or carries an intent
//     phrase. Tool names are matched with explicit ASCII boundaries so `bash`
//     does not match inside `bashful`, and `read_file` does not match inside
//     `read_files`.
//
// Accepted false negatives: a stall whose text happens to end in a period is not
// detected. Keeping the counter clean matters more than covering every phrasing,
// because the counter is what an operator will alarm on.
const PROSE_INTENT_TAIL_MAX = 400;
// Sentence-final punctuation, optionally followed by closing quotes/brackets.
const SENTENCE_FINAL = /[.!?。！？]["'”’`)\]]*\s*$/;
// Future/present intent markers. `let me` is excluded when followed by "know" —
// "Let me know if you need anything else" is a closing, not an intent.
const PROSE_INTENT_VERB = /\b(?:let me(?!\s+know\b)|i(?:'ll| will| am going to|'m going to| need to| should)|next,? i|now,? i)\b|(?:让我|我来|我先|接下来我|我将|我需要|正在)/i;

function proseIntentDetectEnabled(env = process.env) {
  // Log-only, so it is on by default: a detector that has to be switched on
  // before it can capture the shape it exists to capture captures nothing.
  return String(env.DEVIN_CONNECT_PROSE_INTENT_DETECT ?? '1') !== '0';
}

/** Tool names declared by the request, in declaration order. */
function requestToolNames(tools) {
  if (!Array.isArray(tools)) return [];
  const names = [];
  for (const tool of tools) {
    const name = tool?.function?.name || tool?.name;
    if (typeof name === 'string' && name.trim()) names.push(name.trim());
  }
  return names;
}

/**
 * Judge a FINISHED turn for the #236 "narrated a tool call, emitted none" shape.
 * Returns a signal string (`tool_name:<name>` or `intent_verb:<phrase>`) or null.
 * Pure and synchronous — the caller only logs/counts the result.
 */
export function detectProseToolIntent({ text, toolNames = [], finishEv } = {}) {
  if (!finishEv) return null;
  if (finishEv.reason != null && finishEv.reason !== 'stop') return null;
  if (finishEv.toolCalls && finishEv.toolCalls.length) return null;
  const full = String(text || '');
  if (!full.trim()) return null;
  const tail = full.slice(-PROSE_INTENT_TAIL_MAX);
  if (SENTENCE_FINAL.test(tail)) return null;
  for (const name of toolNames) {
    if (!name || name.length < 3) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i').test(tail)) {
      return `tool_name:${name}`;
    }
  }
  const verb = tail.match(PROSE_INTENT_VERB);
  return verb ? `intent_verb:${verb[0].trim().toLowerCase()}` : null;
}

/**
 * Log/count the #236 signal for a turn that has ALREADY been delivered.
 *
 * MUST run at the adapter layer, after tool-call emulation: before the parser
 * strips `<tool_call>` markup, a normal emulated call looks like prose that
 * stops mid-intent, so every emulated call was counted as a stall (the exact
 * traffic the counter exists to measure). The caller passes the DELIVERED text
 * and the calls it actually emitted, so a delivered call can never be reported
 * as "narrated one, emitted none".
 */
function reportProseToolIntent({ params, text, finishEv, reasoning }) {
  if (!proseIntentDetectEnabled()) return;
  if (!Array.isArray(params?.tools) || params.tools.length === 0) return;
  const toolNames = requestToolNames(params.tools);
  const signal = detectProseToolIntent({ text, toolNames, finishEv });
  if (!signal) return;
  bumpConnect('prose_tool_intent');
  log.info(
    `DEVIN_CONNECT: prose tool intent without a call (#236) — `
    + `model=${safeLogValue(params?.model)}, finish=${finishEv?.reason ?? 'null'}, `
    + `signal=${signal}, reasoning=${Boolean(reasoning)}, tools=${toolNames.length}, `
    + `sample=${JSON.stringify(leakSample(text))}`,
  );
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

// Egress/ingress boundary for tool-call ids. The client received a normalized
// `call_…` id (see toClientToolCallId); the upstream issued its own dialect
// (`get_weather:0#<uuid>` on swe-2). Restore the original id on a COPY of the
// request right before the wire encode, so native history replay (#6
// ChatToolCall / #7 tool_call_id) is byte-identical to what the upstream
// issued. Everything upstream of this point — session continuity, cache keys,
// the response body — sees the client-visible id.
function withUpstreamToolIds(params) {
  const messages = restoreUpstreamToolIds(params?.messages);
  return messages === params?.messages ? params : { ...params, messages };
}

async function* streamChatWithEmptyRetry(params, { env = process.env } = {}, opts = {}) {
  // Route-owned request budget. Each internal attempt is one upstream turn; the
  // cap is per REQUEST, shared with the handler's account failover, so the
  // empty/rescue retries can no longer multiply into the measured 45/90-turn
  // products. Backoffs are clamped to the remaining deadline.
  const budget = opts?.budget || null;
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
  // #236's detector is NOT here: it runs in the adapters, after emulation, on
  // the text and calls the client actually received. Judging the raw upstream
  // tail here counted every normal emulated `<tool_call>` turn as a stall
  // (the markup is stripped only downstream).
  const hasTools = Boolean(params?.tools?.length);
  let rescueAttempt = 0;
  let emptyAttempt = 0;
  for (;;) {
    let sawContent = false;
    let sawText = false;
    let sawReasoning = false;
    let sawReasoningText = '';
    let finishEv = null;
    // P-04: reasoning is provisional until this attempt is committed. A rescue
    // REPLACES the attempt and a delta already sent cannot be retracted, so a
    // reasoning-only attempt that is later abandoned used to leave its whole
    // trace on the wire while the returned/cached/continuity value kept only
    // the final attempt. Hold reasoning while a rescue is still possible and
    // release it only when the attempt can no longer be replaced: the first
    // text delta (sawText closes the rescue gate) or the terminal finish. The
    // rescue branch below drops the buffer together with the attempt.
    const rescuePossible = hasTools && rescueAttempt < rescueMax;
    let pendingReasoning = [];
    // The thinking signature (opt-in decode, DEVIN_CONNECT_SIGNATURE_TAG) seals
    // this attempt's reasoning, so it is held and released with it: committed
    // together, or dropped together when a rescue replaces the attempt.
    let pendingSignature = '';
    // Item 1 (loop break): leading think-tagged CONTENT is reclassified into the
    // reasoning channel HERE, at the stream-event level, BEFORE the rescue
    // decision below. A whole turn of ` thinking…` therefore stays a
    // reasoning-only stream.
    // Honest rescue interplay (corrected after review): such a turn does NOT
    // fire the #238 rescue — the :284 nudge path requires tools, and
    // isEmptyCompletion reads sawContent, which the thinking branch below sets
    // at :238. The real outcome: reasoning delivered as thinking blocks, text
    // empty, no retry. That is accepted: the reasoning is not lost (the client
    // receives thinking blocks, not the #238 whole-turn vanish), and sawContent
    // genuinely means "upstream said something", which is true here.
    // Deliberately NOT teaching isEmptyCompletion to read sawText — that would
    // redraw the #238/#241 rescue boundary for a cosmetic gain.
    // (Known limitation: only the ` thinking`…` dialect is recognized; Kimi K2's
    // family uses `◁think▷…◁/think▷` — extending the classifier to that dialect
    // is left for a future PR.)
    const thinkClassifier = thinkTextRerouteEnabled() ? new ThinkTextClassifier() : null;
    // One turn per upstream call, consumed immediately before it. The cap is
    // hard: when it is reached the generator throws a 504-class error instead
    // of starting another turn.
    if (budget && !budget.takeTurn()) {
      throw budgetExceededError(
        budget.expired()
          ? `request budget exhausted before DEVIN_CONNECT attempt (${budget.describe()})`
          : `request upstream-turn cap reached before DEVIN_CONNECT attempt (${budget.describe()})`,
      );
    }
    const upstreamParams = withUpstreamToolIds(attemptParams);
    const callParams = budget
      ? {
        ...upstreamParams,
        // devin-connect.js treats deadlineMs as the total wall clock for THIS
        // stream. Give it what the request has left, never more.
        deadlineMs: Math.min(
          Number.isFinite(upstreamParams?.deadlineMs) && upstreamParams.deadlineMs > 0
            ? upstreamParams.deadlineMs
            : Infinity,
          budget.remainingMs(),
        ),
      }
      : upstreamParams;
    for await (const ev of streamChatImpl(callParams)) {
      if ((ev.type === 'content' || ev.type === 'reasoning') && leakTraceEnabled(env)) {
        log.info('LEAK_TRACE stream-event', {
          channel: ev.type,
          think: thinkMarkersIn(ev.text),
          sample: leakSample(ev.text),
          len: ev.text ? ev.text.length : 0,
          reqId: opts?.reqId ?? null,
          account: opts?.account ?? null,
        });
      }
      if (ev.type === 'content' && thinkClassifier) {
        const routed = thinkClassifier.feed(ev.text);
        if (routed.thinking) {
          sawContent = true;
          sawReasoning = true;
          sawReasoningText += routed.thinking;
          if (rescuePossible && !sawText) pendingReasoning.push(routed.thinking);
          else yield { type: 'reasoning', text: routed.thinking };
        }
        if (routed.text) {
          // First text delta: the rescue gate (`!sawText`) is now closed, so
          // this attempt is committed — release its provisional reasoning
          // before the text it preceded.
          for (const text of pendingReasoning) yield { type: 'reasoning', text };
          pendingReasoning = [];
          if (pendingSignature) { yield { type: 'signature', reasoning_signature: pendingSignature }; pendingSignature = ''; }
          sawContent = true;
          sawText = true;
          yield { type: 'content', text: routed.text };
        }
      } else if (ev.type === 'content' || ev.type === 'reasoning') {
        if (ev.text) {
          sawContent = true;
          if (ev.type === 'content') {
            // First text delta commits the attempt — see the classifier branch.
            for (const text of pendingReasoning) yield { type: 'reasoning', text };
            pendingReasoning = [];
            if (pendingSignature) { yield { type: 'signature', reasoning_signature: pendingSignature }; pendingSignature = ''; }
            sawText = true;
          } else {
            sawReasoning = true;
            sawReasoningText += ev.text;
            if (rescuePossible && !sawText) {
              pendingReasoning.push(ev.text);
              continue;
            }
          }
        }
        yield ev;
      } else if (ev.type === 'finish') {
        finishEv = ev; // hold: decide retry after the stream drains
      } else if (ev.type === 'signature' && rescuePossible && !sawText) {
        pendingSignature += ev.reasoning_signature || '';
      } else {
        yield ev;
      }
    }
    // Flush anything the classifier still holds BEFORE the rescue decision: an
    // unterminated/undecided tail is delivered as text (visible beats dropped),
    // and it must count as real text for the rescue gate above.
    if (thinkClassifier) {
      const rest = thinkClassifier.flush();
      if (rest) {
        // The flushed tail is text, so the attempt is committed for the same
        // reason as a normal content delta.
        for (const text of pendingReasoning) yield { type: 'reasoning', text };
        pendingReasoning = [];
        if (pendingSignature) { yield { type: 'signature', reasoning_signature: pendingSignature }; pendingSignature = ''; }
        sawContent = true;
        sawText = true;
        yield { type: 'content', text: rest };
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
    if (hasTools && rescueAttempt < rescueMax && isStopOrNull && hasNoToolCalls && sawReasoning && !sawText) {
      rescueAttempt++;
      log.warn(`DEVIN_CONNECT: thinking-only completion (reasoning-only, finish=${finishEv?.reason ?? 'null'}) — rescue retry ${rescueAttempt}/${rescueMax} (nudge appended)`);
      const backoff = retryOnEmptyBaseMs(env) * rescueAttempt;
      if (backoff && !(await budgetedSleep(backoff, budget))) {
        throw budgetExceededError(`request budget exhausted during DEVIN_CONNECT rescue backoff (${budget.describe()})`);
      }
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
        if (msg.reasoning_signature && String(msg.reasoning_content || '').length > 0) return true;
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
      // The abandoned attempt's provisional reasoning dies with this loop
      // iteration (`pendingReasoning` is declared inside it): it was never sent
      // (the buffer is only released at commit), so the client, the returned
      // result, the cache and session continuity all stay on the replacement
      // attempt. The attempt_reset below still tells the consumer to clear the
      // other accumulators (content/tool calls/billing) for the same reason.
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
      if (backoff && !(await budgetedSleep(backoff, budget))) {
        throw budgetExceededError(`request budget exhausted during DEVIN_CONNECT empty-retry backoff (${budget.describe()})`);
      }
      continue;
    }
    if (weak && finishEv && isEmptyCompletion(finishEv, sawContent)) {
      log.warn(`DEVIN_CONNECT: weak model ${params.model} empty completion (finish=${finishEv.reason ?? 'null'}) — NOT retrying (deterministic, retry would amplify rate limit)`);
    }
    // No rescue: this is the committed attempt. Release any reasoning still held
    // while a rescue was possible, before its terminal finish event.
    for (const text of pendingReasoning) yield { type: 'reasoning', text };
    pendingReasoning = [];
    if (pendingSignature) { yield { type: 'signature', reasoning_signature: pendingSignature }; pendingSignature = ''; }
    if (finishEv) yield finishEv;
    return;
  }
}

// Sleep that can never outlive the request budget. Returns false when the
// budget has no time left — including when it cannot cover the full backoff —
// so the caller stops instead of starting an attempt that the route deadline
// would kill mid-flight.
async function budgetedSleep(ms, budget) {
  if (!ms) return true;
  if (!budget) {
    await new Promise((r) => setTimeout(r, ms));
    return true;
  }
  const left = budget.remainingMs();
  // A backoff the budget cannot fully honour means there is no room left for
  // the retry it was pacing. Sleeping the clamped remainder and then re-issuing
  // starts the attempt with a sliver of time, and the deadline kills it
  // mid-flight — the v3.9.57 CI flake (run 39861008441). The final
  // `remainingMs() > 0` check cannot catch that: it is the same condition
  // budgetedSleep already returned, and canStartAttempt() adds only the turn
  // cap. Stop here; each caller surfaces its own error.
  if (left < ms) return false;
  await new Promise((r) => setTimeout(r, ms));
  return budget.remainingMs() > 0;
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
 * @returns {Promise<{status:number, body:object, stop:string|null}>}
 */
export async function toChatCompletion(params, opts = {}) {
  const { id = newId(), created = nowSeconds(), displayModel, maxRetries = 1, retryBaseMs = 400, emulateTools = false, stop = null, clineCompat = false, stopCarrier = false, budget = null } = opts;
  const model = displayModel || params.model;

  // Non-stream path buffers the whole answer, so a transient failure (network
  // blip, 5xx, rate limit) can be retried cleanly — a discarded partial buffer
  // never duplicates tokens. Terminal errors (MODEL_BLOCKED / UNAUTHORIZED)
  // are not retryable and throw straight through for the handler to map.
  let content = '';
  let reasoning = '';
  let reasoningSignature = '';
  let signedSegment = false;
  let multipleSignedSegments = false;
  let finishReason = 'stop';
  // The upstream ended the stream without ever naming a stop reason (devin-connect
  // raises `reason:'error'` + `unterminated:true` for a delivered payload with no
  // #5). Remembered separately because the tool-call arms below overwrite
  // finishReason with 'tool_calls' whenever a call exists — which would report a
  // turn whose arguments were never validated as a clean, executable finish.
  let finishUnterminated = false;
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
      content = ''; reasoning = ''; reasoningSignature = ''; signedSegment = false; multipleSignedSegments = false; finishReason = 'stop'; finishUnterminated = false; usage = null; nativeToolCalls = [];
      for await (const ev of streamChatWithEmptyRetry(params, undefined, opts)) {
        // A rescue attempt REPLACES the previous one; drop what it produced or the
        // client is handed every attempt concatenated.
        if (ev.type === 'attempt_reset') { content = ''; reasoning = ''; reasoningSignature = ''; signedSegment = false; multipleSignedSegments = false; nativeToolCalls = []; finishUnterminated = false; billing = null; continue; }
        if (ev.type === 'content') content += ev.text;
        else if (ev.type === 'reasoning') {
          if (signedSegment) multipleSignedSegments = true;
          reasoning += ev.text;
        }
        // Thinking signature (opt-in decode, DEVIN_CONNECT_SIGNATURE_TAG). The
        // per-frame events are increments; the finish event's total is not used
        // because a rescue attempt_reset must discard the abandoned increments.
        else if (ev.type === 'signature') {
          reasoningSignature += ev.reasoning_signature || '';
          signedSegment = true;
        }
        else if (ev.type === 'finish') {
          if (ev.reason) finishReason = ev.reason;
          if (ev.unterminated === true) finishUnterminated = true;
          if (ev.usage) usage = ev.usage;
          if (ev.billing) billing = ev.billing;
          if (ev.toolCalls && ev.toolCalls.length) nativeToolCalls = ev.toolCalls;
        }
      }
      break;
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) throw err;
      // The inner generator already consumes a turn per upstream call; when
      // the route budget has no turn/time left, re-issuing here would only be
      // refused. Surface the real upstream error instead of a synthetic one.
      if (budget && !budget.canStartAttempt()) throw err;
      const backoff = retryBaseMs * 2 ** attempt;
      log.warn(`DEVIN_CONNECT: retryable error (${err.code || err.message}); retry ${attempt + 1}/${maxRetries} in ${backoff}ms`);
      if (!(await budgetedSleep(backoff, budget))) throw err;
      // Re-read the gate after the wait: the pre-sleep check is a snapshot, and
      // the retry must be admitted by the budget as it stands now. (The deadline
      // sliver itself is budgetedSleep()'s job — it refuses a backoff the budget
      // cannot cover.) The real upstream error is what surfaces.
      if (budget && !budget.canStartAttempt()) throw err;
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
  //
  // SEED-C3c: the emulated parse runs BEFORE the stop gate, never after it. The
  // stop sequence fences the model's PROSE; a complete, declared, allowlisted
  // tool call carries opaque structured arguments. Gating the raw text first cut
  // inside that JSON and handed non-stream clients a truncated `<tool_call>`
  // fragment with no tool at all, while the stream path (which parses before its
  // prose gate, see sendContent below) returned the real call — the same request
  // answered two different ways depending on `stream`. Native structured calls
  // are opaque for the same reason.
  //
  // This does NOT decide mixed prose/tool ordering (an END that appears before a
  // later call, split-chunk order, salvage parity): only the accepted, declared,
  // allowlisted structured call is exempt from the cut.
  let stopHit = false;
  let matchedStop = null;
  let toolCalls = [];
  // The upstream's OWN terminal verdict (enum 13 → 'error'), captured before the
  // tool-call arms below, which set 'tool_calls' unconditionally whenever a call
  // was decoded. An error turn that happened to emit a decodable call is still an
  // error — the call's arguments are as unverified as the rest of the turn.
  const terminalError = finishReason === 'error';
  if (nativeToolCalls.length) {
    // arguments is the raw JSON string off the wire (decodeToolCalls); map it to
    // the same shape parseToolCallsFromText produces so the message builder below
    // is source-agnostic.
    toolCalls = nativeToolCalls.map((tc) => ({
      id: tc.id, name: tc.name, argumentsJson: tc.arguments,
    }));
    finishReason = 'tool_calls';
  } else if (emulateTools) {
    const parsed = parseToolCallsFromText(content, {
      modelKey: params.model, provider: null, route: 'devin_connect',
    });
    if (parsed.toolCalls.length) {
      content = parsed.text;
      toolCalls = filterToolCallsByAllowlist(parsed.toolCalls, params.tools || []);   // M2 ToolGuard parity
    }
  }
  // proto-openai-03: enforce the client's `stop` locally (the Devin wire has no
  // native stop field). Truncate at the earliest stop-sequence hit and report
  // finish_reason:'stop'. The cut applies to the prose that is left after the
  // structured-call parse above; tool arguments are never matched against it.
  {
    const stopped = applyStop(content, stop);
    if (stopped.hit) { content = stopped.text; matchedStop = stopped.stop; stopHit = true; }
  }
  if (stopHit && !toolCalls.length) finishReason = 'stop';

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
  let promotedReasoning = !toolCalls.length && !content && !!reasoning && !stopHit;
  if (promotedReasoning) {
    if (emulateTools && !stopHit) {
      const promotedParse = parseToolCallsFromText(reasoning, {
        modelKey: params.model, provider: null, route: 'devin_connect',
      });
      if (promotedParse.toolCalls.length) {
        // M2 ToolGuard parity: only keep calls the client declared
        const allowedCalls = filterToolCallsByAllowlist(promotedParse.toolCalls, params.tools || []);
        // It was a tool call all along. Deliver it as one; keep any surrounding prose
        // as content, and leave reasoning_content in place since nothing was moved
        // out of it into the answer.
        toolCalls = allowedCalls;
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

  // Promotion creates visible prose after the first gate. Gate it at this final boundary.
  if (promotedReasoning) {
    const stopped = applyStop(content, stop);
    content = stopped.text;
    if (stopped.hit) { matchedStop = stopped.stop; stopHit = true; }
    if (stopHit && !toolCalls.length) finishReason = 'stop';
  }

  // OpenAI convention: content is a string (may be empty), never undefined.
  const message = { role: 'assistant', content: content || '' };
  if (reasoning && !promotedReasoning) message.reasoning_content = reasoning;
  // The signature seals exactly this reasoning text; promoted reasoning is no
  // longer a thinking block, so a signature beside it would seal nothing.
  if (reasoning && !promotedReasoning && reasoningSignature && !multipleSignedSegments) message.reasoning_signature = reasoningSignature;
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((tc, i) => ({
      id: toClientToolCallId(tc.id, `call_${i}_${Date.now().toString(36)}`),
      type: 'function',
      function: { name: tc.name || 'unknown', arguments: compatArgs(tc.argumentsJson || tc.arguments, clineCompat) },
    }));
    // content is null when the turn is a tool call (the inline text is usually
    // a hallucinated preview the caller shouldn't show).
    message.content = null;
    finishReason = 'tool_calls';
  }

  // Budget honesty (live finding: gemini-3-6-flash-medium). Thinking is counted
  // in completion_tokens but the upstream does not bound it by max_tokens, so a
  // turn can overrun the caller's cap and still claim a clean 'stop'. Report
  // 'length' when the upstream's own count reached or passed the requested cap.
  // NOT a local truncation: every delta has already been delivered above, and
  // the exact count only exists on the terminal frame — see applyOutputCap.
  //
  // A turn cut by the CLIENT's stop sequence keeps 'stop': the caller asked for
  // that terminal cause and the Messages route carries it as `stop_sequence`
  // (the carrier below is gated on 'stop'). Tool calls / content_filter are
  // stronger states and applyOutputCap leaves them alone.
  //
  // A turn the upstream ended in ERROR (enum 13) stays an error even when a
  // decodable tool call arrived with it — the tool-call arms above would otherwise
  // launder a failed turn into a clean, executable `tool_calls` finish. Same for a
  // turn that never named a stop reason at all. Placed after EVERY tool-call arm so
  // a future one cannot slip past it, and before applyOutputCap (which only
  // upgrades 'stop').
  if (terminalError) finishReason = 'error';
  else if (finishUnterminated && finishReason === 'tool_calls') finishReason = 'error';
  if (!stopHit) finishReason = applyOutputCap(finishReason, usage, params.completion?.maxTokens);

  // #236 log-only detector — AFTER emulation and the stop gate, on the text and
  // calls the client actually receives. `stopHit` means a local stop sequence
  // cut the answer, which is not a model stall.
  if (!stopHit) {
    reportProseToolIntent({
      params,
      text: content,
      finishEv: { reason: finishReason, toolCalls },
      reasoning,
    });
  }

  const choice = { index: 0, message, finish_reason: finishReason };
  // SEED-C3a carrier. The internal Anthropic Messages route needs to know WHICH
  // stop sequence truncated this answer (it echoes it as `stop_sequence`), and
  // the matched bytes are gone from `content`, so the cause has to ride along.
  // Serialisable plain field, not a Symbol: the streaming twin travels through
  // JSON.stringify into the messages translator's SSE parser. Gated on the
  // explicit route opt-in (chat.js sets `stopCarrier` only for
  // trusted Messages context) so a direct OpenAI client sees the public shape
  // byte-for-byte. Only a genuine local stop carries it — a tool/length/refusal
  // finish cannot be upgraded by a stray value.
  if (stopCarrier && matchedStop && finishReason === 'stop') choice._windsurf_stop_sequence = matchedStop;

  const body = {
    id,
    object: OBJECT_COMPLETION,
    created,
    model,
    system_fingerprint: systemFingerprint(model),
    choices: [choice],
  };
  if (usage) body.usage = usage;
  // Private field: per-request credit/ACU cost, absent unless the billing tags are
  // calibrated. Under the _windsurf prefix so it can't be mistaken for an OpenAI
  // field by a downstream relay that metering reads.
  if (billing) body._windsurf_billing = billing;
  return { status: 200, body, stop: matchedStop };
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
 *   2. reasoning_content deltas — provisional while a rescue could still replace
 *      the attempt; released only when the attempt is committed (first text
 *      delta or terminal finish), so an abandoned attempt never reaches the wire
 *   3. content deltas as they arrive
 *   4. finish chunk (delta {}, finish_reason)
 *   5. usage-only chunk (choices [], usage) when usage is known
 *
 * @returns {Promise<{content:string, reasoning:string, finish_reason:string, usage:object|null}>}
 *          the assembled result, so callers can cache it after streaming.
 */
export async function streamChatCompletion(params, send, opts = {}) {
  const { id = newId(), created = nowSeconds(), displayModel, emulateTools = false, includeUsage = false, stop = null, clineCompat = false, stopCarrier = false, maxRetries = 1, retryBaseMs = 400, budget = null } = opts;
  const model = displayModel || params.model;
  const base = { id, object: OBJECT_CHUNK, created, model, system_fingerprint: systemFingerprint(model) };

  // 1. Role-priming chunk. This USED to fire eagerly here, before streamChat
  //    opened the upstream — but the very first send() flips `emitted=true` in
  //    the caller (handlers/chat.js), which disarms the handler's !emitted-gated
  //    account recovery branches (re-login / failover). A dead token — which the
  //    non-stream path re-logs-in / fails over — then surfaced as a hard client
  //    error on the stream path. So we DEFER the prime behind `primed` until the
  //    first REAL delta (content / reasoning / tool_call) actually arrives, i.e.
  //    until the upstream has demonstrably opened. `primed` also gates this
  //    adapter's own one-shot transport retry (nothing emitted ⇒ safe replay).
  //    The empty / immediate-finish path primes from the finish tail below, so a
  //    legitimately empty response is still a well-formed OpenAI stream
  //    (role → finish → optional usage). Operators who relied on the eager role
  //    chunk can restore it with DEVIN_CONNECT_EAGER_PRIME=1.
  let primed = false;
  // V-08: `send` is the handler's bounded writer and returns a promise once the
  // socket reports backpressure. Awaiting it here (and in every emitter below)
  // is what lets a slow reader hold this producer instead of buying unbounded
  // upstream work. A synchronous consumer returns undefined, so `await` is a
  // no-op on the direct-Chat wiring that still passes a plain function.
  const prime = async () => {
    if (primed) return;
    primed = true;
    await send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  };
  if (String(process.env.DEVIN_CONNECT_EAGER_PRIME || '') === '1') await prime();

  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  // Same guard as the non-stream twin: the tool-call arms below force
  // finish_reason='tool_calls' whenever a call was emitted, which would label a
  // turn the upstream never terminated as a clean, executable finish.
  let finishUnterminated = false;
  let usage = null;
  // Exactly what the client received as visible content, after tool-markup
  // stripping and the stop gate. `content` is the RAW upstream accumulator and
  // is used for tool parsing/session continuity; caching must use `delivered`
  // or a filtered/echoed <tool_call> block becomes the visible cached answer.
  let delivered = '';
  // Same billing passthrough as the non-stream path.
  let streamBilling = null;
  // Native tool calls (DEVIN_CONNECT_TOOL_CALL_TAGS calibrated) ride the terminal
  // finish event, not the content stream — captured here, emitted after the loop.
  let nativeToolCalls = [];
  // proto-openai-03: stream-side stop enforcement. The gate holds back a short
  // tail so a stop sequence straddling two content chunks is still caught; on a
  // hit we emit the safe prefix, flip finish_reason:'stop', and stop the stream.
  // `let` because a pre-emit transport retry must start from a fresh gate.
  let stopGate = new StopSequenceGate(stop);
  let stopHit = false;
  let matchedStop = null;
  // Emit content through the stop gate. Returns true when the stream should end.
  const sendContent = async (text) => {
    if (!text) return false;
    if (!stopGate.active) {
      await send({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      delivered += text;
      return false;
    }
    const { emit, hit } = stopGate.push(text);
    if (emit) {
      await send({ ...base, choices: [{ index: 0, delta: { content: emit }, finish_reason: null }] });
      delivered += emit;
    }
    if (hit) { finishReason = 'stop'; stopHit = true; matchedStop = stopGate.matched; }
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
  const emitToolCalls = async (calls, filter = true) => {
    // ToolGuard: same allowlist filter the chat main path applies — the
    // connect stream path used to emit any EMULATED call without checking it
    // against the client's declared tools[] (audit blind spot). Native calls
    // (structured ev.toolCalls from upstream) are trusted and pass through.
    if (filter) calls = filterToolCallsByAllowlist(calls || [], params.tools || []);
    for (const tc of calls || []) {
      await prime(); // a tool_call is a real delta — open the message before it
      const idx = collectedToolCalls.length;
      // Normalize once, before the call is recorded: the emitted delta AND the
      // returned toolCalls (session-continuity commit, cache) must agree with
      // what the client saw, or the next turn's echoed id no longer matches.
      const emitted = {
        ...tc,
        id: toClientToolCallId(tc.id, `call_${idx}_${Date.now().toString(36)}`),
      };
      collectedToolCalls.push(emitted);
      await send({ ...base, choices: [{ index: 0, delta: {
        tool_calls: [{
          index: idx,
          id: emitted.id,
          type: 'function',
          function: { name: emitted.name || 'unknown', arguments: compatArgs(emitted.argumentsJson, clineCompat) },
        }],
      }, finish_reason: null }] });
    }
  };

  // Q5 ownership: the ADAPTER owns transport retries. One bounded retry for a
  // retryable fault (5xx / ECONNRESET / server unavailable) is safe ONLY while
  // nothing has crossed the wire — `primed` is flipped by the first real delta
  // (and by the eager-prime opt-in), so a partial answer is never replayed.
  // Account failover stays in the handler.
  for (let attempt = 0; ; attempt++) {
    try {
      for await (const ev of streamChatWithEmptyRetry(params, undefined, opts)) {
        // A rescue attempt REPLACES the previous one. The generator holds
        // reasoning while an attempt can still be rescued, so no abandoned
        // reasoning delta ever reaches this consumer; the accumulators are
        // reset anyway so `content`, `delivered`, tool calls and billing can
        // never carry a discarded attempt into the returned result, the cache
        // or session continuity. (`reasoning` is reset for the same contract,
        // even though the generator already guarantees it is committed-only.)
        if (ev.type === 'attempt_reset') {
          reasoning = '';
          content = '';
          delivered = '';
          collectedToolCalls.length = 0;
          nativeToolCalls = [];
          continue;
        }
        if (ev.type === 'reasoning') {
          await prime(); // first real delta: emit the deferred role chunk first
          reasoning += ev.text;
          await send({ ...base, choices: [{ index: 0, delta: { reasoning_content: ev.text }, finish_reason: null }] });
        } else if (ev.type === 'signature') {
          // Opt-in decode (DEVIN_CONNECT_SIGNATURE_TAG). Upstream sends it after
          // the last reasoning frame and before content, so messages.js can close
          // the thinking block with a signature_delta. The generator releases it
          // only with a committed attempt, so it always seals exactly `reasoning`.
          if (reasoning && ev.reasoning_signature) {
            await send({ ...base, choices: [{ index: 0, delta: { reasoning_signature: ev.reasoning_signature }, finish_reason: null }] });
          }
        } else if (ev.type === 'content') {
          await prime(); // first real delta: emit the deferred role chunk first
          content += ev.text;
          if (toolParser) {
            const { text, toolCalls } = toolParser.feed(ev.text);
            await emitToolCalls(toolCalls);
            if (await sendContent(text)) break;
          } else {
            if (await sendContent(ev.text)) break;
          }
        } else if (ev.type === 'finish') {
          if (ev.reason) finishReason = ev.reason;
          if (ev.unterminated === true) finishUnterminated = true;
          if (ev.usage) usage = ev.usage;
          if (ev.billing) streamBilling = ev.billing;
          if (ev.toolCalls && ev.toolCalls.length) nativeToolCalls = ev.toolCalls;
        }
      }
      break;
    } catch (err) {
      if (primed || attempt >= maxRetries || !isRetryable(err)) throw err;
      // A client abort during the previous attempt (or during the backoff
      // below) must not start a fresh upstream call for a caller that is gone.
      if (params.signal?.aborted) throw err;
      // The route budget owns the total attempt count: re-issuing with no
      // turn/time left would only be refused by the next upstream call.
      if (budget && !budget.canStartAttempt()) throw err;
      const backoff = retryBaseMs * 2 ** attempt;
      log.warn(`DEVIN_CONNECT: stream retryable error (${err.code || err.status || err.message}); retry ${attempt + 1}/${maxRetries} in ${backoff}ms`);
      bumpConnect('transient_replays');
      if (!(await budgetedSleep(backoff, budget))) throw err;
      // Same post-wait gate as the non-stream loop: the budget's state after the
      // sleep, not the pre-sleep snapshot, decides whether the stream may be
      // re-issued. The real upstream error is what surfaces.
      if (budget && !budget.canStartAttempt()) throw err;
      if (params.signal?.aborted) throw err;
      // Nothing was emitted, so a clean restart cannot duplicate output.
      content = ''; reasoning = ''; finishReason = 'stop'; finishUnterminated = false; usage = null;
      streamBilling = null; nativeToolCalls = []; delivered = '';
      collectedToolCalls.length = 0;
      stopGate = new StopSequenceGate(stop);
      stopHit = false; matchedStop = null;
    }
  }

  // The upstream's OWN terminal verdict (enum 13 → 'error'), captured before the
  // tool-call arms below. Those arms set 'tool_calls' unconditionally, which turned
  // an upstream ERROR that happened to carry a decodable call into a clean,
  // executable finish.
  const terminalError = finishReason === 'error';
  // Drain any tool_call still buffered at end-of-stream, plus the trailing text.
  // Skip when a stop sequence already ended the stream (stopHit) — the tail after
  // the stop must not leak out.
  if (toolParser && !stopHit) {
    const { text, toolCalls } = toolParser.flush();
    await emitToolCalls(toolCalls);
    await sendContent(text);
    if (collectedToolCalls.length) finishReason = 'tool_calls';
  }

  // Native tool calls win over text emulation (the two are mutually exclusive:
  // when native decode is calibrated the text carries no <tool_call> markup).
  // Only emit native if emulation produced nothing, so a call is never counted
  // twice. Native arrives whole on the finish event, so it's emitted here rather
  // than inline — same wire shape as the emulated deltas above.
  if (nativeToolCalls.length && !collectedToolCalls.length) {
    await emitToolCalls(nativeToolCalls.map((tc) => ({
      id: tc.id, name: tc.name, argumentsJson: tc.arguments,
    })), false);   // native calls are trusted (structured upstream data), no allowlist filter
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
      if (promotedParse.text) await sendContent(promotedParse.text);
      await emitToolCalls(promotedParse.toolCalls.map((tc) => ({
        id: tc.id, name: tc.name, argumentsJson: tc.argumentsJson ?? tc.arguments,
      })));
      content = promotedParse.text;
      finishReason = 'tool_calls';
    } else {
      await sendContent(reasoning);
      content = reasoning;
    }
  }

  // proto-openai-03: release the gate's held tail (the last few chars it was
  // withholding in case they started a stop sequence). No-op after a hit.
  if (!stopHit && stopGate.active) {
    const tail = stopGate.flush();
    if (tail) {
      await send({ ...base, choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] });
      delivered += tail;
    }
  }

  // Budget honesty — same rule and same reasons as the non-stream twin above.
  // Applied only after the gate's held tail has been released, so the terminal
  // frame still follows every delivered delta: the answer is reported as over
  // budget, never retracted or cut mid-chunk. A local stop sequence keeps
  // 'stop' (the caller asked for that cause; the carrier below depends on it).
  // A turn the upstream ended in ERROR (enum 13) stays an error even when a
  // decodable tool call arrived with it; a turn that never named a stop reason is
  // not a clean tool-call finish either. The calls were already emitted as deltas
  // (a stream cannot retract them), so the terminal frame is the only place that
  // can say "these arguments are unverified". Without this, every tool-call arm
  // above (`toolParser.flush`, native #6, promoted reasoning) forced 'tool_calls'.
  if (terminalError) finishReason = 'error';
  else if (finishUnterminated && finishReason === 'tool_calls') finishReason = 'error';
  if (!stopHit) finishReason = applyOutputCap(finishReason, usage, params.completion?.maxTokens);

  // #236 log-only detector — AFTER emulation and the stop gate, on what the
  // client actually received. A delivered call (emulated or native) sets
  // finish_reason='tool_calls', so it can never be counted as prose intent;
  // `stopHit` is a local cut, not a stall.
  if (!stopHit) {
    reportProseToolIntent({
      params,
      text: delivered,
      finishEv: { reason: finishReason, toolCalls: collectedToolCalls },
      reasoning,
    });
  }

  // 4. Terminal finish chunk. Reaching here means streamChat drained cleanly
  //    (the upstream opened and completed); if it had thrown before any delta,
  //    the exception would have propagated with `primed` — and therefore the
  //    caller's `emitted` — still false, leaving first-connect recovery armed.
  //    An empty / immediate-finish response yielded no delta to prime from, so
  //    prime here to keep the stream well-formed: role → finish → optional usage.
  await prime();
  const finishChoice = { index: 0, delta: {}, finish_reason: finishReason };
  // SEED-C3a carrier — see the non-stream twin above. This frame is what the
  // internal Messages translator sees (chat.js serialises it onto the `data:`
  // line, messages.js parses it back), so the field must survive JSON round-trip
  // and is emitted only on the route opt-in and only for a genuine local stop.
  if (stopCarrier && matchedStop && finishReason === 'stop') finishChoice._windsurf_stop_sequence = matchedStop;
  await send({ ...base, choices: [finishChoice] });

  // 5. Usage-only chunk (OpenAI streams usage in a trailing choices:[] frame).
  //    O1: only when the caller opted in via stream_options.include_usage;
  //    OpenAI omits this frame by default.
  if (usage && includeUsage) {
    await send({ ...base, choices: [], usage });
  }

  return { content, delivered, reasoning, finish_reason: finishReason, usage, billing: streamBilling, toolCalls: collectedToolCalls, stop: matchedStop };
}

export const __testing = {
  newId, nowSeconds, OBJECT_COMPLETION, OBJECT_CHUNK,
  isEmptyCompletion, streamChatWithEmptyRetry,
  retryOnEmptyEnabled, retryOnEmptyMax,
};
