#!/usr/bin/env node

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const baseUrl = (process.env.BASE_URL || process.env.WINDSURFAPI_BASE_URL || 'http://127.0.0.1:3003').replace(/\/+$/, '');
const apiKey = process.env.API_KEY || process.env.WINDSURFAPI_API_KEY || '';
const model = process.env.MODEL || process.env.WINDSURFAPI_SMOKE_MODEL || 'claude-sonnet-4.6';
const marker = `NATIVE_BRIDGE_SMOKE_${Date.now().toString(36)}`;
const streamEnabled = process.env.NATIVE_BRIDGE_SMOKE_STREAM !== '0';
const nonStreamEnabled = process.env.NATIVE_BRIDGE_SMOKE_NON_STREAM !== '0';
const noExitOnFailure = process.env.NATIVE_BRIDGE_SMOKE_NO_EXIT_ON_FAILURE === '1';
const requestTimeoutMs = Math.max(5_000, Number(process.env.NATIVE_BRIDGE_SMOKE_TIMEOUT_MS || 120_000));
const streamEarlyTool = process.env.NATIVE_BRIDGE_SMOKE_EARLY_TOOL !== '0';
const includeEnv = process.env.NATIVE_BRIDGE_SMOKE_ENV !== '0';
const includeHealth = process.env.NATIVE_BRIDGE_SMOKE_HEALTH !== '0';
const requireNativeBridgeTool = process.env.NATIVE_BRIDGE_SMOKE_REQUIRE_NATIVE !== '0';
const validateToolArgs = process.env.NATIVE_BRIDGE_SMOKE_VALIDATE_ARGS !== '0';
const enforceLsBudget = process.env.NATIVE_BRIDGE_SMOKE_LS_BUDGET !== '0';
const requireNativeBridgeEnabled = process.env.NATIVE_BRIDGE_SMOKE_REQUIRE_BRIDGE_ENABLED !== '0';
const includeProtoTraceSummary = process.env.NATIVE_BRIDGE_SMOKE_PROTO_TRACE_SUMMARY !== '0';
const protoTraceDir = process.env.NATIVE_BRIDGE_SMOKE_PROTO_TRACE_DIR
  || process.env.WINDSURFAPI_PROTO_TRACE_DIR
  || '/data/proto-trace';
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const defaultWorkspaceId = apiKey ? (await sha256Hex(apiKey)).slice(0, 16) : '';
const defaultSmokeCwd = defaultWorkspaceId
  ? `/home/user/projects/workspace-${defaultWorkspaceId}`
  : '/tmp/windsurf-workspace';
const smokeCwd = process.env.NATIVE_BRIDGE_SMOKE_CWD || defaultSmokeCwd;
const smokeFile = process.env.NATIVE_BRIDGE_SMOKE_FILE || `${smokeCwd.replace(/\/+$/, '')}/README.md`;
const requestedScenarios = String(process.env.NATIVE_BRIDGE_SMOKE_TOOLS || 'Bash')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!apiKey) {
  console.error('API_KEY is required. Enable native bridge with narrow gates before this smoke.');
  process.exit(2);
}

function truncate(text, max = 1200) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}...<truncated ${s.length - max} chars>` : s;
}

function compactText(text, max = 1200) {
  return truncate(String(text || '').replace(/\s+/g, ' ').trim(), max);
}

function smokeError(message, diagnostic = null) {
  const err = new Error(message);
  if (diagnostic) err.diagnostic = diagnostic;
  return err;
}

function resultFromError(error) {
  const out = { ok: false, error: String(error?.message || error) };
  if (error?.diagnostic) out.diagnostic = error.diagnostic;
  return out;
}

function fnTool(name, properties, required = []) {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} native bridge smoke tool.`,
      parameters: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

const TOOL = {
  Read: fnTool('Read', {
    file_path: { type: 'string' },
    offset: { type: 'number' },
    limit: { type: 'number' },
  }, ['file_path']),
  Bash: fnTool('Bash', {
    command: { type: 'string' },
    cwd: { type: 'string' },
  }, ['command']),
  Grep: fnTool('Grep', {
    pattern: { type: 'string' },
    path: { type: 'string' },
    glob: { type: 'string' },
    output_mode: { type: 'string' },
  }, ['pattern']),
  Glob: fnTool('Glob', {
    pattern: { type: 'string' },
    path: { type: 'string' },
  }, ['pattern']),
  WebSearch: fnTool('WebSearch', {
    query: { type: 'string' },
    domains: { type: 'array', items: { type: 'string' } },
  }, ['query']),
  WebFetch: fnTool('WebFetch', {
    url: { type: 'string' },
  }, ['url']),
};

