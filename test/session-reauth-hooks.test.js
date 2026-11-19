// SessionReauth — the two wirings the state machine depends on, pinned.
//
// 1. The confirmation probe is reached ONLY from the terminal `kind:'dead'`
//    verdict (stream + non-stream), never from the per-401 arm in
//    finalizeConnectAccount. That placement is the whole "a single chat 401 must
//    not bench an account" rule; moving the call one arm up would silently
//    reinstate the bug.
// 2. Removing an account deletes its stored re-login credential, keyed by the
//    address it was stored under — not by the renameable display email.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  addAccountByKey,
  removeAccount,
  setAccountCredentialEmail,
  updateAccountLabel,
} from '../src/auth.js';
import {
  listCredentialEmails,
  storeCredential,
} from '../src/devin-connect-credentials.js';

const CHAT = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');

/** Body of one function, brace-sliced (same technique as the UI tests). */
function functionBody(src, signature) {
  const at = src.indexOf(signature);
  assert.notEqual(at, -1, `${signature} must exist`);
  // The parameter list may contain braces (destructured options), so walk its
  // parens first; the body starts at the next `{`.
  const parenOpen = src.indexOf('(', at);
  let parenDepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')' && --parenDepth === 0) { parenClose = i; break; }
  }
  assert.notEqual(parenClose, -1, `could not delimit the signature of ${signature}`);
  const open = src.indexOf('{', parenClose);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  assert.fail(`could not delimit ${signature}`);
}

describe('chat dead-verdict → requestReauthCheck wiring', () => {
  it('runs after both reportDeadToken call sites (stream + non-stream)', () => {
    const call = /requestReauthCheck\(acct\.id, \{ source: 'request' \}\)/g;
    const hits = [...CHAT.matchAll(call)];
    assert.equal(hits.length, 2, 'exactly the two terminal dead arms may probe');

    for (const hit of hits) {
      const before = CHAT.slice(Math.max(0, hit.index - 600), hit.index);
      assert.match(before, /reportDeadToken\(currentApiKeyForId\(acct\.id, acct\.apiKey\)\)/,
        'the probe must follow the dead-token verdict, not precede it');
    }
  });

  it('is NOT reachable from the per-401 arm in finalizeConnectAccount', () => {
    const body = functionBody(CHAT, 'export function finalizeConnectAccount(');
    assert.match(body, /err\.code === 'UNAUTHORIZED'/, 'the 401 arm still exists');
    assert.doesNotMatch(body, /requestReauthCheck/,
      'a chat 401 alone must never trigger the confirmation probe');
  });
});

describe('removeAccount deletes the stored credential', () => {
  const previousKey = process.env.DEVIN_CONNECT_CRED_KEY;
  const previousFile = process.env.DEVIN_CONNECT_CRED_FILE;
  let credFile = '';
  const created = new Set();

  function account(label) {
    const a = addAccountByKey(`devin-session-token$hooks-${randomUUID().slice(0, 8)}`, label);
    created.add(a.id);
    return a;
  }

  beforeEach(() => {
    credFile = join(tmpdir(), `windsurfapi-reauth-cred-${randomUUID()}.json`);
    process.env.DEVIN_CONNECT_CRED_FILE = credFile;
    process.env.DEVIN_CONNECT_CRED_KEY = 'session-reauth-hooks-test-key';
  });

  afterEach(() => {
    for (const id of created) removeAccount(id);
    created.clear();
    for (const path of [credFile, `${credFile}.lock`]) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
    if (previousKey === undefined) delete process.env.DEVIN_CONNECT_CRED_KEY;
    else process.env.DEVIN_CONNECT_CRED_KEY = previousKey;
    if (previousFile === undefined) delete process.env.DEVIN_CONNECT_CRED_FILE;
    else process.env.DEVIN_CONNECT_CRED_FILE = previousFile;
  });

  it('removes the password record bound to the account', () => {
    assert.equal(storeCredential('orphan@example.test', 'hunter2'), true);
    assert.deepEqual(listCredentialEmails(), ['orphan@example.test']);
    const a = account('orphan@example.test');
    setAccountCredentialEmail(a.id, 'orphan@example.test');
    assert.equal(removeAccount(a.id), true);
    created.delete(a.id);
    assert.deepEqual(listCredentialEmails(), [], 'a deleted account must not leave a decryptable password behind');
  });

  it('still finds the record after the row was renamed', () => {
    assert.equal(storeCredential('old@example.test', 'hunter2'), true);
    const a = account('old@example.test');
    setAccountCredentialEmail(a.id, 'old@example.test');
    updateAccountLabel(a.id, 'renamed@example.test');
    assert.equal(removeAccount(a.id), true);
    created.delete(a.id);
    assert.deepEqual(listCredentialEmails(), [],
      'the credential is keyed by the stored address, not the renameable display email');
  });

  it('leaves another account’s record alone', () => {
    assert.equal(storeCredential('keep@example.test', 'hunter2'), true);
    const a = account('drop@example.test');
    assert.equal(removeAccount(a.id), true);
    created.delete(a.id);
    assert.deepEqual(listCredentialEmails(), ['keep@example.test']);
  });

  it('does not guess a binding from the display label for an unverified row', () => {
    // A historical row with neither credentialEmail nor identityEmail has no
    // trustworthy store binding. Its label may even have been renamed to
    // another account's address; deleting by that label could remove a secret
    // this row does not own. Leave the unknown record in place.
    assert.equal(storeCredential('label-owner@example.test', 'hunter2'), true);
    const a = account('label-owner@example.test');
    assert.equal(removeAccount(a.id), true);
    created.delete(a.id);
    assert.deepEqual(listCredentialEmails(), ['label-owner@example.test'],
      'an unverified row must not delete a record by its display label');
  });
});
