import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { recordTokenUsage, getStats, resetStats } from '../src/dashboard/stats.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// B1 — the DEVIN_CONNECT request path (both non-stream toChatCompletion and the
// three streamChatCompletion sites) must feed recordTokenUsage, or the dashboard
// "Token 用量分布" card stays empty on connect-only deployments (homecloud showed
// tokenTotals all-zero / requests_with_usage:0 despite hundreds of requests,
// because only the cascade paths called recordTokenUsage).

describe('B1: recordTokenUsage accumulates a DEVIN_CONNECT usage shape', () => {
  it('maps OpenAI-style usage (prompt/completion + cache_read) into tokenTotals', () => {
    resetStats();
    // Shape returned by devin-connect-openai.js (ev.usage → body.usage / return.usage).
    recordTokenUsage({
      prompt_tokens: 120,
      completion_tokens: 45,
      prompt_tokens_details: { cached_tokens: 20 },
    });
    const tt = getStats().tokenTotals;
    assert.equal(tt.requests_with_usage, 1, 'a connect turn with usage must increment the counter');
    assert.equal(tt.cache_read, 20, 'cached_tokens → cache_read');
    assert.equal(tt.fresh_input, 100, 'fresh_input = prompt - cached (120-20)');
    assert.equal(tt.output, 45, 'completion_tokens → output');
    assert.equal(tt.total, 165, 'total = fresh + cacheR + cacheW + output');
    resetStats();
  });

  it('is a safe no-op on null/absent usage (the try/catch guard around it never needs to fire)', () => {
    resetStats();
    recordTokenUsage(null);
    recordTokenUsage(undefined);
    recordTokenUsage({});
    assert.equal(getStats().tokenTotals.requests_with_usage, 0, 'no usage → no counter bump, no throw');
    resetStats();
  });
});

describe('B1: the DEVIN_CONNECT paths are actually wired to recordTokenUsage', () => {
  // Source-level invariant (chat.js connect handler is not unit-drivable without a
  // full pool + mocked upstream; same source-assertion convention as
  // http-cache-control.test.js). Guards against the wiring being dropped again.
  const chat = readFileSync(join(REPO_ROOT, 'src/handlers/chat.js'), 'utf-8');

  it('non-stream connect choke point records usage from r.out.body.usage', () => {
    assert.match(chat, /recordTokenUsage\(r\.out\?\.body\?\.usage\)/,
      'non-stream connect ok-path must feed recordTokenUsage');
  });

  it('all three streamChatCompletion sites capture and record the returned usage', () => {
    // The return value used to be discarded (`await streamChatCompletion(...)`);
    // now each is captured into _sr* and recorded.
    const matches = chat.match(/recordTokenUsage\(_sr\d?\?\.usage\)/g) || [];
    assert.ok(matches.length >= 3, `expected >=3 stream usage-record sites, found ${matches.length}`);
    // And ensure NO ok-return stream path discards the result (both the direct
    // `(params, send, connectMeta)` sites and the re-login `({...token}, …)` site
    // must capture into _sr* before finalize — a bare discard = token dist stays
    // empty on that path). Guard both call shapes.
    assert.doesNotMatch(chat, /await streamChatCompletion\([^;]*\);\n\s+finalizeConnectAccount\(a, \{ model: reqModelName, startTime: ccStart, err: null \}\);\n\s+return \{ kind: 'ok' \}/,
      'a streamChatCompletion result on any ok path must be captured (const _sr = …), not discarded');
    // Exactly three capture sites (main, transient-replay, re-login-replay).
    assert.equal(matches.length, 3, `expected exactly 3 stream capture sites, found ${matches.length}`);
  });
});
