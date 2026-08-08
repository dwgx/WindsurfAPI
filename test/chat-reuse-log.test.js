// The DEVIN_CONNECT session-reuse log line must identify WHICH account served
// the resumed session (acct=<account id>), not just the session_id. This locks
// the log-line construction itself: the acct= tag lives in the same template
// literal as session_id=, and ccAcct is in scope at the call site (it is read
// immediately below to set connectParams.token).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT = readFileSync(join(__dirname, '..', 'src', 'handlers', 'chat.js'), 'utf8');

const REUSE_LOG = 'DEVIN_CONNECT session reuse active';

describe('chat handler: DEVIN_CONNECT reuse log carries the account', () => {
  it('the reuse log line appends acct= to the session_id interpolation', () => {
    const idx = CHAT.indexOf(REUSE_LOG);
    assert.ok(idx !== -1, 'the DEVIN_CONNECT reuse log line must exist');
    const line = CHAT.slice(idx, CHAT.indexOf('\n', idx));
    assert.match(line, /session_id=\$\{connectSessionId\}/, 'the log must carry session_id');
    assert.match(
      line,
      /acct=\$\{ccAcct\?\.account\?\.id \|\| 'env-token'\}/,
      'the log must append acct=<account id> (env-token fallback when no account is bound)',
    );
  });

  it('ccAcct is in scope at the reuse log call site (read right below for connectParams.token)', () => {
    const idx = CHAT.indexOf(REUSE_LOG);
    assert.ok(idx !== -1, 'the DEVIN_CONNECT reuse log line must exist');
    const after = CHAT.slice(idx, idx + 400);
    assert.match(
      after,
      /if \(ccAcct\) \{[\s\S]*connectParams\.token = ccAcct\.apiKey;/,
      'the ccAcct guard for connectParams.token must immediately follow the reuse log call',
    );
  });
});
