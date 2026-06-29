const stats = {
  requests: 0,
  mappedTools: 0,
  unmappedTools: 0,
  additionalSteps: 0,
  accountGateRejects: 0,
  accountGateSkips: 0,
  cascadeToolCalls: 0,
  emittedToolCalls: 0,
  providerXmlToolCalls: 0,
  unmappedCascadeToolCalls: 0,
  noToolCallResponses: 0,
  decisions: 0,
  enabledDecisions: 0,
  disabledDecisions: 0,
  requestedByTool: Object.create(null),
  unmappedRequestedByTool: Object.create(null),
  emittedByTool: Object.create(null),
  byCascadeKind: Object.create(null),
  unmappedByCascadeKind: Object.create(null),
  decisionReasons: Object.create(null),
  lastDecision: null,
  recentDecisions: [],
};

// Cap distinct keys in client-controlled accumulator maps (requestedByTool,
// emittedByTool, etc.). Tool/kind names come from caller requests, so a client
// sending a unique tool name per request would otherwise grow these objects
// without bound for the process lifetime. Once the cap is hit, new keys fold
// into an "(other)" bucket — mirroring the ring-buffer discipline already used
// for recentDecisions. Existing keys keep accumulating exactly.
function statsMapKeyLimit() {
  const n = Number(process.env.WINDSURFAPI_NATIVE_BRIDGE_STATS_KEY_LIMIT);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(2000, Math.floor(n));
}

function bump(obj, key, n = 1) {
  let k = String(key || '(unknown)');
  if (obj[k] === undefined && k !== '(other)' && Object.keys(obj).length >= statsMapKeyLimit()) {
    k = '(other)';
  }
  obj[k] = (obj[k] || 0) + n;
}

function safeString(value, max = 120) {
  const s = String(value || '');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function safeToolList(values) {
  return (Array.isArray(values) ? values : [])
    .map(v => safeString(v, 80))
    .filter(Boolean)
    .slice(0, 50);
}

function decisionRingLimit() {
  const n = Number(process.env.WINDSURFAPI_NATIVE_BRIDGE_DECISION_RING_SIZE);
  if (!Number.isFinite(n) || n <= 0) return 25;
  return Math.min(200, Math.floor(n));
}

function copyDecision(decision) {
  if (!decision || typeof decision !== 'object') return null;
  return {
    ...decision,
    mappedTools: safeToolList(decision.mappedTools),
    unmappedTools: safeToolList(decision.unmappedTools),
  };
}

function sanitizeDecision(decision = {}) {
  const mappedTools = safeToolList(decision.mappedTools);
  const unmappedTools = safeToolList(decision.unmappedTools);
  return {
    at: new Date().toISOString(),
    enabled: !!decision.enabled,
    reason: safeString(decision.reason || (decision.enabled ? 'native_bridge_enabled' : 'native_bridge_disabled'), 80),
    mode: safeString(decision.mode, 40),
    useCascade: decision.useCascade !== false,
    modelKey: safeString(decision.modelKey || decision.model, 120),
    requestedModel: safeString(decision.requestedModel || decision.model, 120),
    provider: safeString(decision.provider, 80),
    route: safeString(decision.route, 80),
    toolChoiceFiltered: !!decision.toolChoiceFiltered,
    hasTools: !!decision.hasTools,
    toolCount: Math.max(0, Number(decision.toolCount) || 0),
    mappedCount: Math.max(0, Number(decision.mappedCount ?? mappedTools.length) || 0),
    unmappedCount: Math.max(0, Number(decision.unmappedCount ?? unmappedTools.length) || 0),
    mappedTools,
    unmappedTools,
  };
}

export function recordNativeBridgeDecision(decision = {}) {
  const entry = sanitizeDecision(decision);
  stats.decisions++;
  if (entry.enabled) stats.enabledDecisions++;
  else stats.disabledDecisions++;
  bump(stats.decisionReasons, entry.reason);
  stats.lastDecision = entry;
  const limit = decisionRingLimit();
  stats.recentDecisions.push(entry);
  while (stats.recentDecisions.length > limit) stats.recentDecisions.shift();
}

export function recordNativeBridgeRequest({ mappedTools = [], unmappedTools = [], additionalSteps = 0 } = {}) {
  stats.requests++;
  stats.mappedTools += Array.isArray(mappedTools) ? mappedTools.length : 0;
  stats.unmappedTools += Array.isArray(unmappedTools) ? unmappedTools.length : 0;
  stats.additionalSteps += Math.max(0, Number(additionalSteps) || 0);
  for (const name of mappedTools || []) bump(stats.requestedByTool, name);
  for (const name of unmappedTools || []) bump(stats.unmappedRequestedByTool, name);
}

export function recordNativeBridgeAccountGateReject() {
  stats.accountGateRejects++;
}

export function recordNativeBridgeAccountGateSkip() {
  stats.accountGateSkips++;
}

export function recordNativeBridgeCascadeToolCall(kind) {
  stats.cascadeToolCalls++;
  bump(stats.byCascadeKind, kind);
}

export function recordNativeBridgeEmittedToolCall(name, { source = 'cascade' } = {}) {
  stats.emittedToolCalls++;
  bump(stats.emittedByTool, name);
  if (source === 'provider_xml') stats.providerXmlToolCalls++;
}

export function recordNativeBridgeUnmappedCascadeToolCall(kind) {
  stats.unmappedCascadeToolCalls++;
  bump(stats.unmappedByCascadeKind, kind);
}

export function recordNativeBridgeNoToolCallResponse() {
  stats.noToolCallResponses++;
}

export function getNativeBridgeStats() {
  return {
    ...stats,
    requestedByTool: { ...stats.requestedByTool },
    unmappedRequestedByTool: { ...stats.unmappedRequestedByTool },
    emittedByTool: { ...stats.emittedByTool },
    byCascadeKind: { ...stats.byCascadeKind },
    unmappedByCascadeKind: { ...stats.unmappedByCascadeKind },
    decisionReasons: { ...stats.decisionReasons },
    lastDecision: copyDecision(stats.lastDecision),
    recentDecisions: stats.recentDecisions.map(copyDecision).filter(Boolean),
  };
}

export function resetNativeBridgeStats() {
  for (const key of Object.keys(stats)) {
    if (key === 'requestedByTool' || key === 'unmappedRequestedByTool' || key === 'emittedByTool' || key === 'byCascadeKind' || key === 'unmappedByCascadeKind' || key === 'decisionReasons') {
      stats[key] = Object.create(null);
    } else if (key === 'lastDecision') {
      stats[key] = null;
    } else if (key === 'recentDecisions') {
      stats[key] = [];
    } else {
      stats[key] = 0;
    }
  }
}
