// CDP verifier for the WebGL fire on saturated StatusBars rows (#firemount).
// Prereq: local server on :3009, chrome --headless=new --remote-debugging-port=9222
//         with WebGL (--enable-unsafe-swiftshader --use-angle=swiftshader).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const BASE = process.env.FIRE_VERIFY_BASE || 'http://127.0.0.1:3009';
const PW = process.env.FIRE_VERIFY_PASSWORD || 'testpw';
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find(t => t.type === 'page') || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/dashboard` });
await new Promise(r => setTimeout(r, 3000));

// auth + go to overview
await evalJs(`(function(){ localStorage.setItem('dp','${PW}'); App.password='${PW}'; var o=document.querySelector('.login-overlay'); if(o) o.classList.add('hidden'); return 1; })()`);

// inject a saturated account so a .hot row renders, then render pool health
const cm = { poolHealth: [
  { id: 'hot0001', email: 'saturated-pro', tier: 'pro', status: 'active', saturated: true, inflight: 3, rpmUsed: 58, rpmLimit: 60, health: { total: 120, error: 0, throttle: 0, dead: 0, ok: 120 } },
  { id: 'warm0002', email: 'busy-free', tier: 'free', status: 'active', saturated: true, inflight: 1, rpmUsed: 8, rpmLimit: 20, health: { total: 40, error: 1, throttle: 2, dead: 0, ok: 37 } },
  { id: 'hot0003', email: 'saturated-3', tier: 'pro', status: 'active', saturated: true, inflight: 2, rpmUsed: 55, rpmLimit: 60, health: { total: 30, error: 0, throttle: 0, dead: 0, ok: 30 } },
  { id: 'hot0004', email: 'saturated-4', tier: 'pro', status: 'active', saturated: true, inflight: 2, rpmUsed: 52, rpmLimit: 60, health: { total: 20, error: 0, throttle: 0, dead: 0, ok: 20 } },
  { id: 'hot0005', email: 'saturated-5', tier: 'pro', status: 'active', saturated: true, inflight: 1, rpmUsed: 49, rpmLimit: 60, health: { total: 10, error: 0, throttle: 0, dead: 0, ok: 10 } },
]};
await evalJs(`(function(){
  App._poolView='bars'; try{localStorage.setItem('dashboard_pool_view','bars');}catch(e){}
  App._lastConnectMetrics=${JSON.stringify(cm)};
  App._poolSig=null;
  App._renderPoolHealth(App._lastConnectMetrics);
  return 1;
})()`);
await new Promise(r => setTimeout(r, 2500)); // let a few fire frames run

// collect diagnostics
const diag = await evalJs(`(function(){
  const hot = document.querySelectorAll('.sbar.hot').length;
  const canv = document.querySelectorAll('.sbar-fire-canvas').length;
  const fires = (App._barFires||[]).length;
  // probe WebGL context liveness on the first fire canvas
  let ctxAlive = null;
  const c = document.querySelector('.sbar-fire-canvas');
  if (c) {
    const gl = c.getContext('webgl2');
    ctxAlive = !!gl && !gl.isContextLost();
  }
  return { hot, canv, fires, ctxAlive, cw: c?c.width:0, ch: c?c.height:0 };
})()`);
console.log('DIAG:', JSON.stringify(diag));
assert.equal(diag.hot, 5);
assert.equal(diag.canv, 3);
assert.equal(diag.fires, 3);
assert.equal(diag.ctxAlive, true);
const initialShot = await send('Page.captureScreenshot', { format: 'png' });
if (initialShot.result?.data) writeFileSync('./tmp/fire-initial.png', Buffer.from(initialShot.result.data, 'base64'));
const compositorDiag = await evalJs(`(async function(){
  const img = new Image();
  img.src = ${JSON.stringify(`data:image/png;base64,${initialShot.result?.data || ''}`)};
  await img.decode();
  const probe = document.createElement('canvas');
  probe.width = img.width; probe.height = img.height;
  const pctx = probe.getContext('2d'); pctx.drawImage(img, 0, 0);
  const fireRect = document.querySelector('.sbar-fire-canvas').getBoundingClientRect();
  const fallback = [...document.querySelectorAll('.sbar.hot')].find(row => !row.querySelector('.sbar-fire-canvas'));
  const sample = (rect) => {
    const x = Math.round(rect.left + rect.width * 0.25);
    const y = Math.round(rect.top + 4);
    const w = Math.max(1, Math.round(rect.width * 0.45));
    const h = Math.max(1, Math.round(rect.height - 8));
    const px = pctx.getImageData(x, y, w, h).data;
    let bright = 0;
    for (let i = 0; i < px.length; i += 4) {
      if ((px[i] + px[i + 1] + px[i + 2]) / 3 > 60) bright++;
    }
    return { bright, pixels: px.length / 4 };
  };
  return { fire: sample(fireRect), fallback: sample(fallback.getBoundingClientRect()) };
})()`);
console.log('COMPOSITOR_PIXELS:', JSON.stringify(compositorDiag));
assert.ok(compositorDiag.fire.bright > compositorDiag.fallback.bright + 100);

// dispose test: switch to grid view → fires should dispose to 0
await evalJs(`(function(){ App._poolView='grid'; App._poolSig=null; App._renderPoolHealth(App._lastConnectMetrics); return 1; })()`);
await new Promise(r => setTimeout(r, 500));
const afterGrid = await evalJs(`(App._barFires||[]).length`);
console.log('FIRES_AFTER_GRID_SWITCH:', afterGrid, '(expect 0 = disposed)');
assert.equal(afterGrid, 0);

// Navigation lifecycle + stale async load: leave -> dispose, return -> remount,
// then resolve an old overview request while settings is active -> stay disposed.
const lifecycle = await evalJs(`(async function(){
  const cm = ${JSON.stringify(cm)};
  const realLoadOverview = App.loadOverview;
  const realLoadSettings = App.loadSettings;
  const realApi = App.api;
  App.loadSettings = function() {};
  App.loadOverview = function() {
    this._lastConnectMetrics = cm;
    this._poolView = 'bars';
    this._renderPoolHealth(cm);
  };
  App.navigate('settings');
  await new Promise(r => setTimeout(r, 50));
  const away = { fires: (App._barFires || []).length, canv: document.querySelectorAll('.sbar-fire-canvas').length, sig: App._poolSig };
  App.navigate('overview');
  await new Promise(r => setTimeout(r, 250));
  const back = { fires: (App._barFires || []).length, canv: document.querySelectorAll('.sbar-fire-canvas').length };

  let releaseOverview;
  App.api = function(_method, path) {
    if (path === '/overview') return new Promise(resolve => { releaseOverview = resolve; });
    if (path === '/connect-metrics') return Promise.resolve(cm);
    return Promise.resolve({});
  };
  App.loadOverview = realLoadOverview;
  const pending = App.loadOverview();
  await Promise.resolve();
  App.navigate('settings');
  releaseOverview({});
  await pending;
  await new Promise(r => setTimeout(r, 50));
  const late = { fires: (App._barFires || []).length, canv: document.querySelectorAll('.sbar-fire-canvas').length, sig: App._poolSig };

  App.api = realApi;
  App.loadOverview = realLoadOverview;
  App.loadSettings = realLoadSettings;
  return { away, back, late };
})()`);
console.log('LIFECYCLE:', JSON.stringify(lifecycle));
assert.deepEqual(lifecycle.away, { fires: 0, canv: 0, sig: null });
assert.deepEqual(lifecycle.back, { fires: 3, canv: 3 });
assert.deepEqual(lifecycle.late, { fires: 0, canv: 0, sig: null });

// Return to a deterministic rendered overview for the screenshot.
await evalJs(`(function(){
  const realLoadOverview = App.loadOverview;
  App.loadOverview = function() {
    this._poolView='bars'; this._lastConnectMetrics=${JSON.stringify(cm)};
    this._renderPoolHealth(this._lastConnectMetrics);
  };
  App.navigate('overview');
  App.loadOverview = realLoadOverview;
  return 1;
})()`);
await new Promise(r => setTimeout(r, 1000));
await evalJs(`document.querySelector('.sbar-fire-canvas')?.scrollIntoView({block:'center'}); true`);
await new Promise(r => setTimeout(r, 250));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) { writeFileSync('./tmp/fire-verify.png', Buffer.from(shot.result.data, 'base64')); console.log('SHOT: ./tmp/fire-verify.png'); }
ws.close();
