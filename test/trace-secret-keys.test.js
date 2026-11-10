// S5-P3: trace.js SECRET_KEYS had the same two gaps as the support-bundle list.
//
// The anchored alternation only fired on whole-name matches: `token` and
// `api_key` were covered, but `access_token`, `session_token`, `csrf_token`,
// `refreshToken`, `jwt`, `bearer`, `credential`, `sort_key`, `client_secret`
// and friends all persisted their values verbatim into 01-client-req.json —
// exactly the legs support-bundle then ships. OAuth account objects carry
// camelCase (idToken/refreshToken/accessToken), so the normalisation must
// cover case + hyphen + underscore + camel spellings, not just *_token.
//
// Same fixture discipline as trace-depth-redaction.test.js: the real
// traceClientRequest writes into a throwaway WINDSURFAPI_TRACE_DIR.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { traceClientRequest } from '../src/trace.js';

const ROOT = mkdtempSync(join(tmpdir(), 's5-secret-keys-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const ON = { WINDSURFAPI_TRACE: '1', WINDSURFAPI_TRACE_DIR: ROOT };

const HEX = 'deadbeefcafebabe0123456789abcdef0123456789abcdef01234567';
const UUIDV = '11111111-2222-4333-8444-555555555555';

function readLeg(traceId) {
  return readFileSync(join(ROOT, traceId, '01-client-req.json'), 'utf8');
}

describe('S5-P3: trace secret-key normalisation', () => {
  it('redacts *_token / *_key / *_secret / jwt / bearer / credential in every separator spelling', () => {
    const body = {
      headers: {
        csrf_token: HEX,
        session_token: HEX,
        'x-custom-token': HEX,
        '__RequestVerificationToken': HEX,
        'set-cookie': UUIDV,
        client_secret: HEX,
        private_key: HEX,
        jwt: UUIDV,
        credential: HEX,
        bearer: UUIDV,
        sort_key: HEX,
      },
      oauth: {
        // The spellings a persisted login/account object actually uses.
        accessToken: HEX,
        refreshToken: UUIDV,
        idToken: HEX,
        sessionKey: HEX,
        access_key: UUIDV,
      },
      nested: { inner: { 'X-SESSION-TOKEN': HEX, ApiKey: UUIDV } },
      benign: { requestId: 'r_1', model: 'swe-fixture', sort_keys: 'plural-stays', keystore: 'keystore-stays' },
    };
    traceClientRequest(body, { traceId: 's5-keys' }, ON);
    const written = readLeg('s5-keys');

    assert.equal(written.includes(HEX), false,
      `a hex credential value survived under a missed key name:\n${written.slice(0, 600)}`);
    assert.equal(written.includes(UUIDV), false,
      `a UUID credential value survived under a missed key name:\n${written.slice(0, 600)}`);

    // The values are redacted, not dropped — the [redacted:Nb] marker keeps the
    // byte-length hint the reader uses to size the lost credential.
    assert.match(written, /"csrf_token": "\[redacted:\d+b\]/);
    assert.match(written, /"accessToken": "\[redacted:\d+b\]/);

    // Non-secret lookalikes must not be claimed: a plural, and a word that ends
    // in a tail only as a substring mid-name.
    assert.match(written, /"sort_keys": "plural-stays"/);
    assert.match(written, /"keystore": "keystore-stays"/);
    assert.match(written, /"requestId": "r_1"/);
    assert.match(written, /"model": "swe-fixture"/);
  });

  it('does not mutate the caller body (control)', () => {
    const body = { headers: { csrf_token: HEX }, keep: 'v' };
    const before = JSON.stringify(body);
    traceClientRequest(body, { traceId: 's5-keys-nomut' }, ON);
    assert.equal(JSON.stringify(body), before);
  });
});
