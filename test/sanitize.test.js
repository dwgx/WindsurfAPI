import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText, PathSanitizeStream, sanitizeToolCall } from '../src/sanitize.js';

const MARKER = '<workspace>';

// Leaked Windsurf paths are redacted to a short structural placeholder.
// The marker MUST be visibly intentional to humans/LLMs and MUST NOT look
// like a real absolute path — see sanitize.js header for the full marker
// history and why both shell-loop and prose-loop failure modes matter.

describe('sanitizeText', () => {
  it('redacts /tmp/windsurf-workspace paths', () => {
    assert.equal(sanitizeText('/tmp/windsurf-workspace/src/index.js'), MARKER);
  });

  it('redacts bare /tmp/windsurf-workspace', () => {
    assert.equal(sanitizeText('/tmp/windsurf-workspace'), MARKER);
  });

  it('redacts per-account workspace paths', () => {
    assert.equal(
      sanitizeText('/home/user/projects/workspace-abc12345/package.json'),
      MARKER
    );
  });

  it('redacts /opt/windsurf', () => {
    assert.equal(sanitizeText('/opt/windsurf/language_server'), MARKER);
  });

  it('leaves normal text unchanged', () => {
    const text = 'Hello, this is a normal response.';
    assert.equal(sanitizeText(text), text);
  });

  it('handles multiple patterns in one string', () => {
    const input = 'Editing /tmp/windsurf-workspace/a.js and /opt/windsurf/bin';
    const result = sanitizeText(input);
    assert.equal(result, `Editing ${MARKER} and ${MARKER}`);
  });

  // Issue #86 follow-up: oaskdosakdoakd reported `C:\home\user\projects\workspace-devinxse`
  // leaking despite the Unix-only regex catching `/home/user/projects/workspace-skxwsx01`.
  // The model (often GLM running on Windows clients) hallucinates Windows-prefixed
  // forms of the workspace path. Defensive: cover backslash, drive prefix, and
  // mixed separators.
  it('redacts Windows-style workspace path with C: drive prefix', () => {
    assert.equal(
      sanitizeText('C:\\home\\user\\projects\\workspace-devinxse\\src\\index.js'),
      MARKER
    );
  });

  it('redacts Windows-style workspace path with backslashes only', () => {
    assert.equal(
      sanitizeText('\\home\\user\\projects\\workspace-skxwsx01\\src\\index.js'),
      MARKER
    );
  });

  it('redacts mixed-separator workspace path (drive prefix + forward slashes)', () => {
    assert.equal(
      sanitizeText('C:\\home/user/projects/workspace-devinxse/src/index.js'),
      MARKER
    );
  });

  it('redacts lowercase-drive Windows workspace path', () => {
    assert.equal(
      sanitizeText('d:\\home\\user\\projects\\workspace-x12345\\file.txt'),
      MARKER
    );
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
    assert.equal(out + rest, `${MARKER} is here`);
  });

  it('handles path split across chunks', () => {
    const stream = new PathSanitizeStream();
    let result = '';
    result += stream.feed('Look at /tmp/windsurf');
    result += stream.feed('-workspace/config.yaml for details');
    result += stream.flush();
    assert.equal(result, `Look at ${MARKER} for details`);
  });

  it('handles partial prefix at buffer end', () => {
    const stream = new PathSanitizeStream();
    let result = '';
    result += stream.feed('path is /tmp/win');
    result += stream.feed('dsurf-workspace/x.js done');
    result += stream.flush();
    assert.equal(result, `path is ${MARKER} done`);
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
    assert.equal(result.argumentsJson, `{"path":"${MARKER}"}`);
  });

  it('sanitizes input object string values', () => {
    const tc = { name: 'Read', input: { file_path: '/home/user/projects/workspace-abc12345/src/x.ts' } };
    const result = sanitizeToolCall(tc);
    assert.equal(result.input.file_path, MARKER);
  });

  it('returns null/undefined unchanged', () => {
    assert.equal(sanitizeToolCall(null), null);
    assert.equal(sanitizeToolCall(undefined), undefined);
  });
});

describe('REDACTED_PATH marker shape (prose-loop regression)', () => {
  // The marker is emitted verbatim into model-facing text. It must be
  // visibly structural so a user who asks for the project path does not
  // mistake the redaction marker for a real one-character answer.
  const marker = sanitizeText('/tmp/windsurf-workspace');

  it('is distinguishable from a natural ellipsis', () => {
    assert.notEqual(marker, '…');
  });

  it('is wrapped in structural delimiters', () => {
    assert.match(marker, /^(<[^<>]+>|\([^()]+\)|\[[^\[\]]+\])$/);
  });

  it('stays terse', () => {
    assert.ok(marker.length < 16, `marker must stay short: got ${JSON.stringify(marker)}`);
  });

  it('is not absolute-path-shaped', () => {
    assert.ok(!marker.includes('/'), 'marker must not contain / (looks like a Unix path)');
    assert.ok(!marker.includes('\\'), 'marker must not contain \\ (looks like a Windows path)');
  });
});
