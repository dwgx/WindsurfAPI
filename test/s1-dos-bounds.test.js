// S1 audit — input-driven algorithmic complexity in the chat env/repair paths.
//
// Each case below is synchronous CPU work on caller- or upstream-controlled
// text; while it runs, every other request on the process is stopped. The
// pre-fix shapes were quadratic (or worse): a ~4× cost increase per input
// doubling, measured by THIS test file on the pre-fix tree (Node 24, this
// machine):
//
//   512 KiB of unterminated `<system-reminder` opens          2,173 ms
//   128 KiB unbroken [A-Za-z0-9._-] run (bare path regex)      9,785 ms
//   256 KiB unbroken [A-Za-z0-9._-] run (bare path regex)     44,625 ms
//   210_000-char run + path tail (same regex, full window)    29,294 ms
//   64 KiB of '{' (extractJsonPayload balanced scan)           6,240 ms
//   256 KiB of '{' (extractJsonPayload balanced scan)        110,638 ms
//   512 KiB negated clauses (maskNonActionableRegions)         7,334 ms
//
// These are PERMANENT regression tests, in the spirit of
// identity-neutralize-complexity.test.js: the bounds sit ~10–40× above the
// measured fixed cost and far below the quadratic behaviour, so they fail
// loudly if an unbounded scan returns without being flaky on a slower box.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  extractCallerEnvironment,
  repairToolCallArguments,
  structuredOutputViolation,
} from '../src/handlers/chat.js';

const KIB = 1024;

/** Build exactly `bytes` chars by repeating `unit` (and slicing the tail). */
const fill = (unit, bytes) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

