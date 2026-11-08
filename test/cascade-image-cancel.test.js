// IMG-01 — Cascade image extraction must stop when the turn is spent.
//
// Before this fix extractImages() had no request-level cancellation: it awaited
// every remote fetch/decode even after the turn deadline, and its per-image
// catch swallowed the new terminal error into a warning. The fix threads the
// turn's AbortSignal and its budget assertion (`beforeFetch`) through
// extractImages and fetchImageUrl. These tests pin the observable contract
// through the narrow __setFetchImageUrlForTest seam (no socket, no DNS):
//   - a throwing checkpoint stops extraction and propagates its exact error,
//   - an already-aborted signal opens zero fetches,
//   - an ordinary 404 still logs and continues (control),
//   - a normal turn still returns every image,
//   - fetchImageUrl itself settles once on abort and destroys its handle.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const transport = await import('./helpers/fake-image-transport.mjs');
const { encodePngRGBA } = await import('./helpers/png-encode.mjs');

const require = createRequire(import.meta.url);
const http = require('node:http');
const https = require('node:https');
http.get = transport.get;
https.get = transport.get;
syncBuiltinESMExports();

const { fetchImageUrl, extractImages, __setFetchImageUrlForTest } = await import('../src/image.js');
const { log } = await import('../src/config.js');
const { budgetExceededError } = await import('../src/request-budget.js');

const URL_A = 'https://img.example.test/a.png';
// A real 2x2 PNG, so the control path survives maybeShrinkImage unchanged.
const PNG_B64 = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0xff), 2, 2).toString('base64');
const IMAGE = { base64_data: PNG_B64, mime_type: 'image/png' };

const flush = () => new Promise((resolve) => setImmediate(resolve));

function remoteBlocks(n) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'image_url',
    image_url: { url: `https://img.example.test/${i}.png` },
  }));
}

afterEach(() => {
  __setFetchImageUrlForTest(null);
  transport.reset();
});

describe('IMG-01: extractImages cancellation', () => {
  it('refuses the second fetch attempt: 2 checkpoints, 1 network call, exact error rethrown', async () => {
    const fetched = [];
    let checkpoints = 0;
    __setFetchImageUrlForTest(async (url) => { fetched.push(url); return { ...IMAGE }; });
    const spent = budgetExceededError('request budget exhausted before Cascade image extraction');

    await assert.rejects(
      extractImages(remoteBlocks(5), {
        beforeFetch: () => {
          checkpoints += 1;
          if (checkpoints === 2) throw spent;
        },
      }),
      (err) => {
        assert.equal(err, spent, 'the caller\'s deadline error is rethrown unchanged');
        assert.equal(err.budgetExceeded, true);
        return true;
      },
    );

    // Checkpoint #1 runs before the first fetch, checkpoint #2 before that
    // image is pushed: the second attempt is refused, so exactly one network
    // call happened and nothing was attempted after the throw.
    assert.equal(checkpoints, 2, 'the second checkpoint is the last work attempted');
    assert.equal(fetched.length, 1, 'no fetch starts after the terminal checkpoint');
  });

  it('an already-aborted signal opens zero fetches and propagates AbortError', async () => {
    let fetched = 0;
    __setFetchImageUrlForTest(async () => { fetched += 1; return { ...IMAGE }; });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      extractImages(remoteBlocks(5), { signal: controller.signal }),
      (err) => {
        assert.equal(err.name, 'AbortError');
        return true;
      },
    );
    assert.equal(fetched, 0, 'no image is fetched for an already-cancelled turn');
  });

  it('a normal turn still fetches and returns every image', async () => {
    const fetched = [];
    __setFetchImageUrlForTest(async (url) => { fetched.push(url); return { ...IMAGE }; });

    const out = await extractImages(remoteBlocks(2));
    assert.equal(fetched.length, 2, 'both remote blocks are fetched');
    assert.equal(out.images.length, 2, 'both images are returned');
    assert.deepEqual(out.images.map((i) => i.base64_data), [PNG_B64, PNG_B64]);
    assert.equal(out.images[0].mime_type, 'image/png');
  });

  it('a per-image 404 still logs and continues (control)', async () => {
    const warnings = [];
    const originalWarn = log.warn;
    log.warn = (...args) => warnings.push(args.join(' '));
    try {
      __setFetchImageUrlForTest(async (url) => {
        if (url.includes('missing')) throw new Error('Image fetch HTTP 404');
        return { ...IMAGE };
      });

      const out = await extractImages([
        { type: 'image_url', image_url: { url: 'https://img.example.test/missing.png' } },
        { type: 'image_url', image_url: { url: 'https://img.example.test/ok.png' } },
      ]);

      assert.equal(out.images.length, 1, 'the good image still attaches');
      assert.match(warnings.join('\n'), /Image fetch failed: Image fetch HTTP 404/,
        'the ordinary per-image failure is logged, not thrown');
    } finally {
      log.warn = originalWarn;
    }
  });
});

describe('IMG-01: fetchImageUrl signal', () => {
  it('settles once on abort and destroys the owned request', async () => {
    transport.reset();
    const controller = new AbortController();
    const state = { settlements: 0, error: null };
    const settled = fetchImageUrl(URL_A, 8000, 0, null, controller.signal).then(
      () => { state.settlements += 1; },
      (err) => { state.settlements += 1; state.error = err; },
    );

    assert.equal(transport.hops.length, 1, 'the hop is issued');
    const hop = transport.hops[0];
    assert.equal(hop.options.timeout, 8000, 'the 8 s inactivity guard is untouched');

    controller.abort();
    await settled;

    assert.equal(state.settlements, 1, 'the fetch settles exactly once');
    assert.equal(state.error.name, 'AbortError');
    assert.equal(hop.req.destroyCalls, 1, 'the in-flight request is destroyed by the settle path');

    // A response arriving after settlement must neither resolve the fetch nor
    // leave a live handle behind.
    const late = transport.respond(hop, { headers: { 'content-type': 'image/png' } });
    await flush();
    assert.equal(state.settlements, 1, 'the late response does not settle it again');
    assert.equal(late.destroyCalls, 1, 'the late response is destroyed too');
  });

  it('an already-aborted signal issues no request', async () => {
    transport.reset();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      fetchImageUrl(URL_A, 8000, 0, null, controller.signal),
      (err) => err.name === 'AbortError',
    );
    assert.equal(transport.hops.length, 0, 'no hop is opened for a cancelled fetch');
  });
});
