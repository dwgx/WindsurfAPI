import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const root = new URL('../src/dashboard/', import.meta.url);
const en = JSON.parse(readFileSync(new URL('i18n/en.json', root), 'utf8'));

for (const skin of ['index.html', 'index-sketch.html']) {
  test(`${skin} renders successful imports from older servers without inventing an outcome or position`, () => {
    const html = readFileSync(new URL(skin, root), 'utf8');
    const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(match => match[1]).find(source => source.includes('const App =') && source.includes('const I18n ='));
    assert.ok(script);
    const browser = {
      addEventListener() {},
      document: { addEventListener() {}, querySelector() { return null; } },
      localStorage: { getItem() { return null; } },
    };
    browser.window = browser;
    const { App, I18n } = runInNewContext(`${script}\n;({ App, I18n })`, browser);
    I18n.locale = 'en';
    if (I18n.bundles) I18n.bundles.en = en;

    for (const disposition of [undefined, 'queued']) {
      assert.equal(App.batchImportSuccess(disposition).toLowerCase(), 'success');
    }
    for (const disposition of ['added', 'existing', 'login_only']) {
      assert.equal(App.batchImportSuccess(disposition), en.batch.outcome[disposition]);
    }
    assert.equal(App.batchImportPosition('json', undefined), '—');
    assert.equal(App.batchImportPosition('text', 3), 'Line 3');
    assert.equal(App.batchImportPosition('json', 2), 'Item 2');
  });
}
