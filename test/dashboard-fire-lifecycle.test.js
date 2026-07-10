import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function section(start, end) {
  const starts = [html.indexOf(`  ${start}(`), html.indexOf(`  async ${start}(`)].filter(i => i >= 0);
  const from = Math.min(...starts);
  const ends = [html.indexOf(`\n  ${end}(`, from), html.indexOf(`\n  async ${end}(`, from)].filter(i => i > from);
  const to = Math.min(...ends);
  assert.ok(from >= 0 && to > from, `expected ${start} section`);
  return html.slice(from, to);
}

test('fire teardown invalidates the pool render signature and stays idempotent', () => {
  const block = section('_teardownFires', '_mountBarFires');
  const source = block.slice(0, block.indexOf('  // Max simultaneous')).replace(/,\s*$/, '');
  const holder = Function(`return ({ ${source} });`)();
  let disposed = 0;
  holder._poolSig = 'same-pool';
  holder._barFires = [() => { disposed++; }];
  const originalDocument = globalThis.document;
  globalThis.document = { querySelectorAll: () => [] };
  try {
    holder._teardownFires();
    holder._teardownFires();
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }

  assert.equal(disposed, 1);
  assert.equal(holder._poolSig, null);
  assert.deepEqual(holder._barFires, []);
});

test('pool render tears down before committing its new signature', () => {
  const render = section('_renderPoolHealth', '_poolGridHtml');
  const mount = section('_mountBarFires', '_poolTierLabel');
  assert.match(render, /if \(this\._poolSig === sig\) return;\s*this\._teardownFires\(\);\s*this\._poolSig = sig;/);
  assert.doesNotMatch(mount, /this\._teardownFires\(\)/);
});

test('late overview work cannot remount fires on a hidden panel', () => {
  const navigate = section('navigate', 'api');
  const load = section('loadOverview', 'restartLs');
  const mount = section('_mountBarFires', '_poolTierLabel');
  assert.match(navigate, /_overviewLoadGeneration/);
  assert.match(load, /_overviewLoadGeneration/);
  assert.ok((load.match(/if \(!isCurrent\(\)\) return;/g) || []).length >= 2);
  assert.match(mount, /p-overview/);
  assert.match(mount, /classList\.contains\('active'\)/);
});
