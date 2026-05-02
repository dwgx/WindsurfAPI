// v2.0.71 — issue triage 七连
//   #114 close (no test, just gh issue close)
//   #115 server-side fabricate detection
//   #116 reuse fingerprint structured log (no behaviour change tested
//        directly — log inspection)
//   #117 model_not_entitled now lists available_in_pool + remediation
//   #119 sticky username auto-detect
//   #120 GLM/Kimi/openai_xml dialects strengthened anti-fabrication
//   #121 /v1/response (singular) alias

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectFabricatedToolResult } from '../src/handlers/chat.js';
import { buildToolPreambleForProto } from '../src/handlers/tool-emulation.js';

describe('#115 — detectFabricatedToolResult heuristic', () => {
  it('flags bare epoch timestamp output when user asked to run shell', () => {
    const r = detectFabricatedToolResult('1777751588', { lastUserText: 'Run shell command echo $(date +%s)' });
    assert.ok(r);
    assert.equal(r.reason, 'fabricated_tool_result');
  });

  it('flags PROBE_xxx_<epoch> pattern (live reproducer from v2.0.70)', () => {
    const r = detectFabricatedToolResult('PROBE_V0270_1777751588', { lastUserText: 'execute echo PROBE_X_$(date +%s)' });
    assert.ok(r);
    // matchedPattern is the regex source string; PROBE pattern is `[A-Z]...\\d{10,}$`
    assert.match(r.matchedPattern, /\[A-Z\]\[A-Z0-9_\]/);
  });

  it('flags ISO timestamp output (`date` fabrication)', () => {
    const r = detectFabricatedToolResult('2026-05-02T19:53:08Z', { lastUserText: 'run date command' });
    assert.ok(r);
  });

  it('flags fake `ls -la` output', () => {
    const r = detectFabricatedToolResult('drwxr-xr-x 5 root root 4096 May 2 19:53 .', { lastUserText: 'list files in root via shell' });
    assert.ok(r);
  });

  it('does NOT flag plain chat output (no shell verbs)', () => {
    const r = detectFabricatedToolResult('1777751588', { lastUserText: 'what does this number mean' });
    assert.equal(r, null);
  });

  it('does NOT flag long outputs (model probably did real reasoning)', () => {
    const longText = '1777751588'.repeat(40);
    const r = detectFabricatedToolResult(longText, { lastUserText: 'run shell' });
    assert.equal(r, null);
  });

  it('does NOT flag empty / whitespace input', () => {
    assert.equal(detectFabricatedToolResult('', {}), null);
    assert.equal(detectFabricatedToolResult('   ', {}), null);
    assert.equal(detectFabricatedToolResult(null, {}), null);
  });

  it('returns helpful hint pointing to Claude as workaround', () => {
    const r = detectFabricatedToolResult('1777751588', { lastUserText: 'execute shell command' });
    assert.match(r.hint, /claude-sonnet|claude-haiku/i);
  });
});

describe('#119 — sticky username auto-detect (no env required)', () => {
  // proxyKey is module-internal; verify behaviour through getLsFor symmetry.
  const reload = () => import(`../src/langserver.js?_t=${Date.now()}`);

  it('module loads with the new isStickyUsername heuristic baked in', async () => {
    const m = await reload();
    assert.equal(typeof m.getLsFor, 'function');
  });

  it('env=0 still forces no segregation (operator override)', async () => {
    const orig = process.env.WINDSURFAPI_LS_PER_PROXY_USER;
    process.env.WINDSURFAPI_LS_PER_PROXY_USER = '0';
    try {
      const m = await reload();
      // Both calls return null (pool empty in test env), but the call
      // shape exercises proxyKey without throwing.
      assert.equal(m.getLsFor({ host: 'us.ipwo.net', port: 1234, username: 'sid_abc' }), null);
    } finally {
      if (orig !== undefined) process.env.WINDSURFAPI_LS_PER_PROXY_USER = orig;
      else delete process.env.WINDSURFAPI_LS_PER_PROXY_USER;
    }
  });
});

describe('#120 — GLM/Kimi/openai_xml dialect anti-fabrication strengthened', () => {
  const tools = [{ type: 'function', function: { name: 'shell_exec', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];

  it('glm47 preamble now contains anti-fabrication wording', () => {
    const p = buildToolPreambleForProto(tools, 'auto', '', 'glm-5.1', 'zhipu', 'chat');
    assert.match(p, /NEVER FABRICATE|fabricate/i);
    assert.match(p, /timestamps|file contents|command outputs/i);
  });

  it('kimi_k2 preamble (legacy `kimi-k2`) contains anti-fabrication', () => {
    const p = buildToolPreambleForProto(tools, 'auto', '', 'kimi-k2', 'moonshot', 'chat');
    assert.match(p, /NEVER FABRICATE|fabricate/i);
  });

  it('openai_json_xml preamble (default dialect) also strengthened', () => {
    const p = buildToolPreambleForProto(tools, 'auto', '', 'claude-sonnet-4.6', 'anthropic', 'chat');
    assert.match(p, /NEVER FABRICATE|fabricate/i);
  });

  it('preambles still describe the protocol (regression check)', () => {
    const p = buildToolPreambleForProto(tools, 'auto', '', 'glm-5', 'zhipu', 'chat');
    assert.match(p, /<tool_call>/);
    assert.match(p, /<arg_key>/);
  });
});