const SCENARIOS = {
  Read: {
    tools: [TOOL.Read],
    choice: 'Read',
    prompt: `Use the Read tool exactly once for ${smokeFile} with limit 20. Marker: ${marker}. Do not answer in prose.`,
    expectArgs: 'file_path ending in README.md',
    validateArgs(args) {
      const filePath = String(args.file_path || args.path || '');
      return /(^|[/\\])README\.md$/i.test(filePath);
    },
  },
  Bash: {
    tools: [TOOL.Bash],
    choice: 'Bash',
    prompt: `Use the Bash tool exactly once with command: printf ${marker}. Do not answer in prose.`,
    expectArgs: `command containing ${marker}`,
    validateArgs(args) {
      const command = String(args.command || args.command_line || '');
      return command.includes(marker);
    },
  },
  Grep: {
    tools: [TOOL.Grep],
    choice: 'Grep',
    prompt: `Use the Grep tool exactly once with pattern "Proxy workspace placeholder", path ${smokeCwd}, glob README.md, and output_mode files_with_matches. Marker: ${marker}. Do not answer in prose.`,
    expectArgs: 'pattern "Proxy workspace placeholder"',
    validateArgs(args) {
      return String(args.pattern || '').trim() === 'Proxy workspace placeholder';
    },
  },
  Glob: {
    tools: [TOOL.Glob],
    choice: 'Glob',
    prompt: `Use the Glob tool exactly once with pattern README.md and path ${smokeCwd}. Marker: ${marker}. Do not answer in prose.`,
    expectArgs: 'pattern exactly README.md',
    validateArgs(args) {
      return String(args.pattern || '').trim() === 'README.md';
    },
  },
  mixed: {
    tools: [TOOL.Read, TOOL.Bash, TOOL.Grep, TOOL.Glob],
    choice: null,
    prompt: `Choose exactly one appropriate tool from Read, Bash, Grep, Glob to inspect ${smokeFile} for ${marker}. Do not answer in prose.`,
  },
  WebSearch: {
    tools: [TOOL.WebSearch],
    choice: 'WebSearch',
    prompt: `Use the WebSearch tool exactly once with query "WindsurfAPI native bridge ${marker}". Do not answer in prose.`,
    expectArgs: `query containing ${marker}`,
    validateArgs(args) {
      return String(args.query || '').includes(marker);
    },
  },
  WebFetch: {
    tools: [TOOL.WebFetch],
    choice: 'WebFetch',
    prompt: `Use the WebFetch tool exactly once with url https://example.com/. Marker: ${marker}. Do not answer in prose.`,
    expectArgs: 'url exactly https://example.com/',
    validateArgs(args) {
      return String(args.url || '').trim() === 'https://example.com/';
    },
  },
};

function expandScenarios(names) {
  const out = [];
  for (const name of names) {
    if (name === 'all') out.push('Read', 'Bash', 'Grep', 'Glob', 'mixed');
    else out.push(name);
  }
  return [...new Set(out)].filter(name => SCENARIOS[name]);
}

function requestBody(scenario, stream) {
  const messages = [];
  if (includeEnv) {
    messages.push({
      role: 'system',
      content: [
        '# Environment',
        `- Working directory: ${smokeCwd}`,
        '- Is directory a git repo: false',
        '- Platform: linux',
      ].join('\n'),
    });
  }
  messages.push({ role: 'user', content: scenario.prompt });
  const body = {
    model,
    stream,
    messages,
    tools: scenario.tools,
    max_tokens: 512,
  };
  if (scenario.choice) body.tool_choice = { type: 'function', function: { name: scenario.choice } };
  return body;
}

