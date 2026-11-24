import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

// Extract an App method body by name (brace-slicing convention) so we can
// exercise the real logic.
function method(name) {
  const start = html.indexOf(`  ${name}(`);
  const end = html.indexOf('\n  },', start);
  assert.ok(start >= 0 && end > start, `expected ${name} method in index.html`);
  return html.slice(start, end + 4).trim();
}

describe('dashboard a11y — segmented controls are radio groups (D3a)', () => {
  it('no seg-group still declares role="tablist"', () => {
    const segGroups = html.match(/<div class="seg-group"[^>]*>/g) || [];
    for (const g of segGroups) {
      assert.doesNotMatch(g, /role="tablist"/,
        'single-select seg-groups must be radiogroup, not tablist');
    }
    // The merged add-account modal IS a real tablist (tabs -> tabpanels), and it
    // must stay the only one so this guard keeps policing the seg-groups.
    assert.equal((html.match(/role="tablist"/g) || []).length, 1,
      'only the add-account modal may declare a tablist');
    const accountTabs = html.match(/<div\b[^>]*\bclass="add-tabs"[^>]*>/)?.[0];
    assert.ok(accountTabs, 'the account-add tab container must exist');
    assert.match(accountTabs, /\brole="tablist"/);
    assert.match(html, /role="tabpanel"/);
  });

  it('every seg-group is a labelled radiogroup', () => {
    const groups = html.match(/<div class="seg-group"[^>]*>/g) || [];
    assert.ok(groups.length >= 3, `expected >=3 seg-groups, found ${groups.length}`);
    for (const g of groups) {
      assert.match(g, /role="radiogroup"/, `seg-group missing role=radiogroup: ${g}`);
      assert.match(g, /aria-label="[^"]+"/, `seg-group missing aria-label: ${g}`);
      assert.match(g, /data-i18n-aria-label="aria\./, `seg-group aria-label not i18n: ${g}`);
    }
  });

  it('every seg-btn is role=radio with an aria-checked state', () => {
    const btns = html.match(/<button class="seg-btn[^>]*>/g) || [];
    assert.ok(btns.length >= 10, `expected many seg-btns, found ${btns.length}`);
    for (const b of btns) {
      assert.match(b, /role="radio"/, `seg-btn missing role=radio: ${b}`);
      assert.match(b, /aria-checked="(true|false)"/, `seg-btn missing aria-checked: ${b}`);
    }
    // Exactly the buttons carrying .active start aria-checked=true.
    for (const b of btns) {
      const active = /\bactive\b/.test(b.split('onclick')[0]);
      const checked = /aria-checked="true"/.test(b);
      assert.equal(checked, active, `aria-checked must match .active: ${b}`);
    }
  });

  it('_syncRadioGroup toggles BOTH .active class and aria-checked', () => {
    const fn = Function('sel', 'isOn', 'document', `(${method('_syncRadioGroup').replace(/^_syncRadioGroup/, 'function')}).call({}, sel, isOn);`);
    // Fake DOM: two buttons, select the second.
    const mk = (val) => {
      const attrs = {};
      const classes = new Set();
      return {
        dataset: { view: val },
        classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); } },
        setAttribute: (k, v) => { attrs[k] = v; },
        _has: (c) => classes.has(c),
        _attr: (k) => attrs[k],
      };
    };
    const a = mk('grid');
    const b = mk('bars');
    const doc = { querySelectorAll: () => [a, b] };
    fn('.pool-view-btn', (btn) => btn.dataset.view === 'bars', doc);
    assert.equal(a._has('active'), false);
    assert.equal(a._attr('aria-checked'), 'false');
    assert.equal(b._has('active'), true);
    assert.equal(b._attr('aria-checked'), 'true');
  });

  it('toggle handlers route through _syncRadioGroup (no bare classList-only updates)', () => {
    for (const name of ['setPoolView', 'setStatsRange', 'setChartType']) {
      const src = method(name);
      assert.match(src, /_syncRadioGroup/, `${name} must sync aria via _syncRadioGroup`);
    }
  });
});

describe('dashboard a11y — chart canvases are labelled images (D3b)', () => {
  // v3.4.x declutter: the overview request-trend chart and the model-pie chart
  // were removed (trend is redundant with the stats-page time-series; pie was
  // replaced by the expandable model-stats table). Only stats-canvas remains.
  const canvases = ['stats-canvas'];
  for (const id of canvases) {
    it(`${id} has role=img + i18n aria-label`, () => {
      const re = new RegExp(`<canvas id="${id}"[^>]*>`);
      const tag = (html.match(re) || [])[0];
      assert.ok(tag, `missing canvas ${id}`);
      assert.match(tag, /role="img"/, `${id} missing role=img`);
      assert.match(tag, /aria-label="[^"]+"/, `${id} missing aria-label`);
      assert.match(tag, /data-i18n-aria-label="aria\./, `${id} aria-label not i18n`);
    });
  }
});

describe('dashboard a11y — modals are dialogs with focus management (D3c)', () => {
  it('confirm() and prompt() render role=dialog + aria-modal', () => {
    const dialogs = html.match(/<div class="modal"[^>]*role="dialog"[^>]*>/g) || [];
    assert.ok(dialogs.length >= 2, `expected >=2 role=dialog modals, found ${dialogs.length}`);
    for (const d of dialogs) {
      assert.match(d, /aria-modal="true"/);
      assert.match(d, /aria-labelledby="[^"]+"/);
    }
  });

  it('confirm() and prompt() save + restore focus and install a Tab trap', () => {
    for (const name of ['confirm', 'prompt']) {
      const src = method(name);
      assert.match(src, /const prevFocus = document\.activeElement/, `${name} must capture prev focus`);
      assert.match(src, /prevFocus\.focus\(\)/, `${name} must restore focus on close`);
      assert.match(src, /_trapFocus\(e, wrap\)/, `${name} must trap Tab focus`);
    }
  });

  it('_trapFocus wraps between first and last focusable', () => {
    const fn = Function('e', 'wrap', 'document', `(${method('_trapFocus').replace(/^_trapFocus/, 'function')}).call({}, e, wrap);`);
    const first = { focus() { this.focused = true; } };
    const last = { focus() { this.focused = true; } };
    const wrap = { querySelectorAll: () => [first, last] };
    // Tab on last -> wrap to first.
    let prevented = false;
    const docLast = { activeElement: last };
    fn({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } }, wrap, docLast);
    assert.equal(prevented, true);
    assert.equal(first.focused, true);
    // Shift+Tab on first -> wrap to last.
    prevented = false; first.focused = false; last.focused = false;
    const docFirst = { activeElement: first };
    fn({ key: 'Tab', shiftKey: true, preventDefault: () => { prevented = true; } }, wrap, docFirst);
    assert.equal(prevented, true);
    assert.equal(last.focused, true);
  });
});
