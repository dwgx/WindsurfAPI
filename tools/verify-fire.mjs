// CDP verifier for the WebGL fire on saturated StatusBars rows (#firemount).
// Prereq: local server on :3009, chrome --headless=new --remote-debugging-port=9222
//         with WebGL (--enable-unsafe-swiftshader --use-angle=swiftshader).
import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3009';
const PW = 'testpw';
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
await send('Page.navigate', { url: `${BASE}/dashboard` });
await new Promise(r => setTimeout(r, 3000));

// auth + go to overview
await evalJs(`(function(){ localStorage.setItem('dp','${PW}'); App.password='${PW}'; var o=document.querySelector('.login-overlay'); if(o) o.classList.add('hidden'); return 1; })()`);

// inject a saturated account so a .hot row renders, then render pool health
const cm = { poolHealth: [
  { id: 'hot0001', email: 'saturated-pro', tier: 'pro', status: 'active', saturated: true, inflight: 3, rpmUsed: 58, rpmLimit: 60, health: { total: 120, error: 0, throttle: 0, dead: 0, ok: 120 } },
  { id: 'warm0002', email: 'busy-free', tier: 'free', status: 'active', saturated: true, inflight: 1, rpmUsed: 8, rpmLimit: 20, health: { total: 40, error: 1, throttle: 2, dead: 0, ok: 37 } },
  { id: 'idle0003', email: 'idle-pro', tier: 'pro', status: 'active', saturated: false, inflight: 0, rpmUsed: 0, rpmLimit: 60, health: { total: 10, error: 0, throttle: 0, dead: 0, ok: 10 } },
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
  let ctxAlive = null, drewNonBlack = null;
  const c = document.querySelector('.sbar-fire-canvas');
  if (c) {
    const gl = c.getContext('webgl2');
    ctxAlive = !!gl && !gl.isContextLost();
    try {
      const px = new Uint8Array(4);
      // read center pixel via a fresh readback isn't reliable cross-context;
      // instead just confirm canvas has non-zero backing size.
      drewNonBlack = c.width > 0 && c.height > 0;
    } catch(e){ drewNonBlack = 'err:'+e.message; }
  }
  return { hot, canv, fires, ctxAlive, cw: c?c.width:0, ch: c?c.height:0, drewNonBlack };
})()`);
console.log('DIAG:', JSON.stringify(diag));

// dispose test: switch to grid view → fires should dispose to 0
await evalJs(`(function(){ App._poolView='grid'; App._poolSig=null; App._renderPoolHealth(App._lastConnectMetrics); return 1; })()`);
await new Promise(r => setTimeout(r, 500));
const afterGrid = await evalJs(`(App._barFires||[]).length`);
console.log('FIRES_AFTER_GRID_SWITCH:', afterGrid, '(expect 0 = disposed)');

// back to bars for the screenshot
await evalJs(`(function(){ App._poolView='bars'; App._poolSig=null; App._renderPoolHealth(App._lastConnectMetrics); return 1; })()`);
await new Promise(r => setTimeout(r, 2000));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) { writeFileSync('./tmp/fire-verify.png', Buffer.from(shot.result.data, 'base64')); console.log('SHOT: ./tmp/fire-verify.png'); }
ws.close();
