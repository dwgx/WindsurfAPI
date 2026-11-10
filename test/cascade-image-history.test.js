// DATA-AUDIT #1 — replayed Cascade history must not lose images silently.
//
// SendUserCascadeMessage carries the replayed history as ONE text blob (field 2)
// and images as a FLAT message-level repeated field (field 6), so the wire cannot
// attribute an image to a turn — but it can carry every image. Before the fix
// only the newest turn was extracted, so an image from turn 1..n-1 reached the
// model as the literal "[Image omitted from text history]" placeholder with no
// counter and no log line anywhere.
//
// These tests drive the real client against a fake LS that decodes the actual
// proto it receives, so they assert on wire bytes, not on an internal return
// value: field 6 contents, marker text, the structured drop log, and the
// process-lifetime counter.
import './setup-env.mjs';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { wrapEnvelope, unwrapRequest, endOfStreamEnvelope } from '../src/connect.js';
import { getAllFields, getField, parseFields, writeMessageField, writeStringField, writeVarintField } from '../src/proto.js';
import { encodePngRGBA } from './helpers/png-encode.mjs';
import { getCascadeImageMetrics, resetCascadeImageMetrics } from '../src/cascade-image-metrics.js';

Object.assign(process.env, {
  CASCADE_POLL_INTERVAL_MS: '5', CASCADE_IDLE_GRACE_MS: '1',
  CASCADE_MAX_WAIT_MS: '1500', CASCADE_COLD_STALL_BASE_MS: '1500', CASCADE_WARM_STALL_MS: '1500',
  GRPC_PROTOCOL: 'connect', WINDSURFAPI_USER_JWT: '0',
});
const { WindsurfClient } = await import('../src/client.js');

// A real 2x2 PNG, so it survives maybeShrinkImage and is byte-identical on the wire.
const PNG_B64 = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0xff), 2, 2).toString('base64');
const IMAGE_MARKER = '[Image #';
const PLACEHOLDER = '[Image omitted from text history]';

const ENV_KEYS = ['CASCADE_MAX_HISTORY_IMAGES', 'CASCADE_MAX_HISTORY_IMAGE_BYTES', 'CASCADE_MAX_HISTORY_BYTES'];
const envSnapshot = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of envSnapshot) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetCascadeImageMetrics();
});

function decodeImages(payload) {
  return getAllFields(parseFields(payload), 6).map((field) => {
    const inner = parseFields(field.value);
    return {
      base64_data: getField(inner, 1, 2)?.value.toString('utf8') || '',
      mime_type: getField(inner, 2, 2)?.value.toString('utf8') || '',
    };
  });
}

function decodeText(payload) {
  const scope = getField(parseFields(payload), 2, 2);
  return scope ? getField(parseFields(scope.value), 1, 2).value.toString('utf8') : '';
}

async function runCascade({ messages, reuseEntry = null, opts = {}, env = {}, failFirstSend = false }) {
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
  resetCascadeImageMetrics();

  const sends = [];
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  const server = http2.createServer();
  const sessions = new Set();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (b) => chunks.push(b));
    stream.on('end', () => {
      const payload = unwrapRequest(Buffer.concat(chunks), headers);
      const method = String(headers[':path']).split('/').pop();
      let body = Buffer.alloc(0);
      if (method === 'StartCascade') body = writeStringField(1, 'synthetic-cascade');
      if (method === 'SendUserCascadeMessage') {
        sends.push({ text: decodeText(payload), images: decodeImages(payload) });
        if (failFirstSend && sends.length === 1) {
          const bytes = Buffer.from(JSON.stringify({ error: { message: 'not_found: cascade trajectory has expired' } }));
          const frame = Buffer.alloc(5 + bytes.length);
          frame[0] = 2;
          frame.writeUInt32BE(bytes.length, 1);
          bytes.copy(frame, 5);
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] });
          stream.end(frame);
          return;
        }
      }
      if (method === 'GetCascadeTrajectorySteps') {
        body = writeMessageField(1, Buffer.concat([
          writeVarintField(1, 15), writeVarintField(4, 3), writeMessageField(20, writeStringField(1, 'answer')),
        ]));
      }
      if (method === 'GetCascadeTrajectory') body = writeVarintField(2, 1);
      stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/connect+proto' });
      stream.end(Buffer.concat([wrapEnvelope(body, { compress: false }), endOfStreamEnvelope()]));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new WindsurfClient('fixture-only-api-key', server.address().port, 'fixture-csrf');
    await client.cascadeChat(messages, 0, 'audit-neutral-model', { reuseEntry, ...opts });
    return { sends, last: sends.at(-1), warnings, metrics: getCascadeImageMetrics() };
  } finally {
    console.warn = origWarn;
    for (const session of sessions) session.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

function imageTurn(text, ...images) {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map((b64) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } })),
    ],
  };
}

