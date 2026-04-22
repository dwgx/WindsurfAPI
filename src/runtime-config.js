/**
 * Runtime configuration — persistent feature toggles that can be flipped from
 * the dashboard at runtime without a restart or editing .env. Backed by a
 * small JSON file next to the project root so it survives redeploys.
 *
 * Currently hosts the "experimental" feature flags. Keep this tiny: anything
 * that needs a restart should stay in config.js / .env.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { config, log } from './config.js';

const FILE = resolve(config.dataDir, 'runtime-config.json');

export const DEFAULT_IDENTITY_PROMPTS = {
  anthropic: 'You are {model}, a large language model created by Anthropic. You are helpful, harmless, and honest. When asked about your identity or which model you are, you respond that you are {model}, made by Anthropic.',
  openai:    'You are {model}, a large language model created by OpenAI. When asked about your identity, you respond that you are {model}, made by OpenAI.',
  google:    'You are {model}, a large language model created by Google. When asked about your identity, you respond that you are {model}, made by Google.',
  deepseek:  'You are {model}, a large language model created by DeepSeek. When asked about your identity, you respond that you are {model}, made by DeepSeek.',
  xai:       'You are {model}, a large language model created by xAI. When asked about your identity, you respond that you are {model}, made by xAI.',
  alibaba:   'You are {model}, a large language model created by Alibaba. When asked about your identity, you respond that you are {model}, made by Alibaba.',
  moonshot:  'You are {model}, a large language model created by Moonshot AI. When asked about your identity, you respond that you are {model}, made by Moonshot AI.',
  zhipu:     'You are {model}, a large language model created by Zhipu AI. When asked about your identity, you respond that you are {model}, made by Zhipu AI.',
  minimax:   'You are {model}, a large language model created by MiniMax. When asked about your identity, you respond that you are {model}, made by MiniMax.',
  windsurf:  'You are {model}, a coding assistant model by Windsurf. When asked about your identity, you respond that you are {model}, made by Windsurf.',
};

const DEFAULTS = {
  experimental: {
    // Reuse Cascade cascade_id across multi-turn requests when the history
    // fingerprint matches. Big latency win for long conversations but relies
    // on Windsurf keeping the cascade alive — off by default.
    cascadeConversationReuse: true,
    // Inject a system prompt that tells the model to identify itself as the
    // requested model (e.g. "You are Claude Opus 4.6, made by Anthropic")
    // instead of revealing the Windsurf/Cascade backend. Enabled by default
    // so API responses match official Claude/GPT behaviour.
    modelIdentityPrompt: true,
    // Pre-flight rate limit check via server.codeium.com before sending a
    // chat request. Reduces wasted attempts when the account has no message
    // capacity. Adds one network round-trip per attempt so off by default.
    preflightRateLimit: false,
  },
  // Per-provider identity prompt templates. Use {model} as the model-name
  // placeholder. Edits from the dashboard are persisted here.
  identityPrompts: { ...DEFAULT_IDENTITY_PROMPTS },
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(base[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let _state = structuredClone(DEFAULTS);

function load() {
  if (!existsSync(FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf-8'));
    _state = deepMerge(DEFAULTS, raw);
  } catch (e) {
    log.warn(`runtime-config: failed to load ${FILE}: ${e.message}`);
  }
}

function persist() {
  try {
    writeFileSync(FILE, JSON.stringify(_state, null, 2));
  } catch (e) {
    log.warn(`runtime-config: failed to persist: ${e.message}`);
  }
}

load();

export function getRuntimeConfig() {
  return structuredClone(_state);
}

export function getExperimental() {
  return { ...(_state.experimental || {}) };
}

export function isExperimentalEnabled(key) {
  return !!_state.experimental?.[key];
}

export function setExperimental(patch) {
  if (!patch || typeof patch !== 'object') return getExperimental();
  _state.experimental = { ...(_state.experimental || {}), ...patch };
  // Coerce to booleans — the dashboard ships JSON but we never want truthy
  // strings sneaking in as "true".
  for (const k of Object.keys(_state.experimental)) {
    _state.experimental[k] = !!_state.experimental[k];
  }
  persist();
  return getExperimental();
}

export function getIdentityPrompts() {
  return { ...DEFAULT_IDENTITY_PROMPTS, ...(_state.identityPrompts || {}) };
}

export function getIdentityPromptFor(provider) {
  const all = getIdentityPrompts();
  return all[provider] || null;
}

export function setIdentityPrompts(patch) {
  if (!patch || typeof patch !== 'object') return getIdentityPrompts();
  const current = _state.identityPrompts || {};
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== 'string') continue;
    current[k] = v.trim();
  }
  _state.identityPrompts = current;
  persist();
  return getIdentityPrompts();
}

export function resetIdentityPrompt(provider) {
  if (provider && _state.identityPrompts) {
    delete _state.identityPrompts[provider];
  } else {
    _state.identityPrompts = {};
  }
  persist();
  return getIdentityPrompts();
}
