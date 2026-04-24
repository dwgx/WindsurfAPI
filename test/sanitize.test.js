import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText, PathSanitizeStream, sanitizeToolCall } from '../src/sanitize.js';

// Leaked Windsurf paths are redacted to the multi-word prose marker
// `redacted internal path`. The marker MUST contain no shell metacharacter
// — earlier `(internal path redacted)` broke zsh (glob-qualifier syntax on
// `(…)` → `unknown file attribute: i`). See sanitize.js header for the
// full history of markers that regressed.

describe('sanitizeText', () => {
  it('redacts /tmp/windsurf-workspace paths', () => {
    assert.equal(sanitizeText('/tmp/windsurf-workspace/src/index.js'), 'redacted internal path');
  });

  it('redacts bare /tmp/windsurf-workspace', () => {
    assert.equal(sanitizeText('/tmp/windsurf-workspace'), 'redacted internal path');
  });

  it('redacts per-account workspace paths', () => {
    assert.equal(
      sanitizeText('/home/user/projects/workspace-abc12345/package.json'),
      'redacted internal path'
    );
  });

  it('redacts /opt/windsurf', () => {
    assert.equal(sanitizeText('/opt/windsurf/language_server'), 'redacted internal path');
  });

  it('leaves normal text unchanged', () => {
    const text = 'Hello, this is a normal response.';
    assert.equal(sanitizeText(text), text);
  });

  it('handles multiple patterns in one string', () => {
    const input = 'Editing /tmp/windsurf-workspace/a.js and /opt/windsurf/bin';
    const result = sanitizeText(input);
    assert.equal(result, 'Editing redacted internal path and redacted internal path');
  });

  it('returns non-strings unchanged', () => {
    assert.equal(sanitizeText(null), null);
    assert.equal(sanitizeText(undefined), undefined);
    assert.equal(sanitizeText(''), '');
  });
});

describe('PathSanitizeStream', () => {
  it('sanitizes a complete path in one chunk', () => {
    const stream = new PathSanitizeStream();
    const out = stream.feed('/tmp/windsurf-workspace/file.js is here');
    const rest = stream.flush();
    assert.equal(out + rest, 'redacted internal path is here');
  });

  it('handles path split across chunks', () => {
    const stream = new PathSanitizeStream();
    let result = '';
    result += stream.feed('Look at /tmp/windsurf');
    result += stream.feed('-workspace/config.yaml for details');
    result += stream.flush();
    assert.equal(result, 'Look at redacted internal path for details');
  });

  it('handles partial prefix at buffer end', () => {
    const stream = new PathSanitizeStream();
    let result = '';
    result += stream.feed('path is /tmp/win');
    result += stream.feed('dsurf-workspace/x.js done');
    result += stream.flush();
    assert.equal(result, 'path is redacted internal path done');
  });

  it('flushes clean text immediately', () => {
    const stream = new PathSanitizeStream();
    const out = stream.feed('Hello world ');
    assert.equal(out, 'Hello world ');
  });
});

describe('sanitizeToolCall', () => {
  it('sanitizes argumentsJson paths', () => {
    const tc = { name: 'Read', argumentsJson: '{"path":"/tmp/windsurf-workspace/f.js"}' };
    const result = sanitizeToolCall(tc);
    assert.equal(result.argumentsJson, '{"path":"redacted internal path"}');
  });

  it('sanitizes input object string values', () => {
    const tc = { name: 'Read', input: { file_path: '/home/user/projects/workspace-abc12345/src/x.ts' } };
    const result = sanitizeToolCall(tc);
    assert.equal(result.input.file_path, 'redacted internal path');
  });

  it('returns null/undefined unchanged', () => {
    assert.equal(sanitizeToolCall(null), null);
    assert.equal(sanitizeToolCall(undefined), undefined);
  });
});

describe('REDACTED_PATH marker shape (shell-safety regression)', () => {
  // The marker is emitted verbatim into model-facing text. Models
  // sometimes echo it back inside a shell command (e.g. `cd <marker>`).
  // If the marker contains any character the shell parses specially, the
  // resulting command fails with a cryptic error instead of a clean
  // ENOENT / too-many-arguments, and the model derails (issue: zsh
  // `unknown file attribute: i` after parens redaction).
  const marker = sanitizeText('/tmp/windsurf-workspace');

  it('contains no shell metacharacters', () => {
    const banned = /[()\[\]{}<>|&;$`\\"'*?]/;
    assert.ok(!banned.test(marker), `marker must not contain shell metachars: got ${JSON.stringify(marker)}`);
  });

  it('is not shaped like a path or identifier (multi-word, no slashes, has spaces)', () => {
    assert.ok(!marker.includes('/'), 'marker must not contain / (looks like a path)');
    assert.ok(!marker.includes('\\'), 'marker must not contain \\ (looks like a Windows path)');
    assert.ok(marker.includes(' '), 'marker must contain whitespace so it cannot be a single identifier / file arg');
    assert.ok(marker.split(/\s+/).filter(Boolean).length >= 2, 'marker must be multi-word');
  });
});