// ---------------------------------------------------------------------------
// Finding 1 — scanUserMessageForBareCwd pass 2.
//
// `content.replace(/<system-reminder\b[\s\S]*?<\/system-reminder>\s*/gi, '')`
// ran on the WHOLE user message. Every `<system-reminder` open tag with no
// closer makes the lazy `[\s\S]*?` re-search the entire tail — K opens on an
// n-char message is O(K×n): 512 KiB of bare opens took ~2.1 s; 2 MiB ≈ 33 s.
// The strip must stay linear at any input size.
// ---------------------------------------------------------------------------
describe('bare-cwd scan — <system-reminder> strip stays linear', () => {
  it('512 KiB of unterminated opens: under 500 ms (was ~2.2 s)', () => {
    const content = fill('<system-reminder ', 512 * KIB);
    const started = performance.now();
    const out = extractCallerEnvironment([{ role: 'user', content }]);
    const ms = performance.now() - started;
    assert.equal(out, '', 'no cwd inside a wall of unterminated tags');
    assert.ok(ms < 500, `took ${ms.toFixed(1)} ms, bound is 500 ms; the regex strip was O(K×n)`);
  });

  it('still finds the cwd after real reminder blocks (regression)', () => {
    const content = '<system-reminder>hook noise</system-reminder>\n'
      + '<system-reminder>more</system-reminder>'
      + 'D:\\proj\\x analyze this';
    assert.match(extractCallerEnvironment([{ role: 'user', content }]),
      /- Working directory: D:\\proj\\x/);
  });

  it('an unterminated reminder keeps its tail verbatim — nothing is scanned past it', () => {
    const content = '<system-reminder>closed</system-reminder>'
      + '<system-reminder>unterminated D:\\proj\\y';
    assert.equal(extractCallerEnvironment([{ role: 'user', content }]), '');
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — repairToolCallArguments fed untruncated user text into
// maskNonActionableRegions (intent-extractor.js:192-225). The mask rebuilds
// the string once per fenced block and once per negated clause — K regions on
// an n-char text is O(K×n): 512 KiB of short negated clauses took ~7.3 s.
// The two NLU entry points already cap at 200_000 for exactly this reason
// (intent-extractor.js:450, :493); the repair path takes the same bound.
// ---------------------------------------------------------------------------
describe('bash prefix repair — user text is capped before masking', () => {
  const bashTc = cmd => ({ name: 'bash', argumentsJson: JSON.stringify({ command: cmd }) });
  const servedCommand = (tc, messages) =>
    JSON.parse(repairToolCallArguments(tc, messages).argumentsJson).command;

  it('a command mention past 200_000 chars is out of the repair window', () => {
    const user = 'x'.repeat(200_000) + '\nrun `deploy --app --force now`';
    assert.equal(
      servedCommand(bashTc('deploy --app'), [{ role: 'user', content: user }]),
      'deploy --app',
      "the model's command must not be rewritten from text beyond the bound",
    );
  });

  it('a command inside the window still completes the prefix', () => {
    const user = 'please run `deploy --app --force now`\n' + 'x'.repeat(210_000);
    assert.equal(
      servedCommand(bashTc('deploy --app'), [{ role: 'user', content: user }]),
      'deploy --app --force now',
    );
  });

  it('a negated command inside the window stays masked', () => {
    const user = 'never run `deploy --app --force now`';
    assert.equal(
      servedCommand(bashTc('deploy --app'), [{ role: 'user', content: user }]),
      'deploy --app',
    );
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — extractRequestedReadPath ran its bare-path matchAll on the full
// last user message. The second alternative
//   [A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)*\.[A-Za-z0-9]{1,12}
// is O(n²) on a long unbroken run of [A-Za-z0-9._-] characters — the `+`
// re-tries every split before the mandatory `\.ext` — and such runs are not
// exotic: a pasted token, hash or base64 blob in the last user turn stalled
// the event loop for seconds on every read-repair. The scan now caps the
// text window AND the per-segment match length.
// ---------------------------------------------------------------------------
describe('requested read path — unbroken token runs cannot stall the scan', () => {
  // file_path = the workspace ROOT, so internalWorkspaceTail returns '' and
  // the repair falls through to extractRequestedReadPath(messages).
  const readTc = { name: 'read_file', argumentsJson: JSON.stringify({ file_path: '/tmp/windsurf-workspace' }) };
  const repairedPath = (tc, messages) =>
    JSON.parse(repairToolCallArguments(tc, messages).argumentsJson).file_path;

  it('128 KiB unbroken [A-Za-z0-9._-] run: under 400 ms (was ~9.8 s)', () => {
    const started = performance.now();
    const out = repairedPath(readTc, [{ role: 'user', content: 'a'.repeat(128 * KIB) }]);
    const ms = performance.now() - started;
    assert.equal(out, '/tmp/windsurf-workspace', 'no path found — the call is unchanged');
    assert.ok(ms < 400, `took ${ms.toFixed(1)} ms, bound is 400 ms`);
  });

  it('256 KiB unbroken run: under 500 ms (was ~44.6 s)', () => {
    const started = performance.now();
    const out = repairedPath(readTc, [{ role: 'user', content: 'b'.repeat(256 * KIB) }]);
    const ms = performance.now() - started;
    assert.equal(out, '/tmp/windsurf-workspace');
    assert.ok(ms < 500, `took ${ms.toFixed(1)} ms, bound is 500 ms`);
  });

  it('still returns the path the user named', () => {
    const user = 'please read /home/dev/notes.txt and summarize it';
    assert.equal(repairedPath(readTc, [{ role: 'user', content: user }]), '/home/dev/notes.txt');
  });

  it('a path mention past the capped window is out of scope', () => {
    const user = 'x'.repeat(210_000) + ' read /home/dev/notes.txt';
    assert.equal(
      repairedPath(readTc, [{ role: 'user', content: user }]),
      '/tmp/windsurf-workspace',
      'the repair window is bounded — text beyond it is not a repair source',
    );
  });
});

// ---------------------------------------------------------------------------
// Finding 4 — extractJsonPayload re-ran its balanced {...}/[...] scan from
// EVERY '{' or '[' start: O(starts × length), plus a JSON.parse per closed
// candidate. 64 KiB of '{' took ~4 s, 256 KiB ≈ 64 s. The scan is budgeted:
// at most 512 starts and 4 MiB of cumulative inner scanning, then it falls
// back to the trimmed text — the same answer an exhausted scan returns.
// ---------------------------------------------------------------------------
describe('extractJsonPayload — the balanced-block scan is budgeted', () => {
  const OBJECT = { type: 'object' };

  it('64 KiB of bare opens: under 500 ms (was ~6.2 s)', () => {
    const started = performance.now();
    const v = structuredOutputViolation('{'.repeat(64 * KIB), OBJECT);
    const ms = performance.now() - started;
    assert.equal(v?.message, 'the response is not valid JSON');
    assert.ok(ms < 500, `took ${ms.toFixed(1)} ms, bound is 500 ms`);
  });

  it('256 KiB of bare opens: under 500 ms (was ~110.6 s)', () => {
    const started = performance.now();
    structuredOutputViolation('{'.repeat(256 * KIB), OBJECT);
    const ms = performance.now() - started;
    assert.ok(ms < 500, `took ${ms.toFixed(1)} ms, bound is 500 ms`);
  });

  it('valid JSON inside prose is still extracted', () => {
    assert.equal(structuredOutputViolation('here is the answer {"ok":true} — done', OBJECT), null);
  });

  it('falls back once the start budget (512) is exceeded', () => {
    // 600 bare opens then a valid object: the object is start #601 and is
    // never scanned, so the whole text is the fallback — not valid JSON.
    const text = '{'.repeat(600) + '{"ok":true}';
    assert.equal(structuredOutputViolation(text, OBJECT)?.message, 'the response is not valid JSON');
  });

  it('falls back once the scan-byte budget (4 MiB) is exceeded', () => {
    // 20_000 opens: ~64 chars scanned per start drains 4 MiB around start
    // ~210 — well before the object at start 20_000 is ever reached.
    const text = '{'.repeat(20_000) + '{"ok":true}';
    assert.equal(structuredOutputViolation(text, OBJECT)?.message, 'the response is not valid JSON');
  });
});
