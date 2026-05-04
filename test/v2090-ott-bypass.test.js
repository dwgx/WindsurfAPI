// v2.0.90 — #114 OTT bypass: Auth1 → PostAuth → sessionToken (no OTT,
// no Codeium register_user). Source-level invariants only — actual
// network behavior covered by scripts/probes/v2089-sessiontoken-as-apikey.mjs
// (proved Cascade gRPC accepts sessionToken as metadata.apiKey 4/4).

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loginSrc = readFileSync(
  join(__dirname, '..', 'src', 'dashboard', 'windsurf-login.js'),
  'utf8'
);

// Slice out the windsurfLoginViaAuth1 function body so we can assert on
// what it CALLS without false-positives from sibling functions
// (windsurfLoginViaFirebase still uses registerWithCodeium and that's
// OK — the firebase path is separate).
function extractViaAuth1Body() {
  const idx = loginSrc.indexOf('async function windsurfLoginViaAuth1(');
  assert.ok(idx >= 0, 'windsurfLoginViaAuth1 must exist');
  // Find matching closing brace by counting depth from first `{`.
  const open = loginSrc.indexOf('{', idx);
  let depth = 0;
  for (let i = open; i < loginSrc.length; i++) {
    if (loginSrc[i] === '{') depth++;
    else if (loginSrc[i] === '}') {
      depth--;
      if (depth === 0) return loginSrc.slice(idx, i + 1);
    }
  }
  throw new Error('windsurfLoginViaAuth1 body not closed');
}

describe('v2.0.90 OTT bypass (#114)', () => {
  const body = extractViaAuth1Body();

  test('windsurfLoginViaAuth1 no longer calls oneTimeTokenDualPath', () => {
    assert.ok(
      !/oneTimeTokenDualPath\s*\(/.test(body),
      'OTT call must be removed — upstream GetOneTimeAuthToken is broken (12/12 fail in matrix probe)'
    );
  });

  test('windsurfLoginViaAuth1 no longer calls registerWithCodeium', () => {
    assert.ok(
      !/registerWithCodeium\s*\(/.test(body),
      'codeium register_user step must be removed — depended on OTT authToken which is gone'
    );
  });

  test('windsurfLoginViaAuth1 no longer references ERR_TOKEN_FETCH_FAILED', () => {
    // That error was the OTT-fail surface; with OTT gone it can't fire.
    assert.ok(
      !/ERR_TOKEN_FETCH_FAILED/.test(body),
      'OTT-specific error code stale once OTT is gone'
    );
  });

  test('windsurfLoginViaAuth1 returns apiKey = sessionToken (the Devin path)', () => {
    // Either explicit `apiKey: sessionToken` or via a destructured local.
    assert.ok(
      /apiKey:\s*sessionToken\b/.test(body),
      'must wire sessionToken into the returned apiKey field — that is what Cascade gRPC accepts'
    );
  });

  test('windsurfLoginViaAuth1 still calls postAuthDualPath', () => {
    // PostAuth is still the step that produces the sessionToken — the
    // bypass collapses the chain but PostAuth itself remains.
    assert.ok(
      /postAuthDualPath\s*\(/.test(body),
      'PostAuth is the final upstream call; must still be invoked'
    );
  });

  test('Source still exports windsurfLogin (dispatcher unchanged)', () => {
    assert.ok(
      /export async function windsurfLogin\s*\(/.test(loginSrc),
      'public entry must remain'
    );
  });
});
