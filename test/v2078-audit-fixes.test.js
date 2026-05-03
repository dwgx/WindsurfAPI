// v2.0.78 — strict audit follow-up (4 HIGH).
//
//   H-1: sanitize must strip <workspace_information> /
//        <workspace_layout> / <user_information> XML blocks (zhangzhang
//        #108 reproducer).
//   H-2: NLU multi-layer placeholder + article-led prose rejection.
//   H-3: normalizeSystemPromptForHash capture-group fix for Current
//        time / cwd / Session ID lines (was a parse-time literal bug).
//   H-4: NLU Layer 3 skipped when structural markers (xml/fenced/
//        openai_native/bare_json) seen WITHOUT natural_lang marker —
//        prevents v2.0.77 regression where xml_tag-emitting Claude
//        models had garbage Layer 3 calls promoted.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText, PathSanitizeStream } from '../src/sanitize.js';
import { extractIntentFromNarrative } from '../src/handlers/intent-extractor.js';
import { fingerprintBefore } from '../src/conversation-pool.js';

describe('H-1 sanitize — workspace_information / workspace_layout / user_information', () => {
  it('strips a full <workspace_information> block', () => {
    const input = 'Hello\n<workspace_information>\n  <workspace_path>/home/user/projects/workspace-devinxse</workspace_path>\n  <workspace_layout>foo/bar.js</workspace_layout>\n</workspace_information>\nGoodbye';
    const out = sanitizeText(input);
    assert.ok(!out.includes('workspace_information'), `still contains tag: ${out}`);
    assert.ok(!out.includes('workspace-devinxse'), `still contains path: ${out}`);
    assert.ok(out.includes('Hello'));
    assert.ok(out.includes('Goodbye'));
  });

  it('strips a full <workspace_layout> block', () => {
    const input = 'A\n<workspace_layout>\nsrc/index.js\nsrc/foo.js\n</workspace_layout>\nB';
    const out = sanitizeText(input);
    assert.ok(!out.includes('workspace_layout'));
    assert.ok(out.includes('A') && out.includes('B'));
  });

  it('strips a full <user_information> block', () => {
    const input = 'Q <user_information>session_id=abc123\nemail=foo@bar.com</user_information> R';
    const out = sanitizeText(input);
    assert.ok(!out.includes('user_information'));
    assert.ok(!out.includes('foo@bar.com'));
    assert.ok(out.includes('Q') && out.includes('R'));
  });

  it('strips multiple sibling blocks in one pass', () => {
    const input = '<workspace_information>x</workspace_information><user_information>y</user_information>tail';
    const out = sanitizeText(input);
    assert.equal(out.trim(), 'tail');
  });

  it('PathSanitizeStream holds incomplete <workspace_information> across feeds', () => {
    const s = new PathSanitizeStream();
    const c1 = s.feed('safe text <workspace_inform');
    // Should NOT yet have emitted the prefix; held back.
    assert.ok(!c1.includes('workspace_inform'));
    assert.equal(c1, 'safe text ');
    const c2 = s.feed('ation>secret /home/user/projects/workspace-x stuff</workspace_information>tail');
    // Now the full block is closed and stripped, secret path gone.
    const combined = c1 + c2 + s.flush();
    assert.ok(!combined.includes('workspace_information'));
    assert.ok(!combined.includes('workspace-x'));
    assert.ok(combined.includes('tail'));
  });

  it('PathSanitizeStream holds an OPEN block with no close yet, then strips on close', () => {
    const s = new PathSanitizeStream();
    const c1 = s.feed('prefix <workspace_information>line one\nline two\n');
    assert.equal(c1, 'prefix '); // open block held
    const c2 = s.feed('</workspace_information>suffix');
    const combined = c1 + c2 + s.flush();
    assert.ok(!combined.includes('workspace_information'));
    assert.ok(combined.includes('prefix'));
    assert.ok(combined.includes('suffix'));
  });
});

describe('H-2 NLU placeholder + article-led prose rejection', () => {
  const fnTool = (name, props = { command: 'string' }, required = ['command']) => ({
    type: 'function',
    function: {
      name, description: `${name} description`,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])),
        required,
      },
    },
  });
  const SHELL = fnTool('shell_exec');
  const ACT = { lastUserText: 'run shell_exec to echo something' };

  it('rejects "a shell command." (article + noun)', () => {
    const r = extractIntentFromNarrative(
      'I should call the shell_exec function to run a shell command.',
      [SHELL], ACT,
    );
    assert.equal(r.length, 0);
  });

  it('rejects "the file" / "the specified file" / "your input"', () => {
    for (const v of ['the file', 'the specified file', 'your input', 'this command', 'an argument']) {
      const r = extractIntentFromNarrative(
        `I'll call shell_exec with command '${v}'`,
        [SHELL], ACT,
      );
      assert.equal(r.length, 0, `"${v}" should be rejected`);
    }
  });

  it('still accepts a real argument like "echo HELLO"', () => {
    const r = extractIntentFromNarrative(
      "I'll call shell_exec with command 'echo HELLO'",
      [SHELL], ACT,
    );
    assert.equal(r.length, 1);
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { command: 'echo HELLO' });
  });

  it('Layer 1 (explicit syntax) also rejects placeholder values', () => {
    const r = extractIntentFromNarrative(
      'shell_exec(command="command")',
      [SHELL], ACT,
    );
    assert.equal(r.length, 0);
  });

  it('Layer 2 (backtick) also rejects placeholder values', () => {
    const r = extractIntentFromNarrative(
      "I'll call `shell_exec` with command `the command`",
      [SHELL], ACT,
    );
    assert.equal(r.length, 0);
  });
});