describe('Cascade replayed-history images (field 6)', () => {
  it('carries an image from turn 1 of a 3-turn history instead of a placeholder', async () => {
    const { last } = await runCascade({
      messages: [
        imageTurn('TURN_0_IMAGE', PNG_B64),
        { role: 'assistant', content: 'TURN_1_TEXT' },
        { role: 'user', content: 'TURN_2_TEXT' },
      ],
    });

    assert.equal(last.images.length, 1, 'the turn-1 image must ride field 6');
    assert.equal(last.images[0].base64_data, PNG_B64, 'same bytes, same order');
    assert.equal(last.images[0].mime_type, 'image/png');
    assert.ok(last.text.includes(`${IMAGE_MARKER}1 attached to this request`),
      'turn 1 text must point at the attached image by number');
    assert.ok(!last.text.includes(PLACEHOLDER), 'no silent placeholder for an image that was carried');
    assert.ok(last.text.includes('TURN_0_IMAGE') && last.text.includes('TURN_1_TEXT') && last.text.includes('TURN_2_TEXT'),
      'the text history is unchanged around the marker');
  });

  it('keeps the current turn image first and numbers the historical one after it', async () => {
    const { last } = await runCascade({
      messages: [
        imageTurn('TURN_0_IMAGE', PNG_B64),
        { role: 'assistant', content: 'TURN_1_TEXT' },
        imageTurn('TURN_2_IMAGE', PNG_B64),
      ],
    });

    assert.equal(last.images.length, 2, 'current turn image + one historical image');
    assert.ok(last.text.includes(`${IMAGE_MARKER}2 attached to this request`),
      'the historical image is #2 because the current turn already contributed #1');
  });

  it('bounds history images newest-first and counts what it dropped', async () => {
    const { last, warnings, metrics } = await runCascade({
      env: { CASCADE_MAX_HISTORY_IMAGES: '1' },
      messages: [
        imageTurn('TURN_0_IMAGE', PNG_B64),
        { role: 'assistant', content: 'TURN_1_TEXT' },
        imageTurn('TURN_2_IMAGE', PNG_B64),
        { role: 'assistant', content: 'TURN_3_TEXT' },
        { role: 'user', content: 'TURN_4_TEXT' },
      ],
    });

    assert.equal(last.images.length, 1, 'cap of one historical image');
    assert.ok(last.text.includes('TURN_2_IMAGE'), 'the NEWER historical turn wins');
    assert.ok(last.text.includes(`${IMAGE_MARKER}1 attached to this request`), 'only the kept image is numbered');
    assert.equal(last.text.split(IMAGE_MARKER).length - 1, 1, 'exactly one marker, so one attached image');
    assert.ok(last.text.includes('TURN_0_IMAGE'), 'the older turn text is still replayed');
    assert.ok(last.text.includes(PLACEHOLDER), 'its image keeps the explicit placeholder');
    const logged = warnings.join('\n');
    assert.match(logged, /cascade_image_history_dropped count=1/);
    assert.match(logged, /cap=1/);
    assert.equal(metrics.cascade_image_history_dropped, 1, 'the drop is counted, not silent');
    assert.equal(metrics.cascade_image_history_attached, 1);
  });

  it('drops on the byte cap with bytes=1 when even a single image exceeds the budget', async () => {
    const { last, warnings, metrics } = await runCascade({
      env: { CASCADE_MAX_HISTORY_IMAGE_BYTES: '1' },
      messages: [
        imageTurn('TURN_0_IMAGE', PNG_B64),
        { role: 'assistant', content: 'TURN_1_TEXT' },
        { role: 'user', content: 'TURN_2_TEXT' },
      ],
    });

    assert.equal(last.images.length, 0, 'a one-byte budget cannot hold any image');
    assert.ok(last.text.includes(PLACEHOLDER), 'the text says the image is missing');
    assert.match(warnings.join('\n'),
      /cascade_image_history_dropped count=1 \(cap=0 bytes=1 truncated=0 no_vision=0\)/,
      'the drop is attributed to the BYTE cap, not to the count cap');
    assert.equal(metrics.cascade_image_history_dropped, 1);
  });

  it('attaches only the per-request cap from a single turn holding more images', async () => {
    const a = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x11), 2, 2).toString('base64');
    const b = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x22), 2, 2).toString('base64');
    const c = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x33), 2, 2).toString('base64');
    const { last, warnings, metrics } = await runCascade({
      env: { CASCADE_MAX_HISTORY_IMAGES: '2' },
      messages: [
        imageTurn('TURN_0_IMAGE', a, b, c),
        { role: 'assistant', content: 'TURN_1_TEXT' },
        { role: 'user', content: 'TURN_2_TEXT' },
      ],
    });

    assert.equal(last.images.length, 2, 'exactly the cap, not the whole turn');
    assert.deepEqual(last.images.map((i) => i.base64_data), [a, b], 'the first two in block order');
    assert.equal(last.text.split(IMAGE_MARKER).length - 1, 2, 'exactly two markers');
    assert.ok(last.text.includes(`${IMAGE_MARKER}1 attached`) && last.text.includes(`${IMAGE_MARKER}2 attached`));
    assert.ok(last.text.includes(PLACEHOLDER), 'the third image keeps the placeholder');
    assert.match(warnings.join('\n'), /cascade_image_history_dropped count=1/,
      'exactly one image is dropped from the turn');
    assert.equal(metrics.cascade_image_history_dropped, 1);
  });

  it('honours CASCADE_MAX_HISTORY_IMAGES=0 as the explicit opt-out, still counted', async () => {
    const { last, warnings, metrics } = await runCascade({
      env: { CASCADE_MAX_HISTORY_IMAGES: '0' },
      messages: [
        imageTurn('TURN_0_IMAGE', PNG_B64),
        { role: 'assistant', content: 'TURN_1_TEXT' },
        { role: 'user', content: 'TURN_2_TEXT' },
      ],
    });

    assert.equal(last.images.length, 0, 'opt-out drops every historical image');
    assert.ok(last.text.includes(PLACEHOLDER), 'the text says the image is missing');
    assert.match(warnings.join('\n'), /cascade_image_history_dropped count=1/);
    assert.equal(metrics.cascade_image_history_dropped, 1);
  });

  it('counts history images dropped because a truncated turn is not replayed at all', async () => {
    const filler = 'x'.repeat(1200);
    const { last, warnings, metrics } = await runCascade({
      env: { CASCADE_MAX_HISTORY_BYTES: '900' },
      messages: [
        imageTurn(`TURN_0_IMAGE ${filler}`, PNG_B64),
        { role: 'assistant', content: `TURN_1_TEXT ${filler}` },
        { role: 'user', content: 'TURN_2_TEXT' },
      ],
    });

    assert.equal(last.images.length, 0, 'an image whose turn is truncated must not ride the wire');
    assert.match(warnings.join('\n'), /cascade_image_history_dropped count=1 .*truncated=1/);
    assert.equal(metrics.cascade_image_history_dropped, 1);
  });

  it('carries the same history image when a resumed cascade is rebuilt from scratch', async () => {
    const { sends, metrics } = await runCascade({
      failFirstSend: true,
      reuseEntry: { cascadeId: 'synthetic-existing', sessionId: 'fixture-session', stepOffset: 5, generatorOffset: 5 },
      messages: [
        imageTurn('TURN_0_IMAGE', PNG_B64),
        { role: 'assistant', content: 'TURN_1_TEXT' },
        { role: 'user', content: 'TURN_2_TEXT' },
      ],
    });

    assert.equal(sends.length, 2, 'the first send failed and the history was rebuilt');
    assert.equal(sends[1].images.length, 1, 'the rebuilt payload carries the historical image too');
    assert.equal(sends[1].images[0].base64_data, PNG_B64);
    assert.ok(sends[1].text.includes(`${IMAGE_MARKER}1 attached to this request`),
      'rebuild uses the same numbering as a fresh request');
    // The resume attempt never calls the history builder (it reuses the live
    // trajectory and only extracts the current turn), so exactly ONE build is
    // counted for this request — not both wire attempts.
    assert.equal(metrics.cascade_image_history_attached, 1,
      'only the rebuilt build is counted');
  });

  it('does not attach history images when the planner runs without vision, and counts them', async () => {
    const { last, warnings, metrics } = await runCascade({
      opts: { toolPreamble: 'TOOL DEFINITIONS' },
      messages: [
        imageTurn('TURN_0_IMAGE', PNG_B64),
        { role: 'assistant', content: 'TURN_1_TEXT' },
        { role: 'user', content: 'TURN_2_TEXT' },
      ],
    });

    assert.equal(last.images.length, 0, 'NO_TOOL mode never renders field 6, so nothing is sent');
    assert.match(warnings.join('\n'), /cascade_image_history_dropped count=1 .*no_vision=1/);
    assert.equal(metrics.cascade_image_history_dropped, 1);
  });
});

