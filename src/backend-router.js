/**
 * Backend router — makes the implicit "which backend" decision explicit.
 *
 * Historically the backend choice was scattered across handlers/chat.js and
 * special-agent.js as inline branches. This module centralizes that decision
 * into one pure function so the multi-backend migration (Cascade ↔ Devin) has
 * a single, testable seam.
 *
 * BEHAVIOUR-PRESERVING: as of P1 this returns exactly what the inline logic in
 * chat.js:1789-1806 produced. No new routing is introduced yet — Devin REST is
 * defined as a backend constant but only selected when explicitly enabled via
 * env, which defaults OFF. Later phases (P2/P3) extend selectBackend() with
 * entitlement + availability inputs without touching the call sites.
 *
 * Decision order (matches legacy):
 *   1. modelInfo.backend === 'special_agent'         → BACKEND.DEVIN_ACP / DEVIN_PRINT
 *      (the special-agent path; its sub-mode comes from DEVIN_CLI_MODE)
 *   2. modelUid (string) OR enumValue > 0             → BACKEND.CASCADE
 *   3. otherwise                                       → BACKEND.LEGACY
 */

export const BACKEND = Object.freeze({
  CASCADE: 'cascade',        // Connect-RPC → server.codeium.com (StartCascade flow)
  LEGACY: 'legacy',          // RawGetChatMessage (deprecated, enum-only models)
  DEVIN_ACP: 'devin-acp',    // Devin CLI ACP over stdio (special-agent, mode=acp)
  DEVIN_PRINT: 'devin-print',// Devin CLI print mode (special-agent, mode=print)
  DEVIN_REST: 'devin-rest',  // Devin DRS REST → api.devin.ai (P2+, not yet wired)
});

/**
 * Is the given model info routed to the special-agent (Devin CLI) backend?
 * Mirrors special-agent.js isSpecialAgentModelInfo without importing it, to
 * keep this module free of side effects.
 */
function isSpecialAgentInfo(modelInfo) {
  return modelInfo?.backend === 'special_agent';
}

/**
 * Resolve the Devin CLI sub-mode (acp vs print). Defaults to print — the same
 * conservative default special-agent.js uses.
 */
function devinCliMode(env = process.env) {
  const mode = String(env.DEVIN_CLI_MODE || 'print').trim().toLowerCase();
  return mode === 'acp' ? BACKEND.DEVIN_ACP : BACKEND.DEVIN_PRINT;
}

/**
 * Select the backend for a request. Pure function — no I/O, no mutation.
 *
 * @param {object} params
 * @param {object|null} params.modelInfo  resolved model catalog entry
 * @param {object} [params.env]           env source (injectable for tests)
 * @returns {{ backend: string, reason: string, flow: 'special_agent'|'cascade'|'legacy' }}
 */
export function selectBackend({ modelInfo = null, env = process.env } = {}) {
  if (isSpecialAgentInfo(modelInfo)) {
    return {
      backend: devinCliMode(env),
      reason: 'modelInfo.backend=special_agent',
      flow: 'special_agent',
    };
  }

  const modelEnum = modelInfo?.enumValue || 0;
  const modelUid = modelInfo?.modelUid || null;
  if (modelUid || modelEnum) {
    return { backend: BACKEND.CASCADE, reason: modelUid ? 'modelUid' : 'enumValue', flow: 'cascade' };
  }

  return { backend: BACKEND.LEGACY, reason: 'no-uid-no-enum', flow: 'legacy' };
}

/**
 * Convenience: does this selection use the Cascade Connect-RPC flow? Call sites
 * in chat.js currently compute `useCascade = !!(modelUid || modelEnum)`; this
 * keeps that exact semantics so the router can be dropped in without behaviour
 * change.
 */
export function usesCascadeFlow(selection) {
  return selection?.flow === 'cascade';
}

export const __testing = { isSpecialAgentInfo, devinCliMode };
