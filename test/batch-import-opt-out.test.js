import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { config } from '../src/config.js';
import { getAccountList } from '../src/auth.js';
import { handleDashboardApi } from '../src/dashboard/api.js';

test('non-adding token and API-key rows are skipped before any pool write', async () => {
  const original = config.dashboardPassword;
  config.dashboardPassword = 'fixture-dashboard';
  const snapshot = () => ['accounts.json', 'proxy.json'].map(file => {
    const path = join(process.env.DATA_DIR, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  });
  const before = snapshot();
  const accounts = getAccountList().map(account => account.id);
  const token = 'devin-session-token$fixture-no-add-0123456789abcdefghijklmnop';
  const key = 'fixture-no-add-api-key';
  const req = { url: '/dashboard/api/batch-import', headers: { 'x-dashboard-password': config.dashboardPassword }, socket: { remoteAddress: '127.0.0.1' } };
  let response;
  const res = { writeHead(status) { assert.equal(status, 200); }, end(value) { response = JSON.parse(value); } };
  try {
    await handleDashboardApi('POST', '/batch-import', { text: JSON.stringify([{ token }, { apiKey: key }]), autoAdd: false }, req, res);
    assert.deepEqual(response.results.map(r => [r.lineNumber, r.importKind, r.skipped, r.error]),
      [[1, 'token', true, 'ERR_AUTO_ADD_DISABLED'], [2, 'api_key', true, 'ERR_AUTO_ADD_DISABLED']]);
    assert.deepEqual([response.successCount, response.failCount, response.skippedCount], [0, 0, 2]);
    assert.deepEqual(getAccountList().map(account => account.id), accounts);
    assert.deepEqual(snapshot(), before);
    assert.ok(!JSON.stringify(response).includes(token) && !JSON.stringify(response).includes(key));
  } finally { config.dashboardPassword = original; }
});

function dashboard(skin) {
  const html = readFileSync(new URL('../src/dashboard/' + skin, import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]).find(s => s.includes('const App =') && s.includes('const I18n ='));
  assert.ok(script);
  const input = { value: 'row one\nrow two' };
  const nodes = { 'wl-batch-input': input, 'wl-auto-add': { checked: true }, 'wl-batch-btn': {}, 'wl-batch-preview-btn': {} };
  const browser = { localStorage: { getItem() { return null; } }, addEventListener() {},
    document: { addEventListener() {}, getElementById(id) { return nodes[id]; } } };
  browser.window = browser;
  const { App, I18n } = runInNewContext(script + '\n;({ App, I18n })', browser);
  I18n.t = key => key;
  let refreshes = 0;
  Object.assign(App, { renderBatchWindsurfLoginResult() {}, pushLoginHistoryEntries() {},
    showWLResult() {}, showWindsurfLoginResult() {}, getWindsurfProxyLabel() { return ''; },
    esc: value => String(value), toast() {}, loadAccounts() { refreshes++; } });
  return { App, input, refreshes: () => refreshes };
}

for (const skin of ['index.html', 'index-sketch.html']) {
  test(skin + ' retains pasted rows on partial failure or skip and only clears an unchanged successful paste', async () => {
    for (const scenario of ['failure', 'skip', 'edited', 'complete']) {
      const { App, input, refreshes } = dashboard(skin);
      const submitted = input.value;
      App.api = async () => {
        if (scenario === 'edited') input.value = 'new draft';
        const failed = scenario === 'failure', skipped = scenario === 'skip';
        return { success: true, successCount: failed || skipped ? 1 : 2, failCount: Number(failed), skippedCount: Number(skipped),
          results: [{ success: true }, { success: !failed && !skipped, skipped, error: failed ? 'fixture' : undefined }] };
      };
      await App.windsurfLoginBatch();
      assert.equal(refreshes(), 1, scenario);
      assert.equal(input.value, scenario === 'edited' ? 'new draft' : scenario === 'complete' ? '' : submitted, scenario);
    }
  });
}
