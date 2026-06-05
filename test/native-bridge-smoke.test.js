import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

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
            mappedTools: 1,
            unmappedTools: 0,
            noToolCallResponses: healthHits - 1,
            requestedByTool: { Read: 1 },
            emittedByTool: {},
          },
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
});
