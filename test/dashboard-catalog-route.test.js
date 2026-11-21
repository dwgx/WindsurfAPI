import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { clearLiveCatalogSelectors, getSnapshotSelectors, setLiveCatalogSelectors } from '../src/devin-connect-models.js';

const PASSWORD = randomUUID();

function fakeRes() {
  return {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(data) { this.body = data; },
  };
}

async function callCatalog() {
  const req = {
    url: '/dashboard/api/models/catalog',
    headers: { 'x-dashboard-password': PASSWORD },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = fakeRes();
  await handleDashboardApi('GET', '/models/catalog', {}, req, res);
  return { status: res.status, json: JSON.parse(res.body) };
}

describe('dashboard catalog diff route', () => {
  before(() => {
    config.dashboardPassword = PASSWORD;
    setLiveCatalogSelectors([
      { selector: 'MODEL_LIVE_ALPHA' },
      { selector: 'MODEL_LIVE_BETA', alias: 'live-beta' },
    ]);
  });
  after(() => clearLiveCatalogSelectors());

  it('serves a synced diff through the real handler', async () => {
    const { status, json } = await callCatalog();
    assert.equal(status, 200);
    assert.equal(json.synced, true);
    assert.equal(json.liveCount, 2);
    assert.equal(json.snapshotCount, getSnapshotSelectors().length);
    assert.ok(json.added.includes('MODEL_LIVE_ALPHA'));
    assert.ok(json.added.includes('MODEL_LIVE_BETA'));
    assert.equal(json.aliasCount, 1);
    assert.equal(json.aliases[0].alias, 'live-beta');
  });

  it('rejects a missing dashboard password before reaching the route', async () => {
    const req = { url: '/dashboard/api/models/catalog', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const res = fakeRes();
    await handleDashboardApi('GET', '/models/catalog', {}, req, res);
    assert.equal(res.status, 401);
  });
});
