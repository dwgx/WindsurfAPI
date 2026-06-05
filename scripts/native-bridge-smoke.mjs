#!/usr/bin/env node

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
};

const SCENARIOS = {
  Read: {
    tools: [TOOL.Read],
    choice: 'Read',
    prompt: `Use the Read tool exactly once for ${smokeFile} with limit 20. Marker: ${marker}. Do not answer in prose.`,
  },
  Bash: {
    tools: [TOOL.Bash],
    choice: 'Bash',
    prompt: `Use the Bash tool exactly once with command: printf ${marker}. Do not answer in prose.`,
  },
  Grep: {
    tools: [TOOL.Grep],
    choice: 'Grep',
    prompt: `Use the Grep tool exactly once with pattern "Proxy workspace placeholder", path ${smokeCwd}, glob README.md, and output_mode files_with_matches. Marker: ${marker}. Do not answer in prose.`,
  },
  Glob: {
    tools: [TOOL.Glob],
    choice: 'Glob',
    prompt: `Use the Glob tool exactly once with pattern README.md and path ${smokeCwd}. Marker: ${marker}. Do not answer in prose.`,
  },
  mixed: {
    tools: [TOOL.Read, TOOL.Bash, TOOL.Grep, TOOL.Glob],
    choice: null,
    prompt: `Choose exactly one appropriate tool from Read, Bash, Grep, Glob to inspect ${smokeFile} for ${marker}. Do not answer in prose.`,
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

function assertExpectedTool(calls, scenarioName, expected, diagnostic = null) {
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
  return { toolCalls: calls.length, names: assertExpectedTool(calls, name, scenario.choice || '', diagnostic), diagnostic };
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
    names: assertExpectedTool(calls, name, scenario.choice || '', diagnostic),
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
      lsPool: summarizeLsPool(json.lsPool),
    };
  } catch (error) {
    return { ok: false, label, error: String(error?.message || error) };
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
const healthAfter = await fetchHealthSnapshot('after');

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
  streamEarlyTool,
  scenarios: selected,
  results,
  failures,
  healthBefore,
  healthAfter,
}, null, 2));
if (failures.length && !noExitOnFailure) process.exit(1);
