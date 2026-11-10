// safeLogValue: client-supplied strings must not be able to forge log records.
//
// Model names / selectors come straight off the request body and were
// interpolated raw into DEVIN_CONNECT log lines, so an authenticated caller could
// embed a newline plus a fake "[INFO] …" record, or ANSI escapes that rewrite an
// operator's terminal.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { safeLogValue } from '../src/log-safety.js';

describe('safeLogValue', () => {
  it('neutralizes a forged log record injected through a newline', () => {
    const out = safeLogValue('gpt-4\n[INFO] Account added: account=attacker');
    assert.equal(out.includes('\n'), false, 'no raw newline may survive');
    assert.ok(out.includes('[INFO]'), 'text is kept readable, only the control char goes');
  });

  it('neutralizes ANSI escape sequences', () => {
    const out = safeLogValue('gpt-4\u001b[31mRED\u001b[0m');
    assert.equal(out.includes('\u001b'), false, 'ESC must not reach the terminal');
  });

  it('strips C1 controls, DEL and NUL as well', () => {
    const raw = 'a\u0000b\u0085c\u007fd\u009fe';
    const out = safeLogValue(raw);
    assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(out), false,
      `control char survived: ${JSON.stringify(out)}`);
    assert.ok(out.startsWith('a') && out.endsWith('e'), 'surrounding text is preserved');
  });


  it('neutralizes U+2028/U+2029 line separators (forged-record class, L1-F3)', () => {
    const out = safeLogValue('line1' + String.fromCharCode(0x2028) + '[INFO] forged' + String.fromCharCode(0x2029) + 'more');
    assert.equal(/[\u2028\u2029]/.test(out), false, 'LS/PS survived: ' + JSON.stringify(out));
    assert.ok(out.includes('[INFO]'), 'text stays readable');
  });

  it('leaves ordinary model names untouched', () => {
    for (const name of ['claude-opus-4.8', 'gpt-5-6-sol-max', 'swe-1-6-slow', 'glm-5.2']) {
      assert.equal(safeLogValue(name), name);
    }
  });

  it('bounds the length so one request cannot flood a line', () => {
    assert.ok(safeLogValue('x'.repeat(5000)).length <= 121);
  });

  it('is inert on null / undefined instead of throwing', () => {
    assert.equal(safeLogValue(null), '');
    assert.equal(safeLogValue(undefined), '');
  });
});

describe('connect log sites sanitize the client-supplied model name', () => {
  it('no DEVIN_CONNECT log line interpolates reqModelName raw', () => {
    const src = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');
    const offenders = src.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /log\.(info|warn|error)\(`/.test(line))
      .filter(({ line }) => /\$\{reqModelName\}|\$\{reqModel\}/.test(line));
    assert.deepEqual(offenders.map(o => o.n), [],
      `these log lines interpolate the raw client model name: ${offenders.map(o => o.n).join(', ')}`);
  });

  it('no log call still uses printf-style %s (the logger never substitutes it)', () => {
    // config.js defines log.info as console.log('[INFO]', ...args) — the format
    // slot is taken by the level tag, so a '%s' in the message is emitted literally.
    for (const f of ['../src/caller-key.js', '../src/account/sticky-session.js', '../src/auth.js']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      assert.equal(/log\.(info|debug|warn|error)\(\s*['"`][^'"`]*%[sdifjoO]/.test(src), false,
        `${f} still has a printf-style log call`);
    }
  });
});
