// The per-account tab must state its unattributed remainder, not silently sum
// short of the log total. Executes the shipped `_renderStatsAgg` out of
// index.html (brace-sliced) against a DOM stub, so the assertion covers the
// real template/JS rather than a mirror implementation.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finalizeStatsScope, getRequestLog, recordRequest, recordTokenUsage, resetStats, withStatsScope } from '../src/dashboard/stats.js';
import { buildUsageBody } from '../src/handlers/chat.js';

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

function renderLog(data, i18n = I18n) {
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
  }, i18n, data);
  return element('stats-log-body').innerHTML.split('</tr>');
}

function usageCells(row) {
  return row.match(/<td\b[^>]*>.*?<\/td>/g).slice(5, 7);
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
  const [failed, succeeded] = renderLog(log);
  assert.match(failed, /badge error.*statsLog\.attemptFailed/);
  assert.match(failed, /HTTP 200/);
  assert.match(failed, /statsLog\.usageMissing[^>]*>—<\/td>/);
  assert.match(succeeded, /badge success.*statsLog\.attemptSucceeded/);
  const [input, output] = usageCells(succeeded);
  assert.match(input, />12<\/td>/);
  assert.match(output, />0<\/td>/, 'a recorded input plus a zero output keeps the zero');
});

it('renders each reported side, and keeps a reported total separate from the split', (t) => {
  resetStats();
  t.after(resetStats);
  recordRequest('absent', true, 1, null);
  recordRequest('zero', true, 1, null, { usage: { prompt_tokens: 0, completion_tokens: 0 } });
  recordRequest('input', true, 1, null, { usage: { prompt_tokens: 8 } });
  recordRequest('output', true, 1, null, { usage: { completion_tokens: 5 } });
  recordRequest('total', true, 1, null, { usage: { total_tokens: 0 } });
  const [total, output, input, zero, absent] = renderLog(getRequestLog())
    .slice(0, 5).map(usageCells);

  assert.ok(absent.every(cell => /usageMissing[^>]*>—<\/td>/.test(cell)));
  assert.ok(zero.every(cell => />0<\/td>/.test(cell)));
  assert.match(input[0], />8<\/td>/);
  assert.match(input[1], />—<\/td>/);
  assert.match(output[0], />—<\/td>/);
  assert.match(output[1], />5<\/td>/);
  assert.match(total[0], />— <small[^>]*>section\.statsLog\.reportedTotal \{"total":"0"\}<\/small>/);
  assert.match(total[1], />—<\/td>/);
});

it('explains accounting estimates next to missing and zero provider observations in both locales', (t) => {
  resetStats();
  t.after(resetStats);
  const messages = [{ role: 'user', content: 'How much?' }];
  const estimate = buildUsageBody(null, messages, 'Estimated answer');
  const reportedZero = buildUsageBody({ inputTokens: 0, outputTokens: 0 }, messages, 'Explicit zero');
  for (const [model, usage] of [['estimated', estimate], ['reported-zero', reportedZero]]) {
    withStatsScope(() => {
      recordRequest(model, true, 1, null);
      recordTokenUsage(usage, model);
    });
  }
  const log = getRequestLog();
  const input = estimate.prompt_tokens + reportedZero.prompt_tokens;
  const output = estimate.completion_tokens + reportedZero.completion_tokens;
  assert.ok(input > 0 && output > 0, 'the accounting fixture includes estimates');
  assert.equal(log.summary.tokensIn, input);
  assert.equal(log.summary.tokensOut, output);

  const explanations = [
    [
      'en',
      `Accounting totals (may include estimates): ${input} input, ${output} output`,
      'Rows show available usage records, which may be incomplete. Older rows retain historical values.',
    ],
    [
      'zh-CN',
      `计账用量（可能含估算）：输入 ${input}，输出 ${output}`,
      '请求行显示可用用量记录，可能不完整；旧记录保留历史数值。',
    ],
  ];
  for (const [locale, totals, rowSource] of explanations) {
    const strings = JSON.parse(readFileSync(new URL(`../src/dashboard/i18n/${locale}.json`, import.meta.url), 'utf8'));
    const i18n = { t(key, vars = {}) {
      const value = key.split('.').reduce((dict, part) => dict?.[part], strings);
      return value.replace(/\{\{(\w+)\}\}/g, (_, field) => vars[field]);
    } };
    const [zero, missing] = renderLog(log, i18n).slice(0, 2).map(usageCells);
    assert.ok(zero.every(cell => />0<\/td>/.test(cell)), locale);
    assert.ok(missing.every(cell => />—<\/td>/.test(cell)), locale);
    const summary = element('stats-log-summary').textContent;
    assert.ok(summary.includes(totals), summary);
    assert.ok(summary.includes(rowSource), summary);
  }
});
