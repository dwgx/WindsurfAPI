import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const smokeScript = readFileSync(join(root, 'scripts', 'native-bridge-smoke.mjs'), 'utf8');

function runNodeScript(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function withMockServer(handler, fn) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

describe('native bridge smoke CLI', () => {
  it('keeps web smoke scenarios explicit instead of adding them to all', () => {
    assert.match(smokeScript, /WebSearch: fnTool\('WebSearch'/);
    assert.match(smokeScript, /WebFetch: fnTool\('WebFetch'/);
    assert.match(smokeScript, /if \(name === 'all'\) out\.push\('Read', 'Bash', 'Grep', 'Glob', 'mixed'\)/);
    assert.doesNotMatch(smokeScript, /if \(name === 'all'\) out\.push\([^)]*WebSearch/);
    assert.doesNotMatch(smokeScript, /if \(name === 'all'\) out\.push\([^)]*WebFetch/);
  });

  it('refuses to run scenarios when native bridge is not enabled', async () => {
    let healthHits = 0;
    let chatHits = 0;
    await withMockServer((req, res) => {
      if (req.url?.startsWith('/health')) {
        healthHits++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          version: 'test-version',
          commit: 'test-commit',
          accounts: { total: 1, active: 1, error: 0 },
          nativeBridge: { requests: 0, emittedByTool: {}, byCascadeKind: {} },
          nativeBridgeConfig: {
            mode: '',
            off: false,
            tools: [],
            models: [],
            hasApiKeyGate: false,
            hasAccountGate: false,
            hasRawConfig: false,
          },
          lsPool: {
            running: true,
            pool: {
              activeRequests: 0,
              maintenanceRequests: 0,
              pending: 0,
              reservedPendingStarts: 0,
              canStartNewNonDefault: true,
            },
          },
        }));
        return;
      }

      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        chatHits++;
        req.resume();
        res.writeHead(500);
        res.end('chat should not be called');
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (baseUrl) => {
      const result = await runNodeScript(join(root, 'scripts', 'native-bridge-smoke.mjs'), {
        API_KEY: 'test-key',
        BASE_URL: baseUrl,
        MODEL: 'claude-test',
        NATIVE_BRIDGE_SMOKE_TOOLS: 'Bash',
        NATIVE_BRIDGE_SMOKE_STREAM: '1',
        NATIVE_BRIDGE_SMOKE_NON_STREAM: '0',
        NATIVE_BRIDGE_SMOKE_NO_EXIT_ON_FAILURE: '1',
        NATIVE_BRIDGE_SMOKE_TIMEOUT_MS: '5000',
      });

      assert.equal(result.code, 0, result.stderr);
      assert.equal(chatHits, 0);
      assert.equal(healthHits, 2);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, false);
      assert.equal(json.requireNativeBridgeEnabled, true);
      assert.match(json.results.preflight.diagnostic.reason, /native_bridge_not_enabled/);
    });
  });

  it('summarizes WebFetch proto trace states without raw URLs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-smoke-trace-'));
    try {
      writeFileSync(join(dir, 'ls-proto-123-GetCascadeTrajectorySteps.jsonl'), [
        JSON.stringify({
          method: 'GetCascadeTrajectorySteps',
          direction: 'response',
          semantic: {
            steps: [{
              index: 0,
              webFetchTrace: {
                state: 'pending_permission',
                stepType: 40,
                status: 2,
                hasRequestedInteraction: true,
                hasReadUrlOneof: false,
                hasWebDocument: false,
              },
            }, {
              index: 1,
              webFetchTrace: {
                state: 'completed_web_document',
                stepType: 40,
                status: 3,
                hasRequestedInteraction: false,
                hasReadUrlOneof: true,
                hasWebDocument: true,
              },
            }],
          },
        }),
      ].join('\n') + '\n');

      await withMockServer((req, res) => {
        if (req.url?.startsWith('/health')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            version: 'test-version',
            commit: 'test-commit',
            accounts: { total: 1, active: 1, error: 0 },
            nativeBridge: { requests: 0, emittedByTool: {}, byCascadeKind: {} },
            nativeBridgeConfig: { mode: '', off: false },
            lsPool: {
              running: true,
              pool: {
                activeRequests: 0,
                maintenanceRequests: 0,
                pending: 0,
                reservedPendingStarts: 0,
                canStartNewNonDefault: true,
              },
            },
          }));
          return;
        }

        res.writeHead(404);
        res.end();
      }, async (baseUrl) => {
        const result = await runNodeScript(join(root, 'scripts', 'native-bridge-smoke.mjs'), {
          API_KEY: 'test-key',
          BASE_URL: baseUrl,
          MODEL: 'claude-test',
          NATIVE_BRIDGE_SMOKE_TOOLS: 'WebFetch',
          NATIVE_BRIDGE_SMOKE_STREAM: '1',
          NATIVE_BRIDGE_SMOKE_NON_STREAM: '0',
          NATIVE_BRIDGE_SMOKE_NO_EXIT_ON_FAILURE: '1',
          NATIVE_BRIDGE_SMOKE_TIMEOUT_MS: '5000',
          NATIVE_BRIDGE_SMOKE_PROTO_TRACE_DIR: dir,
        });

        assert.equal(result.code, 0, result.stderr);
        const json = JSON.parse(result.stdout);
        assert.equal(json.ok, false);
        assert.equal(json.protoTraceSummary.available, true);
        assert.deepEqual(json.protoTraceSummary.stateCounts, {
          pending_permission: 1,
          completed_web_document: 1,
        });
        assert.equal(json.protoTraceSummary.recent.at(-1).state, 'completed_web_document');
        assert.doesNotMatch(result.stdout, /example\.com/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to run scenarios when LS budget preflight is busy', async () => {
    let healthHits = 0;
    let chatHits = 0;
    await withMockServer((req, res) => {
      if (req.url?.startsWith('/health')) {
        healthHits++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          version: 'test-version',
          commit: 'test-commit',
          accounts: { total: 1, active: 1, error: 0 },
          nativeBridge: { requests: 0, emittedByTool: {}, byCascadeKind: {} },
          nativeBridgeConfig: { mode: 'all_mapped', off: false },
          lsPool: {
            running: true,
            maxInstances: 2,
            totalRssBytes: 1234,
            pool: {
              size: 1,
              effectiveOccupancy: 1,
              pending: 0,
              reservedPendingStarts: 0,
              activeRequests: 1,
              maintenanceRequests: 0,
              nonDefaultInstances: 0,
              canStartNewNonDefault: true,
              blockReason: null,
            },
          },
        }));
        return;
      }

      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        chatHits++;
        req.resume();
        res.writeHead(500);
        res.end('chat should not be called');
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (baseUrl) => {
      const result = await runNodeScript(join(root, 'scripts', 'native-bridge-smoke.mjs'), {
        API_KEY: 'test-key',
        BASE_URL: baseUrl,
        MODEL: 'claude-test',
        NATIVE_BRIDGE_SMOKE_TOOLS: 'Bash',
        NATIVE_BRIDGE_SMOKE_STREAM: '1',
        NATIVE_BRIDGE_SMOKE_NON_STREAM: '0',
        NATIVE_BRIDGE_SMOKE_NO_EXIT_ON_FAILURE: '1',
        NATIVE_BRIDGE_SMOKE_TIMEOUT_MS: '5000',
      });

      assert.equal(result.code, 0, result.stderr);
      assert.equal(chatHits, 0);
      assert.equal(healthHits, 2);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, false);
      assert.equal(json.enforceLsBudget, true);
      assert.match(json.results.preflight.error, /LS budget unavailable/);
      assert.match(json.results.preflight.diagnostic.reason, /activeRequests=1/);
    });
  });

  it('prints health snapshots and response diagnostics when a stream has no tool_calls', async () => {
    let healthHits = 0;
    let chatHits = 0;
    await withMockServer((req, res) => {
      if (req.url?.startsWith('/health')) {
        healthHits++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          version: 'test-version',
          commit: 'test-commit',
          accounts: { total: 1, active: 1, error: 0 },
          nativeBridge: {
            requests: healthHits,
            decisions: healthHits,
            enabledDecisions: 0,
            disabledDecisions: healthHits,
            decisionReasons: { native_bridge_no_tool_call: healthHits },
            lastDecision: {
              at: new Date(1700000000000 + healthHits).toISOString(),
              enabled: false,
              reason: 'native_bridge_no_tool_call',
              modelKey: 'claude-test',
              route: 'chat',
              mappedTools: ['Read'],
              unmappedTools: [],
            },
            recentDecisions: [{
              at: new Date(1700000000000 + healthHits).toISOString(),
              enabled: false,
              reason: 'native_bridge_no_tool_call',
              modelKey: 'claude-test',
              route: 'chat',
              mappedTools: ['Read'],
              unmappedTools: [],
            }],
            mappedTools: 1,
            unmappedTools: 0,
            noToolCallResponses: healthHits - 1,
            requestedByTool: { Read: 1 },
            emittedByTool: {},
          },
          nativeBridgeConfig: { mode: 'all_mapped', off: false },
          lsPool: {
            running: true,
            maxInstances: 2,
            totalRssBytes: 1234,
            pool: {
              size: 1,
              effectiveOccupancy: 1,
              pending: 0,
              reservedPendingStarts: 0,
              activeRequests: 0,
              maintenanceRequests: 0,
              nonDefaultInstances: 0,
              canStartNewNonDefault: true,
              blockReason: null,
              memoryGuard: {
                enabled: true,
                availableBytes: 1000,
                minAvailableBytes: 500,
                reservedStarts: 0,
                okToSpawn: true,
                minAvailableBytesSource: 'test',
              },
            },
            admissionStats: { poolExhausted: 0, memoryGuardBlocks: 0 },
          },
        }));
        return;
      }

      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        chatHits++;
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"chatcmpl-mock","choices":[{"index":0,"delta":{"role":"assistant","content":"plain answer"},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"chatcmpl-mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }, async (baseUrl) => {
      const result = await runNodeScript(join(root, 'scripts', 'native-bridge-smoke.mjs'), {
        API_KEY: 'test-key',
        BASE_URL: baseUrl,
        MODEL: 'claude-test',
        NATIVE_BRIDGE_SMOKE_TOOLS: 'Read',
        NATIVE_BRIDGE_SMOKE_STREAM: '1',
        NATIVE_BRIDGE_SMOKE_NON_STREAM: '0',
        NATIVE_BRIDGE_SMOKE_NO_EXIT_ON_FAILURE: '1',
        NATIVE_BRIDGE_SMOKE_EARLY_TOOL: '0',
        NATIVE_BRIDGE_SMOKE_TIMEOUT_MS: '5000',
      });

      assert.equal(result.code, 0, result.stderr);
      assert.equal(chatHits, 1);
      assert.equal(healthHits, 2);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, false);
      assert.equal(json.healthBefore.nativeBridge.requests, 1);
      assert.equal(json.healthAfter.nativeBridge.noToolCallResponses, 1);
      assert.deepEqual(json.nativeBridgeDecisionDelta.reasons, { native_bridge_no_tool_call: 1 });
      assert.equal(json.nativeBridgeDecisionDelta.disabledDecisions, 1);
      assert.equal(json.nativeBridgeDecisionDelta.lastDecision.reason, 'native_bridge_no_tool_call');
      assert.equal(json.healthAfter.lsPool.pool.canStartNewNonDefault, true);
      const stream = json.results.Read.stream;
      assert.equal(stream.ok, false);
      assert.match(stream.error, /produced no tool_calls/);
      assert.equal(stream.diagnostic.frameCount, 3);
      assert.deepEqual(stream.diagnostic.finishReasons, ['stop']);
      assert.equal(stream.diagnostic.contentPreview, 'plain answer');
      assert.deepEqual(stream.diagnostic.usage, {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
      });
    });
  });

  it('does not count NLU recovery tool calls as native bridge success by default', async () => {
    await withMockServer((req, res) => {
      if (req.url?.startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          version: 'test-version',
          commit: 'test-commit',
          accounts: { total: 1, active: 1, error: 0 },
          nativeBridge: { requests: 1, emittedByTool: {}, byCascadeKind: {} },
          nativeBridgeConfig: { mode: 'all_mapped', off: false },
          lsPool: { running: true, pool: {}, memoryGuard: {} },
        }));
        return;
      }

      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"chatcmpl-mock","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"chatcmpl-mock","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"nlu_0_mock","type":"function","function":{"name":"Glob","arguments":"{\\"pattern\\":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (baseUrl) => {
      const result = await runNodeScript(join(root, 'scripts', 'native-bridge-smoke.mjs'), {
        API_KEY: 'test-key',
        BASE_URL: baseUrl,
        MODEL: 'claude-test',
        NATIVE_BRIDGE_SMOKE_TOOLS: 'Glob',
        NATIVE_BRIDGE_SMOKE_STREAM: '1',
        NATIVE_BRIDGE_SMOKE_NON_STREAM: '0',
        NATIVE_BRIDGE_SMOKE_NO_EXIT_ON_FAILURE: '1',
        NATIVE_BRIDGE_SMOKE_EARLY_TOOL: '0',
        NATIVE_BRIDGE_SMOKE_TIMEOUT_MS: '5000',
      });

      assert.equal(result.code, 0, result.stderr);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, false);
      const stream = json.results.Glob.stream;
      assert.match(stream.error, /no native bridge tool_call/);
      assert.deepEqual(stream.diagnostic.toolCallNames, ['Glob']);
      assert.deepEqual(stream.diagnostic.toolCallSources, ['nlu_recovery']);
    });
  });

  it('rejects native bridge tool calls with degraded smoke arguments by default', async () => {
    await withMockServer((req, res) => {
      if (req.url?.startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          version: 'test-version',
          commit: 'test-commit',
          accounts: { total: 1, active: 1, error: 0 },
          nativeBridge: { requests: 1, emittedByTool: { Glob: 1 }, byCascadeKind: { list_directory: 1 } },
          nativeBridgeConfig: { mode: 'all_mapped', off: false },
          lsPool: { running: true, pool: {}, memoryGuard: {} },
        }));
        return;
      }

      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"chatcmpl-mock","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"chatcmpl-mock","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"native:list_directory:3","type":"function","function":{"name":"Glob","arguments":"{\\"pattern\\":\\"*\\",\\"path\\":\\"/tmp/workspace\\"}"}}]},"finish_reason":null}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (baseUrl) => {
      const result = await runNodeScript(join(root, 'scripts', 'native-bridge-smoke.mjs'), {
        API_KEY: 'test-key',
        BASE_URL: baseUrl,
        MODEL: 'claude-test',
        NATIVE_BRIDGE_SMOKE_TOOLS: 'Glob',
        NATIVE_BRIDGE_SMOKE_STREAM: '1',
        NATIVE_BRIDGE_SMOKE_NON_STREAM: '0',
        NATIVE_BRIDGE_SMOKE_NO_EXIT_ON_FAILURE: '1',
        NATIVE_BRIDGE_SMOKE_EARLY_TOOL: '0',
        NATIVE_BRIDGE_SMOKE_TIMEOUT_MS: '5000',
      });

      assert.equal(result.code, 0, result.stderr);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, false);
      assert.equal(json.validateToolArgs, true);
      const stream = json.results.Glob.stream;
      assert.match(stream.error, /arguments did not match/);
      assert.deepEqual(stream.diagnostic.toolCallSources, ['cascade_native']);
      assert.deepEqual(stream.diagnostic.toolCallArguments, [{ pattern: '*', path: '/tmp/workspace' }]);
    });
  });

  it('diagnoses Read calls that only return the workspace redaction marker', async () => {
    await withMockServer((req, res) => {
      if (req.url?.startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          version: 'test-version',
          commit: 'test-commit',
          accounts: { total: 1, active: 1, error: 0 },
          nativeBridge: { requests: 1, emittedByTool: { Read: 1 }, byCascadeKind: { view_file: 1 } },
          nativeBridgeConfig: { mode: 'all_mapped', off: false },
          lsPool: { running: true, pool: {}, memoryGuard: {} },
        }));
        return;
      }

      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"chatcmpl-mock","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"chatcmpl-mock","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"native:view_file:1","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":\\"<workspace>\\",\\"limit\\":20}"}}]},"finish_reason":null}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(404);
      res.end();
    }, async (baseUrl) => {
      const result = await runNodeScript(join(root, 'scripts', 'native-bridge-smoke.mjs'), {
        API_KEY: 'test-key',
        BASE_URL: baseUrl,
        MODEL: 'claude-test',
        NATIVE_BRIDGE_SMOKE_TOOLS: 'Read',
        NATIVE_BRIDGE_SMOKE_STREAM: '1',
        NATIVE_BRIDGE_SMOKE_NON_STREAM: '0',
        NATIVE_BRIDGE_SMOKE_NO_EXIT_ON_FAILURE: '1',
        NATIVE_BRIDGE_SMOKE_EARLY_TOOL: '0',
        NATIVE_BRIDGE_SMOKE_TIMEOUT_MS: '5000',
      });

      assert.equal(result.code, 0, result.stderr);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, false);
      const stream = json.results.Read.stream;
      assert.match(stream.error, /workspace redaction marker/);
      assert.deepEqual(stream.diagnostic.toolCallSources, ['cascade_native']);
      assert.deepEqual(stream.diagnostic.toolCallArguments, [{ file_path: '<workspace>', limit: 20 }]);
      assert.equal(stream.diagnostic.toolCallArgumentMeta[0].fields.file_path.redactedWorkspacePath, true);
      assert.equal(stream.diagnostic.toolCallArgumentMeta[0].issues[0].reason, 'redacted_workspace_path');
      assert.match(stream.diagnostic.argumentValidationIssues[0], /redaction marker/);
    });
  });
});