async function post(body, { streamEarlyTool = false, expectedTool = '' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  let settledByEarlyTool = false;
  let accumulated = '';
  let res;
  try {
    res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!streamEarlyTool || !res.body) {
      const text = await res.text();
      return {
        status: res.status,
        text,
        earlyTool: false,
        seenDone: /(?:^|\n)data:\s*\[DONE\]/.test(text),
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const streamCalls = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      accumulated += chunk;
      assertNoNativeXml(accumulated, 'stream');
      streamCalls.splice(0, streamCalls.length, ...collectStreamToolCalls(accumulated));
      const names = namesFromCalls(streamCalls);
      if (names.length && (!expectedTool || names.includes(expectedTool))) {
        settledByEarlyTool = true;
        await reader.cancel().catch(() => {});
        controller.abort();
        break;
      }
    }
    accumulated += decoder.decode();
    return { status: res.status, text: accumulated, earlyTool: settledByEarlyTool, seenDone: /(?:^|\n)data:\s*\[DONE\]/.test(accumulated) };
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (settledByEarlyTool) return { status: res?.status || 0, text: accumulated, earlyTool: true, seenDone: false };
      throw new Error(`request timed out after ${requestTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertNoNativeXml(text, label) {
  if (/<\/?function_calls\b|<invoke\b/i.test(text)) {
    throw new Error(`${label}: provider-native function XML leaked to the client`);
  }
}

function parseSse(text) {
  const frames = [];
  for (const frame of text.split('\n\n')) {
    const lines = frame.split('\n').filter(Boolean);
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      try { frames.push(JSON.parse(payload)); } catch {}
    }
  }
  return frames;
}

function streamDiagnostics(text, calls = []) {
  const frames = parseSse(text);
  const contents = [];
  const reasoning = [];
  const finishReasons = [];
  const usageFrames = [];
  const responseIds = [];
  for (const frame of frames) {
    if (frame?.id) responseIds.push(frame.id);
    if (frame?.usage) usageFrames.push(frame.usage);
    for (const choice of (frame?.choices || [])) {
      if (choice?.finish_reason) finishReasons.push(choice.finish_reason);
      if (choice?.delta?.content) contents.push(choice.delta.content);
      if (choice?.delta?.reasoning_content) reasoning.push(choice.delta.reasoning_content);
      if (choice?.message?.content) contents.push(choice.message.content);
    }
  }
  return {
    frameCount: frames.length,
    responseIds: [...new Set(responseIds)].slice(0, 3),
    finishReasons: [...new Set(finishReasons)],
    toolCallNames: namesFromCalls(calls),
    toolCallSources: calls.map(toolCallSource),
    toolCallArguments: calls.map(toolCallArgumentPreview),
    toolCallArgumentMeta: calls.map(toolCallArgumentMeta),
    contentPreview: compactText(contents.join('')),
    reasoningPreview: compactText(reasoning.join('')),
    usage: usageFrames.at(-1) || null,
    seenDone: /(?:^|\n)data:\s*\[DONE\]/.test(text),
    rawPreview: compactText(text),
  };
}

function nonStreamDiagnostics(json, rawText, calls = []) {
  const choice = json?.choices?.[0] || {};
  const message = choice.message || {};
  return {
    finishReason: choice.finish_reason || null,
    toolCallNames: namesFromCalls(calls),
    toolCallSources: calls.map(toolCallSource),
    toolCallArguments: calls.map(toolCallArgumentPreview),
    toolCallArgumentMeta: calls.map(toolCallArgumentMeta),
    contentPreview: compactText(message.content || ''),
    usage: json?.usage || null,
    rawPreview: compactText(rawText),
  };
}

function collectStreamToolCalls(text) {
  return parseSse(text).flatMap(f => (f.choices || [])
    .flatMap(choice => choice.delta?.tool_calls || []));
}

function namesFromCalls(calls) {
  return calls.map(c => c.function?.name || c.name || '').filter(Boolean);
}

function toolCallSource(call) {
  const id = String(call?.id || '');
  if (id.startsWith('native:')) return 'cascade_native';
  if (id.startsWith('call_native_')) return 'provider_xml';
  if (id.startsWith('nlu_') || id.startsWith('nlu_retry_')) return 'nlu_recovery';
  if (id.startsWith('call_')) return 'openai_tool_call';
  return id ? 'unknown' : 'missing_id';
}

function isNativeBridgeToolCall(call) {
  const source = toolCallSource(call);
  return source === 'cascade_native' || source === 'provider_xml';
}

function matchingToolCalls(calls, expected) {
  return (calls || []).filter(call => {
    const name = call?.function?.name || call?.name || '';
    return !expected || name === expected;
  });
}

function parseToolCallArguments(call) {
  const raw = call?.function?.arguments ?? call?.argumentsJson ?? call?.arguments ?? '';
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return { __parse_error: compactText(raw, 240) };
  }
}

function toolCallArgumentPreview(call) {
  const args = parseToolCallArguments(call);
  const out = {};
  for (const [key, value] of Object.entries(args).slice(0, 8)) {
    out[key] = typeof value === 'string' ? compactText(value, 240) : value;
  }
  return out;
}

function toolCallArgumentMeta(call) {
  const args = parseToolCallArguments(call);
  const issues = [];
  const fields = {};
  for (const [key, value] of Object.entries(args).slice(0, 12)) {
    if (typeof value !== 'string') {
      fields[key] = { type: typeof value };
      continue;
    }
    const trimmed = value.trim();
    const meta = {
      type: 'string',
      length: value.length,
      redactedWorkspacePath: trimmed === '<workspace>',
      basename: (() => {
        const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
        return normalized.split('/').pop() || '';
      })(),
    };
    fields[key] = meta;
    if (meta.redactedWorkspacePath) {
      issues.push({
        field: key,
        reason: 'redacted_workspace_path',
        message: 'The proxy redacted an internal workspace path; this is protocol evidence, but not a client-usable local path.',
      });
    }
  }
  return { fields, issues };
}

function scenarioArgumentIssue(scenarioName, args) {
  if (scenarioName !== 'Read') return null;
  const filePath = String(args.file_path || args.path || '').trim();
  if (filePath === '<workspace>') {
    return 'Read returned the workspace redaction marker instead of a concrete README.md path';
  }
  if (filePath && !/(^|[/\\])README\.md$/i.test(filePath)) {
    return `Read returned basename "${filePath.replace(/\\/g, '/').split('/').pop() || filePath}" instead of README.md`;
  }
  return null;
}

function assertExpectedTool(calls, scenarioName, scenario, diagnostic = null) {
  const expected = scenario.choice || '';
  const matches = matchingToolCalls(calls, expected);
  const names = namesFromCalls(calls);
  if (!names.length) throw smokeError(`${scenarioName}: produced no tool_calls`, diagnostic);
  if (expected && !names.includes(expected)) {
    throw smokeError(`${scenarioName}: expected ${expected}, got ${names.join(',')}`, diagnostic);
  }
  if (requireNativeBridgeTool && !matches.some(isNativeBridgeToolCall)) {
    const sources = [...new Set(matches.map(toolCallSource))].join(',') || '(none)';
    throw smokeError(`${scenarioName}: produced tool_calls but no native bridge tool_call (sources=${sources})`, diagnostic);
  }
  if (validateToolArgs && expected && typeof scenario.validateArgs === 'function') {
    const eligible = requireNativeBridgeTool ? matches.filter(isNativeBridgeToolCall) : matches;
    const ok = eligible.some(call => scenario.validateArgs(parseToolCallArguments(call)));
    if (!ok) {
      const expectedArgs = scenario.expectArgs || 'expected smoke arguments';
      const issues = eligible
        .map(call => scenarioArgumentIssue(scenarioName, parseToolCallArguments(call)))
        .filter(Boolean);
      const enriched = diagnostic ? { ...diagnostic, argumentValidationIssues: issues } : { argumentValidationIssues: issues };
      const suffix = issues.length ? `; ${issues.join('; ')}` : '';
      throw smokeError(`${scenarioName}: native bridge tool_call arguments did not match (${expectedArgs})${suffix}`, enriched);
    }
  }
  return names;
}

async function runNonStream(name, scenario) {
  const res = await post(requestBody(scenario, false));
  if (res.status !== 200) {
    throw smokeError(`${name} non-stream HTTP ${res.status}: ${res.text.slice(0, 800)}`, {
      status: res.status,
      rawPreview: compactText(res.text),
    });
  }
  assertNoNativeXml(res.text, `${name} non-stream`);
  let json;
  try {
    json = JSON.parse(res.text);
  } catch (error) {
    throw smokeError(`${name} non-stream invalid JSON: ${error.message}`, {
      status: res.status,
      rawPreview: compactText(res.text),
    });
  }
  const calls = json.choices?.[0]?.message?.tool_calls || [];
  const diagnostic = nonStreamDiagnostics(json, res.text, calls);
  return { toolCalls: calls.length, names: assertExpectedTool(calls, name, scenario, diagnostic), diagnostic };
}

async function runStream(name, scenario) {
  const res = await post(requestBody(scenario, true), {
    streamEarlyTool,
    expectedTool: scenario.choice || '',
  });
  if (res.status !== 200) {
    throw smokeError(`${name} stream HTTP ${res.status}: ${res.text.slice(0, 800)}`, {
      status: res.status,
      rawPreview: compactText(res.text),
    });
  }
  assertNoNativeXml(res.text, `${name} stream`);
  const calls = collectStreamToolCalls(res.text);
  const diagnostic = streamDiagnostics(res.text, calls);
  return {
    toolCalls: calls.length,
    names: assertExpectedTool(calls, name, scenario, diagnostic),
    earlyTool: res.earlyTool,
    seenDone: !!res.seenDone,
    diagnostic,
  };
}

function summarizeLsPool(lsPool) {
  if (!lsPool || typeof lsPool !== 'object') return null;
  const pool = lsPool.pool || {};
  const guard = pool.memoryGuard || lsPool.memoryGuard || {};
  return {
    running: !!lsPool.running,
    maxInstances: lsPool.maxInstances,
    totalRssBytes: lsPool.totalRssBytes,
    pool: {
      size: pool.size,
      effectiveOccupancy: pool.effectiveOccupancy,
      pending: pool.pending,
      reservedPendingStarts: pool.reservedPendingStarts,
      activeRequests: pool.activeRequests,
      maintenanceRequests: pool.maintenanceRequests,
      nonDefaultInstances: pool.nonDefaultInstances,
      canStartNewNonDefault: pool.canStartNewNonDefault,
      blockReason: pool.blockReason,
    },
    memoryGuard: {
      enabled: guard.enabled,
      availableBytes: guard.availableBytes,
      minAvailableBytes: guard.minAvailableBytes,
      reservedStarts: guard.reservedStarts,
      okToSpawn: guard.okToSpawn,
      minAvailableBytesSource: guard.minAvailableBytesSource,
    },
    admissionStats: lsPool.admissionStats || null,
  };
}

async function fetchHealthSnapshot(label) {
  if (!includeHealth) return null;
  try {
    const res = await fetch(`${baseUrl}/health?verbose=1`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
      return { ok: false, label, status: res.status, error: 'health returned non-JSON', rawPreview: compactText(text) };
    }
    return {
      ok: res.ok,
      label,
      status: res.status,
      version: json.version,
      commit: json.commit,
      accounts: json.accounts,
      nativeBridge: json.nativeBridge || null,
      nativeBridgeConfig: json.nativeBridgeConfig || null,
      lsPool: summarizeLsPool(json.lsPool),
    };
  } catch (error) {
    return { ok: false, label, error: String(error?.message || error) };
  }
}

function lsBudgetBlockReason(health) {
  if (!enforceLsBudget || !includeHealth) return null;
  if (!health) return 'health_unavailable';
  if (health.ok === false) return `health_${health.status || 'failed'}`;
  if (requireNativeBridgeEnabled) {
    if (!health.nativeBridgeConfig) return 'native_bridge_config_unavailable';
    const cfg = health.nativeBridgeConfig;
    if (cfg.off) return 'native_bridge_off';
    if (!String(cfg.mode || '').trim()) return 'native_bridge_not_enabled';
  }
  const pool = health.lsPool?.pool;
  if (!pool || typeof pool !== 'object') return null;
  const busy = [];
  for (const key of ['activeRequests', 'maintenanceRequests', 'pending', 'reservedPendingStarts']) {
    const value = Number(pool[key] || 0);
    if (value > 0) busy.push(`${key}=${value}`);
  }
  if (busy.length) return `ls_busy:${busy.join(',')}`;
  if (pool.canStartNewNonDefault === false) return `ls_capacity:${pool.blockReason || 'cannot_start_non_default'}`;
  return null;
}

function assertLsBudgetAvailable(health) {
  const reason = lsBudgetBlockReason(health);
  if (!reason) return;
  throw smokeError(`preflight: LS budget unavailable (${reason}); refusing to run native bridge smoke against production capacity`, {
    reason,
    lsPool: health?.lsPool || null,
  });
}

function counterDelta(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = {};
  for (const key of keys) {
    const delta = Number(after?.[key] || 0) - Number(before?.[key] || 0);
    if (delta) out[key] = delta;
  }
  return out;
}

function nativeBridgeDecisionDelta(before, after) {
  const b = before?.nativeBridge || {};
  const a = after?.nativeBridge || {};
  const recent = Array.isArray(a.recentDecisions) ? a.recentDecisions.slice(-8) : [];
  return {
    decisions: Number(a.decisions || 0) - Number(b.decisions || 0),
    enabledDecisions: Number(a.enabledDecisions || 0) - Number(b.enabledDecisions || 0),
    disabledDecisions: Number(a.disabledDecisions || 0) - Number(b.disabledDecisions || 0),
    reasons: counterDelta(b.decisionReasons || {}, a.decisionReasons || {}),
    lastDecision: a.lastDecision || null,
    recentDecisions: recent.map(d => ({
      at: d.at,
      enabled: !!d.enabled,
      reason: d.reason || '',
      modelKey: d.modelKey || '',
      route: d.route || '',
      mappedTools: d.mappedTools || [],
      unmappedTools: d.unmappedTools || [],
      toolChoiceFiltered: !!d.toolChoiceFiltered,
    })),
  };
}

function readTailText(file, maxBytes = 2 * 1024 * 1024) {
  const stat = statSync(file);
  const size = stat.size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function summarizeWebFetchTraceDir(dir = protoTraceDir) {
  try {
    if (!includeProtoTraceSummary) return null;
    if (!dir || !existsSync(dir)) return { available: false, dir, reason: 'trace_dir_missing' };
    const files = readdirSync(dir)
      .filter(name => /GetCascadeTrajectorySteps.*\.jsonl$/i.test(name))
      .map(name => {
        const path = join(dir, name);
        const stat = statSync(path);
        return { name, path, mtimeMs: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 6);
    const stateCounts = {};
    const recent = [];
    let records = 0;
    let parseErrors = 0;
    for (const file of files) {
      const lines = readTailText(file.path).split('\n').filter(Boolean);
      for (const line of lines) {
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          parseErrors++;
          continue;
        }
        records++;
        const steps = rec?.semantic?.steps || [];
        for (const step of steps) {
          const trace = step?.webFetchTrace;
          if (!trace?.state) continue;
          stateCounts[trace.state] = (stateCounts[trace.state] || 0) + 1;
          recent.push({
            file: file.name,
            method: rec.method || '',
            direction: rec.direction || '',
            stepIndex: step.index,
            state: trace.state,
            stepType: trace.stepType,
            status: trace.status,
            hasRequestedInteraction: !!trace.hasRequestedInteraction,
            hasReadUrlOneof: !!trace.hasReadUrlOneof,
            hasWebDocument: !!trace.hasWebDocument,
            errorClassifications: trace.errorClassifications || {},
          });
        }
      }
    }
    return {
      available: true,
      dir,
      files: files.map(f => ({ name: f.name, size: f.size })),
      records,
      parseErrors,
      stateCounts,
      recent: recent.slice(-12),
    };
  } catch (error) {
    return { available: false, dir, reason: 'trace_summary_failed', error: String(error?.message || error) };
  }
}

const selected = expandScenarios(requestedScenarios);
if (!selected.length) {
  console.error(`No valid scenarios selected. Use one or more of: ${Object.keys(SCENARIOS).join(',')},all`);
  process.exit(2);
}

const results = {};
const failures = [];
const healthBefore = await fetchHealthSnapshot('before');
try {
  assertLsBudgetAvailable(healthBefore);
} catch (error) {
  failures.push(String(error?.message || error));
  results.preflight = resultFromError(error);
}
if (!failures.length) {
  for (const name of selected) {
    const scenario = SCENARIOS[name];
    results[name] = {};
    if (nonStreamEnabled) {
      try {
        results[name].nonStream = await runNonStream(name, scenario);
      } catch (error) {
        results[name].nonStream = resultFromError(error);
        failures.push(`${name} non-stream: ${String(error?.message || error)}`);
      }
    }
    if (streamEnabled) {
      try {
        results[name].stream = await runStream(name, scenario);
      } catch (error) {
        results[name].stream = resultFromError(error);
        failures.push(`${name} stream: ${String(error?.message || error)}`);
      }
    }
  }
}
const healthAfter = await fetchHealthSnapshot('after');
const protoTraceSummary = summarizeWebFetchTraceDir();

console.log(JSON.stringify({
  ok: failures.length === 0,
  baseUrl,
  model,
  marker,
  timeoutMs: requestTimeoutMs,
  smokeCwd,
  smokeFile,
  includeEnv,
  includeHealth,
  enforceLsBudget,
  requireNativeBridgeEnabled,
  requireNativeBridgeTool,
  validateToolArgs,
  streamEarlyTool,
  scenarios: selected,
  results,
  failures,
  nativeBridgeDecisionDelta: nativeBridgeDecisionDelta(healthBefore, healthAfter),
  protoTraceSummary,
  healthBefore,
  healthAfter,
}, null, 2));
if (failures.length && !noExitOnFailure) process.exit(1);