describe('H-3 normalizeSystemPromptForHash — capture-group fix', () => {
  const buildMessages = (sys) => [
    { role: 'system', content: sys },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ];

  it('two systems differing only in cwd path hash to the same fingerprint', () => {
    const a = 'preamble\nWorking directory: /home/alice/proj\nrest';
    const b = 'preamble\nWorking directory: /home/bob/different\nrest';
    const fpA = fingerprintBefore(buildMessages(a), 'm', 'c');
    const fpB = fingerprintBefore(buildMessages(b), 'm', 'c');
    assert.equal(fpA, fpB);
  });

  it('Working directory: vs cwd: labels stay DISTINCT after normalize (label preserved)', () => {
    // Pre-fix bug: both labels collapsed to literal ' <cwd>', meaning
    // distinct sessions hashed identically. Post-fix: label is kept so
    // genuinely different label conventions remain separable.
    const a = 'preamble\nWorking directory: /x\nrest';
    const b = 'preamble\ncwd: /x\nrest';
    const fpA = fingerprintBefore(buildMessages(a), 'm', 'c');
    const fpB = fingerprintBefore(buildMessages(b), 'm', 'c');
    assert.notEqual(fpA, fpB, 'distinct labels must produce distinct fingerprints');
  });

  it('Current time: lines collapse but label is preserved', () => {
    const a = 'p\nCurrent time: 2026-05-03 14:23:01\nq';
    const b = 'p\nCurrent time: 2026-05-04 09:15:42\nq';
    const fpA = fingerprintBefore(buildMessages(a), 'm', 'c');
    const fpB = fingerprintBefore(buildMessages(b), 'm', 'c');
    assert.equal(fpA, fpB);
  });
});

describe('H-4 NLU Layer 3 skipped when xml_tag marker fires without natural_lang', () => {
  const fnTool = (name) => ({
    type: 'function',
    function: {
      name, description: `${name}`,
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  });
  const SHELL = fnTool('shell_exec');

  it('xml_tag marker → Layer 3 narrative skipped (Claude-style protocol)', () => {
    // Claude's tool_use uses <tool_call>...</tool_call> syntax. If the
    // parser saw the marker but couldn't lift a call, the surrounding
    // narrative is descriptive prose, not args.
    const text = `<tool_call>{"name":"shell_exec","arguments":{"command":"echo HELLO"}</tool_call>\nI was going to run a shell command first.`;
    const r = extractIntentFromNarrative(text, [SHELL], {
      lastUserText: 'run something',
      markers: ['xml_tag'],
    });
    assert.equal(r.length, 0);
  });

  it('bare_json marker → Layer 3 STILL runs (v2.0.79 narrowing — GLM/Kimi case)', () => {
    // GLM-4.7 / Kimi often emit JSON-shaped fragments in thinking
    // text (so bare_json marker fires) AND a real narrate elsewhere
    // ("I'll call shell_exec with command 'X'"). Layer 3 catches
    // that narrate — pre-v2.0.79 H-4 was over-blocking it.
    const text = `Sample: {"name":"shell_exec","arguments":{"command":"X"}}. I'll call shell_exec with command 'echo HELLO'.`;
    const r = extractIntentFromNarrative(text, [SHELL], {
      lastUserText: 'echo something',
      markers: ['bare_json'],
    });
    assert.equal(r.length, 1);
    assert.deepEqual(JSON.parse(r[0].argumentsJson), { command: 'echo HELLO' });
  });

  it('fenced_json marker → Layer 3 still runs', () => {
    const text = "```json\n{...}\n```\nI'll call shell_exec with command 'echo HELLO'.";
    const r = extractIntentFromNarrative(text, [SHELL], {
      lastUserText: 'echo something',
      markers: ['fenced_json'],
    });
    assert.equal(r.length, 1);
  });

  it('natural_lang marker present + xml_tag → Layer 3 STILL runs', () => {
    const text = `<tool_call>partial</tool_call> I'll call shell_exec with command 'echo HELLO'`;
    const r = extractIntentFromNarrative(text, [SHELL], {
      lastUserText: 'echo something',
      markers: ['xml_tag', 'natural_lang'],
    });
    assert.equal(r.length, 1);
  });

  it('no markers (default) → Layer 3 runs as before', () => {
    const text = `I'll call shell_exec with command 'echo HELLO'`;
    const r = extractIntentFromNarrative(text, [SHELL], { lastUserText: 'echo something' });
    assert.equal(r.length, 1);
  });
});
