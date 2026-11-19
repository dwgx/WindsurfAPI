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
    // Slice to the next `if (ccAcct)` rather than a fixed character count: the
    // off-branch notice added for O3 sits between the reuse log and that guard.
    const after = CHAT.slice(idx, CHAT.indexOf('if (ccAcct) {', idx));
    assert.match(
      after,
      /acct=\$\{ccAcct\?\.account\?\.id \|\| 'env-token'\}/,
      'the reuse log must append acct=<account id> (env-token fallback when no account is bound)',
    );
    assert.match(
      CHAT.slice(CHAT.indexOf('if (ccAcct) {', idx), CHAT.indexOf('if (ccAcct) {', idx) + 120),
      /connectParams\.token = ccAcct\.apiKey;/,
      'the ccAcct guard for connectParams.token must immediately follow the reuse log call',
    );
  });
});

// O3 (evidence/ClientSandboxes.md §5.3): the capture ran with DEVIN_CONNECT_SESSION_REUSE
// off (the default), so all 7 omp requests carried distinct random #16 session ids. The
// config is documented, but the handler only logged when reuse was ON — a default
// deployment had no way to see that every turn was a new upstream session.
describe('chat handler: the session-id source is observable either way', () => {
  it('the reuse-off branch logs the fresh-per-request source', () => {
    const idx = CHAT.indexOf('const connectSession = scopedSession && !__sHit ? resolveConnectSessionBinding');
    assert.ok(idx !== -1, 'the connect session resolution must exist');
    const block = CHAT.slice(idx, idx + 1800);
    assert.match(block, /session_id source=fresh-per-request/,
      'the off branch must say WHERE the session id came from');
    assert.match(block, /DEVIN_CONNECT_SESSION_REUSE/,
      'and name the switch an operator has to flip');
  });
});
