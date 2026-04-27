// Regression for issues #82 and #83 — `cachePolicy is not defined`.
//
// `streamResponse()` is a top-level helper, not a closure, so the
// `cachePolicy` declared inside `handleChatCompletions()` is invisible to
// it. v2.0.12 added prompt-caching wiring that referenced cachePolicy at
// three points inside streamResponse (TTL hint on pool checkin, usage body
// builder, retry-fallback pool restore) — without a corresponding declare,
// every successful stream and every retry threw `ReferenceError:
// cachePolicy is not defined` and Cherry Studio surfaced it as a partial
// response failure.
//
// This test reads the source statically and asserts that streamResponse
// declares cachePolicy from `deps` before any of those lines run. A future
// refactor that drops the declare or moves the references above it will
// fail here instead of in production.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Slice from `function streamResponse(` to the next top-level function
// declaration. Brace counting on a 2k-line file with template strings and
// nested closures is unreliable — boundary heuristics on top-level decls
// are good enough for a static guard.
function sliceStreamResponseBody(src) {
  const start = src.indexOf('\nfunction streamResponse(');
  if (start === -1) return null;
  const offsetsAfter = ['\nasync function ', '\nfunction ', '\nexport async function ', '\nexport function ']
    .map(marker => src.indexOf(marker, start + 5))
    .filter(idx => idx > 0);
  const end = offsetsAfter.length ? Math.min(...offsetsAfter) : src.length;
  return src.slice(start, end);
}

test('streamResponse declares cachePolicy before any reference (#82, #83)', () => {
  const src = readFileSync(join(root, 'src/handlers/chat.js'), 'utf8');
  const body = sliceStreamResponseBody(src);
  assert.ok(body, 'streamResponse function must exist');

  // Strip line and block comments so a stray `cachePolicy` mention in a
  // comment doesn't shadow the real first-use position.
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const lines = stripped.split('\n');
  const firstLineIdx = lines.findIndex(line => /\bcachePolicy\b/.test(line));
  assert.ok(firstLineIdx > -1, 'streamResponse must reference cachePolicy somewhere');
  assert.match(
    lines[firstLineIdx],
    /const\s+cachePolicy\s*=\s*deps\.cachePolicy/,
    'the first occurrence of cachePolicy in streamResponse must be the const declare from deps; any earlier use throws ReferenceError mid-stream',
  );
});

test('handleChatCompletions threads cachePolicy into streamResponse deps (#82, #83)', () => {
  const src = readFileSync(join(root, 'src/handlers/chat.js'), 'utf8');
  const callIdx = src.indexOf('return streamResponse(');
  assert.ok(callIdx > -1, 'handleChatCompletions must call streamResponse');

  let depth = 0;
  let endIdx = -1;
  for (let i = callIdx + 'return streamResponse'.length; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  assert.ok(endIdx > callIdx, 'streamResponse call must close on a matched paren');

  const callExpr = src.slice(callIdx, endIdx + 1);
  assert.match(
    callExpr,
    /cachePolicy/,
    'streamResponse call site must pass cachePolicy through deps so the helper can attribute prompt-caching usage and TTL hints',
  );
});

test('nonStreamResponse accepts cachePolicy parameter (#82, #83)', () => {
  const src = readFileSync(join(root, 'src/handlers/chat.js'), 'utf8');
  // Function declaration must include cachePolicy parameter — without it,
  // the buildUsageBody call inside throws ReferenceError on the
  // non-streaming branch the same way streamResponse used to crash.
  assert.match(
    src,
    /async function nonStreamResponse\([^)]*\bcachePolicy\s*=/,
    'nonStreamResponse must accept cachePolicy as an explicit parameter',
  );
  // Caller must pass cachePolicy as the trailing positional arg.
  assert.match(
    src,
    /await nonStreamResponse\([\s\S]+?wantJson,\s*cachePolicy,?\s*\)/,
    'handleChatCompletions must pass cachePolicy when invoking nonStreamResponse',
  );
});
