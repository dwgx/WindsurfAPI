// S5-P2: the dashboard's inline-JS-string sinks used the wrong escaper.
//
// onclick="App.f('${value}')" is TWO nested contexts: the HTML attribute is
// decoded first, then the JS string is parsed. esc() — or the sketch's old
// escAttr(), which called esc() first and left its '.replace(/'/g, "\\'")'
// with no target — emits &#39;, which the attribute decode turns back into a
// live single quote: `a'); App.deleteAccount('victim` ran. escJsAttr() emits
// JS escapes (\', \x3c, \x26 …) so the attribute value carries no raw ' " < >
// & at all.
//
// This file pins the cluster end to end:
//   * index-sketch.html gained escJsAttr (same contract as index.html's) and
//     every one of its quoted handler interpolations routes through it or a
//     proven-safe local;
//   * index.html's OAuth fail-panel email + loadLsBinary sinks are fixed;
//   * index.html has no leftover call to the never-defined escAttr();
//   * auth.js updateAccountLabel stops a label from carrying control chars or
//     unbounded length into account.email in the first place.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { addAccountByKey, removeAccount, updateAccountLabel, sanitizeLabelText } from '../src/auth.js';

const SKETCH = readFileSync(new URL('../src/dashboard/index-sketch.html', import.meta.url), 'utf8');
const DASHBOARD = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

// Same shipped-source extraction as dashboard-escape-behaviour.test.js —
// reimplementing the helper here would pass while production degraded.
function extractMethod(html, name) {
  const at = html.indexOf(`\n  ${name}(s)`);
  assert.notEqual(at, -1, `${name}(s) must exist as a single-argument App method`);
  const open = html.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, `could not delimit ${name}`);
  return new Function('s', `return (function ${name}(s) ${html.slice(open, end)}).call(null, s);`);
}

