import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText, PathSanitizeStream, sanitizeToolCall } from '../src/sanitize.js';

// Leaked Windsurf paths are redacted to a single Unicode ellipsis (U+2026).
// The marker MUST contain no shell metacharacter and MUST NOT look like a
// path or identifier the model could re-use — see sanitize.js header for
// the full history (./tail, [internal], <redacted-path>, (internal path
// redacted), redacted internal path) and why each previous marker regressed.

describe('sanitizeText', () => {
  it('redacts /tmp/windsurf-workspace paths', () => {
    assert.equal(sanitizeText('/tmp/windsurf-workspace/src/index.js'), '…');
  });

  it('redacts bare /tmp/windsurf-workspace', () => {
    assert.equal(sanitizeText('/tmp/windsurf-workspace'), '…');
  });

  it('redacts per-account workspace paths', () => {
    assert.equal(
      sanitizeText('/home/user/projects/workspace-abc12345/package.json'),
      '…'
    );
  });

  it('redacts /opt/windsurf', () => {
    assert.equal(sanitizeText('/opt/windsurf/language_server'), '…');
  });

  it('leaves normal text unchanged', () => {
    const text = 'Hello, this is a normal response.';
    assert.equal(sanitizeText(text), text);
  });

  it('handles multiple patterns in one string', () => {
    const input = 'Editing /tmp/windsurf-workspace/a.js and /opt/windsurf/bin';
    const result = sanitizeText(input);
    assert.equal(result, 'Editing … and …');
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
    assert.equal(out + rest, '… is here');
  });

  it('handles path split across chunks', () => {
    const stream = new PathSanitizeStream();
    let result = '';
    result += stream.feed('Look at /tmp/windsurf');
    result += stream.feed('-workspace/config.yaml for details');
    result += stream.flush();
    assert.equal(result, 'Look at … for details');
  });

  it('handles partial prefix at buffer end', () => {
    const stream = new PathSanitizeStream();
    let result = '';
    result += stream.feed('path is /tmp/win');
    result += stream.feed('dsurf-workspace/x.js done');
    result += stream.flush();
    assert.equal(result, 'path is … done');
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
    assert.equal(result.argumentsJson, '{"path":"…"}');
  });

  it('sanitizes input object string values', () => {
    const tc = { name: 'Read', input: { file_path: '/home/user/projects/workspace-abc12345/src/x.ts' } };
    const result = sanitizeToolCall(tc);
    assert.equal(result.input.file_path, '…');
  });

  it('returns null/undefined unchanged', () => {
    assert.equal(sanitizeToolCall(null), null);
    assert.equal(sanitizeToolCall(undefined), undefined);
  });
});

describe('REDACTED_PATH marker shape (shell-safety + reuse-loop regression)', () => {
  // The marker is emitted verbatim into model-facing text. Models sometimes
  // echo it back inside a shell command (e.g. `cd <marker>`). The marker
  // must therefore satisfy two independent constraints:
  //   (a) Shell-safe: no character any mainstream shell parses specially,
  //       so a stray `cd <marker>` fails with a clean recoverable error.
  //   (b) Not path-shaped: no `/`, no `\`, no identifier-looking words.
  //       Otherwise the model reuses it as a real path on later turns and
  //       enters an ENOENT loop (issue history: ./tail, [internal],
  //       <redacted-path>, (internal path redacted), redacted internal
  //       path — every prose-shaped marker has regressed at least once).
  const marker = sanitizeText('/tmp/windsurf-workspace');

  it('contains no shell metacharacters', () => {
    const banned = /[()\[\]{}<>|&;$`\\"'*?]/;
    assert.ok(!banned.test(marker), `marker must not contain shell metachars: got ${JSON.stringify(marker)}`);
  });

  it('is not path-shaped', () => {
    assert.ok(!marker.includes('/'), 'marker must not contain / (looks like a Unix path)');
    assert.ok(!marker.includes('\\'), 'marker must not contain \\ (looks like a Windows path)');
  });

  it('is not identifier-shaped (no ASCII word characters)', () => {
    // Any ASCII letter sequence in the marker is a re-use risk: the model
    // sees "redacted"/"internal"/"path" as plausible directory or file
    // names and emits `cd <marker>` or `Read("<marker>")` on later turns.
    // The ellipsis (U+2026) contains zero ASCII word chars and reads as
    // "content omitted" universally, so the model never tries to use it
    // as a real argument.
    assert.ok(!/[A-Za-z0-9_]/.test(marker), `marker must contain no ASCII word chars (avoid identifier-shape reuse loop): got ${JSON.stringify(marker)}`);
  });
});
