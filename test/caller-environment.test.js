import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCallerEnvironment } from '../src/handlers/chat.js';
import { buildToolPreambleForProto } from '../src/handlers/tool-emulation.js';

// Why these tests exist:
//
// Without environment lifting Opus on Cascade believes its workspace is
// /tmp/windsurf-workspace (the planner's authoritative prior) and issues
// LS / Read tool calls against that path even when Claude Code's `<env>`
// block in the request says cwd is /Users/<user>/IdeaProjects/<project>.
// The model then narrates the contents of an empty scratch dir back as
// if it were the user's project.
//
// extractCallerEnvironment lifts the canonical Claude Code `<env>` keys
// (Working directory, Is directory a git repo, Platform, OS Version) so
// buildToolPreambleForProto can emit them as authoritative environment
// facts at the very top of the proto-level tool_calling_section
// override — which IS authoritative to the upstream model and overrides
// the Cascade planner's workspace prior.

describe('extractCallerEnvironment', () => {
  it('lifts Claude Code <env> block from a system message', () => {
    const messages = [
      { role: 'system', content: 'You are Claude Code...\n\n<env>\nWorking directory: /Users/jaxyu/IdeaProjects/flux-panel\nIs directory a git repo: Yes\nPlatform: darwin\nOS Version: Darwin 24.0.0\nToday\'s date: 2026-04-25\n</env>\n\nMore instructions.' },
      { role: 'user', content: 'check the branches' },
    ];
    const result = extractCallerEnvironment(messages);
    assert.match(result, /- Working directory: \/Users\/jaxyu\/IdeaProjects\/flux-panel/);
    assert.match(result, /- Is the directory a git repo: Yes/);
    assert.match(result, /- Platform: darwin/);
    assert.match(result, /- OS version: Darwin 24\.0\.0/);
  });

  it('lifts cwd from a <system-reminder> embedded in a user message (Claude Code 2.x layout)', () => {
    const messages = [
      { role: 'system', content: 'You are Claude Code...' },
      { role: 'user', content: '<system-reminder>\nSkills available...\n\n<env>\nWorking directory: /home/dev/proj\n</env>\n</system-reminder>\n\nactual question here' },
    ];
    const result = extractCallerEnvironment(messages);
    assert.match(result, /- Working directory: \/home\/dev\/proj/);
  });

  it('handles content-block arrays (Anthropic-format text blocks)', () => {
    const messages = [
      { role: 'user', content: [
        { type: 'text', text: 'Working directory: /var/app' },
        { type: 'text', text: 'Platform: linux' },
      ]},
    ];
    const result = extractCallerEnvironment(messages);
    assert.match(result, /- Working directory: \/var\/app/);
    assert.match(result, /- Platform: linux/);
  });

  it('returns empty string when no env hints are present', () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hello' },
    ];
    assert.equal(extractCallerEnvironment(messages), '');
  });

  it('lifts cwd from Claude Code 2.1+ prose form (no key/value separator)', () => {
    // Real Claude Code v2.1.114 system prompt embeds cwd in prose, e.g.:
    //   "You are an interactive agent that helps users with software
    //    engineering tasks and the current working directory is /Users/.../proj."
    // The line-anchored key/value form does not match; we fall back to a
    // looser "current working directory is /path" pattern that requires the
    // captured slot to actually look like a path (`[/~]…`).
    const messages = [
      { role: 'system', content: 'You are an interactive agent that helps users with software engineering tasks and the current working directory is /Users/jaxyu/IdeaProjects/flux-panel. Match the user\'s language.' },
      { role: 'user', content: 'check the project' },
    ];
    const result = extractCallerEnvironment(messages);
    assert.match(result, /- Working directory: \/Users\/jaxyu\/IdeaProjects\/flux-panel/);
  });

  it('lifts cwd from prose form with backticks around the path', () => {
    const messages = [
      { role: 'system', content: 'The current working directory is `/Users/dev/proj`.' },
    ];
    assert.match(extractCallerEnvironment(messages), /- Working directory: \/Users\/dev\/proj/);
  });

  it('does not match abstract prose without an actual path', () => {
    // "the working directory you choose" / "the working directory in the
    // docs" never has a `/` or `~` in the captured slot, so the path-tail
    // guard rejects it.
    const messages = [
      { role: 'user', content: 'Note: the working directory you choose is up to you.' },
      { role: 'user', content: 'See the working directory in the docs.' },
    ];
    assert.equal(extractCallerEnvironment(messages), '');
  });

  it('takes the first occurrence per key (closest to system / earliest message)', () => {
    const messages = [
      { role: 'system', content: 'Working directory: /first' },
      { role: 'user', content: 'Working directory: /second' },
    ];
    assert.match(extractCallerEnvironment(messages), /\/first/);
  });

  it('rejects values that are control-character noise or our own redaction marker', () => {
    const messages = [
      { role: 'system', content: 'Working directory: …' },
    ];
    assert.equal(extractCallerEnvironment(messages), '');
  });

  it('handles non-array input safely', () => {
    assert.equal(extractCallerEnvironment(null), '');
    assert.equal(extractCallerEnvironment(undefined), '');
    assert.equal(extractCallerEnvironment('not an array'), '');
  });
});

describe('buildToolPreambleForProto with environment override', () => {
  const tools = [{ type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object' } } }];

  it('emits an authoritative environment block before the protocol header when env is provided', () => {
    const env = '- Working directory: /Users/jaxyu/IdeaProjects/flux-panel\n- Platform: darwin';
    const out = buildToolPreambleForProto(tools, 'auto', env);
    // Env block must come BEFORE the protocol header
    const envIdx = out.indexOf('## Authoritative environment for this session');
    const headerIdx = out.indexOf('You have access to the following functions');
    assert.ok(envIdx >= 0, 'env header must be present');
    assert.ok(headerIdx >= 0, 'protocol header must be present');
    assert.ok(envIdx < headerIdx, 'env block must come BEFORE the protocol header');
    assert.match(out, /\/Users\/jaxyu\/IdeaProjects\/flux-panel/);
    // Must explicitly tell the model to prefer THIS over any prior assumption
    assert.match(out, /Ignore any workspace path you may have inferred/i);
  });

  it('omits the environment block when env is empty (back-compat with PR #54 shape)', () => {
    const out = buildToolPreambleForProto(tools, 'auto', '');
    assert.ok(!out.includes('Authoritative environment'));
    // Tool protocol still rendered as before
    assert.match(out, /You have access to the following functions/);
    assert.match(out, /### Bash/);
  });

  it('omits the environment block when env is missing', () => {
    const out = buildToolPreambleForProto(tools, 'auto');
    assert.ok(!out.includes('Authoritative environment'));
    assert.match(out, /You have access to the following functions/);
  });

  it('still returns empty string when there are no tools (env alone is not enough to render)', () => {
    const out = buildToolPreambleForProto([], 'auto', '- Working directory: /x');
    assert.equal(out, '');
  });
});
