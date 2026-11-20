// addAccountByEmail wiring + CheckUserLoginMethod empty-body fallback.
//
// Two regressions that surfaced together when email login was tested on
// a lab host against three real accounts (2026-04-29):
//
// 1. src/auth.js `addAccountByEmail` had been stubbed to throw
//    `"Direct email/password login is not supported"`. The dashboard had
//    a fully-working windsurfLogin pipeline next door, but the
//    /auth/login HTTP path called the stub instead. Result: every
//    {email,password} POST to /auth/login was a hard 401 even though
//    Windsurf upstream still served the credentials fine.
//
// 2. The new Connect-RPC probe `CheckUserLoginMethod` (added 2026-04-26
//    when Windsurf moved off /_devin-auth/connections as primary)
//    sometimes returns an empty `{}` for valid emails on cold-start
//    Vercel edges. The original code defaulted absent fields to false
//    and reported `{method:'auth1', hasPassword:false}`, which surfaced
//    as `ERR_NO_PASSWORD_SET` for accounts that DO have passwords.
//    Fix: when both `userExists` and `hasPassword` are missing, return
//    null so the caller does not guess.
//    Update (2026-10-22): the probe ORDER was inverted — `/_devin-auth/
//    connections` is now primary (its `auth_method.has_password` is what
//    windsurf.com itself branches on) and CheckUserLoginMethod is enrichment
//    only. An empty `{}` is still "unknown", never "password-capable".

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_JS = readFileSync(join(__dirname, '..', 'src/auth.js'), 'utf8');
const LOGIN_JS = readFileSync(join(__dirname, '..', 'src/dashboard/windsurf-login.js'), 'utf8');

describe('addAccountByEmail wiring (#follow-up)', () => {
  test('addAccountByEmail no longer throws the stub error', () => {
    // The stub used to be the entire body. If it's still there as the
    // first statement, the function is broken regardless of what else
    // ends up in the file.
    const stubLine = 'throw new Error(\'Direct email/password login is not supported';
    const m = AUTH_JS.match(/export async function addAccountByEmail\(email, password, opts = \{\}\)\s*\{([\s\S]+?)\n\}/);
    assert.ok(m, 'addAccountByEmail signature/body not found');
    const body = m[1];
    assert.ok(!body.trim().startsWith(stubLine),
      'addAccountByEmail still throws the unsupported-stub error as its first statement');
  });

  test('addAccountByEmail delegates to windsurfLogin from the dashboard module', () => {
    const m = AUTH_JS.match(/export async function addAccountByEmail[\s\S]+?\n\}/);
    assert.ok(m);
    const body = m[0];
    assert.match(body, /windsurfLogin/,
      'must call windsurfLogin (the live email→Codeium pipeline)');
    assert.match(body, /addAccountByKey\(/,
      'must persist the resulting apiKey via addAccountByKey');
    assert.match(body, /setAccountTokens\(/,
      'must persist Firebase refreshToken via setAccountTokens so background renewal works');
    assert.match(body, /opts\?\.storeCredential === true/,
      'retention must require the explicit per-operation opt-in');
    assert.match(body, /if \(wantStore\)/,
      'the credential store must only run behind the consent branch');
  });

  test('addAccountByEmail rejects empty email or password before hitting upstream', () => {
    const m = AUTH_JS.match(/export async function addAccountByEmail[\s\S]+?\n\}/);
    assert.ok(m);
    const body = m[0];
    assert.match(body, /if \(!email \|\| !password\)/,
      'must short-circuit on missing credentials so we never POST {email:"",password:""} to Windsurf');
  });

  test('addAccountByEmail updates an existing email instead of duplicating the account', () => {
    const m = AUTH_JS.match(/export async function addAccountByEmail[\s\S]+?\n\}/);
    assert.ok(m);
    const body = m[0];
    assert.match(body, /existingByEmail/,
      'must look up an existing account by normalized email before adding a new one');
    assert.match(body, /existingByEmail \|\| addAccountByKey\(/,
      'must reuse the existing email account instead of always appending');
    assert.match(body, /account\.apiKey = result\.apiKey/,
      'must refresh the existing account apiKey after re-login');
  });
});

describe('CheckUserLoginMethod empty-body fallback (#follow-up)', () => {
  test('fetchCheckUserLoginMethod returns null when both userExists and hasPassword are missing', () => {
    // Static-validate the guard. The bug was: `{}` body → `userExists`
    // is undefined → not strictly === false → fell through to
    // {method:'auth1', hasPassword:!!undefined} = {auth1, false}.
    const m = LOGIN_JS.match(/async function fetchCheckUserLoginMethod[\s\S]+?\n\}/);
    assert.ok(m, 'fetchCheckUserLoginMethod not found');
    const body = m[0];
    assert.match(body, /hasOwnProperty\.call\(res\.data, 'userExists'\)/,
      'must explicitly check whether userExists field is present (not just truthy)');
    assert.match(body, /hasOwnProperty\.call\(res\.data, 'hasPassword'\)/,
      'must explicitly check whether hasPassword field is present');
    assert.match(body, /if \(!hasUserField && !hasPwField\)[\s\S]{0,200}return null/,
      'when neither field is present, must return null so caller falls back to /_devin-auth/connections');
  });

  test('falsy-but-present has_password:false is a terminal, non-lockout "no password" answer', () => {
    // The fix must not accidentally silence the legitimate "no password, sign
    // in with an emailed code / OAuth" case. windsurfLogin still stops on a
    // positive hasPassword:false — before any password attempt.
    const m = LOGIN_JS.match(/if \(probe\.hasPassword === false\)[\s\S]+?\n  \}/);
    assert.ok(m, 'hasPassword:false terminal branch removed or refactored');
    // The error must still make clear this is a no-password / OAuth account
    // (it now points users at the email code / OAuth / token instead of the
    // old wording).
    assert.match(m[0], /noPasswordError\(probe\)/,
      'must keep the dedicated no-password error helper');
    assert.match(LOGIN_JS, /code\s*=\s*'ERR_NO_PASSWORD_OAUTH_ACCOUNT'/,
      'the helper must keep the dedicated no-password error code');
    assert.match(m[0], /no password|OAuth|email/i,
      'must still surface a clear "this account has no password" friendly error');
    assert.match(LOGIN_JS, /method\s*=\s*probe\.emailCode \? 'email_code' : 'oauth'/,
      'must tell the caller which method actually works');
    // v3: a no-password result is a WRONG-METHOD signal, not a brute-force
    // guess — it must NOT feed the email lockout (that locked users for using
    // the wrong login tab). Assert the branch does not record a failure.
    assert.doesNotMatch(m[0], /recordEmailFailure/,
      'no_password must not count toward the email lockout');
    // And it must never reach the password endpoints.
    assert.doesNotMatch(m[0], /windsurfLoginViaAuth1\(|windsurfLoginViaFirebase\(/,
      'no_password must not attempt a password login');
  });
});
