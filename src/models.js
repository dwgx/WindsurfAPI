/**
 * Model catalog with enum values and UID routing.
 * UIDs sourced from https://docs.windsurf.com/windsurf/models (Apr 2026).
 *
 * Models with modelUid → Cascade flow (currently disabled — crashes LS)
 * Models with only enumValue → RawGetChatMessage (legacy)
 */

export const MODELS = {
  // ── Claude ──────────────────────────────────────────────
  'claude-3.5-sonnet': { name: 'claude-3.5-sonnet', provider: 'anthropic', enumValue: 166 },
  'claude-3.7-sonnet': { name: 'claude-3.7-sonnet', provider: 'anthropic', enumValue: 226 },
  'claude-3.7-sonnet-thinking': { name: 'claude-3.7-sonnet-thinking', provider: 'anthropic', enumValue: 227 },
  'claude-4-sonnet': { name: 'claude-4-sonnet', provider: 'anthropic', enumValue: 281, modelUid: 'MODEL_CLAUDE_4_SONNET' },
  'claude-4-sonnet-thinking': { name: 'claude-4-sonnet-thinking', provider: 'anthropic', enumValue: 282, modelUid: 'MODEL_CLAUDE_4_SONNET_THINKING' },
  'claude-4-opus': { name: 'claude-4-opus', provider: 'anthropic', enumValue: 290, modelUid: 'MODEL_CLAUDE_4_OPUS' },
  'claude-4-opus-thinking': { name: 'claude-4-opus-thinking', provider: 'anthropic', enumValue: 291, modelUid: 'MODEL_CLAUDE_4_OPUS_THINKING' },
  'claude-4.1-opus': { name: 'claude-4.1-opus', provider: 'anthropic', enumValue: 328, modelUid: 'MODEL_CLAUDE_4_1_OPUS' },
  'claude-4.1-opus-thinking': { name: 'claude-4.1-opus-thinking', provider: 'anthropic', enumValue: 329, modelUid: 'MODEL_CLAUDE_4_1_OPUS_THINKING' },
  'claude-4.5-sonnet': { name: 'claude-4.5-sonnet', provider: 'anthropic', enumValue: 353, modelUid: 'MODEL_PRIVATE_2' },
  'claude-4.5-sonnet-thinking': { name: 'claude-4.5-sonnet-thinking', provider: 'anthropic', enumValue: 354, modelUid: 'claude-sonnet-4-6-thinking' },
  'claude-4.5-haiku': { name: 'claude-4.5-haiku', provider: 'anthropic', enumValue: 0, modelUid: 'MODEL_PRIVATE_11' },
  'claude-4.5-opus': { name: 'claude-4.5-opus', provider: 'anthropic', enumValue: 391, modelUid: 'MODEL_CLAUDE_4_5_OPUS' },
  'claude-4.5-opus-thinking': { name: 'claude-4.5-opus-thinking', provider: 'anthropic', enumValue: 392, modelUid: 'claude-opus-4-6-thinking' },
  'claude-sonnet-4.6': { name: 'claude-sonnet-4.6', provider: 'anthropic', enumValue: 0, modelUid: 'claude-sonnet-4-6' },
  'claude-sonnet-4.6-thinking': { name: 'claude-sonnet-4.6-thinking', provider: 'anthropic', enumValue: 0, modelUid: 'claude-sonnet-4-6-thinking' },
  'claude-opus-4.6': { name: 'claude-opus-4.6', provider: 'anthropic', enumValue: 0, modelUid: 'claude-opus-4-6' },
  'claude-opus-4.6-thinking': { name: 'claude-opus-4.6-thinking', provider: 'anthropic', enumValue: 0, modelUid: 'claude-opus-4-6-thinking' },
  // claude-code requires Windsurf's special is_claude_code agent flow
  // (different RPC than standard Cascade/legacy) — not supported through our proxy.

  // ── GPT ─────────────────────────────────────────────────
  'gpt-4o': { name: 'gpt-4o', provider: 'openai', enumValue: 109 },
  'gpt-4o-mini': { name: 'gpt-4o-mini', provider: 'openai', enumValue: 113 },
  'gpt-4.1': { name: 'gpt-4.1', provider: 'openai', enumValue: 259, modelUid: 'MODEL_CHAT_GPT_4_1_2025_04_14' },
  'gpt-4.1-mini': { name: 'gpt-4.1-mini', provider: 'openai', enumValue: 260 },
  'gpt-4.1-nano': { name: 'gpt-4.1-nano', provider: 'openai', enumValue: 261 },
  'gpt-5': { name: 'gpt-5', provider: 'openai', enumValue: 340 },
  'gpt-5-mini': { name: 'gpt-5-mini', provider: 'openai', enumValue: 337 },
  'gpt-5.2': { name: 'gpt-5.2', provider: 'openai', enumValue: 401, modelUid: 'MODEL_GPT_5_2_MEDIUM' },
  'gpt-5.2-low': { name: 'gpt-5.2-low', provider: 'openai', enumValue: 400, modelUid: 'MODEL_GPT_5_2_LOW' },
  'gpt-5.2-high': { name: 'gpt-5.2-high', provider: 'openai', enumValue: 402, modelUid: 'MODEL_GPT_5_2_HIGH' },
  'gpt-5.4-low': { name: 'gpt-5.4-low', provider: 'openai', enumValue: 0, modelUid: 'gpt-5-4-low' },
  'gpt-5.4-medium': { name: 'gpt-5.4-medium', provider: 'openai', enumValue: 0, modelUid: 'gpt-5-4-medium' },
  'gpt-5.4-xhigh': { name: 'gpt-5.4-xhigh', provider: 'openai', enumValue: 0, modelUid: 'gpt-5-4-xhigh' },
  'gpt-5.3-codex': { name: 'gpt-5.3-codex', provider: 'openai', enumValue: 0, modelUid: 'gpt-5-3-codex-medium' },

  // ── O-series ────────────────────────────────────────────
  'o3-mini': { name: 'o3-mini', provider: 'openai', enumValue: 207 },
  'o3': { name: 'o3', provider: 'openai', enumValue: 218, modelUid: 'MODEL_CHAT_O3' },
  'o3-high': { name: 'o3-high', provider: 'openai', enumValue: 0, modelUid: 'MODEL_CHAT_O3_HIGH' },
  'o3-pro': { name: 'o3-pro', provider: 'openai', enumValue: 294 },
  'o4-mini': { name: 'o4-mini', provider: 'openai', enumValue: 264 },

  // ── Gemini ──────────────────────────────────────────────
  'gemini-2.5-pro': { name: 'gemini-2.5-pro', provider: 'google', enumValue: 246, modelUid: 'MODEL_GOOGLE_GEMINI_2_5_PRO' },
  'gemini-2.5-flash': { name: 'gemini-2.5-flash', provider: 'google', enumValue: 312, modelUid: 'MODEL_GOOGLE_GEMINI_2_5_FLASH' },
  'gemini-3.0-pro': { name: 'gemini-3.0-pro', provider: 'google', enumValue: 412, modelUid: 'MODEL_GOOGLE_GEMINI_3_0_PRO_LOW' },
  'gemini-3.0-flash': { name: 'gemini-3.0-flash', provider: 'google', enumValue: 415, modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM' },
  'gemini-3.1-pro-low': { name: 'gemini-3.1-pro-low', provider: 'google', enumValue: 0, modelUid: 'gemini-3-1-pro-low' },
  'gemini-3.1-pro-high': { name: 'gemini-3.1-pro-high', provider: 'google', enumValue: 0, modelUid: 'gemini-3-1-pro-high' },

  // ── DeepSeek ────────────────────────────────────────────
  'deepseek-v3': { name: 'deepseek-v3', provider: 'deepseek', enumValue: 205 },
  'deepseek-r1': { name: 'deepseek-r1', provider: 'deepseek', enumValue: 206 },

  // ── Grok ────────────────────────────────────────────────
  'grok-3': { name: 'grok-3', provider: 'xai', enumValue: 217, modelUid: 'MODEL_XAI_GROK_3' },
  'grok-3-mini': { name: 'grok-3-mini', provider: 'xai', enumValue: 234 },
  'grok-code-fast-1': { name: 'grok-code-fast-1', provider: 'xai', enumValue: 0, modelUid: 'MODEL_PRIVATE_4' },

  // ── Qwen ────────────────────────────────────────────────
  'qwen-3': { name: 'qwen-3', provider: 'alibaba', enumValue: 324 },
  'qwen-3-coder': { name: 'qwen-3-coder', provider: 'alibaba', enumValue: 325 },

  // ── Kimi ────────────────────────────────────────────────
  'kimi-k2': { name: 'kimi-k2', provider: 'moonshot', enumValue: 0, modelUid: 'MODEL_KIMI_K2' },
  'kimi-k2.5': { name: 'kimi-k2.5', provider: 'moonshot', enumValue: 0, modelUid: 'kimi-k2-5' },

  // ── Windsurf SWE ────────────────────────────────────────
  'swe-1.5': { name: 'swe-1.5', provider: 'windsurf', enumValue: 359, modelUid: 'MODEL_SWE_1_5' },
  'swe-1.5-thinking': { name: 'swe-1.5-thinking', provider: 'windsurf', enumValue: 369, modelUid: 'MODEL_SWE_1_5_SLOW' },
  'swe-1.6-fast': { name: 'swe-1.6-fast', provider: 'windsurf', enumValue: 0, modelUid: 'swe-1-6-fast' },

  // ── Arena ───────────────────────────────────────────────
  'arena-fast': { name: 'arena-fast', provider: 'windsurf', enumValue: 0, modelUid: 'arena-fast' },
  'arena-smart': { name: 'arena-smart', provider: 'windsurf', enumValue: 0, modelUid: 'arena-smart' },
};

// Build reverse lookup
const _lookup = new Map();
for (const [id, info] of Object.entries(MODELS)) {
  _lookup.set(id, id);
  _lookup.set(id.toLowerCase(), id);
  _lookup.set(info.name, id);
  _lookup.set(info.name.toLowerCase(), id);
  if (info.modelUid) _lookup.set(info.modelUid, id);
  if (info.modelUid) _lookup.set(info.modelUid.toLowerCase(), id);
}
// Legacy aliases
_lookup.set('claude-sonnet-4-6-thinking', 'claude-4.5-sonnet-thinking');
_lookup.set('claude-opus-4-6-thinking', 'claude-4.5-opus-thinking');
_lookup.set('claude-sonnet-4-6', 'claude-sonnet-4.6');
_lookup.set('claude-opus-4-6', 'claude-opus-4.6');
_lookup.set('MODEL_CLAUDE_4_5_SONNET', 'claude-4.5-sonnet');
_lookup.set('MODEL_CLAUDE_4_5_SONNET_THINKING', 'claude-4.5-sonnet-thinking');

/** Resolve user model name → internal model key. */
export function resolveModel(name) {
  if (!name) return null;
  return _lookup.get(name) || _lookup.get(name.toLowerCase()) || name;
}

/** Get model info including enum and uid. */
export function getModelInfo(id) {
  return MODELS[id] || null;
}

// ─── Tier access ───────────────────────────────────────────
//
// Which models each subscription tier can call. Hardcoded rather than
// probe-derived because Windsurf's free/pro entitlements are stable — the
// old auto-probe flow only tested 4 canary models and left the rest as
// "unknown", so the dashboard couldn't tell the difference between "not
// probed" and "not entitled". This table is the source of truth; the
// per-account `blockedModels` list then lets the operator hide specific
// models from a specific account (e.g. to route premium models only
// through certain PRO keys).

const ALL_MODEL_KEYS = Object.keys(MODELS);
const FREE_TIER_MODELS = ['gpt-4o-mini', 'gemini-2.5-flash'];

export const MODEL_TIER_ACCESS = {
  pro: ALL_MODEL_KEYS,
  free: FREE_TIER_MODELS,
  unknown: FREE_TIER_MODELS, // treat unprobed accounts as free until known
  expired: [],
};

/** Models a given tier is entitled to. */
export function getTierModels(tier) {
  return MODEL_TIER_ACCESS[tier] || MODEL_TIER_ACCESS.unknown;
}

/** List all models in OpenAI /v1/models format. */
export function listModels() {
  const ts = Math.floor(Date.now() / 1000);
  return Object.entries(MODELS).map(([id, info]) => ({
    id: info.name,
    object: 'model',
    created: ts,
    owned_by: info.provider,
    _windsurf_id: id,
  }));
}