describe('index-sketch.html: escJsAttr replaces the dead escAttr composition', () => {
  it('the helper exists and neutralises JS-string breakouts', () => {
    const escJsAttr = extractMethod(SKETCH, 'escJsAttr');
    const cases = [
      ['\\', '\\\\'], ["'", "\\'"], ['"', '\\"'],
      ['<', '\\x3c'], ['>', '\\x3e'], ['&', '\\x26'],
      ['\r', '\\r'], ['\n', '\\n'], ['\u2028', '\\u2028'], ['\u2029', '\\u2029'],
    ];
    for (const [raw, encoded] of cases) {
      assert.equal(escJsAttr(raw), encoded, `escJsAttr(${JSON.stringify(raw)})`);
    }
    // The exact payload that owned the old escAttr path.
    const out = escJsAttr("a'); App.deleteAccount('victim");
    assert.doesNotMatch(out, /(?<!\\)'/, 'an unescaped quote survives into the handler');
    assert.equal(escJsAttr(null), '');
    assert.equal(escJsAttr(undefined), '');
  });

  it('escAttr is gone — definition and every call site', () => {
    // escAttr( catches both a helper definition (`escAttr(s) {`) and call
    // sites (`this.escAttr(...)`); prose mentioning the retired name is fine.
    assert.doesNotMatch(SKETCH, /\bescAttr\s*\(/,
      'the broken helper must not linger as a copy-paste footgun');
  });

  it('every single-quoted interpolation inside an inline handler is safe', () => {
    // Sweep, not a point pin: '${x}' inside generated markup is only sound when
    // x is escJsAttr()'d or a local built from one (inlineId is random hex,
    // emailAttr/keyArg are escJsAttr outputs).
    const SAFE = /^(?:this\.escJsAttr\(|inlineId|emailAttr|keyArg|jid)/;
    const offenders = [];
    for (const m of SKETCH.matchAll(/'\$\{([^}]*)\}/g)) {
      if (!SAFE.test(m[1])) offenders.push(m[1].trim().slice(0, 80));
    }
    assert.deepEqual(offenders, [],
      `quoted JS-string interpolations bypassing escJsAttr: ${offenders.join(' | ')}`);
  });

  it('the OAuth success line escapes the server-supplied email', () => {
    assert.match(SKETCH, /logged in as \$\{this\.esc\(r\.email \|\| label\)\}/);
    assert.doesNotMatch(SKETCH, /logged in as \$\{r\.email \|\| label\}/);
  });

  it('the fail-panel email goes through escJsAttr, not esc', () => {
    assert.match(SKETCH, /const emailAttr = this\.escJsAttr\(email \|\| r\.email \|\| ''\)/);
    assert.match(SKETCH, /addAccountFromInlineToken\('\$\{inlineId\}','\$\{emailAttr\}'\)/);
  });
});

describe('index.html: the same two sinks', () => {
  it('the OAuth fail-panel email goes through escJsAttr', () => {
    assert.match(DASHBOARD, /const emailAttr = this\.escJsAttr\(r\.email \|\| ''\)/);
    assert.match(DASHBOARD, /addAccountFromInlineToken\('\$\{inlineId\}','\$\{emailAttr\}'\)/);
  });

  it('loadLsBinary escapes the server error text and the path', () => {
    assert.match(DASHBOARD, /\$\{this\.esc\(msg\)\}<\/span> · <code[^>]*>\$\{this\.esc\(r\.path \|\| ''\)\}<\/code>/);
  });

  it('no call to the never-defined escAttr() remains', () => {
    // index.html never defined escAttr — the one call site at provider-swatch
    // was a latent TypeError waiting on the render path. Keep it at zero.
    assert.doesNotMatch(DASHBOARD, /\bescAttr\s*\(/);
  });
});

describe('updateAccountLabel: the label cannot carry hostile text into account.email', () => {
  const created = new Set();
  after(() => { for (const id of created) removeAccount(id); });

  function account(label) {
    const a = addAccountByKey(`devin-session-token$lbl-${randomUUID().slice(0, 8)}`, label);
    created.add(a.id);
    return a;
  }

  it('rejects control characters, oversized and non-string labels', () => {
    const a = account('ok@example.test');
    const bad = [
      'a\nb', 'a\u001b[31m', 'a\rb', 'a\u0000b', 'a\u0085b',
      'x'.repeat(129), '', '   ', 42, null, undefined, { toString: () => 'x' },
    ];
    for (const label of bad) {
      assert.throws(() => updateAccountLabel(a.id, label),
        (e) => e.code === 'ERR_ACCOUNT_LABEL_INVALID' && e.statusCode === 400,
        `label ${JSON.stringify(label)?.slice(0, 40)} must be refused`);
    }
    assert.equal(a.email, 'ok@example.test', 'a refused label must not mutate the account');
  });

  it('accepts printable (incl. non-ASCII) labels and stores them trimmed', () => {
    const a = account('before@example.test');
    assert.equal(updateAccountLabel(a.id, '  renamed@example.test  '), true);
    assert.equal(a.email, 'renamed@example.test');
    assert.equal(updateAccountLabel(a.id, '张三 <zhang@corp.example>'), true);
    assert.equal(a.email, '张三 <zhang@corp.example>');
    assert.equal(updateAccountLabel(a.id, 'x'.repeat(128)), true);
  });

  it('addAccountByKey applies the same boundary at write time (S5)', () => {
    // The PATCH path got the validator first; add/import paths wrote `label`
    // straight into `email`. A hostile add must be a coded 400, not a stored
    // ANSI/forged-log label that only render-time sanitization would catch.
    for (const label of ['a\nb', 'a\u001b[31m', 'x'.repeat(129), 42]) {
      assert.throws(
        () => addAccountByKey(`devin-session-token$bad-${randomUUID().slice(0, 8)}`, label),
        (e) => e.code === 'ERR_ACCOUNT_LABEL_INVALID' && e.statusCode === 400,
        `add label ${JSON.stringify(label)?.slice(0, 40)} must be refused`);
    }
    // An absent/blank label is not an error — it falls back to the key prefix.
    const blank = addAccountByKey(`devin-session-token$blk-${randomUUID().slice(0, 8)}`, '   ');
    created.add(blank.id);
    assert.match(blank.email, /^key-/);
    // Non-string labels passed as undefined/null keep the fallback too.
    const none = addAccountByKey(`devin-session-token$non-${randomUUID().slice(0, 8)}`);
    created.add(none.id);
    assert.match(none.email, /^key-/);
  });

  it('rejects invisible/bidi format characters (label spoofing, L5 probe)', () => {
    const a = account('ok@example.test');
    // L5 measured these ALLOWED pre-fix: RLO can visually reverse a label on
    // the dashboard; ZWSP/BOM/SHY/isolates hide in plain sight.
    const spoof = [
      'x‮y',    // RLO — bidi override
      'x​y',    // ZWSP
      'x﻿y',    // BOM / ZWNBSP
      'x­y',    // soft hyphen
      'x⁦y',    // LRI isolate
      'x⁧y',    // RLI isolate
      'x⁠y',    // word joiner
      'x᠎y',    // Mongolian vowel separator (Cf)
      'x͏y',    // combining grapheme joiner
      'x y',    // LINE SEPARATOR — renders a line break, forges a log line (L1-F3)
      'x y',    // PARAGRAPH SEPARATOR — same forged-record class
    ];
    for (const label of spoof) {
      assert.throws(() => updateAccountLabel(a.id, label),
        (e) => e.code === 'ERR_ACCOUNT_LABEL_INVALID',
        `label with ${[...label].map(c => 'U+' + c.codePointAt(0).toString(16)).join(' ')} must be refused`);
    }
    // Legitimate invisible-adjacent characters stay allowed: ZWJ (emoji
    // sequences) and ZWNJ/LRM/RLM (real RTL names).
    assert.equal(updateAccountLabel(a.id, 'family👨‍👩‍👧 dev'), true);
    assert.equal(updateAccountLabel(a.id, 'نام\u200cکاربر'), true);
  });

  it('sanitizeLabelText strips the same characters for upstream-sourced writes', () => {
    // Upstream (login result / GetUserStatus) text is sanitized, not asserted:
    // a hostile response degrades to a clean label instead of throwing.
    assert.equal(sanitizeLabelText('a\u202Eb\u200bc'), 'abc');
    assert.equal(sanitizeLabelText('a\u2028b\u2029c'), 'abc');
    assert.equal(sanitizeLabelText('  spaced@example.test  '), 'spaced@example.test');
    assert.equal(sanitizeLabelText('a\nb\rc'), 'abc');
    assert.equal(sanitizeLabelText(null), '');
    assert.equal(sanitizeLabelText(42), '42');
  });
});
