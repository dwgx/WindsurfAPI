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

  it('lifts Windows CWD from Claude Code 2.1.120 system-reminder form', () => {
    const messages = [
      { role: 'user', content: [
        { type: 'text', text: '<system-reminder>\nAs you answer the user, use this context:\n# currentWorkingDirectory\nCWD: D:\\Project\\WindsurfAPI\n</system-reminder>' },
        { type: 'text', text: 'Read package.json' },
      ] },
    ];
    const result = extractCallerEnvironment(messages);
    assert.match(result, /- Working directory: D:\\Project\\WindsurfAPI/);
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
      { role: 'system', content: 'Working directory: <workspace>' },
    ];
    assert.equal(extractCallerEnvironment(messages), '');
  });

  it('handles non-array input safely', () => {
    assert.equal(extractCallerEnvironment(null), '');
    assert.equal(extractCallerEnvironment(undefined), '');
    assert.equal(extractCallerEnvironment('not an array'), '');
  });

  // ───── #100 follow-up: bare-path fallback when no <env> block ─────
  describe('bare-path cwd fallback (#100)', () => {
    it('lifts a Windows path glued to Chinese text in the first user message', () => {
      // Real yunduobaba prompt — no <env>, no separator between path and CJK.
      const messages = [
        { role: 'user', content: 'C:\\Users\\renfei\\Downloads\\WindsurfAPI-master\\WindsurfAPI-master分析下这个项目' },
      ];
      const out = extractCallerEnvironment(messages);
      assert.equal(out, '- Working directory: C:\\Users\\renfei\\Downloads\\WindsurfAPI-master\\WindsurfAPI-master');
    });

    it('lifts a Unix path at the start of a user prompt', () => {
      const messages = [
        { role: 'user', content: '/home/user/projects/myproj 帮我分析' },
      ];
      assert.match(extractCallerEnvironment(messages), /\/home\/user\/projects\/myproj/);
    });

    it('lifts a Mac /Users path with no separator', () => {
      const messages = [
        { role: 'user', content: '/Users/jane/code/app please review' },
      ];
      assert.match(extractCallerEnvironment(messages), /\/Users\/jane\/code\/app/);
    });

    it('lifts a tilde path', () => {
      const messages = [
        { role: 'user', content: '~/dotfiles 看看这个' },
      ];
      assert.match(extractCallerEnvironment(messages), /~\/dotfiles/);
    });

    it('rejects a path that ends in a common file extension (single-file reference)', () => {
      const messages = [
        { role: 'user', content: 'C:\\Users\\me\\notes.md 解释这个文件' },
      ];
      // The file path is a target, not a cwd. Should not lift.
      assert.equal(extractCallerEnvironment(messages), '');
    });

    it('does NOT trigger when the canonical extractor already found cwd', () => {
      // Bare-path fallback is a last-resort. If <env> already gave us cwd we use that.
      const messages = [
        { role: 'system', content: 'Working directory: /Users/dev/proj' },
        { role: 'user', content: 'C:\\some\\windows\\path 分析' },
      ];
      const out = extractCallerEnvironment(messages);
      assert.match(out, /\/Users\/dev\/proj/);
      assert.doesNotMatch(out, /windows\\path/);
    });

    it('only scans the first user message (later assistant/tool replies do not count)', () => {
      const messages = [
        { role: 'user', content: 'no path here' },
        { role: 'assistant', content: 'I see C:\\some\\path in some logs' },
      ];
      assert.equal(extractCallerEnvironment(messages), '');
    });

    it('only scans the leading 200 chars of a user message (mid-prose paths skipped)', () => {
      const head = 'I have been wondering for a long time about a thing in the project that lives somewhere in my filesystem and I think it might be useful to look there. The path I have in mind is /home/user/proj but please confirm.';
      assert.ok(head.length > 200);
      const messages = [{ role: 'user', content: head }];
      // The path appears past char 200 → fallback should NOT trigger.
      assert.equal(extractCallerEnvironment(messages), '');
    });

    it('rejects too-short fragments like /a or C:\\', () => {
      assert.equal(extractCallerEnvironment([{ role: 'user', content: '/a please look' }]), '');
      assert.equal(extractCallerEnvironment([{ role: 'user', content: 'C:\\ open this' }]), '');
    });

    it('handles content-block array with a path in the first text block', () => {
      const messages = [
        { role: 'user', content: [
          { type: 'text', text: 'D:\\Project\\WindsurfAPI 你看一下' },
        ]},
      ];
      assert.match(extractCallerEnvironment(messages), /D:\\Project\\WindsurfAPI/);
    });

    // ───── #100 follow-up #2 (yunduobaba): Claude Code <system-reminder> wrappers ─────
    //
    // Claude Code's hooks inject one or more <system-reminder>...</system-reminder>
    // blocks at the very top of every user turn — frequently 1–5 KB
    // (skills list, available tools, MCP server hints, todo state). That
    // pushes the path the user actually typed past the 300-char head and
    // the original pass-1 scan misses it. Real reproduction from the
    // user's debug log: lastUser=len=14095 with the path at the very
    // start of the *user's* prose but buried under reminder wrappers.

    it('lifts a path from after a 1KB <system-reminder> block (the #100 follow-up bug)', () => {
      const reminder = '<system-reminder>' + 'x'.repeat(1000) + '</system-reminder>\n\n';
      const messages = [
        { role: 'user', content: reminder + 'C:\\Users\\renfei\\Downloads\\WindsurfAPI-master 分析下这个项目' },
      ];
      const out = extractCallerEnvironment(messages);
      assert.match(out, /C:\\Users\\renfei\\Downloads\\WindsurfAPI-master/,
        'path past 300 chars but at start of post-reminder content must lift');
    });

    it('lifts a path from after multiple stacked <system-reminder> blocks', () => {
      const r1 = '<system-reminder>' + 'a'.repeat(800) + '</system-reminder>';
      const r2 = '<system-reminder>' + 'b'.repeat(800) + '</system-reminder>';
      const r3 = '<system-reminder>' + 'c'.repeat(800) + '</system-reminder>';
      const messages = [
        { role: 'user', content: `${r1}\n${r2}\n${r3}\n\n/home/dev/myproj 帮我看下` },
      ];
      assert.match(extractCallerEnvironment(messages), /\/home\/dev\/myproj/);
    });

    it('does NOT match a path buried in prose after stripping reminders', () => {
      // Pass 2 must remain anchored — only paths at the start of the
      // unwrapped content count. A reminder followed by prose followed
      // by a path is still a mid-prose mention, not a cwd hint.
      const reminder = '<system-reminder>' + 'x'.repeat(500) + '</system-reminder>\n\n';
      const messages = [
        { role: 'user', content: reminder + 'I was wondering about /home/user/proj because something something' },
      ];
      assert.equal(extractCallerEnvironment(messages), '');
    });

    it('skips pass 2 entirely when no <system-reminder> wrapper is present', () => {
      // Cheap-out: if there's no reminder wrapper there's nothing to strip,
      // and the original pass-1 result already covers the case.
      const messages = [
        { role: 'user', content: 'just a question with no path and no reminder' },
      ];
      assert.equal(extractCallerEnvironment(messages), '');
    });
  });

  // ───── #106 / #107 (zhangzhang-bit): adjective-prefixed cwd + bullet fallback ─────
  //
  // Two real-world failure modes from a Claude Code 2.x system prompt:
  //
  //   (A) The canonical key is preceded by an adjective:
  //         "- Primary working directory: D:\Project\foo"
  //       The old regex only matched bare "Working directory" so this
  //       lifted as nothing.
  //
  //   (B) The system prompt mentions "current working directory" in
  //       prose first (no path adjacent), and the actual cwd appears
  //       later as a standalone bullet line. Old regex stopped at the
  //       first textual hit and returned empty.

  describe('Claude Code 2.x adjective + bullet cwd (#106 / #107)', () => {
    it('lifts cwd from "Primary working directory: ..." (Claude Code 2.x phrasing)', () => {
      const messages = [
        { role: 'system', content: '# Environment\nYou have been invoked in the following environment:\n - Primary working directory: D:\\Project\\WindsurfAPI\n - Is a git repository: true\n - Platform: win32\n' },
        { role: 'user', content: 'hi' },
      ];
      const out = extractCallerEnvironment(messages);
      assert.match(out, /- Working directory: D:\\Project\\WindsurfAPI/,
        'adjective-prefixed "Primary working directory" must lift');
      assert.match(out, /- Is the directory a git repo: true/,
        'Claude Code 2.x "Is a git repository" must also lift');
      assert.match(out, /- Platform: win32/);
    });

    it('lifts cwd via prose-then-bullet pattern (#107 zhangzhang-bit symptom)', () => {
      // 26 KB system prompt that says "...current working directory."
      // mid-prose with NO adjacent path, then has the actual cwd in a
      // bullet much later. Old regex would match the prose form first,
      // capture nothing, and return empty.
      const filler = 'lorem ipsum dolor sit amet '.repeat(200); // ~5 KB filler
      const sys = [
        'You are an interactive agent that helps users with software engineering tasks and the current working directory.',
        '',
        filler,
        '',
        '# Environment',
        ' - Primary working directory: D:\\Project\\foo',
        ' - Platform: win32',
      ].join('\n');
      const messages = [
        { role: 'system', content: sys },
        { role: 'user', content: 'analyze this' },
      ];
      assert.match(extractCallerEnvironment(messages), /- Working directory: D:\\Project\\foo/,
        'must skip the keyword-only prose mention and find the bulleted cwd later');
    });

    it('falls back to a standalone bullet path when no key/value pair exists', () => {
      // Custom agent emitting just a bullet list of paths with no
      // explicit "Working directory:" key. Last-resort scanForBulletCwdInSystem
      // should pick the first absolute-looking path.
      const messages = [
        { role: 'system', content: 'Environment facts:\n - D:\\Project\\foo\n - some other note' },
        { role: 'user', content: 'hi' },
      ];
      assert.match(extractCallerEnvironment(messages), /- Working directory: D:\\Project\\foo/);
    });

    it('bullet-fallback ignores file-extension paths and our redaction marker', () => {
      // A bullet pointing at a single file is not a cwd hint.
      const messages = [
        { role: 'system', content: 'Files of interest:\n - D:\\Project\\foo\\readme.md\n - <workspace>' },
        { role: 'user', content: 'hi' },
      ];
      assert.equal(extractCallerEnvironment(messages), '',
        'file-target bullets and the <workspace> redaction marker must not lift as cwd');
    });

    it('bullet-fallback only scans system messages (chat-mention paths do not count)', () => {
      const messages = [
        { role: 'system', content: 'no env here' },
        { role: 'user', content: 'I was browsing /home/dev/random earlier — unrelated' },
      ];
      assert.equal(extractCallerEnvironment(messages), '',
        'a path mentioned in a user chat message must not be promoted to cwd via the system-bullet fallback');
    });

    it('matches the canonical "Working directory" form as before (back-compat)', () => {
      const messages = [
        { role: 'system', content: '<env>\nWorking directory: /Users/jane/proj\n</env>' },
        { role: 'user', content: 'hi' },
      ];
      assert.match(extractCallerEnvironment(messages), /- Working directory: \/Users\/jane\/proj/);
    });
  });
});

describe('buildToolPreambleForProto with environment override', () => {
  const tools = [{ type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object' } } }];

  it('emits an authoritative environment block before the protocol header when env is provided', () => {
    const env = '- Working directory: /Users/jaxyu/IdeaProjects/flux-panel\n- Platform: darwin';
    const out = buildToolPreambleForProto(tools, 'auto', env);
    // Env block must come BEFORE the protocol header
    const envIdx = out.indexOf('## Environment facts');
    const headerIdx = out.indexOf('You have access to the following functions');
    assert.ok(envIdx >= 0, 'env header must be present');
    assert.ok(headerIdx >= 0, 'protocol header must be present');
    assert.ok(envIdx < headerIdx, 'env block must come BEFORE the protocol header');
    assert.match(out, /\/Users\/jaxyu\/IdeaProjects\/flux-panel/);
    assert.match(out, /active execution context/i);
    assert.doesNotMatch(out, /ignore|for this request only|---/i);
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
