import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function method(name) {
  const start = html.indexOf(`  ${name}(`);
  const end = html.indexOf('\n  },', start);
  assert.ok(start >= 0 && end > start, `expected ${name} method`);
  return html.slice(start, end + 4).trim();
}

const App = Function(`return ({${[
  '_trendGeom', '_trendPaint', '_smoothPath', '_trendSample', '_trendYAtX',
].map(method).join(',')}});`)();
App._compactNum = String;
App._hexA = () => '#00000000';
App._trendRange = 24;

function recordingContext() {
  const curves = [];
  const arcs = [];
  return {
    curves,
    arcs,
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    bezierCurveTo(...args) { curves.push(args); },
    createLinearGradient() { return { addColorStop() {} }; },
    fill() {}, stroke() {}, save() {}, restore() {}, fillText() {}, setLineDash() {},
    arc(x, y) { arcs.push({ x, y }); },
  };
}

test('trend request and rate plateaus keep controls and hover markers inside the plot', () => {
  for (const peak of [100, 1000]) {
    const values = [0, peak, peak, 0];
    const buckets = values.map((requests, i) => ({
      hour: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
      requests,
      errors: requests,
      rate: requests === 0 ? 0 : 100,
    }));
    const ctx = recordingContext();
    const geom = App._trendGeom(400, 180, buckets);
    const top = geom.pad.t;
    const bottom = geom.pad.t + geom.cH;
    const cursor = (geom.xAt(1) + geom.xAt(2)) / 2;

    App._trendPaint(ctx, 400, 180, buckets, {
      grid: '#111', dim: '#222', acc: '#333', err: '#444', suc: '#555', paper: '#000',
    }, cursor, 1);

    const controlYs = ctx.curves.flatMap(args => [args[1], args[3], args[5]]);
    assert.ok(controlYs.length > 0);
    assert.ok(controlYs.every(y => y >= top && y <= bottom), `peak ${peak} control escaped ${top}..${bottom}`);
    assert.ok(ctx.arcs.every(({ y }) => y >= top && y <= bottom), `peak ${peak} marker escaped ${top}..${bottom}`);
  }
});

test('unbounded smooth paths retain the existing main-chart geometry', () => {
  const points = [
    { x: 0, y: 118 }, { x: 1, y: 18 }, { x: 2, y: 18 }, { x: 3, y: 118 },
  ];
  const ctx = recordingContext();
  App._smoothPath(ctx, points, true, 1 / 6);
  const controlYs = ctx.curves.flatMap(args => [args[1], args[3]]);
  assert.ok(Math.min(...controlYs) < 18, 'control case must preserve the old unbounded spline');
});
