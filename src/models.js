/**
 * Model catalog — merged from hardcoded enum values + live GetCascadeModelConfigs.
 *
 * Routing logic:
 *   modelUid present  → Cascade flow (StartCascade → SendUserCascadeMessage)
 *   only enumValue>0  → RawGetChatMessage (legacy)
 *
 * Credit multipliers sourced from GetCascadeModelConfigs (server.codeium.com).
 * Enum values sourced from Windsurf extension.js decompilation.
 */

export const MODELS = {
  // ── Claude ──────────────────────────────────────────────
  'claude-3.5-sonnet':              { name: 'claude-3.5-sonnet',              provider: 'anthropic', enumValue: 166, credit: 2 },
  'claude-3.7-sonnet':              { name: 'claude-3.7-sonnet',              provider: 'anthropic', enumValue: 226, credit: 2 },
  'claude-3.7-sonnet-thinking':     { name: 'claude-3.7-sonnet-thinking',     provider: 'anthropic', enumValue: 227, credit: 3 },
  'claude-4-sonnet':                { name: 'claude-4-sonnet',                provider: 'anthropic', enumValue: 281, modelUid: 'MODEL_CLAUDE_4_SONNET', credit: 2 },
  'claude-4-sonnet-thinking':       { name: 'claude-4-sonnet-thinking',       provider: 'anthropic', enumValue: 282, modelUid: 'MODEL_CLAUDE_4_SONNET_THINKING', credit: 3 },
  'claude-4-opus':                  { name: 'claude-4-opus',                  provider: 'anthropic', enumValue: 290, modelUid: 'MODEL_CLAUDE_4_OPUS', credit: 4 },
  'claude-4-opus-thinking':         { name: 'claude-4-opus-thinking',         provider: 'anthropic', enumValue: 291, modelUid: 'MODEL_CLAUDE_4_OPUS_THINKING', credit: 5 },
  'claude-4.1-opus':                { name: 'claude-4.1-opus',                provider: 'anthropic', enumValue: 328, modelUid: 'MODEL_CLAUDE_4_1_OPUS', credit: 4 },
  'claude-4.1-opus-thinking':       { name: 'claude-4.1-opus-thinking',       provider: 'anthropic', enumValue: 329, modelUid: 'MODEL_CLAUDE_4_1_OPUS_THINKING', credit: 5 },
  'claude-4.5-haiku':               { name: 'claude-4.5-haiku',               provider: 'anthropic', enumValue: 0,   modelUid: 'MODEL_PRIVATE_11', credit: 1 },
  'claude-4.5-sonnet':              { name: 'claude-4.5-sonnet',              provider: 'anthropic', enumValue: 353, modelUid: 'MODEL_PRIVATE_2', credit: 2 },
  'claude-4.5-sonnet-thinking':     { name: 'claude-4.5-sonnet-thinking',     provider: 'anthropic', enumValue: 354, modelUid: 'MODEL_PRIVATE_3', credit: 3 },
  'claude-4.5-opus':                { name: 'claude-4.5-opus',                provider: 'anthropic', enumValue: 391, modelUid: 'MODEL_CLAUDE_4_5_OPUS', credit: 4 },
  'claude-4.5-opus-thinking':       { name: 'claude-4.5-opus-thinking',       provider: 'anthropic', enumValue: 392, modelUid: 'MODEL_CLAUDE_4_5_OPUS_THINKING', credit: 5 },
  'claude-sonnet-4.6':              { name: 'claude-sonnet-4.6',              provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-4-6', credit: 4 },
  'claude-sonnet-4.6-thinking':     { name: 'claude-sonnet-4.6-thinking',     provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-4-6-thinking', credit: 6 },
  'claude-sonnet-4.6-1m':           { name: 'claude-sonnet-4.6-1m',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-4-6-1m', credit: 12 },
  'claude-sonnet-4.6-thinking-1m':  { name: 'claude-sonnet-4.6-thinking-1m',  provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-4-6-thinking-1m', credit: 16 },
  'claude-opus-4.6':                { name: 'claude-opus-4.6',                provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-6', credit: 6 },
  'claude-opus-4.6-thinking':       { name: 'claude-opus-4.6-thinking',       provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-6-thinking', credit: 8 },

  // ── GPT ─────────────────────────────────────────────────
  'gpt-4o':                         { name: 'gpt-4o',                         provider: 'openai', enumValue: 109, modelUid: 'MODEL_CHAT_GPT_4O_2024_08_06', credit: 1 },
  'gpt-4o-mini':                    { name: 'gpt-4o-mini',                    provider: 'openai', enumValue: 113, credit: 0.5 },
  'gpt-4.1':                        { name: 'gpt-4.1',                        provider: 'openai', enumValue: 259, modelUid: 'MODEL_CHAT_GPT_4_1_2025_04_14', credit: 1 },
  'gpt-4.1-mini':                   { name: 'gpt-4.1-mini',                   provider: 'openai', enumValue: 260, credit: 0.5 },
  'gpt-4.1-nano':                   { name: 'gpt-4.1-nano',                   provider: 'openai', enumValue: 261, credit: 0.25 },
  'gpt-5':                          { name: 'gpt-5',                          provider: 'openai', enumValue: 340, modelUid: 'MODEL_PRIVATE_6', credit: 0.5 },
  'gpt-5-medium':                   { name: 'gpt-5-medium',                   provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_7', credit: 1 },
  'gpt-5-high':                     { name: 'gpt-5-high',                     provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_8', credit: 2 },
  'gpt-5-mini':                     { name: 'gpt-5-mini',                     provider: 'openai', enumValue: 337, credit: 0.25 },
  'gpt-5-codex':                    { name: 'gpt-5-codex',                    provider: 'openai', enumValue: 346, modelUid: 'MODEL_CHAT_GPT_5_CODEX', credit: 0.5 },

  // GPT-5.1
  'gpt-5.1':                        { name: 'gpt-5.1',                        provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_12', credit: 0.5 },
  'gpt-5.1-low':                    { name: 'gpt-5.1-low',                    provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_13', credit: 0.5 },
  'gpt-5.1-medium':                 { name: 'gpt-5.1-medium',                 provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_14', credit: 1 },
  'gpt-5.1-high':                   { name: 'gpt-5.1-high',                   provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_15', credit: 2 },
  'gpt-5.1-fast':                   { name: 'gpt-5.1-fast',                   provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_20', credit: 1 },
  'gpt-5.1-low-fast':               { name: 'gpt-5.1-low-fast',               provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_21', credit: 1 },
  'gpt-5.1-medium-fast':            { name: 'gpt-5.1-medium-fast',            provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_22', credit: 2 },
  'gpt-5.1-high-fast':              { name: 'gpt-5.1-high-fast',              provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_23', credit: 4 },

  // GPT-5.1 Codex
  'gpt-5.1-codex-low':              { name: 'gpt-5.1-codex-low',              provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_1_CODEX_LOW', credit: 0.5 },
  'gpt-5.1-codex-medium':           { name: 'gpt-5.1-codex-medium',           provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_9', credit: 1 },
  'gpt-5.1-codex-mini-low':         { name: 'gpt-5.1-codex-mini-low',         provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_1_CODEX_MINI_LOW', credit: 0.25 },
  'gpt-5.1-codex-mini':             { name: 'gpt-5.1-codex-mini',             provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_19', credit: 0.5 },
  'gpt-5.1-codex-max-low':          { name: 'gpt-5.1-codex-max-low',          provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_1_CODEX_MAX_LOW', credit: 1 },
  'gpt-5.1-codex-max-medium':       { name: 'gpt-5.1-codex-max-medium',       provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_1_CODEX_MAX_MEDIUM', credit: 1.25 },
  'gpt-5.1-codex-max-high':         { name: 'gpt-5.1-codex-max-high',         provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_1_CODEX_MAX_HIGH', credit: 1.5 },

  // GPT-5.2
  'gpt-5.2':                        { name: 'gpt-5.2',                        provider: 'openai', enumValue: 401, modelUid: 'MODEL_GPT_5_2_MEDIUM', credit: 2 },
  'gpt-5.2-none':                   { name: 'gpt-5.2-none',                   provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_NONE', credit: 1 },
  'gpt-5.2-low':                    { name: 'gpt-5.2-low',                    provider: 'openai', enumValue: 400, modelUid: 'MODEL_GPT_5_2_LOW', credit: 1 },
  'gpt-5.2-high':                   { name: 'gpt-5.2-high',                   provider: 'openai', enumValue: 402, modelUid: 'MODEL_GPT_5_2_HIGH', credit: 3 },
  'gpt-5.2-xhigh':                  { name: 'gpt-5.2-xhigh',                  provider: 'openai', enumValue: 403, modelUid: 'MODEL_GPT_5_2_XHIGH', credit: 8 },
  'gpt-5.2-none-fast':              { name: 'gpt-5.2-none-fast',              provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_NONE_PRIORITY', credit: 2 },
  'gpt-5.2-low-fast':               { name: 'gpt-5.2-low-fast',               provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_LOW_PRIORITY', credit: 2 },
  'gpt-5.2-medium-fast':            { name: 'gpt-5.2-medium-fast',            provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_MEDIUM_PRIORITY', credit: 4 },
  'gpt-5.2-high-fast':              { name: 'gpt-5.2-high-fast',              provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_HIGH_PRIORITY', credit: 6 },
  'gpt-5.2-xhigh-fast':             { name: 'gpt-5.2-xhigh-fast',             provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_XHIGH_PRIORITY', credit: 16 },

  // GPT-5.2 Codex
  'gpt-5.2-codex-low':              { name: 'gpt-5.2-codex-low',              provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_CODEX_LOW', credit: 1 },
  'gpt-5.2-codex-medium':           { name: 'gpt-5.2-codex-medium',           provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_CODEX_MEDIUM', credit: 1 },
  'gpt-5.2-codex-high':             { name: 'gpt-5.2-codex-high',             provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_CODEX_HIGH', credit: 2 },
  'gpt-5.2-codex-xhigh':            { name: 'gpt-5.2-codex-xhigh',            provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_CODEX_XHIGH', credit: 3 },
  'gpt-5.2-codex-low-fast':         { name: 'gpt-5.2-codex-low-fast',         provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_CODEX_LOW_PRIORITY', credit: 2 },
  'gpt-5.2-codex-medium-fast':      { name: 'gpt-5.2-codex-medium-fast',      provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_CODEX_MEDIUM_PRIORITY', credit: 2 },
  'gpt-5.2-codex-high-fast':        { name: 'gpt-5.2-codex-high-fast',        provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_CODEX_HIGH_PRIORITY', credit: 4 },
  'gpt-5.2-codex-xhigh-fast':       { name: 'gpt-5.2-codex-xhigh-fast',       provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_5_2_CODEX_XHIGH_PRIORITY', credit: 6 },

  // GPT-5.3 Codex (legacy key)
  'gpt-5.3-codex':                  { name: 'gpt-5.3-codex',                  provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-medium', credit: 1 },

  // GPT-5.4
  'gpt-5.4-none':                   { name: 'gpt-5.4-none',                   provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-none', credit: 0.5 },
  'gpt-5.4-low':                    { name: 'gpt-5.4-low',                    provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-low', credit: 1 },
  'gpt-5.4-medium':                 { name: 'gpt-5.4-medium',                 provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-medium', credit: 2 },
  'gpt-5.4-high':                   { name: 'gpt-5.4-high',                   provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-high', credit: 4 },
  'gpt-5.4-xhigh':                  { name: 'gpt-5.4-xhigh',                  provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-xhigh', credit: 8 },
  'gpt-5.4-mini-low':               { name: 'gpt-5.4-mini-low',               provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-mini-low', credit: 1.5 },
  'gpt-5.4-mini-medium':            { name: 'gpt-5.4-mini-medium',            provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-mini-medium', credit: 1.5 },
  'gpt-5.4-mini-high':              { name: 'gpt-5.4-mini-high',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-mini-high', credit: 4.5 },
  'gpt-5.4-mini-xhigh':             { name: 'gpt-5.4-mini-xhigh',             provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-mini-xhigh', credit: 12 },

  // GPT-OSS
  'gpt-oss-120b':                   { name: 'gpt-oss-120b',                   provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_OSS_120B', credit: 0.25 },

  // ── O-series ────────────────────────────────────────────
  'o3-mini':                        { name: 'o3-mini',                        provider: 'openai', enumValue: 207, credit: 0.5 },
  'o3':                             { name: 'o3',                             provider: 'openai', enumValue: 218, modelUid: 'MODEL_CHAT_O3', credit: 1 },
  'o3-high':                        { name: 'o3-high',                        provider: 'openai', enumValue: 0,   modelUid: 'MODEL_CHAT_O3_HIGH', credit: 1 },
  'o3-pro':                         { name: 'o3-pro',                         provider: 'openai', enumValue: 294, credit: 4 },
  'o4-mini':                        { name: 'o4-mini',                        provider: 'openai', enumValue: 264, credit: 0.5 },

  // ── Gemini ──────────────────────────────────────────────
  'gemini-2.5-pro':                 { name: 'gemini-2.5-pro',                 provider: 'google', enumValue: 246, modelUid: 'MODEL_GOOGLE_GEMINI_2_5_PRO', credit: 1 },
  'gemini-2.5-flash':               { name: 'gemini-2.5-flash',               provider: 'google', enumValue: 312, modelUid: 'MODEL_GOOGLE_GEMINI_2_5_FLASH', credit: 0.5 },
  'gemini-3.0-pro':                 { name: 'gemini-3.0-pro',                 provider: 'google', enumValue: 412, modelUid: 'MODEL_GOOGLE_GEMINI_3_0_PRO_LOW', credit: 1 },
  'gemini-3.0-flash-minimal':       { name: 'gemini-3.0-flash-minimal',       provider: 'google', enumValue: 0,   modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL', credit: 0.75 },
  'gemini-3.0-flash-low':           { name: 'gemini-3.0-flash-low',           provider: 'google', enumValue: 0,   modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW', credit: 1 },
  'gemini-3.0-flash':               { name: 'gemini-3.0-flash',               provider: 'google', enumValue: 415, modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM', credit: 1 },
  'gemini-3.0-flash-high':          { name: 'gemini-3.0-flash-high',          provider: 'google', enumValue: 0,   modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH', credit: 1.75 },
  'gemini-3.1-pro-low':             { name: 'gemini-3.1-pro-low',             provider: 'google', enumValue: 0,   modelUid: 'gemini-3-1-pro-low', credit: 1 },
  'gemini-3.1-pro-high':            { name: 'gemini-3.1-pro-high',            provider: 'google', enumValue: 0,   modelUid: 'gemini-3-1-pro-high', credit: 2 },

  // ── DeepSeek ────────────────────────────────────────────
  'deepseek-v3':                    { name: 'deepseek-v3',                    provider: 'deepseek', enumValue: 205, credit: 0.5 },
  'deepseek-v3-2':                  { name: 'deepseek-v3-2',                  provider: 'deepseek', enumValue: 409, credit: 0.5 },
  'deepseek-r1':                    { name: 'deepseek-r1',                    provider: 'deepseek', enumValue: 206, credit: 1 },

  // ── Grok ────────────────────────────────────────────────
  'grok-3':                         { name: 'grok-3',                         provider: 'xai', enumValue: 217, modelUid: 'MODEL_XAI_GROK_3', credit: 1 },
  'grok-3-mini':                    { name: 'grok-3-mini',                    provider: 'xai', enumValue: 234, credit: 0.5 },
  'grok-3-mini-thinking':           { name: 'grok-3-mini-thinking',           provider: 'xai', enumValue: 0,   modelUid: 'MODEL_XAI_GROK_3_MINI_REASONING', credit: 0.125 },
  'grok-code-fast-1':               { name: 'grok-code-fast-1',               provider: 'xai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_4', credit: 0.5 },

  // ── Qwen ────────────────────────────────────────────────
  'qwen-3':                         { name: 'qwen-3',                         provider: 'alibaba', enumValue: 324, credit: 0.5 },
  'qwen-3-coder':                   { name: 'qwen-3-coder',                   provider: 'alibaba', enumValue: 325, credit: 0.5 },

  // ── Kimi ────────────────────────────────────────────────
  'kimi-k2':                        { name: 'kimi-k2',                        provider: 'moonshot', enumValue: 0,   modelUid: 'MODEL_KIMI_K2', credit: 0.5 },
  'kimi-k2.5':                      { name: 'kimi-k2.5',                      provider: 'moonshot', enumValue: 0,   modelUid: 'kimi-k2-5', credit: 1 },

  // ── GLM ─────────────────────────────────────────────────
  'glm-4.7':                        { name: 'glm-4.7',                        provider: 'zhipu', enumValue: 417, modelUid: 'MODEL_GLM_4_7', credit: 0.25 },
  'glm-5':                          { name: 'glm-5',                          provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5', credit: 1.5 },
  'glm-5.1':                        { name: 'glm-5.1',                        provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-1', credit: 1.5 },

  // ── MiniMax ─────────────────────────────────────────────
  'minimax-m2.5':                   { name: 'minimax-m2.5',                   provider: 'minimax', enumValue: 0,   modelUid: 'minimax-m2-5', credit: 1 },

  // ── Windsurf SWE ────────────────────────────────────────
  'swe-1.5':                        { name: 'swe-1.5',                        provider: 'windsurf', enumValue: 369, modelUid: 'MODEL_SWE_1_5_SLOW', credit: 0.5 },
  'swe-1.5-fast':                   { name: 'swe-1.5-fast',                   provider: 'windsurf', enumValue: 359, modelUid: 'MODEL_SWE_1_5', credit: 0.5 },
  'swe-1.6':                        { name: 'swe-1.6',                        provider: 'windsurf', enumValue: 0,   modelUid: 'swe-1-6', credit: 0.5 },
  'swe-1.6-fast':                   { name: 'swe-1.6-fast',                   provider: 'windsurf', enumValue: 0,   modelUid: 'swe-1-6-fast', credit: 0.5 },

  // ── Arena ───────────────────────────────────────────────
  'arena-fast':                     { name: 'arena-fast',                     provider: 'windsurf', enumValue: 0,   modelUid: 'arena-fast', credit: 0.5 },
  'arena-smart':                    { name: 'arena-smart',                    provider: 'windsurf', enumValue: 0,   modelUid: 'arena-smart', credit: 1 },
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
_lookup.set('claude-sonnet-4-6-thinking', 'claude-sonnet-4.6-thinking');
_lookup.set('claude-opus-4-6-thinking', 'claude-opus-4.6-thinking');
_lookup.set('claude-sonnet-4-6', 'claude-sonnet-4.6');
_lookup.set('claude-opus-4-6', 'claude-opus-4.6');
_lookup.set('MODEL_CLAUDE_4_5_SONNET', 'claude-4.5-sonnet');
_lookup.set('MODEL_CLAUDE_4_5_SONNET_THINKING', 'claude-4.5-sonnet-thinking');
// UID-based aliases not already covered by modelUid field
_lookup.set('claude-sonnet-4-6-1m', 'claude-sonnet-4.6-1m');
_lookup.set('claude-sonnet-4-6-thinking-1m', 'claude-sonnet-4.6-thinking-1m');
_lookup.set('gpt-5-4-none', 'gpt-5.4-none');
_lookup.set('gpt-5-4-low', 'gpt-5.4-low');
_lookup.set('gpt-5-4-medium', 'gpt-5.4-medium');
_lookup.set('gpt-5-4-high', 'gpt-5.4-high');
_lookup.set('gpt-5-4-xhigh', 'gpt-5.4-xhigh');
_lookup.set('gpt-5-4-mini-low', 'gpt-5.4-mini-low');
_lookup.set('gpt-5-4-mini-medium', 'gpt-5.4-mini-medium');
_lookup.set('gpt-5-4-mini-high', 'gpt-5.4-mini-high');
_lookup.set('gpt-5-4-mini-xhigh', 'gpt-5.4-mini-xhigh');

/** Resolve user model name → internal model key. */
export function resolveModel(name) {
  if (!name) return null;
  return _lookup.get(name) || _lookup.get(name.toLowerCase()) || name;
}

/** Get model info including enum and uid. */
export function getModelInfo(id) {
  return MODELS[id] || null;
}

// Reverse map: Model enum number → list of catalog keys (enum may match
// multiple variants if we ever dupe, but typically 1:1).
const _enumToKeys = (() => {
  const m = new Map();
  for (const [key, info] of Object.entries(MODELS)) {
    if (info.enumValue && info.enumValue > 0) {
      const arr = m.get(info.enumValue) || [];
      arr.push(key);
      m.set(info.enumValue, arr);
    }
  }
  return m;
})();

/** Reverse-lookup a Model enum number to our catalog keys. */
export function getModelKeysByEnum(enumValue) {
  return _enumToKeys.get(enumValue) || [];
}

// ─── Tier access ───────────────────────────────────────────

const ALL_MODEL_KEYS = Object.keys(MODELS);
const FREE_TIER_MODELS = ['gpt-4o-mini', 'gemini-2.5-flash'];

export const MODEL_TIER_ACCESS = {
  get pro() { return Object.keys(MODELS); },
  free: FREE_TIER_MODELS,
  unknown: FREE_TIER_MODELS,
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

/**
 * Merge live model configs from GetCascadeModelConfigs into the catalog.
 * Called once at startup after the first successful cloud fetch.
 * Only adds NEW models not already in the catalog (doesn't overwrite enums).
 */
export function mergeCloudModels(configs) {
  if (!Array.isArray(configs)) return 0;
  let added = 0;
  const providerMap = {
    MODEL_PROVIDER_ANTHROPIC: 'anthropic',
    MODEL_PROVIDER_OPENAI: 'openai',
    MODEL_PROVIDER_GOOGLE: 'google',
    MODEL_PROVIDER_DEEPSEEK: 'deepseek',
    MODEL_PROVIDER_XAI: 'xai',
    MODEL_PROVIDER_WINDSURF: 'windsurf',
    MODEL_PROVIDER_MOONSHOT: 'moonshot',
  };

  for (const m of configs) {
    const uid = m.modelUid;
    if (!uid) continue;
    // Already in catalog?
    if (_lookup.has(uid) || _lookup.has(uid.toLowerCase())) continue;

    const key = uid.toLowerCase().replace(/_/g, '-');
    if (MODELS[key]) continue;

    const provider = providerMap[m.provider] || m.provider?.toLowerCase()?.replace('model_provider_', '') || 'unknown';
    MODELS[key] = {
      name: key,
      provider,
      enumValue: 0,
      modelUid: uid,
      credit: m.creditMultiplier || 1,
    };
    _lookup.set(key, key);
    _lookup.set(uid, key);
    _lookup.set(uid.toLowerCase(), key);
    added++;
  }
  return added;
}
