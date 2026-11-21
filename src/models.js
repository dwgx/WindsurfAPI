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

import { getBackendSwitch } from './runtime-config.js';

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
  'claude-opus-4-6-1m':             { name: 'claude-opus-4-6-1m',             provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-6-1m', credit: 10 },
  'claude-opus-4-6-thinking-1m':    { name: 'claude-opus-4-6-thinking-1m',    provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-6-thinking-1m', credit: 12 },
  // Claude Opus 4.7 — Windsurf changelog 2026-04-16; new xhigh effort tier vs 4.6.
  // `medium` is the canonical default; low/high/xhigh/max are reasoning tiers,
  // each can be paired with -thinking for visible chain-of-thought.
  'claude-opus-4-7-medium':         { name: 'claude-opus-4-7-medium',         provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-medium', credit: 40 },
  'claude-opus-4-7-low':            { name: 'claude-opus-4-7-low',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-low', credit: 20 },
  'claude-opus-4-7-high':           { name: 'claude-opus-4-7-high',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-high', credit: 60 },
  'claude-opus-4-7-xhigh':          { name: 'claude-opus-4-7-xhigh',          provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-xhigh', credit: 65 },
  'claude-opus-4-7-medium-thinking': { name: 'claude-opus-4-7-medium-thinking', provider: 'anthropic', enumValue: 0, modelUid: 'claude-opus-4-7-medium-thinking', credit: 10 },
  'claude-opus-4-7-high-thinking':  { name: 'claude-opus-4-7-high-thinking',  provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-high-thinking', credit: 12 },
  'claude-opus-4-7-xhigh-thinking': { name: 'claude-opus-4-7-xhigh-thinking', provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-xhigh-thinking', credit: 16 },
  // `max` reasoning tier appeared in GetCascadeModelConfigs after the 4.7 launch — sits
  // above xhigh in the effort ladder. No -thinking sibling in cloud catalog yet.
  'claude-opus-4-7-max':            { name: 'claude-opus-4-7-max',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-7-max', credit: 75 },
  // Claude Opus 4.8 — confirmed live in GetCascadeModelConfigs (2026-07-03).
  // Upstream exposes normal and priority (=fast) lanes across low/medium/high/xhigh/max.
  'claude-opus-4-8-low':            { name: 'claude-opus-4-8-low',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-8-low', credit: 20 },
  'claude-opus-4-8-medium':         { name: 'claude-opus-4-8-medium',         provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-8-medium', credit: 25 },
  'claude-opus-4-8-high':           { name: 'claude-opus-4-8-high',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-8-high', credit: 35 },
  'claude-opus-4-8-xhigh':          { name: 'claude-opus-4-8-xhigh',          provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-8-xhigh', credit: 40 },
  'claude-opus-4-8-max':            { name: 'claude-opus-4-8-max',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-8-max', credit: 50 },
  'claude-opus-4-8-low-fast':       { name: 'claude-opus-4-8-low-fast',       provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-8-low-fast', credit: 40 },
  'claude-opus-4-8-medium-fast':    { name: 'claude-opus-4-8-medium-fast',    provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-8-medium-fast', credit: 50 },
  'claude-opus-4-8-high-fast':      { name: 'claude-opus-4-8-high-fast',      provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-8-high-fast', credit: 70 },
  'claude-opus-4-8-xhigh-fast':     { name: 'claude-opus-4-8-xhigh-fast',     provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-8-xhigh-fast', credit: 80 },
  'claude-opus-4-8-max-fast':       { name: 'claude-opus-4-8-max-fast',       provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-4-8-max-fast', credit: 100 },
  // ── added 2026-10-16 from docs.devin.ai modelCostData (public price table); NOT yet frame-verified ──
  // Claude Fable 5.1
  'claude-fable-5-1-low':           { name: 'claude-fable-5-1-low',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-fable-5-1-low', credit: 150 },
  'claude-fable-5-1-medium':        { name: 'claude-fable-5-1-medium',        provider: 'anthropic', enumValue: 0,   modelUid: 'claude-fable-5-1-medium', credit: 175 },
  'claude-fable-5-1-high':          { name: 'claude-fable-5-1-high',          provider: 'anthropic', enumValue: 0,   modelUid: 'claude-fable-5-1-high', credit: 200 },
  'claude-fable-5-1-xhigh':         { name: 'claude-fable-5-1-xhigh',         provider: 'anthropic', enumValue: 0,   modelUid: 'claude-fable-5-1-xhigh', credit: 225 },
  'claude-fable-5-1-max':           { name: 'claude-fable-5-1-max',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-fable-5-1-max', credit: 250 },
  // Claude Opus 5.5
  'claude-opus-5-5-low':            { name: 'claude-opus-5-5-low',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-5-low', credit: 35 },
  'claude-opus-5-5-medium':         { name: 'claude-opus-5-5-medium',         provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-5-medium', credit: 45 },
  'claude-opus-5-5-high':           { name: 'claude-opus-5-5-high',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-5-high', credit: 65 },
  'claude-opus-5-5-xhigh':          { name: 'claude-opus-5-5-xhigh',          provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-5-xhigh', credit: 125 },
  'claude-opus-5-5-max':            { name: 'claude-opus-5-5-max',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-5-max', credit: 150 },
  // Claude Sonnet 5.5
  'claude-sonnet-5-5-low':          { name: 'claude-sonnet-5-5-low',          provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-5-5-low', credit: 12 },
  'claude-sonnet-5-5-medium':       { name: 'claude-sonnet-5-5-medium',       provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-5-5-medium', credit: 15 },
  'claude-sonnet-5-5-high':         { name: 'claude-sonnet-5-5-high',         provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-5-5-high', credit: 20 },
  'claude-sonnet-5-5-xhigh':        { name: 'claude-sonnet-5-5-xhigh',        provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-5-5-xhigh', credit: 30 },
  'claude-sonnet-5-5-max':          { name: 'claude-sonnet-5-5-max',          provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-5-5-max', credit: 40 },
  // Claude Haiku 5.5 — live GetCascadeModelConfigs 2026-10-18.
  'claude-haiku-5-5-low':           { name: 'claude-haiku-5-5-low',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-haiku-5-5-low', credit: 3 },
  'claude-haiku-5-5-medium':        { name: 'claude-haiku-5-5-medium',        provider: 'anthropic', enumValue: 0,   modelUid: 'claude-haiku-5-5-medium', credit: 4 },
  'claude-haiku-5-5-high':          { name: 'claude-haiku-5-5-high',          provider: 'anthropic', enumValue: 0,   modelUid: 'claude-haiku-5-5-high', credit: 5 },
  'claude-haiku-5-5-xhigh':         { name: 'claude-haiku-5-5-xhigh',         provider: 'anthropic', enumValue: 0,   modelUid: 'claude-haiku-5-5-xhigh', credit: 8 },
  'claude-haiku-5-5-max':           { name: 'claude-haiku-5-5-max',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-haiku-5-5-max', credit: 10 },

  // ── Claude 5 family ──────────────────────────────────────
  // fable-5 (2026-06-09) / sonnet-5 (2026-06-30) / opus-5 (2026-07-23) — Devin
  // catalog, dash-form selectors. fable/sonnet-5 confirmed in the 07-08 live
  // snapshot; opus-5 + fast lanes from the official price table (docs.devin.ai
  // 2026-08-11) — selector form follows the 4-8 family (claude-opus-5-*). All
  // five effort tiers per family, no -thinking siblings in the catalog.
  // Credit multipliers from the official modelCostData table.
  'claude-5-fable-low':             { name: 'claude-5-fable-low',             provider: 'anthropic', enumValue: 0,   modelUid: 'claude-5-fable-low', credit: 40 },
  'claude-5-fable-medium':          { name: 'claude-5-fable-medium',          provider: 'anthropic', enumValue: 0,   modelUid: 'claude-5-fable-medium', credit: 50 },
  'claude-5-fable-high':            { name: 'claude-5-fable-high',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-5-fable-high', credit: 70 },
  'claude-5-fable-xhigh':           { name: 'claude-5-fable-xhigh',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-5-fable-xhigh', credit: 80 },
  'claude-5-fable-max':             { name: 'claude-5-fable-max',             provider: 'anthropic', enumValue: 0,   modelUid: 'claude-5-fable-max', credit: 100 },
  'claude-sonnet-5-low':            { name: 'claude-sonnet-5-low',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-5-low', credit: 12 },
  'claude-sonnet-5-medium':         { name: 'claude-sonnet-5-medium',         provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-5-medium', credit: 15 },
  'claude-sonnet-5-high':           { name: 'claude-sonnet-5-high',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-5-high', credit: 20 },
  'claude-sonnet-5-xhigh':          { name: 'claude-sonnet-5-xhigh',          provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-5-xhigh', credit: 30 },
  'claude-sonnet-5-max':            { name: 'claude-sonnet-5-max',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-sonnet-5-max', credit: 40 },
  'claude-opus-5-low':              { name: 'claude-opus-5-low',              provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-low', credit: 75 },
  'claude-opus-5-medium':           { name: 'claude-opus-5-medium',           provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-medium', credit: 80 },
  'claude-opus-5-high':             { name: 'claude-opus-5-high',             provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-high', credit: 115 },
  'claude-opus-5-xhigh':            { name: 'claude-opus-5-xhigh',            provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-xhigh', credit: 155 },
  'claude-opus-5-max':              { name: 'claude-opus-5-max',              provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-max', credit: 160 },
  'claude-opus-5-low-fast':         { name: 'claude-opus-5-low-fast',         provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-low-fast', credit: 150 },
  'claude-opus-5-medium-fast':      { name: 'claude-opus-5-medium-fast',      provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-medium-fast', credit: 160 },
  'claude-opus-5-high-fast':        { name: 'claude-opus-5-high-fast',        provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-high-fast', credit: 230 },
  'claude-opus-5-xhigh-fast':       { name: 'claude-opus-5-xhigh-fast',       provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-xhigh-fast', credit: 310 },
  'claude-opus-5-max-fast':         { name: 'claude-opus-5-max-fast',         provider: 'anthropic', enumValue: 0,   modelUid: 'claude-opus-5-max-fast', credit: 320 },

  // ── GPT ─────────────────────────────────────────────────
  'gpt-4o':                         { name: 'gpt-4o',                         provider: 'openai', enumValue: 109, modelUid: 'MODEL_CHAT_GPT_4O_2024_08_06', credit: 1 , deprecated: true },
  'gpt-4o-mini':                    { name: 'gpt-4o-mini',                    provider: 'openai', enumValue: 113, credit: 0.5, deprecated: true },
  'gpt-4.1':                        { name: 'gpt-4.1',                        provider: 'openai', enumValue: 259, modelUid: 'MODEL_CHAT_GPT_4_1_2025_04_14', credit: 1 , deprecated: true },
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
  'gpt-5.3-codex':                  { name: 'gpt-5.3-codex',                  provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-medium', credit: 2 },

  // GPT-5.4
  'gpt-5.4-none':                   { name: 'gpt-5.4-none',                   provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-none', credit: 1.5 },
  'gpt-5.4-low':                    { name: 'gpt-5.4-low',                    provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-low', credit: 1.5 },
  'gpt-5.4-medium':                 { name: 'gpt-5.4-medium',                 provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-medium', credit: 3 },
  'gpt-5.4-high':                   { name: 'gpt-5.4-high',                   provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-high', credit: 4 },
  'gpt-5.4-xhigh':                  { name: 'gpt-5.4-xhigh',                  provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-xhigh', credit: 12 },
  'gpt-5.4-mini-low':               { name: 'gpt-5.4-mini-low',               provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-mini-low', credit: 1.5 },
  'gpt-5.4-mini-medium':            { name: 'gpt-5.4-mini-medium',            provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-mini-medium', credit: 1.5 },
  'gpt-5.4-mini-high':              { name: 'gpt-5.4-mini-high',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-mini-high', credit: 4.5 },
  'gpt-5.4-mini-xhigh':             { name: 'gpt-5.4-mini-xhigh',             provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-4-mini-xhigh', credit: 12 },

  // GPT-5.5 — Windsurf catalog 2026-04-30. Same effort ladder as 5.2/5.4 (none/low/medium/high/xhigh)
  // with priority (=fast) lane equivalents. Bare `gpt-5.5` defaults to medium.
  'gpt-5.5':                        { name: 'gpt-5.5',                        provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-medium', credit: 15 },
  'gpt-5.5-none':                   { name: 'gpt-5.5-none',                   provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-none', credit: 9 },
  'gpt-5.5-low':                    { name: 'gpt-5.5-low',                    provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-low', credit: 12 },
  'gpt-5.5-medium':                 { name: 'gpt-5.5-medium',                 provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-medium', credit: 15 },
  'gpt-5.5-high':                   { name: 'gpt-5.5-high',                   provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-high', credit: 24 },
  'gpt-5.5-xhigh':                  { name: 'gpt-5.5-xhigh',                  provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-xhigh', credit: 36 },
  'gpt-5.5-none-fast':              { name: 'gpt-5.5-none-fast',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-none-priority', credit: 22.5 },
  'gpt-5.5-low-fast':               { name: 'gpt-5.5-low-fast',               provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-low-priority', credit: 30 },
  'gpt-5.5-medium-fast':            { name: 'gpt-5.5-medium-fast',            provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-medium-priority', credit: 37.5 },
  'gpt-5.5-high-fast':              { name: 'gpt-5.5-high-fast',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-high-priority', credit: 60 },
  'gpt-5.5-xhigh-fast':             { name: 'gpt-5.5-xhigh-fast',             provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-5-xhigh-priority', credit: 90 },

  // GPT-5.6 — Devin catalog 2026-07-09 (Sol/Terra/Luna). Luna is the fastest
  // cheapest sibling; issue #244 asked for it by name. Five effort tiers
  // (none/low/medium/high/xhigh), no max tier in the official price table.
  // Bare `gpt-5.6-luna` / `gpt-5-6-luna` / compact `gpt5.6-luna` default to
  // medium (see _lookup aliases below). Credit from official modelCostData.
  'gpt-5.6-luna':                   { name: 'gpt-5.6-luna',                   provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-luna-medium', credit: 5 },
  'gpt-5.6-luna-none':              { name: 'gpt-5.6-luna-none',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-luna-none', credit: 3 },
  'gpt-5.6-luna-low':               { name: 'gpt-5.6-luna-low',               provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-luna-low', credit: 4 },
  'gpt-5.6-luna-medium':            { name: 'gpt-5.6-luna-medium',            provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-luna-medium', credit: 5 },
  'gpt-5.6-luna-high':              { name: 'gpt-5.6-luna-high',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-luna-high', credit: 6 },
  'gpt-5.6-luna-xhigh':             { name: 'gpt-5.6-luna-xhigh',             provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-luna-xhigh', credit: 8 },

  // GPT-5.3 Codex — already had bare `gpt-5.3-codex` (legacy alias), now expose tier variants.
  'gpt-5.3-codex-low':              { name: 'gpt-5.3-codex-low',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-low', credit: 1.5 },
  'gpt-5.3-codex-high':             { name: 'gpt-5.3-codex-high',             provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-high', credit: 2.5 },
  'gpt-5.3-codex-xhigh':            { name: 'gpt-5.3-codex-xhigh',            provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-xhigh', credit: 3 },
  'gpt-5.3-codex-low-fast':         { name: 'gpt-5.3-codex-low-fast',         provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-low-priority', credit: 3 },
  'gpt-5.3-codex-medium-fast':      { name: 'gpt-5.3-codex-medium-fast',      provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-medium-priority', credit: 4 },
  'gpt-5.3-codex-high-fast':        { name: 'gpt-5.3-codex-high-fast',        provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-high-priority', credit: 5 },
  'gpt-5.3-codex-xhigh-fast':       { name: 'gpt-5.3-codex-xhigh-fast',       provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-3-codex-xhigh-priority', credit: 6 },

  // GPT-OSS
  'gpt-oss-120b':                   { name: 'gpt-oss-120b',                   provider: 'openai', enumValue: 0,   modelUid: 'MODEL_GPT_OSS_120B', credit: 0.25 },
  // ── added 2026-10-16 from docs.devin.ai modelCostData (public price table); NOT yet frame-verified ──
  // GPT-5.6 Luna (max + priority lanes)
  'gpt-5-6-luna-max':               { name: 'gpt-5-6-luna-max',               provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-luna-max', credit: 30 },
  // GPT-5.6 Sol
  'gpt-5-6-sol-none':               { name: 'gpt-5-6-sol-none',               provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-sol-none', credit: 10 },
  'gpt-5-6-sol-low':                { name: 'gpt-5-6-sol-low',                provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-sol-low', credit: 30 },
  'gpt-5-6-sol-medium':             { name: 'gpt-5-6-sol-medium',             provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-sol-medium', credit: 50 },
  'gpt-5-6-sol-high':               { name: 'gpt-5-6-sol-high',               provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-sol-high', credit: 90 },
  'gpt-5-6-sol-xhigh':              { name: 'gpt-5-6-sol-xhigh',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-sol-xhigh', credit: 150 },
  'gpt-5-6-sol-max':                { name: 'gpt-5-6-sol-max',                provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-sol-max', credit: 200 },
  // GPT-5.6 Terra
  'gpt-5-6-terra-none':             { name: 'gpt-5-6-terra-none',             provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-terra-none', credit: 4 },
  'gpt-5-6-terra-low':              { name: 'gpt-5-6-terra-low',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-terra-low', credit: 8 },
  'gpt-5-6-terra-medium':           { name: 'gpt-5-6-terra-medium',           provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-terra-medium', credit: 10 },
  'gpt-5-6-terra-high':             { name: 'gpt-5-6-terra-high',             provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-terra-high', credit: 20 },
  'gpt-5-6-terra-xhigh':            { name: 'gpt-5-6-terra-xhigh',            provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-terra-xhigh', credit: 30 },
  'gpt-5-6-terra-max':              { name: 'gpt-5-6-terra-max',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-5-6-terra-max', credit: 50 },
  // GPT-6.1 Sol
  'gpt-6-1-sol-low':                { name: 'gpt-6-1-sol-low',                provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-1-sol-low', credit: 30 },
  'gpt-6-1-sol-medium':             { name: 'gpt-6-1-sol-medium',             provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-1-sol-medium', credit: 40 },
  'gpt-6-1-sol-high':               { name: 'gpt-6-1-sol-high',               provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-1-sol-high', credit: 50 },
  'gpt-6-1-sol-xhigh':              { name: 'gpt-6-1-sol-xhigh',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-1-sol-xhigh', credit: 70 },
  'gpt-6-1-sol-max':                { name: 'gpt-6-1-sol-max',                provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-1-sol-max', credit: 100 },
  // GPT-6 Astra
  'gpt-6-astra-low':                { name: 'gpt-6-astra-low',                provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-astra-low', credit: 100 },
  'gpt-6-astra-medium':             { name: 'gpt-6-astra-medium',             provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-astra-medium', credit: 200 },
  'gpt-6-astra-high':               { name: 'gpt-6-astra-high',               provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-astra-high', credit: 400 },
  'gpt-6-astra-xhigh':              { name: 'gpt-6-astra-xhigh',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-astra-xhigh', credit: 375 },
  'gpt-6-astra-max':                { name: 'gpt-6-astra-max',                provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-astra-max', credit: 500 },
  // GPT-6 Luna
  'gpt-6-luna-none':                { name: 'gpt-6-luna-none',                provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-luna-none', credit: 2 },
  'gpt-6-luna-low':                 { name: 'gpt-6-luna-low',                 provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-luna-low', credit: 3 },
  'gpt-6-luna-medium':              { name: 'gpt-6-luna-medium',              provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-luna-medium', credit: 4 },
  'gpt-6-luna-high':                { name: 'gpt-6-luna-high',                provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-luna-high', credit: 5 },
  'gpt-6-luna-xhigh':               { name: 'gpt-6-luna-xhigh',               provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-luna-xhigh', credit: 6 },
  'gpt-6-luna-max':                 { name: 'gpt-6-luna-max',                 provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-luna-max', credit: 7 },
  // GPT-6 Sol
  'gpt-6-sol-none':                 { name: 'gpt-6-sol-none',                 provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-sol-none', credit: 65 },
  'gpt-6-sol-low':                  { name: 'gpt-6-sol-low',                  provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-sol-low', credit: 135 },
  'gpt-6-sol-medium':               { name: 'gpt-6-sol-medium',               provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-sol-medium', credit: 145 },
  'gpt-6-sol-high':                 { name: 'gpt-6-sol-high',                 provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-sol-high', credit: 150 },
  'gpt-6-sol-xhigh':                { name: 'gpt-6-sol-xhigh',                provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-sol-xhigh', credit: 190 },
  'gpt-6-sol-max':                  { name: 'gpt-6-sol-max',                  provider: 'openai', enumValue: 0,   modelUid: 'gpt-6-sol-max', credit: 200 },

  // ── O-series ────────────────────────────────────────────
  'o3-mini':                        { name: 'o3-mini',                        provider: 'openai', enumValue: 207, credit: 0.5 , deprecated: true },
  'o3':                             { name: 'o3',                             provider: 'openai', enumValue: 218, modelUid: 'MODEL_CHAT_O3', credit: 1 , deprecated: true },
  'o3-high':                        { name: 'o3-high',                        provider: 'openai', enumValue: 0,   modelUid: 'MODEL_CHAT_O3_HIGH', credit: 1 , deprecated: true },
  'o3-pro':                         { name: 'o3-pro',                         provider: 'openai', enumValue: 294, credit: 4 , deprecated: true },
  'o4-mini':                        { name: 'o4-mini',                        provider: 'openai', enumValue: 264, credit: 0.5 , deprecated: true },

  // ── Astraflow (UCloud) ─────────────────────────────────────
  // Astraflow is an OpenAI-compatible aggregation platform supporting 200+ models.
  // Global endpoint: https://api-us-ca.umodelverse.ai/v1  (ASTRAFLOW_API_KEY)
  // China  endpoint: https://api.modelverse.cn/v1         (ASTRAFLOW_CN_API_KEY)
  // Website: https://astraflow.ucloud-global.com (global) / https://astraflow.ucloud.cn (CN)
  // These entries use provider:'astraflow' and set enumValue:0 / modelUid equal to the
  // upstream model ID so the passthrough layer can forward them to the Astraflow base URL.
  'astraflow/gpt-4o':               { name: 'astraflow/gpt-4o',               provider: 'astraflow', enumValue: 0, modelUid: 'gpt-4o',                    credit: 1 , deprecated: true },
  'astraflow/gpt-4.1':              { name: 'astraflow/gpt-4.1',              provider: 'astraflow', enumValue: 0, modelUid: 'gpt-4.1',                   credit: 1 , deprecated: true },
  'astraflow/gpt-4o-mini':          { name: 'astraflow/gpt-4o-mini',          provider: 'astraflow', enumValue: 0, modelUid: 'gpt-4o-mini',               credit: 0.5 , deprecated: true },
  'astraflow/claude-3.5-sonnet':    { name: 'astraflow/claude-3.5-sonnet',    provider: 'astraflow', enumValue: 0, modelUid: 'claude-3-5-sonnet-20241022', credit: 2 , deprecated: true },
  'astraflow/claude-3.7-sonnet':    { name: 'astraflow/claude-3.7-sonnet',    provider: 'astraflow', enumValue: 0, modelUid: 'claude-3-7-sonnet-20250219', credit: 2 , deprecated: true },
  'astraflow/deepseek-v3':          { name: 'astraflow/deepseek-v3',          provider: 'astraflow', enumValue: 0, modelUid: 'deepseek-v3',               credit: 1 , deprecated: true },
  'astraflow/deepseek-r1':          { name: 'astraflow/deepseek-r1',          provider: 'astraflow', enumValue: 0, modelUid: 'deepseek-r1',               credit: 2 , deprecated: true },
  'astraflow/llama-3.3-70b':        { name: 'astraflow/llama-3.3-70b',        provider: 'astraflow', enumValue: 0, modelUid: 'llama-3.3-70b-instruct',    credit: 0.5 , deprecated: true },
  'astraflow/gemini-2.0-flash':     { name: 'astraflow/gemini-2.0-flash',     provider: 'astraflow', enumValue: 0, modelUid: 'gemini-2.0-flash',          credit: 0.5 , deprecated: true },

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
  // Gemini 3.5 Flash — live GetCascadeModelConfigs 2026-10-18.
  'gemini-3-5-flash-minimal':       { name: 'gemini-3-5-flash-minimal',       provider: 'google', enumValue: 0,   modelUid: 'gemini-3-5-flash-minimal', credit: 2 },
  'gemini-3-5-flash-low':           { name: 'gemini-3-5-flash-low',           provider: 'google', enumValue: 0,   modelUid: 'gemini-3-5-flash-low', credit: 4 },
  'gemini-3-5-flash-medium':        { name: 'gemini-3-5-flash-medium',        provider: 'google', enumValue: 0,   modelUid: 'gemini-3-5-flash-medium', credit: 8 },
  'gemini-3-5-flash-high':          { name: 'gemini-3-5-flash-high',          provider: 'google', enumValue: 0,   modelUid: 'gemini-3-5-flash-high', credit: 9 },
  // ── added 2026-10-16 from docs.devin.ai modelCostData (public price table); NOT yet frame-verified ──
  // Gemini 3.6 Flash
  'gemini-3-6-flash-minimal':       { name: 'gemini-3-6-flash-minimal',       provider: 'google', enumValue: 0,   modelUid: 'gemini-3-6-flash-minimal', credit: 2 },
  'gemini-3-6-flash-low':           { name: 'gemini-3-6-flash-low',           provider: 'google', enumValue: 0,   modelUid: 'gemini-3-6-flash-low', credit: 4 },
  'gemini-3-6-flash-medium':        { name: 'gemini-3-6-flash-medium',        provider: 'google', enumValue: 0,   modelUid: 'gemini-3-6-flash-medium', credit: 8 },
  'gemini-3-6-flash-high':          { name: 'gemini-3-6-flash-high',          provider: 'google', enumValue: 0,   modelUid: 'gemini-3-6-flash-high', credit: 9 },
  // Gemini 3.7 Flash
  'gemini-3-7-flash-low':           { name: 'gemini-3-7-flash-low',           provider: 'google', enumValue: 0,   modelUid: 'gemini-3-7-flash-low', credit: 6 },
  'gemini-3-7-flash-medium':        { name: 'gemini-3-7-flash-medium',        provider: 'google', enumValue: 0,   modelUid: 'gemini-3-7-flash-medium', credit: 8 },
  'gemini-3-7-flash-high':          { name: 'gemini-3-7-flash-high',          provider: 'google', enumValue: 0,   modelUid: 'gemini-3-7-flash-high', credit: 10 },
  // Gemini 3.8 Flash
  'gemini-3-8-flash-low':           { name: 'gemini-3-8-flash-low',           provider: 'google', enumValue: 0,   modelUid: 'gemini-3-8-flash-low', credit: 6 },
  'gemini-3-8-flash-medium':        { name: 'gemini-3-8-flash-medium',        provider: 'google', enumValue: 0,   modelUid: 'gemini-3-8-flash-medium', credit: 8 },
  'gemini-3-8-flash-high':          { name: 'gemini-3-8-flash-high',          provider: 'google', enumValue: 0,   modelUid: 'gemini-3-8-flash-high', credit: 10 },
  // Gemini 4 Argon
  'gemini-4-argon-low':             { name: 'gemini-4-argon-low',             provider: 'google', enumValue: 0,   modelUid: 'gemini-4-argon-low', credit: 50 },
  'gemini-4-argon-medium':          { name: 'gemini-4-argon-medium',          provider: 'google', enumValue: 0,   modelUid: 'gemini-4-argon-medium', credit: 70 },
  'gemini-4-argon-high':            { name: 'gemini-4-argon-high',            provider: 'google', enumValue: 0,   modelUid: 'gemini-4-argon-high', credit: 90 },

  // ── DeepSeek ────────────────────────────────────────────
  'deepseek-v3':                    { name: 'deepseek-v3',                    provider: 'deepseek', enumValue: 205, credit: 0.5, deprecated: true },
  'deepseek-v3-2':                  { name: 'deepseek-v3-2',                  provider: 'deepseek', enumValue: 409, credit: 0.5, deprecated: true },
  'deepseek-r1':                    { name: 'deepseek-r1',                    provider: 'deepseek', enumValue: 206, credit: 1, deprecated: true },
  // DeepSeek V4 Pro — live in the 105 catalog (2026-07). DEVIN_CONNECT selector.
  'deepseek-v4':                    { name: 'deepseek-v4',                    provider: 'deepseek', enumValue: 0, modelUid: 'deepseek-v4', credit: 0.5 },
  // ── added 2026-10-16 from docs.devin.ai modelCostData (public price table); NOT yet frame-verified ──
  // DeepSeek V4 Flash
  'deepseek-v4-flash-low':          { name: 'deepseek-v4-flash-low',          provider: 'deepseek', enumValue: 0,   modelUid: 'deepseek-v4-flash-low', credit: 0.25 },
  'deepseek-v4-flash-high':         { name: 'deepseek-v4-flash-high',         provider: 'deepseek', enumValue: 0,   modelUid: 'deepseek-v4-flash-high', credit: 0.5 },
  'deepseek-v4-flash-max':          { name: 'deepseek-v4-flash-max',          provider: 'deepseek', enumValue: 0,   modelUid: 'deepseek-v4-flash-max', credit: 1 },
  // DeepSeek V4 Pro
  'deepseek-v4-pro-low':            { name: 'deepseek-v4-pro-low',            provider: 'deepseek', enumValue: 0,   modelUid: 'deepseek-v4-pro-low', credit: 3 },
  'deepseek-v4-pro-high':           { name: 'deepseek-v4-pro-high',           provider: 'deepseek', enumValue: 0,   modelUid: 'deepseek-v4-pro-high', credit: 3 },
  'deepseek-v4-pro-max':            { name: 'deepseek-v4-pro-max',            provider: 'deepseek', enumValue: 0,   modelUid: 'deepseek-v4-pro-max', credit: 3 },
  // DeepSeek V4.1 Flash
  'deepseek-v4-1-flash-high':       { name: 'deepseek-v4-1-flash-high',       provider: 'deepseek', enumValue: 0,   modelUid: 'deepseek-v4-1-flash-high', credit: 2 },
  'deepseek-v4-1-flash-max':        { name: 'deepseek-v4-1-flash-max',        provider: 'deepseek', enumValue: 0,   modelUid: 'deepseek-v4-1-flash-max', credit: 3 },

  // ── Grok ────────────────────────────────────────────────
  'grok-3':                         { name: 'grok-3',                         provider: 'xai', enumValue: 217, modelUid: 'MODEL_XAI_GROK_3', credit: 1 },
  'grok-3-mini':                    { name: 'grok-3-mini',                    provider: 'xai', enumValue: 234, credit: 0.5, deprecated: true },
  'grok-3-mini-thinking':           { name: 'grok-3-mini-thinking',           provider: 'xai', enumValue: 0,   modelUid: 'MODEL_XAI_GROK_3_MINI_REASONING', credit: 0.125 },
  'grok-code-fast-1':               { name: 'grok-code-fast-1',               provider: 'xai', enumValue: 0,   modelUid: 'MODEL_PRIVATE_4', credit: 0.5 },
  // ── added 2026-10-16 from docs.devin.ai modelCostData (public price table); NOT yet frame-verified ──
  // Grok 4.5
  'grok-4-5-low':                   { name: 'grok-4-5-low',                   provider: 'xai', enumValue: 0,   modelUid: 'grok-4-5-low', credit: 5 },
  'grok-4-5-medium':                { name: 'grok-4-5-medium',                provider: 'xai', enumValue: 0,   modelUid: 'grok-4-5-medium', credit: 8 },
  'grok-4-5-high':                  { name: 'grok-4-5-high',                  provider: 'xai', enumValue: 0,   modelUid: 'grok-4-5-high', credit: 10 },
  // Grok 4.6
  'grok-4-6-low':                   { name: 'grok-4-6-low',                   provider: 'xai', enumValue: 0,   modelUid: 'grok-4-6-low', credit: 10 },
  'grok-4-6-medium':                { name: 'grok-4-6-medium',                provider: 'xai', enumValue: 0,   modelUid: 'grok-4-6-medium', credit: 20 },
  'grok-4-6-high':                  { name: 'grok-4-6-high',                  provider: 'xai', enumValue: 0,   modelUid: 'grok-4-6-high', credit: 25 },
  'grok-4-6-xhigh':                 { name: 'grok-4-6-xhigh',                 provider: 'xai', enumValue: 0,   modelUid: 'grok-4-6-xhigh', credit: 30 },
  // Grok 4.7
  'grok-4-7-low':                   { name: 'grok-4-7-low',                   provider: 'xai', enumValue: 0,   modelUid: 'grok-4-7-low', credit: 15 },
  'grok-4-7-medium':                { name: 'grok-4-7-medium',                provider: 'xai', enumValue: 0,   modelUid: 'grok-4-7-medium', credit: 20 },
  'grok-4-7-high':                  { name: 'grok-4-7-high',                  provider: 'xai', enumValue: 0,   modelUid: 'grok-4-7-high', credit: 30 },
  'grok-4-7-xhigh':                 { name: 'grok-4-7-xhigh',                 provider: 'xai', enumValue: 0,   modelUid: 'grok-4-7-xhigh', credit: 55 },

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
  'kimi-k2-7':                      { name: 'kimi-k2-7',                      provider: 'moonshot', enumValue: 0,   modelUid: 'kimi-k2-7', credit: 1 },
  // ── added 2026-10-16 from docs.devin.ai modelCostData (public price table); NOT yet frame-verified ──
  // Kimi K3
  'kimi-k3-low':                    { name: 'kimi-k3-low',                    provider: 'moonshot', enumValue: 0,   modelUid: 'kimi-k3-low', credit: 4 },
  'kimi-k3-high':                   { name: 'kimi-k3-high',                   provider: 'moonshot', enumValue: 0,   modelUid: 'kimi-k3-high', credit: 6 },
  'kimi-k3-max':                    { name: 'kimi-k3-max',                    provider: 'moonshot', enumValue: 0,   modelUid: 'kimi-k3-max', credit: 9 },

  // ── GLM ─────────────────────────────────────────────────
  'glm-4.7':                        { name: 'glm-4.7',                        provider: 'zhipu', enumValue: 417, modelUid: 'MODEL_GLM_4_7', credit: 0.25 },
  'glm-4.7-fast':                   { name: 'glm-4.7-fast',                   provider: 'zhipu', enumValue: 418, modelUid: 'MODEL_GLM_4_7_FAST', credit: 0.5 },
  'glm-5':                          { name: 'glm-5',                          provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5', credit: 1.5 },
  'glm-5.1':                        { name: 'glm-5.1',                        provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-1', credit: 1.5 },
  'glm-5.2':                        { name: 'glm-5.2',                        provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-2', credit: 1.5 },
  // GLM-5.2 variants — live GetCascadeModelConfigs 2026-10-18.
  'glm-5-2-none':                   { name: 'glm-5-2-none',                   provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-2-none', credit: 1 },
  'glm-5-2-none-1m':                { name: 'glm-5-2-none-1m',                provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-2-none-1m', credit: 2 },
  'glm-5-2-1m':                     { name: 'glm-5-2-1m',                     provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-2-1m', credit: 3 },
  'glm-5-2-max':                    { name: 'glm-5-2-max',                    provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-2-max', credit: 3 },
  'glm-5-2-max-1m':                 { name: 'glm-5-2-max-1m',                 provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-2-max-1m', credit: 6 },
  // ── added 2026-10-16 from docs.devin.ai modelCostData (public price table); NOT yet frame-verified ──
  // GLM-5.3 Flash
  'glm-5-3-flash-low':              { name: 'glm-5-3-flash-low',              provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-3-flash-low', credit: 1 },
  'glm-5-3-flash-high':             { name: 'glm-5-3-flash-high',             provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-3-flash-high', credit: 1 },
  'glm-5-3-flash-max':              { name: 'glm-5-3-flash-max',              provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-3-flash-max', credit: 1 },
  // GLM-5.3
  'glm-5-3-low':                    { name: 'glm-5-3-low',                    provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-3-low', credit: 1 },
  'glm-5-3-high':                   { name: 'glm-5-3-high',                   provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-3-high', credit: 1 },
  'glm-5-3-max':                    { name: 'glm-5-3-max',                    provider: 'zhipu', enumValue: 0,   modelUid: 'glm-5-3-max', credit: 1 },

  // ── MiniMax ─────────────────────────────────────────────
  // proto enum 419 = MODEL_MINIMAX_M2_1; the canonical name in cloud configs is m2.5.
  'minimax-m2.5':                   { name: 'minimax-m2.5',                   provider: 'minimax', enumValue: 419, modelUid: 'MODEL_MINIMAX_M2_1', credit: 1 },
  // ── added 2026-10-16 from docs.devin.ai modelCostData (public price table); NOT yet frame-verified ──
  // Inkling (Thinking Machines)
  'inkling-none':                   { name: 'inkling-none',                   provider: 'thinking_machines', enumValue: 0,   modelUid: 'inkling-none', credit: 2 },
  'inkling-low':                    { name: 'inkling-low',                    provider: 'thinking_machines', enumValue: 0,   modelUid: 'inkling-low', credit: 4 },
  'inkling-medium':                 { name: 'inkling-medium',                 provider: 'thinking_machines', enumValue: 0,   modelUid: 'inkling-medium', credit: 6 },
  'inkling-high':                   { name: 'inkling-high',                   provider: 'thinking_machines', enumValue: 0,   modelUid: 'inkling-high', credit: 8 },
  'inkling-xhigh':                  { name: 'inkling-xhigh',                  provider: 'thinking_machines', enumValue: 0,   modelUid: 'inkling-xhigh', credit: 10 },
  'inkling-max':                    { name: 'inkling-max',                    provider: 'thinking_machines', enumValue: 0,   modelUid: 'inkling-max', credit: 14 },
  // Nemotron 3 Ultra (NVIDIA)
  'nemotron-3-ultra-none':          { name: 'nemotron-3-ultra-none',          provider: 'nvidia', enumValue: 0,   modelUid: 'nemotron-3-ultra-none', credit: 1 },
  'nemotron-3-ultra-medium':        { name: 'nemotron-3-ultra-medium',        provider: 'nvidia', enumValue: 0,   modelUid: 'nemotron-3-ultra-medium', credit: 1 },
  'nemotron-3-ultra-high':          { name: 'nemotron-3-ultra-high',          provider: 'nvidia', enumValue: 0,   modelUid: 'nemotron-3-ultra-high', credit: 1 },

  // ── Windsurf SWE ────────────────────────────────────────
  // Proto canonical enums: 359=MODEL_SWE_1_5 (fast), 369=THINKING, 377=SLOW, 420=1_6, 421=1_6_FAST.
  // The default `swe-1.5` UID alias in upstream cloud config maps to the SLOW tier (377).
  'swe-1.5':                        { name: 'swe-1.5',                        provider: 'windsurf', enumValue: 377, modelUid: 'MODEL_SWE_1_5_SLOW', credit: 0.5 },
  'swe-1.5-fast':                   { name: 'swe-1.5-fast',                   provider: 'windsurf', enumValue: 359, modelUid: 'MODEL_SWE_1_5', credit: 0.5 },
  'swe-1.5-thinking':               { name: 'swe-1.5-thinking',               provider: 'windsurf', enumValue: 369, modelUid: 'MODEL_SWE_1_5_THINKING', credit: 0.75 },
  'swe-1.6':                        { name: 'swe-1.6',                        provider: 'windsurf', enumValue: 420, modelUid: 'MODEL_SWE_1_6', credit: 3, backend: 'special_agent' },
  'swe-1.6-fast':                   { name: 'swe-1.6-fast',                   provider: 'windsurf', enumValue: 421, modelUid: 'MODEL_SWE_1_6_FAST', credit: 3, backend: 'special_agent' },
  // SWE-1.7 family — live in the 105 catalog (2026-07). DEVIN_CONNECT selectors
  // (dash-form modelUid, no special_agent backend — resolved via catalog, not LS).
  'swe-1-7':                        { name: 'swe-1-7',                        provider: 'windsurf', enumValue: 0, modelUid: 'swe-1-7', credit: 9 },
  'swe-1-7-lightning':              { name: 'swe-1-7-lightning',              provider: 'windsurf', enumValue: 0, modelUid: 'swe-1-7-lightning', credit: 18 },
  // SWE-2 — Cognition 2026-09-10 (docs.devin.ai: swe-2-medium/high/max).
  // DEVIN_CONNECT=1 uses the snapshot selectors. Cascade has no UID, so the
  // LS path marks them special_agent (same as swe-1.6) for an opted-in CLI.
  'swe-2':                          { name: 'swe-2',                          provider: 'windsurf', enumValue: 0, modelUid: 'swe-2-medium', credit: 6, backend: 'special_agent' },
  'swe-2-medium':                   { name: 'swe-2-medium',                   provider: 'windsurf', enumValue: 0, modelUid: 'swe-2-medium', credit: 6, backend: 'special_agent' },
  'swe-2-high':                     { name: 'swe-2-high',                     provider: 'windsurf', enumValue: 0, modelUid: 'swe-2-high', credit: 9, backend: 'special_agent' },
  'swe-2-max':                      { name: 'swe-2-max',                      provider: 'windsurf', enumValue: 0, modelUid: 'swe-2-max', credit: 12, backend: 'special_agent' },
  // SWE-2 Lightning — live GetCascadeModelConfigs 2026-10-18.
  'swe-2-medium-lightning':         { name: 'swe-2-medium-lightning',         provider: 'windsurf', enumValue: 0, modelUid: 'swe-2-medium-lightning', credit: 12, backend: 'special_agent' },
  'swe-2-high-lightning':           { name: 'swe-2-high-lightning',           provider: 'windsurf', enumValue: 0, modelUid: 'swe-2-high-lightning', credit: 18, backend: 'special_agent' },
  'swe-2-max-lightning':            { name: 'swe-2-max-lightning',            provider: 'windsurf', enumValue: 0, modelUid: 'swe-2-max-lightning', credit: 24, backend: 'special_agent' },
  // ── added 2026-10-16 from docs.devin.ai modelCostData (public price table); NOT yet frame-verified ──
  // SWE-1.7 Lightning
  'swe-1-7-lightning-medium':       { name: 'swe-1-7-lightning-medium',       provider: 'windsurf', enumValue: 0,   modelUid: 'swe-1-7-lightning-medium', credit: 9 },
  // SWE-1.7
  'swe-1-7-medium':                 { name: 'swe-1-7-medium',                 provider: 'windsurf', enumValue: 0,   modelUid: 'swe-1-7-medium', credit: 3 },

  // ── Adaptive (Windsurf 2026-04-06 changelog) ────────────
  // Adaptive Model Router + Arena models live in the cloud catalog but their
  // UIDs aren't recognized by SendUserCascadeMessage's direct-call path —
  // upstream returns "unknown model UID adaptive: model not found". They only
  // work through the Windsurf IDE's special routing layer that Cascade-direct
  // doesn't expose. Keep them hidden from /v1/models by default, but route
  // explicit calls through the optional special-agent backend instead of the
  // broken direct Cascade path. #109/#190.
  'adaptive':                       { name: 'adaptive',                       provider: 'windsurf', enumValue: 0,   modelUid: 'adaptive', credit: 1.5, deprecated: true, backend: 'special_agent' },
  'arena-fast':                     { name: 'arena-fast',                     provider: 'windsurf', enumValue: 0,   modelUid: 'arena-fast', credit: 1, deprecated: true, backend: 'special_agent' },
  'arena-smart':                    { name: 'arena-smart',                    provider: 'windsurf', enumValue: 0,   modelUid: 'arena-smart', credit: 2, deprecated: true, backend: 'special_agent' },
};

// Build reverse lookup
const _lookup = new Map();
for (const [id, info] of Object.entries(MODELS)) {
  _lookup.set(id, id);
  _lookup.set(id.toLowerCase(), id);
  _lookup.set(info.name, id);
  _lookup.set(info.name.toLowerCase(), id);
  // modelUid can be a provider-local upstream id. Astraflow entries, for
  // example, use modelUid="gpt-4o"; that must not steal the public
  // "gpt-4o" alias from the native Windsurf model.
  if (info.modelUid && !_lookup.has(info.modelUid)) _lookup.set(info.modelUid, id);
  if (info.modelUid) {
    const lowerUid = info.modelUid.toLowerCase();
    if (!_lookup.has(lowerUid)) _lookup.set(lowerUid, id);
  }
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
// Bare `claude5` / `claude-5` — issue #244 verbatim. Default to sonnet-5 medium
// (same convention as claude-4.6 → sonnet: sonnet is the more common tier).
_lookup.set('claude5', 'claude-sonnet-5-medium');
_lookup.set('claude-5', 'claude-sonnet-5-medium');
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
// gpt-5.6-luna cloud-format aliases (cloud sends `gpt-5-6-luna-*`, OpenAI-style
// is `gpt-5.6-luna-*`). Bare + compact `gpt5.6-luna` (issue #244 verbatim) → medium.
_lookup.set('gpt-5-6-luna', 'gpt-5.6-luna-medium');
_lookup.set('gpt5.6-luna', 'gpt-5.6-luna-medium');
_lookup.set('gpt-5-6-luna-none', 'gpt-5.6-luna-none');
_lookup.set('gpt-5-6-luna-low', 'gpt-5.6-luna-low');
_lookup.set('gpt-5-6-luna-medium', 'gpt-5.6-luna-medium');
_lookup.set('gpt-5-6-luna-high', 'gpt-5.6-luna-high');
_lookup.set('gpt-5-6-luna-xhigh', 'gpt-5.6-luna-xhigh');
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
_lookup.set('swe-2.0', 'swe-2');
_lookup.set('swe-2-0', 'swe-2');
_lookup.set('swe2', 'swe-2');
_lookup.set('swe-2.0-medium', 'swe-2-medium');
_lookup.set('swe-2.0-high', 'swe-2-high');
_lookup.set('swe-2.0-max', 'swe-2-max');
_lookup.set('minimax-m2-5', 'minimax-m2.5');
_lookup.set('kimi-k2-5', 'kimi-k2.5');
_lookup.set('kimi-k2.6', 'kimi-k2-6');
_lookup.set('kimi-k2.7', 'kimi-k2-7');
_lookup.set('glm-5-1', 'glm-5.1');
_lookup.set('glm-5-2', 'glm-5.2');

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
  // v2.0.85: README + every recent reply uses the dotted form
  // `claude-haiku-4.5` (mirrors `claude-sonnet-4.6`). Alias both
  // dotted and dashed so users following the docs verbatim don't hit
  // 400 model_not_found.
  'claude-haiku-4.5':           'claude-4.5-haiku',
  'claude-haiku-4.5-latest':    'claude-4.5-haiku',
  // Sonnet 4.5 dotted-suffix variants for the same reason.
  'claude-sonnet-4.5':          'claude-4.5-sonnet',
  'claude-sonnet-4.5-thinking': 'claude-4.5-sonnet-thinking',
  'claude-opus-4.5':            'claude-4.5-opus',
  'claude-opus-4.5-thinking':   'claude-4.5-opus-thinking',
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

  // Anthropic Opus 4.8. Bare aliases default to medium; tier aliases route explicitly.
  'claude-opus-4-8':            'claude-opus-4-8-medium',
  'claude-opus-4-8-latest':     'claude-opus-4-8-medium',
  'claude-opus-4.8':            'claude-opus-4-8-medium',
  'claude-opus-4.8-low':        'claude-opus-4-8-low',
  'claude-opus-4.8-medium':     'claude-opus-4-8-medium',
  'claude-opus-4.8-high':       'claude-opus-4-8-high',
  'claude-opus-4.8-xhigh':      'claude-opus-4-8-xhigh',
  'claude-opus-4.8-max':        'claude-opus-4-8-max',
  'claude-opus-4.8-low-fast':   'claude-opus-4-8-low-fast',
  'claude-opus-4.8-medium-fast': 'claude-opus-4-8-medium-fast',
  'claude-opus-4.8-high-fast':  'claude-opus-4-8-high-fast',
  'claude-opus-4.8-xhigh-fast': 'claude-opus-4-8-xhigh-fast',
  'claude-opus-4.8-max-fast':   'claude-opus-4-8-max-fast',
  'claude-opus-4-8-thinking':   'claude-opus-4-8-medium',
  'claude-opus-4.8-thinking':   'claude-opus-4-8-medium',

  // Claude 5 — bare aliases default to medium (family convention). Upstream
  // selectors are the dash form (claude-5-fable-*, claude-sonnet-5-*,
  // claude-opus-5-*); `claude-fable-5-*` is the docs display name, not the wire
  // selector. No dated suffix variants exist yet — bare/latest cover clients.
  'claude-5-fable':             'claude-5-fable-medium',
  'claude-5-fable-latest':      'claude-5-fable-medium',
  'claude-sonnet-5':            'claude-sonnet-5-medium',
  'claude-sonnet-5-latest':     'claude-sonnet-5-medium',
  'claude-opus-5':              'claude-opus-5-medium',
  'claude-opus-5-latest':       'claude-opus-5-medium',
  'claude-5-fable-low':         'claude-5-fable-low',
  'claude-5-fable-high':        'claude-5-fable-high',
  'claude-5-fable-xhigh':       'claude-5-fable-xhigh',
  'claude-5-fable-max':         'claude-5-fable-max',
  'claude-sonnet-5-low':        'claude-sonnet-5-low',
  'claude-sonnet-5-high':       'claude-sonnet-5-high',
  'claude-sonnet-5-xhigh':      'claude-sonnet-5-xhigh',
  'claude-sonnet-5-max':        'claude-sonnet-5-max',
  'claude-opus-5-low':          'claude-opus-5-low',
  'claude-opus-5-high':         'claude-opus-5-high',
  'claude-opus-5-xhigh':        'claude-opus-5-xhigh',
  'claude-opus-5-max':          'claude-opus-5-max',
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
  // GPT-5.6 Luna — OpenAI-side slug `gpt-5.6-luna` (bare → medium).
  'gpt-5.6-luna': 'gpt-5.6-luna-medium',
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
  'opus-4-8':              'claude-opus-4-8-medium',
  'opus-4.8':              'claude-opus-4-8-medium',
  'opus-4.8-thinking':     'claude-opus-4-8-medium',
  'o4.8':                  'claude-opus-4-8-medium',
  // Claude 5 — Cursor whitelist blocks "claude" in model names, so bare
  // family names resolve through here.
  'opus-5':                'claude-opus-5-medium',
  'o5':                    'claude-opus-5-medium',
  'fable-5':               'claude-5-fable-medium',
  'sonnet-5':              'claude-sonnet-5-medium',
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

// v2.0.89 (audit follow-up to v2.0.88 H-1.5): cascade pool alias
// fingerprint relies on `toolPreamble` being IDENTICAL between the
// stored fpAfterAlias and the next-turn fpBefore. toolPreamble depends
// on the dialect picked for (modelKey, provider, route). Inside one
// provider the dialect normally stays the same, so the alias slot
// fingerprint matches the next-turn lookup. But a cross-provider
// fallback (e.g. anthropic claude-opus → openai gpt-5.5) would build
// the alias slot with the gpt_native dialect's toolPreamble while the
// next turn rebuilds with claude's dialect → silent fingerprint
// mismatch → cascade reuse miss → model "forgets" prior turns again,
// regressing the v2.0.87 fix that the v2.0.88 alias write was meant
// to enforce.
//
// Today the EFFORT_LADDER and CONTEXT_LADDER walk only ever stays
// inside the same base model name (claude-opus-4-7-* siblings are all
// anthropic; codex max-* are all openai). But this is fragile —
// future catalog edits could produce a cross-provider candidate by
// accident. Add a hard guard: only return a fallback that has the
// same `provider` as the original.
function _isSameProviderFallback(originalKey, candidateKey) {
  const o = MODELS[originalKey];
  const c = MODELS[candidateKey];
  if (!o || !c) return false;
  // No provider on either side → conservatively allow (matches old
  // behaviour for entries that haven't been catalogued with provider
  // metadata, though all current entries do have provider).
  if (!o.provider || !c.provider) return true;
  return o.provider === c.provider;
}

export function pickRateLimitFallback(modelKey) {
  if (!modelKey || typeof modelKey !== 'string') return null;
  // Try effort suffix first (e.g. -max → -xhigh → -high → -medium → -low)
  for (let i = EFFORT_LADDER.length - 1; i >= 1; i--) {
    const suffix = `-${EFFORT_LADDER[i]}`;
    if (modelKey.endsWith(suffix)) {
      const base = modelKey.slice(0, -suffix.length);
      // Walk DOWN the ladder until we find a key actually in the catalog
      // AND from the same provider (cascade pool alias requires same
      // dialect → same toolPreamble → same fingerprint).
      for (let j = i - 1; j >= 0; j--) {
        const candidate = `${base}-${EFFORT_LADDER[j]}`;
        if (MODELS[candidate] && _isSameProviderFallback(modelKey, candidate)) return candidate;
      }
    }
  }
  // 1m context variants → drop -1m
  for (const suffix of CONTEXT_LADDER) {
    const dashed = `-${suffix}`;
    if (modelKey.endsWith(dashed)) {
      const candidate = modelKey.slice(0, -dashed.length);
      if (MODELS[candidate] && _isSameProviderFallback(modelKey, candidate)) return candidate;
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

// Cold-start floor for free accounts — deliberately ONE model.
//
// v2.0.0 (4b72ecd) cut this from `['gpt-4o-mini', 'gemini-2.5-flash']` because
// the extra enum-only entries were no longer routed upstream. #149's closure
// reason ("free tier = gemini-2.5-flash + glm-4.7 + kimi-k2") is a per-account
// PROBE RESULT, not this table: glm-4.7 (enum 417) and kimi-k2 (enum 323) are
// enum-keyed, so GetUserStatus's authoritative allowlist supplies them for
// accounts the upstream actually entitles; UID-only models arrive through
// registerDiscoveredFreeModel() after a successful call. Adding guesses here
// advertises models the upstream did not entitle, and those requests fail
// upstream (permission_denied → 529) instead of with a clean 403.
// Pinned by test/free-tier-cold-start.test.js; decision memo in
// evidence/Wave4-Models.md §2.
const FREE_TIER_BASE = ['gemini-2.5-flash'];
const _discoveredFreeModels = new Set();

export function registerDiscoveredFreeModel(key) {
  if (MODELS[key] && !FREE_TIER_BASE.includes(key)) _discoveredFreeModels.add(key);
}

// ─── Cloud catalog filter ─────────────────────────────────
// GetCascadeModelConfigs is fetched with one upstream account. Keep each
// account's response separate: the pool-wide catalog is their union, while
// routing checks the catalog for the candidate account only. Special-agent
// backends keep their own catalog and are not governed by this response.
const DEFAULT_CLOUD_CATALOG_ACCOUNT = Symbol('default-cloud-catalog-account');
const _cloudCatalogUidsByAccount = new Map();
const _activeCloudCatalogAccounts = new Set();
const _pendingCloudCatalogUidsByAccount = new Map();
// Consecutive rounds this account's shrunken snapshot has gone unconfirmed without
// ever repeating the same UID set. See CLOUD_CATALOG_RECHECK_MAX_ROUNDS.
const _cloudCatalogQuarantineRoundsByAccount = new Map();
// Accounts observed at least once to have a NON-EMPTY upstream catalog.
//
// Separate from the snapshot itself because the snapshot is deliberately dropped
// whenever the account needs a re-fetch — a key rotation, a status flip, leaving
// and re-entering the active set. If the "did this account ever have a filter?"
// question were answered from the snapshot alone, every one of those routine
// events would reopen the unguarded path: the next empty response would read as
// "this deployment has no cloud filter", fail open, and re-advertise everything.
// Measured before this existed: one disable/enable cycle plus one empty body took
// an account from 148/163 to 163/163 with zero confirmation rounds.
//
// Cleared only when the account is genuinely gone (forgetCloudModelCatalog, called
// from removeAccount) or on a full reset. Keeping it is the safe direction: a stale
// marker only makes the empty-response guard STRICTER.
const _cloudCatalogEverFilteredAccounts = new Set();
// Per-account cost tier + promotion, keyed by selector (lowercased modelUid).
//
// GetCascadeModelConfigs sends `modelCostTier` ("MODEL_COST_TIER_FREE" | LOW |
// MEDIUM | HIGH) and `promoStatus` ({ isActive, endDate, label? }) on every row.
// That pair is the upstream's OWN answer to "does this model debit quota right
// now", and it is the only source that can see a plan-scoped promotion: the
// credit rate table carries LIST price (swe-2-medium is 6, not 0) and the static
// table has no tier field at all. Measured on a live Pro account (2026-10-22):
// exactly three configs are MODEL_COST_TIER_FREE — swe-2-medium/high/max — with
// an active promo ending 2026-11-01T06:59:59Z, while the account's rate table has
// zero zero-rate entries.
//
// Deliberately NOT written onto MODELS[key].caps: promos are account/plan scoped
// and MODELS is the shared catalog for the whole pool. A global row would leak one
// account's promotion to every other account (and outlive its end date). Same
// reason _cloudCatalogUidsByAccount is per account.
//
// Only an ACCEPTED, non-empty snapshot replaces an account's map, mirroring the
// UID filter's fail-conservative rule: a response that omits the fields must not
// relabel a known promotion as unknown.
const _cloudCostTiersByAccount = new Map();
// Model keys that came from a live catalog snapshot rather than the static table.
//
// applyCloudModels adds keys for UIDs the static table doesn't know, and nothing ever
// removed them: a deleted account's models stayed advertised forever. Measured —
// inject one account-only UID, removeAccount, then pool total is 0 while the key is
// still in MODELS and still returned by listModels.
//
// Deliberately NOT keyed by account. applyCloudModels skips a UID that already exists,
// so only the FIRST account to report it would get an injection record — and then
// removing the SECOND account (the last real holder) would withdraw nothing and leak
// the key anyway. Measured that exact failure while building this. So the set is global
// and eviction asks the only question that actually matters: does any remaining
// account's catalog still contain this UID?
const _injectedModelKeys = new Set();
const CLOUD_CATALOG_CONFIRM_RATIO = 0.5;
// How many consecutive UNCONFIRMED shrink rounds the caller keeps re-checking
// before it gives up and leaves the last-known-good in place. This bounds the
// polling only — nothing unconfirmed is ever adopted, no matter how many rounds
// pass. See the long note at the confirmation branch for why an earlier version
// of this counter (which DID adopt the newest candidate on exhaustion) was worse
// than the wedge it was meant to fix.
const CLOUD_CATALOG_RECHECK_MAX_ROUNDS = 4;

function normalizeCloudCatalogUid(uid) {
  return typeof uid === 'string' ? uid.trim().toLowerCase() : '';
}

const STATIC_CLOUD_CATALOG_UID_COUNT = new Set(
  Object.values(MODELS)
    .filter(model => !model?.deprecated && model?.backend !== 'special_agent')
    .map(model => normalizeCloudCatalogUid(model?.modelUid))
    .filter(Boolean),
).size;

function cloudCatalogAccountKey(accountId) {
  if (accountId === undefined || accountId === null || accountId === '') {
    return DEFAULT_CLOUD_CATALOG_ACCOUNT;
  }
  return String(accountId);
}

/**
 * Cost tier + promotion off one upstream ClientModelConfig.
 *
 * Shape measured live (2026-10-22):
 *   modelCostTier: "MODEL_COST_TIER_FREE"
 *   promoStatus:   { isActive: true, endDate: "2026-11-01T06:59:59.999999999Z" }
 * and, for a discounted-but-paid row:
 *   modelCostTier: "MODEL_COST_TIER_HIGH"
 *   promoStatus:   { isActive: true, endDate: "2027-01-01T07:59:59.999999999Z", label: "83% off" }
 *
 * Returns null when the row carries neither field: "the upstream did not say" must
 * stay distinguishable from "it said FREE".
 */
function cloudCostInfo(m) {
  if (!m || typeof m !== 'object') return null;
  const costTier = typeof m.modelCostTier === 'string' && m.modelCostTier.trim()
    ? m.modelCostTier.trim()
    : null;
  const promo = m.promoStatus && typeof m.promoStatus === 'object' ? m.promoStatus : null;
  const endRaw = typeof promo?.endDate === 'string' ? promo.endDate : null;
  // The wire uses 9 fractional digits; V8's parser accepts them (verified:
  // 2026-11-01T06:59:59.999999999Z → 1793516399999). A garbage date must not
  // become a bogus expiry — keep null and let isCostTierFreeNow ignore it.
  const endMs = endRaw ? Date.parse(endRaw) : NaN;
  const info = {
    costTier,
    promoActive: typeof promo?.isActive === 'boolean' ? promo.isActive : undefined,
    promoEndsAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
    promoEndsAtMs: Number.isFinite(endMs) ? endMs : null,
    promoLabel: typeof promo?.label === 'string' && promo.label.trim() ? promo.label.trim() : null,
  };
  if (!info.costTier && !info.promoEndsAt && info.promoActive === undefined) return null;
  return Object.freeze(info);
}

/**
 * Does this cost-tier row debit quota right now?
 *
 * FREE is the upstream's own "no charge" statement, so a FREE row with no promo
 * metadata counts. An explicitly INACTIVE promo, or an end date in the past, means
 * the promotion is over — the row is then treated as billable even if the tier
 * field still says FREE, because the conservative direction is the one that does
 * not spend someone's quota.
 */
export function isCostTierFreeNow(info, now = Date.now()) {
  if (!info || info.costTier !== 'MODEL_COST_TIER_FREE') return false;
  if (info.promoActive === false) return false;
  if (info.promoEndsAtMs != null && info.promoEndsAtMs <= now) return false;
  return true;
}

/** True once any account has contributed cost-tier rows. */
export function hasCloudCostTierData() {
  for (const map of _cloudCostTiersByAccount.values()) {
    if (map.size) return true;
  }
  return false;
}

/**
 * Cost-tier info for one selector, pooled across accounts.
 *
 * Pool-wide on purpose, like the rate-table free set: "free now" answers "can this
 * deployment run it without debiting SOME account's quota", and a promo active for
 * one plan is enough. When accounts disagree, a currently-free row wins over an
 * expired one so a stale account cannot mask a live promotion.
 */
export function getCloudCostTierInfo(selector) {
  const key = typeof selector === 'string' ? selector.trim().toLowerCase() : '';
  if (!key) return null;
  let found = null;
  for (const map of _cloudCostTiersByAccount.values()) {
    const info = map.get(key);
    if (!info) continue;
    if (!found) { found = info; continue; }
    if (!isCostTierFreeNow(found) && isCostTierFreeNow(info)) found = info;
  }
  return found;
}

/**
 * Cost-tier info for one selector as reported by ONE account.
 *
 * The pool-wide getter above answers "can this deployment run it without debiting
 * SOMEONE's quota", which is the right question for a badge and the wrong one for
 * routing: a FREE row on account A says nothing about whether account B can serve
 * the same selector for free. Callers that must keep a request on a free account
 * (the drought free-only admission) ask per account, so one account's promotion
 * cannot be spent on another account's bill.
 *
 * No pooling and no "free wins" reconciliation: this is that account's own row, or
 * null when it never reported one. Null stays null — absence is not free.
 */
export function getCloudCostTierInfoForAccount(selector, accountId) {
  const key = typeof selector === 'string' ? selector.trim().toLowerCase() : '';
  if (!key || accountId === undefined || accountId === null || accountId === '') return null;
  return _cloudCostTiersByAccount.get(cloudCatalogAccountKey(accountId))?.get(key) || null;
}

/**
 * Selectors at least one account reports as free right now (promo-aware), or null
 * when no account has contributed cost-tier data. Null and an empty Set answer
 * different questions — "no data" must not read as "nothing is free".
 */
export function getCloudCostTierFreeSelectors(now = Date.now()) {
  if (!hasCloudCostTierData()) return null;
  const free = new Set();
  for (const map of _cloudCostTiersByAccount.values()) {
    for (const [selector, info] of map) {
      if (isCostTierFreeNow(info, now)) free.add(selector);
    }
  }
  return free;
}

// ── Billing sync: rate + freshness ─────────────────────────────────────────
//
// GetCascadeModelConfigs carries the credit rate (`creditMultiplier`) on the SAME
// rows as `modelCostTier`/`promoStatus`, and the catalog sync already fetches it.
// Keeping only the cost tier threw that half away, so "free by a zero rate" could
// only ever be answered by GetUserStatus's rate table — which a free account may
// never receive at all. These maps make the rate a first-class synced fact.
//
// Both maps are per account for the same reason the cost tiers are: a promotion
// or a plan-scoped rate belongs to the account that reported it, and pooling at
// write time would let one account's row outlive its own plan.
const _cloudRatesByAccount = new Map();
// When each account's billing snapshot (cost tier + rate) was last REPLACED.
// Deliberately not "last fetched": a response that omitted the fields keeps the
// last-known-good rows, so the honest age of those rows is the older timestamp.
// That is what makes staleness visible instead of silently trusted.
const _cloudBillingFetchedAtByAccount = new Map();

// How old a billing snapshot may get before the dashboard says so. 2h is 4× the
// default 30-min refresh interval, so one missed round does not flip the badge,
// while a stopped sync becomes visible the same working day. Env override for
// operators who run a much slower cadence.
const CLOUD_BILLING_STALE_MS = (() => {
  const raw = Number(process.env.BILLING_SYNC_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60 * 60 * 1000;
})();

/** True once any account has contributed a numeric credit rate. */
export function hasCloudRateData() {
  for (const map of _cloudRatesByAccount.values()) {
    if (map.size) return true;
  }
  return false;
}

/**
 * The upstream's own credit rate for one selector, pooled across accounts.
 *
 * Returns `{ credit, fetchedAt }` or null. A zero rate is a real answer (the
 * upstream charges nothing); "no row" stays null so absence never reads as free.
 */
export function getCloudCreditRate(selector) {
  const key = typeof selector === 'string' ? selector.trim().toLowerCase() : '';
  if (!key) return null;
  let found = null;
  for (const [accountKey, map] of _cloudRatesByAccount) {
    const credit = map.get(key);
    if (typeof credit !== 'number') continue;
    const fetchedAt = _cloudBillingFetchedAtByAccount.get(accountKey) || 0;
    if (!found) { found = { credit, fetchedAt }; continue; }
    // Same "free wins" rule as the cost tiers: a zero rate from any account is
    // enough to say this deployment can run it without spending quota.
    if (found.credit !== 0 && credit === 0) found = { credit, fetchedAt };
    else if (credit === found.credit && fetchedAt > found.fetchedAt) found = { credit, fetchedAt };
  }
  return found;
}

/**
 * The upstream's own credit rate for one selector, as reported by ONE account.
 *
 * The pooled getter above answers "can this deployment run it without spending
 * SOMEONE's quota", which is the right question for the gate and the wrong one for
 * routing: a zero on account A says nothing about whether account B can serve the
 * same selector for free. Callers that must keep a request on a free account (the
 * drought free-only admission) ask per account, so one account's zero cannot be
 * spent on another account's bill.
 *
 * No pooling and no "free wins" reconciliation: this is that account's own row, or
 * null when it never reported one. Null stays null — absence is not free.
 */
export function getCloudCreditRateForAccount(selector, accountId) {
  const key = typeof selector === 'string' ? selector.trim().toLowerCase() : '';
  if (!key || accountId === undefined || accountId === null || accountId === '') return null;
  const accountKey = cloudCatalogAccountKey(accountId);
  const credit = _cloudRatesByAccount.get(accountKey)?.get(key);
  if (typeof credit !== 'number') return null;
  return { credit, fetchedAt: _cloudBillingFetchedAtByAccount.get(accountKey) || 0 };
}

/**
 * Selectors at least one account's catalog prices at exactly 0 credits, or null
 * when no account has contributed a numeric rate.
 *
 * Strictly zero, like the account rate table: a 0.5-credit row still bills, and
 * calling it free is the failure that spends someone's quota.
 */
export function getCloudZeroRateSelectors() {
  if (!hasCloudRateData()) return null;
  const free = new Set();
  for (const map of _cloudRatesByAccount.values()) {
    for (const [selector, credit] of map) {
      if (credit === 0) free.add(selector);
    }
  }
  return free;
}

/** When the newest billing snapshot was applied, or 0 when none ever was. */
export function getCloudBillingFetchedAt() {
  let newest = 0;
  for (const ts of _cloudBillingFetchedAtByAccount.values()) {
    if (ts > newest) newest = ts;
  }
  return newest;
}

/** Is the newest billing snapshot older than the staleness budget? */
export function isCloudBillingStale(now = Date.now()) {
  const fetchedAt = getCloudBillingFetchedAt();
  return fetchedAt > 0 && now - fetchedAt > CLOUD_BILLING_STALE_MS;
}

/**
 * One snapshot of the billing-sync state for the dashboard.
 *
 * `accounts` and the two row counts say WHAT is known; `fetchedAt`/`stale` say
 * HOW current it is. An operator needs both: "3 free rows" is meaningless if the
 * last successful sync was yesterday.
 */
export function getCloudBillingSyncState(now = Date.now()) {
  let costTierRows = 0;
  let rateRows = 0;
  for (const map of _cloudCostTiersByAccount.values()) costTierRows += map.size;
  for (const map of _cloudRatesByAccount.values()) rateRows += map.size;
  const fetchedAt = getCloudBillingFetchedAt();
  return {
    fetchedAt: fetchedAt || null,
    stale: isCloudBillingStale(now),
    staleAfterMs: CLOUD_BILLING_STALE_MS,
    accounts: new Set([..._cloudCostTiersByAccount.keys(), ..._cloudRatesByAccount.keys()]).size,
    costTierRows,
    rateRows,
    freeRows: getCloudCostTierFreeSelectors(now)?.size ?? 0,
  };
}

/**
 * Billing facts for one selector, from the synced upstream snapshots only.
 *
 * Precedence is the project's documented one: the cost tier is the upstream's own
 * "no charge" statement, so it wins; otherwise a zero credit rate is the same
 * statement in the other field. `freeNow: null` means the upstream has said
 * NOTHING about this selector — never fold that into false here, because callers
 * still have the static cold-start fallback to consider.
 */
export function getCloudSelectorPricing(selector, now = Date.now()) {
  const info = getCloudCostTierInfo(selector);
  const costFree = info ? isCostTierFreeNow(info, now) : false;
  const rate = getCloudCreditRate(selector);
  const base = {
    costTier: info?.costTier || null,
    promoEndsAt: info?.promoEndsAt || null,
    promoLabel: info?.promoLabel || null,
    rate: rate ? rate.credit : null,
    fetchedAt: rate?.fetchedAt || getCloudBillingFetchedAt() || null,
  };
  if (costFree) return { ...base, freeNow: true, freeReason: 'cost_tier_free' };
  if (rate && rate.credit === 0) return { ...base, freeNow: true, freeReason: 'rate_zero' };
  if (info || rate) return { ...base, freeNow: false, freeReason: null };
  return { ...base, freeNow: null, freeReason: null };
}

/**
 * Apply the billing half of one accepted GetCascadeModelConfigs snapshot.
 *
 * Split out of applyCloudModels so the periodic billing refresh can update cost
 * tier + rate WITHOUT touching the model-UID filter snapshot or its "this account
 * has synced" latch. Those answer different questions: the UID set gates what may
 * be advertised, while these rows price what is already known. Re-fetching one
 * must never let a transient shrunken catalog overwrite the other.
 *
 * Replace rule: a response that carries at least one cost-tier row (or one numeric
 * rate) replaces that account's map wholesale, so a model the upstream stopped
 * marking free loses its stale promotion. A response that carries NONE of the
 * fields is a partial body and keeps the last-known-good rows — the same
 * fail-conservative rule the UID filter uses.
 */
export function mergeCloudCostTiers(configs, { accountId = null, now = Date.now() } = {}) {
  const accountKey = cloudCatalogAccountKey(accountId);
  const safeConfigs = Array.isArray(configs) ? configs : [];
  const nextCostTiers = new Map();
  const nextRates = new Map();
  for (const m of safeConfigs) {
    const uid = normalizeCloudCatalogUid(m?.modelUid);
    if (!uid) continue;
    const info = cloudCostInfo(m);
    if (info) nextCostTiers.set(uid, info);
    // Accept only a real number or a non-empty numeric string. `Number('')`,
    // `Number(' ')` and `Number(false)` all yield 0 — treating those as a
    // multiplier would silently bill a paid model at the free tier (M2).
    const rawCredit = m?.creditMultiplier;
    const credit = typeof rawCredit === 'number'
      ? rawCredit
      : (typeof rawCredit === 'string' && rawCredit.trim() !== '' ? Number(rawCredit.trim()) : NaN);
    if (rawCredit !== null && rawCredit !== undefined
      && Number.isFinite(credit) && credit >= 0) {
      nextRates.set(uid, credit);
    }
  }

  let applied = false;
  if (nextCostTiers.size > 0) {
    _cloudCostTiersByAccount.set(accountKey, nextCostTiers);
    applied = true;
  }
  if (nextRates.size > 0) {
    _cloudRatesByAccount.set(accountKey, nextRates);
    applied = true;
  }
  if (applied) _cloudBillingFetchedAtByAccount.set(accountKey, now);
  return {
    applied,
    costTierRows: nextCostTiers.size,
    rateRows: nextRates.size,
    fetchedAt: applied ? now : (_cloudBillingFetchedAtByAccount.get(accountKey) || null),
  };
}

/**
 * Set the accounts that currently contribute to pool-wide model listings.
 *
 * A listing fails open until every active account has a usable catalog. This
 * prevents a newly-added or temporarily-unsynced account from having models
 * hidden before its own upstream response arrives.
 */
export function setActiveCloudCatalogAccounts(accountIds) {
  const nextActiveAccounts = new Set();
  for (const accountId of accountIds || []) {
    if (accountId === undefined || accountId === null || accountId === '') continue;
    nextActiveAccounts.add(String(accountId));
  }
  for (const accountId of _activeCloudCatalogAccounts) {
    if (nextActiveAccounts.has(accountId)) continue;
    _cloudCatalogUidsByAccount.delete(accountId);
    _pendingCloudCatalogUidsByAccount.delete(accountId);
    _cloudCatalogQuarantineRoundsByAccount.delete(accountId);
    _cloudCostTiersByAccount.delete(accountId);
    _cloudRatesByAccount.delete(accountId);
    _cloudBillingFetchedAtByAccount.delete(accountId);
  }
  _activeCloudCatalogAccounts.clear();
  for (const accountId of nextActiveAccounts) _activeCloudCatalogAccounts.add(accountId);
}

/**
 * Remove one account's catalog when it leaves the active pool or its key changes.
 *
 * Deliberately does NOT clear the "this account has had a filter" marker: the
 * account is still the same account and still subject to the same upstream
 * restriction, so an empty response after this must not be read as "no filter".
 * Use forgetCloudModelCatalog when the account itself is gone.
 */
export function removeCloudModelCatalog(accountId) {
  const accountKey = cloudCatalogAccountKey(accountId);
  _cloudCatalogUidsByAccount.delete(accountKey);
  _pendingCloudCatalogUidsByAccount.delete(accountKey);
  _cloudCatalogQuarantineRoundsByAccount.delete(accountKey);
  _cloudCostTiersByAccount.delete(accountKey);
  _cloudRatesByAccount.delete(accountKey);
  _cloudBillingFetchedAtByAccount.delete(accountKey);
}

/** Drop every trace of an account, including that it ever had a catalog. */
export function forgetCloudModelCatalog(accountId) {
  const accountKey = cloudCatalogAccountKey(accountId);
  // Order matters, opposite to the first attempt: drop this account's catalog FIRST so
  // its own UIDs stop counting as reachable, THEN evict whatever no surviving account
  // still claims. Evicting first would always see this account's UIDs and keep everything.
  removeCloudModelCatalog(accountId);
  _cloudCatalogEverFilteredAccounts.delete(accountKey);
  evictUnreachableInjectedModels();
}

/** Clear all in-memory catalog state. Primarily useful for deterministic tests. */
export function clearCloudModelCatalogs() {
  _injectedModelKeys.clear();
  _cloudCatalogUidsByAccount.clear();
  _pendingCloudCatalogUidsByAccount.clear();
  _cloudCatalogQuarantineRoundsByAccount.clear();
  _cloudCatalogEverFilteredAccounts.clear();
  _cloudCostTiersByAccount.clear();
  _cloudRatesByAccount.clear();
  _cloudBillingFetchedAtByAccount.clear();
  _activeCloudCatalogAccounts.clear();
}

function applicableCloudCatalogUids(accountId) {
  if (accountId !== undefined && accountId !== null && accountId !== '') {
    const catalog = _cloudCatalogUidsByAccount.get(cloudCatalogAccountKey(accountId));
    return catalog?.size ? catalog : null;
  }

  if (_activeCloudCatalogAccounts.size > 0) {
    const union = new Set();
    for (const activeAccountId of _activeCloudCatalogAccounts) {
      const catalog = _cloudCatalogUidsByAccount.get(activeAccountId);
      if (!catalog?.size) return null;
      for (const uid of catalog) union.add(uid);
    }
    return union;
  }

  const fallback = _cloudCatalogUidsByAccount.get(DEFAULT_CLOUD_CATALOG_ACCOUNT);
  return fallback?.size ? fallback : null;
}

function isModelAllowedByCatalogUids(key, catalogUids) {
  if (!catalogUids) return true;
  const model = MODELS[key];
  if (!model) return false;
  if (model.backend === 'special_agent') return true;
  const uid = normalizeCloudCatalogUid(model.modelUid);
  return uid !== '' && catalogUids.has(uid);
}

/** Whether one model key is permitted by the relevant upstream account catalog. */
export function isModelAllowedByCloudCatalog(key, env = process.env, accountId = null) {
  if (env.WINDSURFAPI_IGNORE_CLOUD_FILTER === '1') return true;
  // DEVIN_CONNECT uses a separate selector namespace and catalog source.
  // Applying GetCascadeModelConfigs here can turn a valid Connect-only
  // allowlist (for example swe-1-6-slow) into an empty model view because the
  // selector has no equivalent entry in the Cascade MODELS table.
  if (getBackendSwitch('devinConnect', env)) return true;
  const catalogUids = applicableCloudCatalogUids(accountId);
  return isModelAllowedByCatalogUids(key, catalogUids);
}

/**
 * Return model keys allowed by an account catalog or by the active pool union.
 *
 * Passing accountId applies only that account's response. Omitting it applies
 * the union used by pool-wide model listings. Before every relevant catalog is
 * usable (or when explicitly disabled), this fails open.
 */
export function filterModelKeysByCloudCatalog(
  keys = Object.keys(MODELS),
  env = process.env,
  accountId = null,
) {
  const input = Array.from(keys || []);
  if (env.WINDSURFAPI_IGNORE_CLOUD_FILTER === '1') return input;
  if (getBackendSwitch('devinConnect', env)) return input;
  const catalogUids = applicableCloudCatalogUids(accountId);
  if (!catalogUids) return input;
  return input.filter((key) => isModelAllowedByCatalogUids(key, catalogUids));
}

function baseTierModels(tier) {
  if (tier === 'free') return [...FREE_TIER_BASE, ..._discoveredFreeModels];
  if (tier === 'expired') return [];
  return Object.keys(MODELS);
}

export const MODEL_TIER_ACCESS = {
  get pro() { return filterModelKeysByCloudCatalog(baseTierModels('pro')); },
  get free() { return filterModelKeysByCloudCatalog(baseTierModels('free')); },
  // Optimistic: a freshly-added account whose probe hasn't completed yet
  // gets the FULL pro catalog, not just gemini-2.5-flash. Otherwise the
  // chat.js anyEligible check (line ~1141) immediately 403s any non-free
  // model with "模型 X 在当前账号池中不可用", and users see "添加账号后
  // 不能调用任何模型" until probe finishes ~10-30s later. Trade-off: a
  // free user may try opus before probe completes; the request will fail
  // upstream with a real entitlement error from the LS, which is a more
  // accurate failure than the misleading "model not in account pool" we
  // were emitting. Reported in QQ group, 2026-04-30.
  get unknown() { return filterModelKeysByCloudCatalog(baseTierModels('unknown')); },
  expired: [],
};

/** Models a given tier is entitled to. */
export function getTierModels(tier, accountId = null, env = process.env) {
  const resolvedTier = ['pro', 'free', 'unknown', 'expired'].includes(tier) ? tier : 'unknown';
  return filterModelKeysByCloudCatalog(baseTierModels(resolvedTier), env, accountId);
}

function isSpecialAgentCatalogEnabled() {
  // DEVIN_ONLY retires Cascade and makes Devin the only backend, so the
  // special-agent models must stay listed. Routing itself is handled in
  // backend-router.selectBackend() (DEVIN_ONLY short-circuits there); this
  // only keeps the catalog/listing consistent with that mode.
  if (getBackendSwitch('devinOnly')) return true;
  const backend = String(process.env.WINDSURFAPI_SPECIAL_AGENT_BACKEND || '').trim().toLowerCase();
  return backend === 'devin-cli' || process.env.DEVIN_CLI_ENABLED === '1';
}

// O13: OpenAI `created` is a stable unix-seconds stamp, not per-request now().
export const MODEL_CREATED = 1704067200;

/** List all models in OpenAI /v1/models format. Hides deprecated models. */
export function listModels(opts = {}) {
  const env = opts.env ?? process.env;
  const specialAgentEnabled = opts.specialAgentEnabled ?? isSpecialAgentCatalogEnabled();
  const includeDisabledSpecialAgent = opts.includeDisabledSpecialAgent
    ?? process.env.WINDSURFAPI_SHOW_DISABLED_SPECIAL_AGENT_MODELS === '1';
  return filterModelKeysByCloudCatalog(Object.keys(MODELS), env)
    .map((id) => [id, MODELS[id]])
    .filter(([, info]) => !info.deprecated)
    .filter(([, info]) => info.backend !== 'special_agent' || specialAgentEnabled || includeDisabledSpecialAgent)
    .map(([id, info]) => ({
      id: info.name,
      object: 'model',
      created: MODEL_CREATED,
      owned_by: info.provider,
      _windsurf_id: id,
      ...(info.backend === 'special_agent' ? {
        _backend: 'special_agent',
        _available: !!specialAgentEnabled,
        ...(!specialAgentEnabled ? { _unavailable_reason: 'special-agent backend disabled' } : {}),
      } : {}),
    }));
}

function applyCloudModels(configs, { accountId = null } = {}) {
  const catalogAccountKey = cloudCatalogAccountKey(accountId);
  const safeConfigs = Array.isArray(configs) ? configs : [];
  _pendingCloudCatalogUidsByAccount.delete(catalogAccountKey);

  // Replace this account's policy snapshot atomically. An empty/invalid
  // response removes it so filtering remains fail-open for that account.
  const nextCloudCatalogUids = new Set();
  for (const model of safeConfigs) {
    const uid = normalizeCloudCatalogUid(model?.modelUid);
    if (uid) nextCloudCatalogUids.add(uid);
  }
  if (nextCloudCatalogUids.size > 0) {
    _cloudCatalogUidsByAccount.set(catalogAccountKey, nextCloudCatalogUids);
  } else {
    _cloudCatalogUidsByAccount.delete(catalogAccountKey);
  }

  // Same account-scoped replace as the UID set, with the same "never blank on a
  // silent response" rule. `applyCloudModels` only runs for ACCEPTED snapshots, so
  // reaching here means the upstream actually answered for this account.
  //
  // Delegated to mergeCloudCostTiers (the single writer) so the periodic billing
  // refresh and this catalog sync cannot drift apart about what a snapshot means.
  mergeCloudCostTiers(safeConfigs, { accountId });

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

  for (const m of safeConfigs) {
    const uid = typeof m?.modelUid === 'string' ? m.modelUid.trim() : '';
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
      // Capability data the upstream already sent and this merge used to discard.
      // GetCascadeModelConfigs returns the full ClientModelConfig; keeping only
      // uid/provider/credit meant every capability question (does this model take
      // images? what is its real output ceiling? is the tier allowed to use it?)
      // had to be answered from a hardcoded table or by spending a chat roundtrip
      // and reading the error. `disabled` is the load-bearing one: it is the
      // upstream's own "this account's tier may not use this model", and without
      // it a tier-forbidden model is indistinguishable from a transient fault.
      //
      // Undefined when absent rather than defaulted — a missing field means "the
      // upstream did not say", which must not read as "false".
      caps: cloudModelCaps(m),
    };
    _lookup.set(key, key);
    _lookup.set(uid, key);
    _lookup.set(uid.toLowerCase(), key);
    // Mark this key as snapshot-derived so it can be withdrawn once no account reaches
    // its UID. Without this the table only ever grows.
    _injectedModelKeys.add(key);
    added++;
  }
  return added;
}

/**
 * Withdraw snapshot-derived models that no remaining account can reach.
 *
 * Called after an account's catalog has been dropped. Reachability is decided from the
 * surviving accounts' UID sets, NOT from who originally injected the key — see the note
 * on _injectedModelKeys for why an injector-based rule leaks the last-holder case.
 *
 * Static-table models are never touched: only keys in _injectedModelKeys are candidates.
 */
function evictUnreachableInjectedModels() {
  if (!_injectedModelKeys.size) return 0;

  const reachableUids = new Set();
  for (const uids of _cloudCatalogUidsByAccount.values()) {
    for (const uid of uids) reachableUids.add(uid);
  }

  let removed = 0;
  for (const key of [..._injectedModelKeys]) {
    const model = MODELS[key];
    if (!model) { _injectedModelKeys.delete(key); continue; }
    const uid = normalizeCloudCatalogUid(model.modelUid);
    if (uid && reachableUids.has(uid)) continue; // some account still reaches it
    const rawUid = typeof model.modelUid === 'string' ? model.modelUid.trim() : '';
    delete MODELS[key];
    _lookup.delete(key);
    if (rawUid) {
      _lookup.delete(rawUid);
      _lookup.delete(rawUid.toLowerCase());
    }
    _injectedModelKeys.delete(key);
    removed++;
  }
  return removed;
}

/**
 * Merge live model configs from GetCascadeModelConfigs into the catalog.
 * Account-scoped snapshots pass through the shrink-confirmation guard. The
 * default legacy catalog remains a direct merge for compatibility.
 * Only adds NEW models not already in the catalog (doesn't overwrite enums).
 */
export function mergeCloudModels(configs, { accountId = null } = {}) {
  if (accountId === undefined || accountId === null || accountId === '') {
    return applyCloudModels(configs, { accountId });
  }
  return mergeCloudCatalogSnapshot(configs, { accountId }).added;
}

function cloudCatalogUidSet(configs) {
  const uids = new Set();
  for (const model of configs || []) {
    const uid = normalizeCloudCatalogUid(model?.modelUid);
    if (uid) uids.add(uid);
  }
  return uids;
}

/**
 * Capability fields off one upstream ClientModelConfig.
 *
 * Every value is left `undefined` when the upstream did not send it. That
 * distinction matters most for `disabled`: `false` means "the upstream says this
 * account may use it", `undefined` means "we were not told", and only the former
 * is safe to act on. Defaulting the absent case to `false` would turn silence
 * into permission — the fail-open direction this catalog is careful about
 * everywhere else (see mergeCloudCatalogSnapshot's empty/malformed handling).
 *
 * Field names follow the upstream JSON (camelCase off Connect's JSON codec).
 */
function cloudModelCaps(m) {
  if (!m || typeof m !== 'object') return undefined;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

  const caps = {
    // The tier gate. Upstream's own answer to "may this account use this model".
    disabled: bool(m.disabled),
    // Human-facing reason that pairs with `disabled` — real text for the opaque
    // "model not enabled" the dashboard used to show with no explanation.
    disabledReason: str(m.disabledReason?.shortReason || m.disabledReason?.description || m.disabledReason),
    supportsImages: bool(m.supportsImages),
    isCapacityLimited: bool(m.isCapacityLimited),
    maxTokens: num(m.maxTokens),
    maxOutputTokens: num(m.modelInfo?.maxOutputTokens ?? m.maxOutputTokens),
    maxInputTokens: num(m.maxNumChatInputTokens),
    costTier: str(m.modelCostTier),
  };
  // Drop the keys the upstream stayed silent on so a consumer can use `in`.
  for (const k of Object.keys(caps)) if (caps[k] === undefined) delete caps[k];
  return Object.keys(caps).length ? Object.freeze(caps) : undefined;
}

/**
 * Capability data for a model key, or null when the catalog has none.
 *
 * Null is the honest answer for a statically-catalogued model: the static table
 * carries no upstream capability data, and inventing defaults here would let a
 * caller believe the upstream vouched for something it never said.
 */
export function getModelCaps(modelKey) {
  if (!modelKey || typeof modelKey !== 'string') return null;
  const resolved = _lookup.get(modelKey) || _lookup.get(modelKey.toLowerCase()) || modelKey;
  return MODELS[resolved]?.caps || null;
}

/**
 * True only when the upstream explicitly said this model is disabled for the tier.
 *
 * `undefined` (not told) reads as NOT disabled on purpose: a preflight that
 * refuses on silence would break every statically-catalogued model and every
 * account whose catalog has not synced yet.
 */
export function isModelDisabledUpstream(modelKey) {
  return getModelCaps(modelKey)?.disabled === true;
}

function cloudCatalogSetsEqual(left, right) {
  if (!left || left.size !== right.size) return false;
  for (const uid of left) {
    if (!right.has(uid)) return false;
  }
  return true;
}

/**
 * Validate and merge one fetched account catalog snapshot.
 *
 * A non-empty snapshot that is less than half the account's last accepted
 * snapshot, or the static catalog when no account snapshot exists yet, is
 * quarantined until the same UID set is returned in a later sync round.
 */
export function mergeCloudCatalogSnapshot(configs, { accountId = null } = {}) {
  const accountKey = cloudCatalogAccountKey(accountId);
  const currentUids = _cloudCatalogUidsByAccount.get(accountKey);
  // "Has this account ever been under an upstream restriction?" — answered from the
  // durable marker as well as the live snapshot, because the snapshot is dropped by
  // routine re-fetch events (key rotation, status flip, leaving the active set) and
  // answering from it alone let every one of those reopen the empty-response hole.
  const everFiltered = _cloudCatalogEverFilteredAccounts.has(accountKey);
  const hasAcceptedSnapshot = !!currentUids?.size || everFiltered;

  // A malformed response is NO DATA, not "this account has no filter". It used to
  // call applyCloudModels([]) — which DELETES the account's snapshot — so a single
  // truncated / throttled / auth-blipped response silently restored the full
  // catalog and re-advertised every model the filter existed to hide (#231's own
  // symptom). Keep the last-known-good and let the caller retry.
  if (!Array.isArray(configs)) {
    return {
      accepted: false,
      added: 0,
      reason: 'malformed',
      receivedCount: 0,
      baselineCount: currentUids?.size || 0,
      baselineSource: hasAcceptedSnapshot ? 'last_accepted' : 'static',
      preservedLastKnownGood: hasAcceptedSnapshot,
    };
  }

  const nextUids = cloudCatalogUidSet(configs);
  if (nextUids.size === 0) {
    // Zero UIDs is ambiguous, and the two readings need OPPOSITE handling —
    // because the consequences are asymmetric, not because one is rarer:
    //
    //  - No snapshot accepted yet → "this deployment has no cloud filter". That
    //    is the documented fail-open and stays immediate: for such a deployment
    //    an empty response is the normal steady state.
    //  - A snapshot WAS accepted before → this is NO DATA, and it must never
    //    delete the filter. An earlier attempt at this routed the empty case
    //    through the same confirmation as any other shrink, reasoning that empty
    //    is just the maximal shrink. That was wrong on both counts. (a) Accepting
    //    a small NON-EMPTY snapshot over-restricts — it fails CLOSED, the operator
    //    sees fewer models and can act. Accepting an EMPTY one DELETES the
    //    snapshot (applyCloudModels with no UIDs), which fails OPEN and
    //    re-advertises every model the account may not have — #231's own symptom,
    //    and via the pool union it drops the filter for every OTHER account too.
    //    (b) Confirmation is the wrong instrument here: a throttled or blipped
    //    upstream returns empty repeatedly, so a second identical empty body is
    //    not evidence, it is the same non-answer twice.
    //
    // If an account genuinely loses its upstream restriction, the cost of this
    // rule is that a stale filter keeps over-restricting until the upstream sends
    // a non-empty catalog again — visible to the operator, and
    // WINDSURFAPI_IGNORE_CLOUD_FILTER=1 is the documented escape hatch. That is
    // the trade this project's own recurring lesson asks for: an absent answer is
    // "I don't know", never "it's fine".
    if (!hasAcceptedSnapshot) {
      _pendingCloudCatalogUidsByAccount.delete(accountKey);
      _cloudCatalogQuarantineRoundsByAccount.delete(accountKey);
      return {
        accepted: true,
        added: applyCloudModels(configs, { accountId }),
        reason: 'no_filter',
        receivedCount: 0,
        baselineCount: 0,
      };
    }
    return {
      accepted: false,
      added: 0,
      reason: 'empty_over_snapshot',
      receivedCount: 0,
      baselineCount: currentUids?.size || 0,
      baselineSource: 'last_accepted',
      preservedLastKnownGood: true,
    };
  }

  const baselineCount = currentUids?.size || STATIC_CLOUD_CATALOG_UID_COUNT;
  const baselineSource = hasAcceptedSnapshot ? 'last_accepted' : 'static';
  const confirmationThreshold = Math.ceil(baselineCount * CLOUD_CATALOG_CONFIRM_RATIO);
  const needsConfirmation = nextUids.size < confirmationThreshold;

  if (needsConfirmation) {
    const pendingUids = _pendingCloudCatalogUidsByAccount.get(accountKey);
    const repeated = cloudCatalogSetsEqual(pendingUids, nextUids);
    if (!repeated) {
      // Count rounds only to bound how long we keep RE-CHECKING, never to lower
      // the bar for acceptance. An earlier attempt used this counter to accept the
      // newest candidate once the budget ran out, on the theory that "the upstream
      // has said it is small several times" beats a stale snapshot. Measured, that
      // was worse than the wedge it replaced: the counter is per-account, not per
      // candidate, so two unrelated rounds paid for a third candidate that was then
      // adopted the first time it was ever seen — including an empty body, which
      // fails wide open. And once adopted, auth.js records the account as synced and
      // stops re-fetching, so a 90-second upstream wobble permanently pinned an
      // account to a never-confirmed model list with no self-healing path.
      //
      // The wedge that motivated the ceiling is already gone: auth.js now arms the
      // delayed re-check on EVERY quarantined round (it used to arm only the first),
      // and a GENUINE downgrade is stable, so it repeats and gets confirmed in two
      // rounds by the ordinary path. An upstream that keeps changing its answer has
      // no stable answer to adopt — refusing to adopt one is the correct behaviour,
      // not a wedge.
      const rounds = (_cloudCatalogQuarantineRoundsByAccount.get(accountKey) || 0) + 1;
      _pendingCloudCatalogUidsByAccount.set(accountKey, nextUids);
      _cloudCatalogQuarantineRoundsByAccount.set(accountKey, rounds);
      return {
        accepted: false,
        added: 0,
        reason: 'confirmation_required',
        receivedCount: nextUids.size,
        baselineCount,
        baselineSource,
        quarantineRounds: rounds,
        // Past this many consecutive unconfirmed rounds the caller stops arming a
        // new re-check and leaves the last-known-good in place. This bounds the
        // polling, NOT the correctness bar — nothing unconfirmed is ever adopted.
        recheckRoundsMax: CLOUD_CATALOG_RECHECK_MAX_ROUNDS,
        recheckExhausted: rounds >= CLOUD_CATALOG_RECHECK_MAX_ROUNDS,
        preservedLastKnownGood: hasAcceptedSnapshot,
      };
    }
    _pendingCloudCatalogUidsByAccount.delete(accountKey);
    _cloudCatalogQuarantineRoundsByAccount.delete(accountKey);
    _cloudCatalogEverFilteredAccounts.add(accountKey);
    return {
      accepted: true,
      added: applyCloudModels(configs, { accountId }),
      reason: 'confirmed_small',
      receivedCount: nextUids.size,
      baselineCount,
      baselineSource,
    };
  }

  _pendingCloudCatalogUidsByAccount.delete(accountKey);
  _cloudCatalogQuarantineRoundsByAccount.delete(accountKey);
  _cloudCatalogEverFilteredAccounts.add(accountKey);
  return {
    accepted: true,
    added: applyCloudModels(configs, { accountId }),
    reason: 'accepted',
    receivedCount: nextUids.size,
    baselineCount,
    baselineSource,
  };
}
