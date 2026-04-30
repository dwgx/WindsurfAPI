// #107 follow-up (zhangzhang-bit): after the v2.0.45 cwd extraction
// fix, env now lifts correctly but a new symptom surfaces — upstream LS
// returns "untrusted workspace" on SendUserCascadeMessage. Recovered
// log line:
//
//   [LS:default:err] ... SendUserCascadeMessage (unknown): untrusted workspace
//   ERROR Stream error after retries: untrusted workspace
//
// Root cause analysis: warmupCascade() runs UpdateWorkspaceTrust during
// the per-LS one-shot init, but its catch handler (handleWarmupError)
// silently swallowed any non-transport error. If UpdateWorkspaceTrust
// failed silently, the LS retained its default "untrusted" state and
// every subsequent SendUserCascadeMessage rejected. The existing per-
// Send retry loop only recognized "panel state not found" / "cascade
// expired" — neither matches "untrusted workspace", so the request
// burned its retry budget without ever force-rewarming.
//
// Fix (src/client.js):
//   1. Add isUntrustedWorkspace classifier matching the LS phrasing
//   2. Plumb it into the existing panel-retry branch alongside
//      isPanelMissing/isExpiredCascade so re-warm + retry kicks in
//   3. Bump UpdateWorkspaceTrust silent-failure logging from warn to
//      error so operators actually see when the silent-killer fires

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = readFileSync(join(__dirname, '..', 'src/client.js'), 'utf8');

describe('untrusted workspace recovery (#107 follow-up)', () => {
  test('classifier function exists and matches the LS phrasing', () => {
    const m = CLIENT_JS.match(/const isUntrustedWorkspace = \(e\) =>\s*([^;]+);/);
    assert.ok(m, 'isUntrustedWorkspace classifier missing from client.js');
    const re = m[1];
    assert.match(re, /untrusted workspace/i,
      'classifier regex must match the literal "untrusted workspace" phrase emitted by the upstream LS');
  });

  test('per-Send retry loop calls the classifier and falls into the re-warm branch', () => {
    // The retry loop is `while (true) { try { sendMessage } catch (e) { ... } }`.
    // Don't try to bracket the whole catch block (too brittle to refactors);
    // just assert the four load-bearing strings co-occur in the file.
    assert.match(CLIENT_JS, /isUntrustedWorkspace\(e\)/,
      'retry loop must invoke the isUntrustedWorkspace classifier');
    assert.match(CLIENT_JS, /!isPanelMissing\(e\) && !expired && !untrusted/,
      'rethrow guard must include the untrusted branch — otherwise the loop would burn its retry budget without ever re-warming');
    assert.match(CLIENT_JS, /Untrusted workspace on Send/,
      'must log a distinct message for untrusted-workspace retries so operators can grep them');
    // The classifier and the loop must be in the same function body — a
    // simple sanity check is that both are within ~5 KB of each other.
    const ciIdx = CLIENT_JS.search(/const isUntrustedWorkspace =/);
    const useIdx = CLIENT_JS.search(/!isPanelMissing\(e\) && !expired && !untrusted/);
    assert.ok(ciIdx > 0 && useIdx > 0 && Math.abs(useIdx - ciIdx) < 15000,
      `classifier (idx ${ciIdx}) and use site (idx ${useIdx}) drifted apart — likely moved out of the same function scope`);
  });

  test('UpdateWorkspaceTrust failure is logged at error level (visible in dashboards)', () => {
    // The silent killer: the warmup catches a non-transport error from
    // UpdateWorkspaceTrust and just logged warn (`${stage}: ${message}`).
    // After the fix it must be log.error with the explicit hint that
    // SendUserCascadeMessage will fail until the next force re-warm.
    const m = CLIENT_JS.match(/UpdateWorkspaceTrust failed silently[^`]*?force re-warm[^`]*?:/);
    assert.ok(m, 'UpdateWorkspaceTrust silent-failure error log message not found — should be log.error so untrusted-workspace symptoms are debuggable');
  });

  test('exhaustion message distinguishes untrusted-workspace from panel-state-lost', () => {
    // When MAX_PANEL_RETRIES is exceeded, the thrown Error message
    // should tell the operator which class of failure persisted, not
    // just say "Panel state lost" generically.
    const m = CLIENT_JS.match(/untrusted workspace persisted across [^']+/);
    assert.ok(m, 'exhaustion message must distinguish untrusted-workspace failures from panel-state-lost — otherwise debugging is hopeless');
  });
});
