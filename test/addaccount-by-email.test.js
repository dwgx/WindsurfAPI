// addAccountByEmail wiring + CheckUserLoginMethod empty-body fallback.
//
// Two regressions that surfaced together when dwgx tested email login on
// VPS 154.40.36.22 against three real accounts (Joshua/Susan/Barbara,
// 2026-04-29):
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
//    null so the call site falls back to /_devin-auth/connections.

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
    const m = AUTH_JS.match(/export async function addAccountByEmail\(email, password\)\s*\{([\s\S]+?)\n\}/);
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

  test('falsy-but-present hasPassword:false still throws ERR_NO_PASSWORD_SET (we did not over-relax)', () => {
    // Make sure the fix didn't accidentally silence the legitimate
    // "no password, sign in via Google" case. windsurfLogin still
    // throws when conn.method==='auth1' && !conn.hasPassword.
    const m = LOGIN_JS.match(/if \(conn\.method === 'auth1'\)[\s\S]+?if \(!conn\.hasPassword\)[\s\S]+?\}/);
    assert.ok(m, 'auth1 + !hasPassword branch removed or refactored');
    assert.match(m[0], /No password set/i,
      'must still surface the "No password set. Please log in with Google or GitHub." friendly error');
  });
});
