import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Issue #97 — sub2api and similar middlebox aggregators priority-cache
// proxy responses unless they see an explicit Cache-Control: no-store.
// no-cache (the prior value) only meant "revalidate before serving from
// cache" — some aggregators ignore that and return stale chunks for
// fresh requests. This regression test asserts every per-request
// response surface ships no-store.

function readSrc(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8');
}

describe('HTTP Cache-Control: no-store on per-request responses (issue #97)', () => {
  it('json() helper in server.js sets Cache-Control: no-store', () => {
    const src = readSrc('src/server.js');
    const helper = src.match(/function json\(res, status, body\) \{[\s\S]*?\n\}/);
    assert.ok(helper, 'json() helper not found');
    assert.match(helper[0], /'Cache-Control':\s*'no-store'/, 'json() must set Cache-Control: no-store');
    assert.doesNotMatch(helper[0], /'Cache-Control':\s*'no-cache'/, 'json() must not use no-cache (cacheable by spec)');
  });

  it('chat.js stream headers set Cache-Control: no-store', () => {
    const src = readSrc('src/handlers/chat.js');
    // Find the stream-header block (Content-Type: text/event-stream)
    const block = src.match(/'Content-Type':\s*'text\/event-stream',[\s\S]*?'X-Accel-Buffering':\s*'no'/);
    assert.ok(block, 'chat stream header block not found');
    assert.match(block[0], /'Cache-Control':\s*'no-store'/);
    assert.doesNotMatch(block[0], /'Cache-Control':\s*'no-cache'/);
  });

  it('messages.js stream headers set Cache-Control: no-store', () => {
    const src = readSrc('src/handlers/messages.js');
    const block = src.match(/'Content-Type':\s*'text\/event-stream',[\s\S]*?'X-Accel-Buffering':\s*'no'/);
    assert.ok(block, 'messages stream header block not found');
    assert.match(block[0], /'Cache-Control':\s*'no-store'/);
    assert.doesNotMatch(block[0], /'Cache-Control':\s*'no-cache'/);
  });

  it('responses.js stream headers set Cache-Control: no-store', () => {
    const src = readSrc('src/handlers/responses.js');
    const block = src.match(/'Content-Type':\s*'text\/event-stream',[\s\S]*?'X-Accel-Buffering':\s*'no'/);
    assert.ok(block, 'responses stream header block not found');
    assert.match(block[0], /'Cache-Control':\s*'no-store'/);
    assert.doesNotMatch(block[0], /'Cache-Control':\s*'no-cache'/);
  });

  it('json() actually emits Cache-Control: no-store on the wire', async () => {
    // Spin up the route handler with a fake req/res and capture writeHead.
    // Use a path that returns immediately without any account/auth state:
    // /v1/models hits handleModels() which is pure. We have to bypass the
    // API-key gate, but the simplest unit-level check is to import json
    // indirectly by exercising any code path that calls it.
    //
    // Easier: spin a mini http.createServer with the same json helper
    // signature and assert. But we can also just verify the writeHead
    // call shape from the source — already done above. Add a runtime
    // smoke test that imports the server module and triggers a no-auth
    // 401 against /v1/models, then inspects the response.
    const http = await import('node:http');
    const { startServer } = await import('../src/server.js');
    const { config } = await import('../src/config.js');
    // Bind to a random port and ensure auth is required so /v1/models 401s
    // through json() — we just need to see the response headers.
    const prevPort = config.port;
    const prevApiKey = config.apiKey;
    config.port = 0;
    config.apiKey = 'test-key-no-store';
    let server;
    try {
      server = startServer();
      await new Promise((resolve) => {
        const tries = setInterval(() => {
          const addr = server.address?.();
          if (addr && typeof addr === 'object') { clearInterval(tries); resolve(); }
        }, 10);
      });
      const port = server.address().port;
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/v1/models', method: 'GET' }, resolve);
        req.on('error', reject);
        req.end();
      });
      assert.equal(res.statusCode, 401, 'expected 401 without auth');
      assert.equal(res.headers['cache-control'], 'no-store',
        `expected Cache-Control: no-store, got: ${res.headers['cache-control']}`);
      // Drain
      await new Promise((resolve) => { res.on('data', () => {}); res.on('end', resolve); });
    } finally {
      config.port = prevPort;
      config.apiKey = prevApiKey;
      if (server) await new Promise((resolve) => server.close(resolve));
    }
  });
});
