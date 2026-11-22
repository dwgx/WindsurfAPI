// The per-account tab must state its unattributed remainder, not silently sum
// short of the log total. Executes the shipped `_renderStatsAgg` out of
// index.html (brace-sliced) against a DOM stub, so the assertion covers the
// real template/JS rather than a mirror implementation.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finalizeStatsScope, getRequestLog, recordRequest, resetStats, withStatsScope } from '../src/dashboard/stats.js';

const HTML = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function methodParts(name) {
  const at = HTML.indexOf(`\n  ${name}(`);
  assert.notEqual(at, -1, `${name} must exist as a method in the dashboard App object`);
  const parenOpen = HTML.indexOf('(', HTML.indexOf(name, at));
  let depth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < HTML.length; i++) {
    if (HTML[i] === '(') depth++;
    else if (HTML[i] === ')' && --depth === 0) { parenClose = i; break; }
  }
  assert.notEqual(parenClose, -1, `could not delimit the parameter list of ${name}`);
  const params = HTML.slice(parenOpen, parenClose + 1);
  const open = HTML.indexOf('{', parenClose);
  depth = 0;
  let end = -1;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, `could not delimit the body of ${name}`);
  return { params, body: HTML.slice(open, end) };
}

const I18n = {
  t(key, vars = {}) {
    return `${key} ${JSON.stringify(vars)}`;
  },
};

const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, { id, textContent: '', innerHTML: '', hidden: false });
  }
  return elements.get(id);
}
globalThis.document = { getElementById: (id) => element(id) };

function render(data, tab = 'account') {
  const { params, body } = methodParts('_renderStatsAgg');
  // eslint-disable-next-line no-new-func -- executing the shipped source is the point
  const fn = new Function('I18n', '...args', `return (function _renderStatsAgg${params} ${body}).apply(this, args);`);
  const self = {
    statsAggTab: tab,
    esc: (v) => String(v ?? ''),
    fmtMs: (v) => `${v} ms`,
    fmtTokenCount: (v) => String(v),
    fmtCredit: (v) => String(v),
    _statsFreeLabel: () => '',
    _statsTokenTitle: () => '',
  };
  fn.call(self, I18n, data);
  return { self, note: element('stats-agg-note') };
}

function logPayload({ unattributed = 41, total = 393 } = {}) {
  return {
    summary: { requests: total },
    unattributed: { account: null, requests: unattributed },
    byAccount: [{
      account: 'acct0001', requests: total - unattributed, success: 330, errors: 22,
      avgMs: 10, p95Ms: 20, tokensIn: 0, tokensOut: 0, credits: 0,
    }],
    byModel: [],
    byDay: [],
  };
}

describe('stats aggregates — unattributed footnote', () => {
  it('states the unattributed remainder on the account tab', () => {
    const { note } = render(logPayload());
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /unattributedNote/);
    assert.match(note.textContent, /"count":41/);
    assert.match(note.textContent, /"total":393/);
  });

  it('hides the footnote on dimensions that already reconcile', () => {
    const { note } = render(logPayload(), 'model');
    assert.equal(note.hidden, true);
    assert.equal(note.textContent, '');
  });

  it('hides the footnote when every request is attributed', () => {
    const { note } = render(logPayload({ unattributed: 0 }));
    assert.equal(note.hidden, true);
    assert.equal(note.textContent, '');
  });
});

it('renders a failed HTTP 200 attempt and missing usage as separate facts', (t) => {
  resetStats();
  t.after(resetStats);
  recordRequest('normal', true, 5000, null, { usage: { prompt_tokens: 12, completion_tokens: 0 } });
  withStatsScope((scope) => {
    recordRequest('timeout', false, 899988, null);
    scope.status = 200;
    finalizeStatsScope(scope);
  });
  const log = getRequestLog();
  assert.equal(log.items[0].status, 200);
  assert.equal(log.items[0].success, false);
  const { params, body } = methodParts('_renderStatsLog');
  const fn = new Function('I18n', '...args', 'return (function ' + params + ' ' + body + ').apply(this, args);');
  fn.call({
    esc: (value) => String(value ?? ''),
    fmtMs: (value) => String(value),
    fmtTokenCount: (value) => String(value),
    fmtCredit: (value) => String(value),
    _statsTokenTitle: () => '',
    _fillStatsLogSelect() {},
    _renderStatsAgg() {},
  }, I18n, log);
  const [failed, succeeded] = element('stats-log-body').innerHTML.split('</tr>');
  assert.match(failed, /badge error.*statsLog\.attemptFailed/);
  assert.match(failed, /HTTP 200/);
  assert.match(failed, /statsLog\.usageMissing[^>]*>—<\/td>/);
  assert.match(succeeded, /badge success.*statsLog\.attemptSucceeded/);
  assert.match(succeeded, />12<\/td>/);
  assert.match(succeeded, />0<\/td>/, 'a recorded input plus a zero output keeps the zero');
});
