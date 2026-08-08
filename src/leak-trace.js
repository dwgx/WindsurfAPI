// Reasoning/content boundary tracing — gate-controlled OBSERVABILITY.
//
// WINDSURFAPI_LEAK_TRACE=1 emits structured log lines at the reasoning/content
// boundary so the live-only leak — model reasoning spilling into the content
// channel (PRs #238/#241/#243 rescued empty answers and rerouted a ' thinking'
// prefix, but never reproduced the leak in a forced harness) — can be caught in
// production. Default OFF: when disabled the hot path does nothing beyond one
// env read + boolean compare and nothing else changes.
//
// Every line is prefixed `LEAK_TRACE` and carries structured fields. The three
// call sites:
//   - devin-connect-openai.js streamChatWithEmptyRetry: per raw stream event —
//     channel (content/reasoning), think markers, truncated sample.
//   - handlers/messages.js AnthropicStreamTranslator: block open + per-delta
//     classification (blockType/channel).
//   - handlers/chat.js streamResponse: settle summary — what went to content vs
//     reasoning and whether the thinking→content fallback fired.
import { safeLogValue } from './log-safety.js';

export const LEAK_TRACE_ENV = 'WINDSURFAPI_LEAK_TRACE';

export function leakTraceEnabled(env = process.env) {
  return String(env[LEAK_TRACE_ENV] ?? '').trim() === '1';
}

// Marker strings that indicate model reasoning present in a text channel.
// DeepSeek wraps reasoning in <thinking>…</thinking>; Kimi K2 emits ◁think▷;
// <think>…</think> is the dialect #250 is named by and the one the #243
// classifier (THINK_OPEN) is built on — the trace must recognize the dialect
// it is deployed to catch. Extend here when another model ships a different
// marker.
export const THINK_MARKERS = ['<think>', '</think>', '<thinking>', '</thinking>', '◁think▷'];

export function thinkMarkersIn(text) {
  const found = THINK_MARKERS.filter((m) => String(text ?? '').includes(m));
  return found.length ? found : null;
}

// Bounded text sample for logs (never the whole payload). Reuses the repo's
// existing log-boundary sanitizer (control chars → '·', slice to max, '…').
export function leakSample(text, max = 120) {
  return safeLogValue(text, max);
}