// G08 — the field-6 image budget is ONE budget over the whole image list, not
// a history-only allowance. Before the fix the current turn's images were
// appended unbounded (MAX_BODY_SIZE only caps the HTTP body, not the model
// context): a caller could push unlimited image bytes through the current
// turn and STILL get the full history allowance on top.
describe('Cascade shared image budget — current turn included (G08)', () => {
  it('bounds the current turn by the shared count cap', async () => {
    const a = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x44), 2, 2).toString('base64');
    const b = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x55), 2, 2).toString('base64');
    const c = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x66), 2, 2).toString('base64');
    const d = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x77), 2, 2).toString('base64');
    const { last, warnings, metrics } = await runCascade({
      env: { CASCADE_MAX_HISTORY_IMAGES: '2' },
      messages: [
        imageTurn('TURN_0_IMAGE', a),
        { role: 'assistant', content: 'TURN_1_TEXT' },
        imageTurn('TURN_2_CURRENT', b, c, d),
      ],
    });

    assert.equal(last.images.length, 2,
      'the shared cap is over the WHOLE field-6 list: 3 current + 1 history must not ride');
    assert.deepEqual(last.images.map((i) => i.base64_data), [b, c],
      'the current turn spends the budget first, in block order');
    assert.equal(metrics.cascade_image_current_dropped, 1,
      'the current-turn overflow is counted, not silent');
    assert.equal(metrics.cascade_image_history_dropped, 1,
      'the history image that lost its slot to the current turn is counted too');
    assert.match(warnings.join('\n'), /cascade_image_current_dropped count=1/);
  });

  it('the current turn spends the budget first; replayed history gets the remainder', async () => {
    const a = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x11), 2, 2).toString('base64');
    const h = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x22), 2, 2).toString('base64');
    const c = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x33), 2, 2).toString('base64');
    const { last, metrics } = await runCascade({
      env: { CASCADE_MAX_HISTORY_IMAGES: '2' },
      messages: [
        imageTurn('TURN_0_IMAGE', a),
        { role: 'assistant', content: 'TURN_1_TEXT' },
        imageTurn('TURN_2_IMAGE', h),
        { role: 'assistant', content: 'TURN_3_TEXT' },
        imageTurn('TURN_4_CURRENT', c),
      ],
    });

    assert.equal(last.images.length, 2,
      'budget 2 = current(1) + the single newest history image, not current + full history allowance');
    assert.deepEqual(last.images.map((i) => i.base64_data), [c, h],
      'current-turn image first, then the newest historical one');
    assert.ok(last.text.includes(`${IMAGE_MARKER}2 attached to this request`),
      'the surviving history image is numbered after the current one');
    assert.equal(metrics.cascade_image_history_dropped, 1,
      'the older history image that did not fit is counted');
  });

  it('bounds the single-turn path by the same shared cap', async () => {
    const a = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x11), 2, 2).toString('base64');
    const b = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x22), 2, 2).toString('base64');
    const c = encodePngRGBA(Buffer.alloc(2 * 2 * 4, 0x33), 2, 2).toString('base64');
    const { last, warnings, metrics } = await runCascade({
      env: { CASCADE_MAX_HISTORY_IMAGES: '2' },
      messages: [imageTurn('ONLY_TURN', a, b, c)],
    });

    assert.equal(last.images.length, 2,
      'a one-message request is all current turn — "no history" must not mean "no cap"');
    assert.deepEqual(last.images.map((i) => i.base64_data), [a, b]);
    assert.equal(metrics.cascade_image_current_dropped, 1);
    assert.match(warnings.join('\n'), /cascade_image_current_dropped count=1/);
  });

  it('bounds the current turn by the shared byte cap as well', async () => {
    const { last, metrics } = await runCascade({
      env: { CASCADE_MAX_HISTORY_IMAGE_BYTES: '1' },
      messages: [imageTurn('ONLY_TURN', PNG_B64)],
    });

    assert.equal(last.images.length, 0, 'a one-byte budget cannot hold the current-turn image either');
    assert.equal(metrics.cascade_image_current_dropped, 1);
  });
});
