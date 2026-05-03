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
  // Legacy 3.5 / 3.7 series — only have enumValue (legacy RawGetChatMessage flow), no modelUid.
  // Cascade upstream returns "neither PlanModel nor RequestedModel specified" for all three;
  // chat.js translates that to 410 model_deprecated when the catalog flag is set. issue #109.
  'claude-3.5-sonnet':              { name: 'claude-3.5-sonnet',              provider: 'anthropic', enumValue: 166, credit: 2, deprecated: true },
  'claude-3.7-sonnet':              { name: 'claude-3.7-sonnet',              provider: 'anthropic', enumValue: 226, credit: 2, deprecated: true },
  'claude-3.7-sonnet-thinking':     { name: 'claude-3.7-sonnet-thinking',     provider: 'anthropic', enumValue: 227, credit: 3, deprecated: true },
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
  // Claude Opus 4.7 — Windsurf changelog 2026-04-16; new xhigh effort tier vs 4.6.
  // `medium` is the canonical default; low/high/xhigh/max are reasoning tiers,
  // each can be paired with -thinking for visible chain-of-thought.
  'claude-opus-4-7-medium':         { name: 'claude-opus-4-7-medium',         provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-medium', credit: 8 },
  'claude-opus-4-7-low':            { name: 'claude-opus-4-7-low',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-low', credit: 6 },
  'claude-opus-4-7-high':           { name: 'claude-opus-4-7-high',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-high', credit: 10 },
  'claude-opus-4-7-xhigh':          { name: 'claude-opus-4-7-xhigh',          provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-xhigh', credit: 12 },
  'claude-opus-4-7-medium-thinking': { name: 'claude-opus-4-7-medium-thinking', provider: 'anthropic', enumValue: 0, modelUid: 'claude-opus-4-7-medium-thinking', credit: 10 },
  'claude-opus-4-7-high-thinking':  { name: 'claude-opus-4-7-high-thinking',  provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-high-thinking', credit: 12 },
  'claude-opus-4-7-xhigh-thinking': { name: 'claude-opus-4-7-xhigh-thinking', provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-xhigh-thinking', credit: 16 },
  // `max` reasoning tier appeared in GetCascadeModelConfigs after the 4.7 launch — sits
  // above xhigh in the effort ladder. No -thinking sibling in cloud catalog yet.
  'claude-opus-4-7-max':            { name: 'claude-opus-4-7-max',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-max', credit: 16 },

  // ── GPT ─────────────────────────────────────────────────
  'gpt-4o':                         { name: 'gpt-4o',                         provider: 'openai', enumValue: 109, modelUid: 'MODEL_CHAT_GPT_4O_2024_08_06', credit: 1 },
  'gpt-4o-mini':                    { name: 'gpt-4o-mini',                    provider: 'openai', enumValue: 113, credit: 0.5, deprecated: true },
  'gpt-4.1':                        { name: 'gpt-4.1',                        provider: 'openai', enumValue: 259, modelUid: 'MODEL_CHAT_GPT_4_1_2025_04_14', credit: 1 },
  'gpt-4.1-mini':                   { name: 'gpt-4.1-mini',                   provider: 'openai', enumValue: 260, credit: 0.5, deprecated: true },
  'gpt-4.1-nano':                   { name: 'gpt-4.1-nano',                   provider: 'openai', enumValue: 261, credit: 0.25, deprecated: true },
  'gpt-5':                          { name: 'gpt-5',                          provider: 'openai', enumValue: 340, modelUid: 'MODEL_PRIVATE_6', credit: 0.5 },
  'gpt-5-medium':                   { name: 'gpt-5-medium',                   provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_7', credit: 1 },
  'gpt-5-high':                     { name: 'gpt-5-high',                     provider: 'openai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_8', credit: 2 },
  'gpt-5-mini':                     { name: 'gpt-5-mini',                     provider: 'openai', enumValue: 337, credit: 0.25, deprecated: true },
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

  // GPT-5.5 — Windsurf catalog 2026-04-30. Same effort ladder as 5.2/5.4 (none/low/medium/high/xhigh)
  // with priority (=fast) lane equivalents. Bare `gpt-5.5` defaults to medium.
  'gpt-5.5':                        { name: 'gpt-5.5',                        provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-medium', credit: 2 },
  'gpt-5.5-none':                   { name: 'gpt-5.5-none',                   provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-none', credit: 1 },
  'gpt-5.5-low':                    { name: 'gpt-5.5-low',                    provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-low', credit: 1 },
  'gpt-5.5-medium':                 { name: 'gpt-5.5-medium',                 provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-medium', credit: 2 },
  'gpt-5.5-high':                   { name: 'gpt-5.5-high',                   provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-high', credit: 4 },
  'gpt-5.5-xhigh':                  { name: 'gpt-5.5-xhigh',                  provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-xhigh', credit: 8 },
  'gpt-5.5-none-fast':              { name: 'gpt-5.5-none-fast',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-none-priority', credit: 2 },
  'gpt-5.5-low-fast':               { name: 'gpt-5.5-low-fast',               provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-low-priority', credit: 2 },
  'gpt-5.5-medium-fast':            { name: 'gpt-5.5-medium-fast',            provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-medium-priority', credit: 4 },
  'gpt-5.5-high-fast':              { name: 'gpt-5.5-high-fast',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-high-priority', credit: 8 },
  'gpt-5.5-xhigh-fast':             { name: 'gpt-5.5-xhigh-fast',             provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-xhigh-priority', credit: 16 },

  // GPT-5.3 Codex — already had bare `gpt-5.3-codex` (legacy alias), now expose tier variants.
  'gpt-5.3-codex-low':              { name: 'gpt-5.3-codex-low',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-low', credit: 0.5 },
  'gpt-5.3-codex-high':             { name: 'gpt-5.3-codex-high',             provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-high', credit: 2 },
  'gpt-5.3-codex-xhigh':            { name: 'gpt-5.3-codex-xhigh',            provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-xhigh', credit: 4 },
  'gpt-5.3-codex-low-fast':         { name: 'gpt-5.3-codex-low-fast',         provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-low-priority', credit: 1 },
  'gpt-5.3-codex-medium-fast':      { name: 'gpt-5.3-codex-medium-fast',      provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-medium-priority', credit: 2 },
  'gpt-5.3-codex-high-fast':        { name: 'gpt-5.3-codex-high-fast',        provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-high-priority', credit: 4 },
  'gpt-5.3-codex-xhigh-fast':       { name: 'gpt-5.3-codex-xhigh-fast',       provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-xhigh-priority', credit: 6 },

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
  'deepseek-v3':                    { name: 'deepseek-v3',                    provider: 'deepseek', enumValue: 205, credit: 0.5, deprecated: true },
  'deepseek-v3-2':                  { name: 'deepseek-v3-2',                  provider: 'deepseek', enumValue: 409, credit: 0.5, deprecated: true },
  'deepseek-r1':                    { name: 'deepseek-r1',                    provider: 'deepseek', enumValue: 206, credit: 1, deprecated: true },

  // ── Grok ────────────────────────────────────────────────
  'grok-3':                         { name: 'grok-3',                         provider: 'xai', enumValue: 217, modelUid: 'MODEL_XAI_GROK_3', credit: 1 },
  'grok-3-mini':                    { name: 'grok-3-mini',                    provider: 'xai', enumValue: 234, credit: 0.5, deprecated: true },
  'grok-3-mini-thinking':           { name: 'grok-3-mini-thinking',           provider: 'xai', enumValue: 0,   modelUid: 'MODEL_XAI_GROK_3_MINI_REASONING', credit: 0.125 },
  'grok-code-fast-1':               { name: 'grok-code-fast-1',               provider: 'xai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_4', credit: 0.5 },

  // ── Qwen ────────────────────────────────────────────────
  'qwen-3':                         { name: 'qwen-3',                         provider: 'alibaba', enumValue: 324, credit: 0.5, deprecated: true },
  // qwen-3-coder + qwen-3-coder-fast: exist in binary enum (325/327)
  // but cascade server doesn't have any routing registered for them —
  // both enum-only and explicit UIDs fail with 'model not found'.
  // Removed from catalog until upstream registers them.

  // ── Kimi ────────────────────────────────────────────────
  'kimi-k2':                        { name: 'kimi-k2',                        provider: 'moonshot', enumValue: 323, modelUid: 'MODEL_KIMI_K2', credit: 0.5 },
  'kimi-k2-thinking':               { name: 'kimi-k2-thinking',               provider: 'moonshot', enumValue: 394, modelUid: 'MODEL_KIMI_K2_THINKING', credit: 1 },
  'kimi-k2.5':                      { name: 'kimi-k2.5',                      provider: 'moonshot', enumValue: 0,   modelUid: 'kimi-k2-5', credit: 1 },
  'kimi-k2-6':                      { name: 'kimi-k2-6',                      provider: 'moonshot', enumValue: 0,   modelUid: 'kimi-k2-6', credit: 1 },

  // ── GLM ─────────────────────────────────────────────────
  'glm-4.7':                        { name: 'glm-4.7',                        provider: 'zhipu', enumValue: 417, modelUid: 'MODEL_GLM_4_7', credit: 0.25 },
  'glm-4.7-fast':                   { name: 'glm-4.7-fast',                   provider: 'zhipu', enumValue: 418, modelUid: 'MODEL_GLM_4_7_FAST', credit: 0.5 },
  'glm-5':                          { name: 'glm-5',                          provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5', credit: 1.5 },
  'glm-5.1':                        { name: 'glm-5.1',                        provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-1', credit: 1.5 },

  // ── MiniMax ─────────────────────────────────────────────
  // proto enum 419 = MODEL_MINIMAX_M2_1; the canonical name in cloud configs is m2.5.
  'minimax-m2.5':                   { name: 'minimax-m2.5',                   provider: 'minimax', enumValue: 419, modelUid: 'MODEL_MINIMAX_M2_1', credit: 1 },

  // ── Windsurf SWE ────────────────────────────────────────
  // Proto canonical enums: 359=MODEL_SWE_1_5 (fast), 369=THINKING, 377=SLOW, 420=1_6, 421=1_6_FAST.
  // The default `swe-1.5` UID alias in upstream cloud config maps to the SLOW tier (377).
  'swe-1.5':                        { name: 'swe-1.5',                        provider: 'windsurf', enumValue: 377, modelUid: 'MODEL_SWE_1_5_SLOW', credit: 0.5 },
  'swe-1.5-fast':                   { name: 'swe-1.5-fast',                   provider: 'windsurf', enumValue: 359, modelUid: 'MODEL_SWE_1_5', credit: 0.5 },
  'swe-1.5-thinking':               { name: 'swe-1.5-thinking',               provider: 'windsurf', enumValue: 369, modelUid: 'MODEL_SWE_1_5_THINKING', credit: 0.75 },
  'swe-1.6':                        { name: 'swe-1.6',                        provider: 'windsurf', enumValue: 420, modelUid: 'MODEL_SWE_1_6', credit: 0.5 },
  'swe-1.6-fast':                   { name: 'swe-1.6-fast',                   provider: 'windsurf', enumValue: 421, modelUid: 'MODEL_SWE_1_6_FAST', credit: 0.5 },

  // ── Adaptive (Windsurf 2026-04-06 changelog) ────────────
  // Adaptive Model Router + Arena models live in the cloud catalog but their
  // UIDs aren't recognized by SendUserCascadeMessage's direct-call path —
  // upstream returns "unknown model UID adaptive: model not found". They only
  // work through the Windsurf IDE's special routing layer that Cascade-direct
  // doesn't expose. Mark deprecated so they stop showing in /v1/models. #109.
  'adaptive':                       { name: 'adaptive',                       provider: 'windsurf', enumValue: 0,   modelUid: 'adaptive', credit: 1, deprecated: true },
  'arena-fast':                     { name: 'arena-fast',                     provider: 'windsurf', enumValue: 0,   modelUid: 'arena-fast', credit: 0.5, deprecated: true },
  'arena-smart':                    { name: 'arena-smart',                    provider: 'windsurf', enumValue: 0,   modelUid: 'arena-smart', credit: 1, deprecated: true },
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
// Bare `claude-4.6` (no explicit sonnet/opus) — issue #68. Without these,
// resolveModel falls through to the raw string, getModelInfo returns null,
// and chat.js silently routes to legacy rawGetChatMessage with no model
// name, so the upstream falls back to a default model whose self-knowledge
// is "I'm Claude 4.5". Default the bare alias to sonnet (more common).
_lookup.set('claude-4.6', 'claude-sonnet-4.6');
_lookup.set('claude-4.6-thinking', 'claude-sonnet-4.6-thinking');
_lookup.set('claude-4.6-1m', 'claude-sonnet-4.6-1m');
_lookup.set('claude-4.6-thinking-1m', 'claude-sonnet-4.6-thinking-1m');
_lookup.set('gpt-5-4-none', 'gpt-5.4-none');
_lookup.set('gpt-5-4-low', 'gpt-5.4-low');
_lookup.set('gpt-5-4-medium', 'gpt-5.4-medium');
_lookup.set('gpt-5-4-high', 'gpt-5.4-high');
_lookup.set('gpt-5-4-xhigh', 'gpt-5.4-xhigh');
_lookup.set('gpt-5-4-mini-low', 'gpt-5.4-mini-low');
_lookup.set('gpt-5-4-mini-medium', 'gpt-5.4-mini-medium');
_lookup.set('gpt-5-4-mini-high', 'gpt-5.4-mini-high');
_lookup.set('gpt-5-4-mini-xhigh', 'gpt-5.4-mini-xhigh');
// Bare-tier aliases — clients commonly write the dotted form for the medium tier
// even when the catalog uses bare-only or tier-only entries. Without these the
// /v1/messages handler 400s "Unsupported model" before forwarding. #109 sub2api
// reproducer was `gpt-5.2-medium` (bare gpt-5.2 = medium but the alias was missing).
_lookup.set('gpt-5.2-medium', 'gpt-5.2');                  // bare gpt-5.2 IS the medium tier
_lookup.set('gpt-5-2-medium', 'gpt-5.2');                  // cloud-format equivalent
_lookup.set('gpt-5.2-codex', 'gpt-5.2-codex-medium');      // bare codex → medium
_lookup.set('gpt-5-2-codex-medium', 'gpt-5.2-codex-medium');
_lookup.set('gpt-5.3-codex-medium', 'gpt-5.3-codex');      // bare codex IS medium
_lookup.set('gpt-5.4', 'gpt-5.4-medium');                  // bare → medium per family convention
// gpt-5.5 cloud-format aliases (cloud sends `gpt-5-5-*`, OpenAI-style is `gpt-5.5-*`)
_lookup.set('gpt-5-5', 'gpt-5.5');
_lookup.set('gpt-5-5-none', 'gpt-5.5-none');
_lookup.set('gpt-5-5-low', 'gpt-5.5-low');
_lookup.set('gpt-5-5-medium', 'gpt-5.5-medium');
_lookup.set('gpt-5-5-high', 'gpt-5.5-high');
_lookup.set('gpt-5-5-xhigh', 'gpt-5.5-xhigh');
_lookup.set('gpt-5-5-none-priority', 'gpt-5.5-none-fast');
_lookup.set('gpt-5-5-low-priority', 'gpt-5.5-low-fast');
_lookup.set('gpt-5-5-medium-priority', 'gpt-5.5-medium-fast');
_lookup.set('gpt-5-5-high-priority', 'gpt-5.5-high-fast');
_lookup.set('gpt-5-5-xhigh-priority', 'gpt-5.5-xhigh-fast');
// gpt-5.3-codex tier aliases
_lookup.set('gpt-5-3-codex-low', 'gpt-5.3-codex-low');
_lookup.set('gpt-5-3-codex-medium', 'gpt-5.3-codex');
_lookup.set('gpt-5-3-codex-high', 'gpt-5.3-codex-high');
_lookup.set('gpt-5-3-codex-xhigh', 'gpt-5.3-codex-xhigh');
_lookup.set('gpt-5-3-codex-low-priority', 'gpt-5.3-codex-low-fast');
_lookup.set('gpt-5-3-codex-medium-priority', 'gpt-5.3-codex-medium-fast');
_lookup.set('gpt-5-3-codex-high-priority', 'gpt-5.3-codex-high-fast');
_lookup.set('gpt-5-3-codex-xhigh-priority', 'gpt-5.3-codex-xhigh-fast');
// Cloud-format aliases for existing dotted names
_lookup.set('swe-1-6', 'swe-1.6');
_lookup.set('swe-1-6-fast', 'swe-1.6-fast');
_lookup.set('minimax-m2-5', 'minimax-m2.5');
_lookup.set('kimi-k2-5', 'kimi-k2.5');

// Anthropic official dated names — Cursor / Claude Code / Anthropic SDK
// all send these verbatim. Map each to our short key so the same client
// can talk to this API without a custom-name translation layer.
const ANTHROPIC_DATED = {
  'claude-3-5-sonnet-20240620': 'claude-3.5-sonnet',
  'claude-3-5-sonnet-20241022': 'claude-3.5-sonnet',
  'claude-3-5-sonnet-latest':   'claude-3.5-sonnet',
  'claude-3-7-sonnet-20250219': 'claude-3.7-sonnet',
  'claude-3-7-sonnet-latest':   'claude-3.7-sonnet',
  'claude-sonnet-4-20250514':   'claude-4-sonnet',
  'claude-sonnet-4-0':          'claude-4-sonnet',
  'claude-opus-4-20250514':     'claude-4-opus',
  'claude-opus-4-0':            'claude-4-opus',
  'claude-opus-4-1':            'claude-4.1-opus',
  'claude-opus-4-1-20250805':   'claude-4.1-opus',
  'claude-sonnet-4-5':          'claude-4.5-sonnet',
  'claude-sonnet-4-5-20250929': 'claude-4.5-sonnet',
  'claude-sonnet-4-5-latest':   'claude-4.5-sonnet',
  'claude-opus-4-5':            'claude-4.5-opus',
  'claude-opus-4-5-20251101':   'claude-4.5-opus',
  'claude-opus-4-5-latest':     'claude-4.5-opus',
  // Claude Haiku 4.5 — Anthropic official id `claude-haiku-4-5-20251001`
  // (#117 xiaoxin-zk: dashboard test sent the dated form, hit
  // "Unsupported model" 400 because no alias existed). Cover the dated
  // name + bare + latest the same way sonnet/opus already are.
  'claude-haiku-4-5':           'claude-4.5-haiku',
  'claude-haiku-4-5-20251001':  'claude-4.5-haiku',
  'claude-haiku-4-5-latest':    'claude-4.5-haiku',
  // Legacy Haiku dated names — Anthropic SDK clients sometimes still
  // ship these. Map to the closest live model (4.5-haiku) so the request
  // doesn't 400; the `deprecated` flag isn't set on 4.5-haiku so it
  // routes normally.
  'claude-3-5-haiku-20241022':  'claude-4.5-haiku',
  'claude-3-5-haiku-latest':    'claude-4.5-haiku',
  'claude-haiku-3-5':           'claude-4.5-haiku',
  'claude-haiku-3-5-latest':    'claude-4.5-haiku',

  // Anthropic Opus 4.7 — Windsurf changelog 2026-04-16. Cloud now exposes 4 reasoning
  // tiers (low/medium/high/xhigh) plus matching -thinking variants. Bare `claude-opus-4-7`
  // and `claude-opus-4.7` default to medium; `-thinking` suffix routes to medium-thinking.
  'claude-opus-4-7':            'claude-opus-4-7-medium',
  'claude-opus-4-7-latest':     'claude-opus-4-7-medium',
  'claude-opus-4.7':            'claude-opus-4-7-medium',
  'claude-opus-4.7-thinking':   'claude-opus-4-7-medium-thinking',
  'claude-opus-4-7-thinking':   'claude-opus-4-7-medium-thinking',
  'claude-opus-4.7-low':        'claude-opus-4-7-low',
  'claude-opus-4.7-medium':     'claude-opus-4-7-medium',
  'claude-opus-4.7-high':       'claude-opus-4-7-high',
  'claude-opus-4.7-xhigh':      'claude-opus-4-7-xhigh',
  'claude-opus-4.7-medium-thinking': 'claude-opus-4-7-medium-thinking',
  'claude-opus-4.7-high-thinking':   'claude-opus-4-7-high-thinking',
  'claude-opus-4.7-xhigh-thinking':  'claude-opus-4-7-xhigh-thinking',
  'claude-opus-4.7-max':             'claude-opus-4-7-max',
};
for (const [k, v] of Object.entries(ANTHROPIC_DATED)) _lookup.set(k, v);

// OpenAI official dated names — same pattern
const OPENAI_DATED = {
  'gpt-4o-2024-11-20': 'gpt-4o',
  'gpt-4o-2024-08-06': 'gpt-4o',
  'gpt-4o-2024-05-13': 'gpt-4o',
  'gpt-4o-mini-2024-07-18': 'gpt-4o-mini',
  'gpt-4.1-2025-04-14': 'gpt-4.1',
  'gpt-4.1-mini-2025-04-14': 'gpt-4.1-mini',
  'gpt-4.1-nano-2025-04-14': 'gpt-4.1-nano',
  'gpt-5-2025-08-07': 'gpt-5',
  'gpt-5-pro-2025-10-06': 'gpt-5-high',
  // GPT-5.5 — bare aliases default to medium tier (matches gpt-5.2 / gpt-5.4 pattern).
  'gpt-5-5':    'gpt-5.5-medium',
  'gpt-5.5':    'gpt-5.5-medium',
};
for (const [k, v] of Object.entries(OPENAI_DATED)) _lookup.set(k, v);

// Cursor-friendly aliases — Cursor's client-side whitelist blocks model names
// containing "claude". These prefixes bypass the filter while resolving to the
// same Windsurf backend models. Use any of these in Cursor's Custom Model field.
const CURSOR_ALIASES = {
  // opus
  'opus-4.6':              'claude-opus-4.6',
  'opus-4.6-thinking':     'claude-opus-4.6-thinking',
  'opus-4.7-thinking':     'claude-opus-4-7-medium-thinking',
  'opus-4-7':              'claude-opus-4-7-medium',
  'opus-4.7':              'claude-opus-4-7-medium',
  'o4.7':                  'claude-opus-4-7-medium',
  // sonnet
  'sonnet-4.6':            'claude-sonnet-4.6',
  'sonnet-4.6-thinking':   'claude-sonnet-4.6-thinking',
  'sonnet-4.6-1m':         'claude-sonnet-4.6-1m',
  'sonnet-4.5':            'claude-4.5-sonnet',
  'sonnet-4.5-thinking':   'claude-4.5-sonnet-thinking',
  // haiku
  'haiku-4.5':             'claude-4.5-haiku',
  // older
  'sonnet-4':              'claude-4-sonnet',
  'opus-4':                'claude-4-opus',
  'opus-4.1':              'claude-4.1-opus',
  'sonnet-3.7':            'claude-3.7-sonnet',
  'sonnet-3.5':            'claude-3.5-sonnet',
  // ws-* prefix variant (even safer against future whitelist updates)
  'ws-opus':               'claude-opus-4.6',
  'ws-sonnet':             'claude-sonnet-4.6',
  'ws-opus-thinking':      'claude-opus-4.6-thinking',
  'ws-sonnet-thinking':    'claude-sonnet-4.6-thinking',
  'ws-haiku':              'claude-4.5-haiku',
};
for (const [k, v] of Object.entries(CURSOR_ALIASES)) _lookup.set(k, v);

/** Resolve user model name → internal model key. */
export function resolveModel(name) {
  if (!name) return null;
  return _lookup.get(name) || _lookup.get(name.toLowerCase()) || name;
}

/** Get model info including enum and uid. */
export function getModelInfo(id) {
  return MODELS[id] || null;
}

// v2.0.84 (#118 0a00) — when an entire account pool is rate-limited
// on a high-effort variant (`-max` / `-xhigh` / `-thinking-1m`), find
// a same-base lower-effort variant the user could fall back to. Used
// for two purposes:
//   1. Error remediation: include the suggested model in the 429
//      response so the client can switch transparently.
//   2. Optional auto-fallback (env opt-in): proxy retries the same
//      request against the lower variant before reporting failure.
//
// Returns null when no lower variant exists in the catalog. Effort
// ladder is suffix-only — we don't infer ladders, we read them off
// the literal model-key suffix.
//
// Suffix order: less expensive first → more expensive last.
const EFFORT_LADDER = [
  // Anthropic effort tiers
  'low', 'medium', 'high', 'xhigh', 'max',
  // GPT codex max sub-tiers (claude has -low, -medium, -high; gpt
  // codex has -low / -medium / -high stacked under -max-)
];
const CONTEXT_LADDER = ['1m']; // 1m context variants are weekly-quota'd

export function pickRateLimitFallback(modelKey) {
  if (!modelKey || typeof modelKey !== 'string') return null;
  // Try effort suffix first (e.g. -max → -xhigh → -high → -medium → -low)
  for (let i = EFFORT_LADDER.length - 1; i >= 1; i--) {
    const suffix = `-${EFFORT_LADDER[i]}`;
    if (modelKey.endsWith(suffix)) {
      const base = modelKey.slice(0, -suffix.length);
      // Walk DOWN the ladder until we find a key actually in the catalog.
      for (let j = i - 1; j >= 0; j--) {
        const candidate = `${base}-${EFFORT_LADDER[j]}`;
        if (MODELS[candidate]) return candidate;
      }
    }
  }
  // 1m context variants → drop -1m
  for (const suffix of CONTEXT_LADDER) {
    const dashed = `-${suffix}`;
    if (modelKey.endsWith(dashed)) {
      const candidate = modelKey.slice(0, -dashed.length);
      if (MODELS[candidate]) return candidate;
    }
  }
  // -thinking variants don't have a simple ladder; the natural fallback
  // is the non-thinking sibling, but that changes user-visible behaviour
  // (no reasoning content). Skip auto-fallback for those.
  return null;
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

const FREE_TIER_BASE = ['gemini-2.5-flash'];
const _discoveredFreeModels = new Set();

export function registerDiscoveredFreeModel(key) {
  if (MODELS[key] && !FREE_TIER_BASE.includes(key)) _discoveredFreeModels.add(key);
}

export const MODEL_TIER_ACCESS = {
  get pro() { return Object.keys(MODELS); },
  get free() { return [...FREE_TIER_BASE, ..._discoveredFreeModels]; },
  // Optimistic: a freshly-added account whose probe hasn't completed yet
  // gets the FULL pro catalog, not just gemini-2.5-flash. Otherwise the
  // chat.js anyEligible check (line ~1141) immediately 403s any non-free
  // model with "模型 X 在当前账号池中不可用", and users see "添加账号后
  // 不能调用任何模型" until probe finishes ~10-30s later. Trade-off: a
  // free user may try opus before probe completes; the request will fail
  // upstream with a real entitlement error from the LS, which is a more
  // accurate failure than the misleading "model not in account pool" we
  // were emitting. Reported in QQ group, 2026-04-30.
  get unknown() { return Object.keys(MODELS); },
  expired: [],
};

/** Models a given tier is entitled to. */
export function getTierModels(tier) {
  return MODEL_TIER_ACCESS[tier] || MODEL_TIER_ACCESS.unknown;
}

/** List all models in OpenAI /v1/models format. Hides deprecated models. */
export function listModels() {
  const ts = Math.floor(Date.now() / 1000);
  return Object.entries(MODELS)
    .filter(([, info]) => !info.deprecated)
    .map(([id, info]) => ({
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
