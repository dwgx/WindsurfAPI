import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync as zlibDeflate } from 'node:zlib';
import {
  detectImageFormat,
  readImageDimensions,
  maybeShrinkImage,
  shrinkPixels,
  extractImages,
} from '../src/image.js';
import jpegDecode from '../src/vendor/jpeg-js/decoder.js';
import { decodePng } from '../src/vendor/png.js';
import { solidPngBase64, noisyPngBase64 } from './helpers/png-encode.mjs';

// Decode a JPEG base64 (production always re-encodes to JPEG) to {width,height}.
function decodeJpegDims(base64) {
  const img = jpegDecode(Buffer.from(base64, 'base64'), { useTArray: true });
  return { width: img.width, height: img.height };
}

// ---------------------------------------------------------------------------
// Minimal header byte builders. We only need the bytes the header parsers read;
// pixel data is irrelevant (pure-Node never decodes pixels). All returned as
// base64 because that is the on-the-wire contract `image.js` works with.
// ---------------------------------------------------------------------------

function pngHeader(width, height, extraLen = 0) {
  // signature(8) + IHDR chunk: len(4) + 'IHDR'(4) + width(4 BE) + height(4 BE) + ...
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(8 + 8 + extraLen);
  ihdr.writeUInt32BE(13, 0); // chunk length
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([sig, ihdr]);
}

function jpegHeader(width, height, { exifLen = 0, marker = 0xc0 } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])]; // SOI
  if (exifLen > 0) {
    // An APP0/APP1-style segment to push the SOF deeper into the stream.
    const seg = Buffer.alloc(4 + exifLen);
    seg[0] = 0xff; seg[1] = 0xe1; // APP1
    seg.writeUInt16BE(2 + exifLen, 2); // segment length includes the 2 length bytes
    parts.push(seg);
  }
  // SOF segment: FF <marker> len(2) precision(1) height(2 BE) width(2 BE) ...
  const sof = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1); // +1 component byte
  sof[0] = 0xff; sof[1] = marker;
  sof.writeUInt16BE(8, 2); // length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

function gifHeader(width, height) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function webpVp8xHeader(width, height) {
  // RIFF(4) size(4) WEBP(4) VP8X(4) flags+reserved... w-1(3 LE) h-1(3 LE)
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(26, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16); // VP8X chunk size
  // flags(1) + reserved(3) occupy 20..23
  const w = width - 1, h = height - 1;
  b[24] = w & 0xff; b[25] = (w >> 8) & 0xff; b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff; b[28] = (h >> 8) & 0xff; b[29] = (h >> 16) & 0xff;
  return b;
}

const b64 = (buf) => buf.toString('base64');

describe('detectImageFormat (magic bytes)', () => {
  it('identifies PNG / JPEG / GIF / WebP', () => {
    assert.equal(detectImageFormat(b64(pngHeader(10, 10))), 'png');
    assert.equal(detectImageFormat(b64(jpegHeader(10, 10))), 'jpeg');
    assert.equal(detectImageFormat(b64(gifHeader(10, 10))), 'gif');
    assert.equal(detectImageFormat(b64(webpVp8xHeader(10, 10))), 'webp');
  });

  it('returns null for undetectable / empty input', () => {
    assert.equal(detectImageFormat(b64(Buffer.from('not an image at all'))), null);
    assert.equal(detectImageFormat(''), null);
    assert.equal(detectImageFormat(null), null);
  });
});

describe('readImageDimensions (header only, no pixel decode)', () => {
  it('reads PNG IHDR width/height', () => {
    assert.deepEqual(readImageDimensions(b64(pngHeader(1920, 1080)), 'png'), { width: 1920, height: 1080 });
  });

  it('reads JPEG SOF width/height even behind a large EXIF segment', () => {
    const data = b64(jpegHeader(4032, 3024, { exifLen: 5000 }));
    assert.deepEqual(readImageDimensions(data, 'jpeg'), { width: 4032, height: 3024 });
  });

  it('reads GIF (little-endian) width/height', () => {
    assert.deepEqual(readImageDimensions(b64(gifHeader(640, 480)), 'gif'), { width: 640, height: 480 });
  });

  it('reads WebP VP8X 24-bit dimensions', () => {
    assert.deepEqual(readImageDimensions(b64(webpVp8xHeader(2000, 1500)), 'webp'), { width: 2000, height: 1500 });
  });

  it('falls back to magic-byte detection when the format hint is wrong', () => {
    // Declared png but the bytes are jpeg -> still parsed via detection.
    assert.deepEqual(readImageDimensions(b64(jpegHeader(800, 600)), 'png'), { width: 800, height: 600 });
  });

  it('returns null on undecodable header', () => {
    assert.equal(readImageDimensions(b64(Buffer.from('garbage')), 'png'), null);
  });
});

describe('maybeShrinkImage decision branches', () => {
  it('passes a small in-budget image through unchanged', async () => {
    const png = b64(pngHeader(100, 100));
    const r = await maybeShrinkImage({ base64_data: png, mime_type: 'image/png' });
    assert.equal(r.dropped, false);
    assert.equal(r.oversizeBytes, false);
    assert.equal(r.oversizeDimensions, false);
    assert.equal(r.base64_data, png);
    assert.equal(r.mime_type, 'image/png');
    assert.deepEqual([r.width, r.height], [100, 100]);
  });

  it('corrects a mislabeled mime from the real magic bytes', async () => {
    // bytes are jpeg, label claims png -> mime_type corrected to image/jpeg
    const jpeg = b64(jpegHeader(64, 64));
    const r = await maybeShrinkImage({ base64_data: jpeg, mime_type: 'image/png' });
    assert.equal(r.format, 'jpeg');
    assert.equal(r.mime_type, 'image/jpeg');
    assert.equal(r.dropped, false);
  });

  it('flags oversized dimensions but still forwards when re-encode cannot decode the header-only bytes', async () => {
    // These are header-only fake bytes (no real pixel data), so the decoder
    // cannot re-encode them -> falls back to forwarding the original.
    const png = b64(pngHeader(4000, 100)); // long side 4000 > 1568
    const r = await maybeShrinkImage({ base64_data: png, mime_type: 'image/png' });
    assert.equal(r.oversizeDimensions, true);
    assert.equal(r.dropped, false);
    assert.equal(r.resized, false);
    assert.equal(r.base64_data, png);
    assert.match(r.reason, /long side 4000px exceeds 1568px/);
  });

  it('respects custom maxLongSide override', async () => {
    const png = b64(pngHeader(800, 800));
    assert.equal((await maybeShrinkImage({ base64_data: png, mime_type: 'image/png' }, { maxLongSide: 512 })).oversizeDimensions, true);
    assert.equal((await maybeShrinkImage({ base64_data: png, mime_type: 'image/png' }, { maxLongSide: 1024 })).oversizeDimensions, false);
  });

  it('drops a byte-oversized image with a structured reason when it cannot be decoded', async () => {
    // Build a payload whose base64 length exceeds the byte budget but whose
    // bytes are not a decodable image -> re-encode fails -> drop.
    const big = b64(Buffer.concat([pngHeader(50, 50), Buffer.alloc(6 * 1024 * 1024)]));
    const r = await maybeShrinkImage({ base64_data: big, mime_type: 'image/png' }, { maxBase64Len: 1000 });
    assert.equal(r.dropped, true);
    assert.equal(r.oversizeBytes, true);
    assert.match(r.reason, /exceeds limit/);
  });

  it('keeps the declared label when bytes are undetectable, never throws', async () => {
    const bogus = Buffer.from('X'.repeat(40)).toString('base64');
    const r = await maybeShrinkImage({ base64_data: bogus, mime_type: 'image/png' });
    assert.equal(r.dropped, false);
    assert.equal(r.mime_type, 'image/png'); // detection failed -> keep declared
    assert.equal(r.format, 'png');          // falls back to declared format
  });
});

describe('extractImages contract preservation', () => {
  it('still returns { text, images } with {base64_data, mime_type} entries', async () => {
    const png = b64(pngHeader(120, 120));
    const out = await extractImages([
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', data: png, media_type: 'image/png' } },
    ]);
    assert.equal(out.text, 'hello');
    assert.equal(out.images.length, 1);
    assert.deepEqual(Object.keys(out.images[0]).sort(), ['base64_data', 'mime_type']);
    assert.equal(out.images[0].base64_data, png);
    assert.equal(out.images[0].mime_type, 'image/png');
  });

  it('skips a byte-oversized base64 image instead of forwarding it (was a silent drop, now logged)', async () => {
    const big = 'A'.repeat(Math.ceil(5 * 1024 * 1024 * 4 / 3) + 500);
    const out = await extractImages([
      { type: 'image', source: { type: 'base64', data: big, media_type: 'image/png' } },
    ]);
    assert.equal(out.images.length, 0);
  });

  it('corrects mislabeled mime for an OpenAI image_url data URL', async () => {
    const jpeg = b64(jpegHeader(64, 64));
    const out = await extractImages([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${jpeg}` } },
    ]);
    assert.equal(out.images.length, 1);
    assert.equal(out.images[0].mime_type, 'image/jpeg');
  });

  it('forwards an oversized-dimension image (within byte budget) rather than dropping it', async () => {
    const png = b64(pngHeader(3000, 200));
    const out = await extractImages([
      { type: 'image', source: { type: 'base64', data: png, media_type: 'image/png' } },
    ]);
    assert.equal(out.images.length, 1);
    assert.equal(out.images[0].base64_data, png);
  });
});

// ---------------------------------------------------------------------------
// Real-pixel tests. Unlike the header-only fixtures above, these build genuine
// decodable images with the pure-Node PNG encoder helper so the actual downscale
// + JPEG re-encode path (vendored zero-dep codecs) runs end to end (no network,
// no accounts, no npm deps).
// ---------------------------------------------------------------------------

// Solid-color image — compresses to almost nothing as JPEG (used for dimension
// tests where byte size is irrelevant). Pure-Node PNG builder, no deps.
async function realPng(width, height) {
  return solidPngBase64(width, height, [255, 0, 0, 255]);
}

// Random-noise image — does NOT compress, so JPEG byte size stays large. Used to
// exercise the two-stage byte-convergence loop. Deterministic (seeded) so the
// test is reproducible.
async function noisyPng(width, height) {
  return noisyPngBase64(width, height, (width * 31 + height) >>> 0);
}

describe('shrinkPixels (real vendored decode + re-encode)', () => {
  it('downscales an oversized-dimension image so the long side fits the cap', async () => {
    const png = await realPng(2400, 600);
    const r = await shrinkPixels(png, { maxLongSide: 1568, maxBytes: 400000 });
    assert.equal(r.ok, true);
    assert.equal(r.mime_type, 'image/jpeg');
    const decoded = decodeJpegDims(r.base64_data);
    assert.ok(Math.max(decoded.width, decoded.height) <= 1568,
      `long side ${Math.max(decoded.width, decoded.height)} should be <= 1568`);
    // Aspect ratio (4:1) preserved within rounding.
    assert.ok(Math.abs(decoded.width / decoded.height - 4) < 0.05);
  });

  it('two-stage convergence drives a noisy image under a tight byte budget', async () => {
    const png = await noisyPng(1200, 1200); // ~incompressible
    const maxBytes = 20000;
    const r = await shrinkPixels(png, { maxLongSide: 1568, maxBytes, quality: 85 });
    assert.equal(r.ok, true);
    assert.ok(r.base64_data.length <= maxBytes,
      `re-encoded base64 ${r.base64_data.length} should be <= ${maxBytes}`);
    assert.equal(r.mime_type, 'image/jpeg');
  });

  it('returns ok:false on undecodable data (caller keeps original)', async () => {
    const r = await shrinkPixels(Buffer.from('not a real image').toString('base64'));
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  it('returns ok:false for a format the vendored codecs do not support (WebP)', async () => {
    // WebP is intentionally out of scope for the zero-dep re-encoder; it must
    // degrade to ok:false so maybeShrinkImage forwards the original untouched
    // rather than throwing.
    const riff = Buffer.alloc(64);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(56, 4);
    riff.write('WEBP', 8, 'ascii');
    riff.write('VP8 ', 12, 'ascii');
    const r = await shrinkPixels(riff.toString('base64'));
    assert.equal(r.ok, false);
    assert.match(r.error, /unsupported image format/);
  });

  it('rejects an interlaced/16-bit PNG variant via ok:false (safe passthrough)', async () => {
    // Craft a PNG whose IHDR claims 16-bit depth — the decoder must throw, which
    // shrinkPixels turns into ok:false rather than a crash or a bad image.
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(32, 0); ihdrData.writeUInt32BE(32, 4);
    ihdrData[8] = 16; ihdrData[9] = 6; // 16-bit RGBA -> unsupported
    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(13, 0);
    const png = Buffer.concat([sig, lenBuf, Buffer.from('IHDR'), ihdrData, Buffer.alloc(4)]);
    const r = await shrinkPixels(png.toString('base64'));
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });
});

// ---------------------------------------------------------------------------
// PNG-1 / IMG-1 decode-bomb regression. A crafted PNG can declare enormous IHDR
// dimensions backed by a few KB of high-ratio IDAT. Before the fix, decodePng
// ran an unbounded inflateSync and then allocated unfilter/toRGBA buffers sized
// from the giant dimensions — peak RSS >1GB, OOM-aborting the single process.
// The fix rejects the dimensions at the header and caps inflate output, and
// shrinkPixels bails on the header pixel budget before ever allocating. All of
// this must complete in milliseconds with a few KB of input (no GB allocation).
// ---------------------------------------------------------------------------

// Build a syntactically valid PNG with attacker-declared IHDR dimensions and a
// small, highly-compressible IDAT (a few KB expanding to nothing near what the
// dimensions imply). Deliberately does NOT match the declared size — the point
// is that the guard fires before the size mismatch would even matter.
function bombPng(declW, declH) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(declW, 0);
  ihdrData.writeUInt32BE(declH, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type 6 = RGBA
  ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
  const ihdrLen = Buffer.alloc(4); ihdrLen.writeUInt32BE(13, 0);
  // A few KB of zeros deflate to a tiny high-ratio IDAT (the "bomb" payload).
  const idatRaw = zlibDeflate(Buffer.alloc(64 * 1024, 0));
  const idatLen = Buffer.alloc(4); idatLen.writeUInt32BE(idatRaw.length, 0);
  const iendLen = Buffer.alloc(4); iendLen.writeUInt32BE(0, 0);
  return Buffer.concat([
    sig,
    ihdrLen, Buffer.from('IHDR'), ihdrData, Buffer.alloc(4),
    idatLen, Buffer.from('IDAT'), idatRaw, Buffer.alloc(4),
    iendLen, Buffer.from('IEND'), Buffer.alloc(4),
  ]);
}

describe('PNG decode-bomb guard (PNG-1 / IMG-1)', () => {
  it('decodePng rejects an over-dimension IHDR without unbounded inflate/alloc', () => {
    // 16000x16000 = 256M pixels -> ~1GB RGBA before the fix. Must throw fast.
    const png = bombPng(16000, 16000);
    const t0 = Date.now();
    assert.throws(() => decodePng(png), /exceed|limit/i);
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `decodePng took ${ms}ms — possible unbounded decode regression`);
  });

  it('decodePng rejects a single over-dimension side (per-side cap)', () => {
    // width within the per-side cap product-wise only if height tiny; here the
    // per-side ceiling (32767) itself is exceeded.
    assert.throws(() => decodePng(bombPng(100000, 2)), /exceed|limit/i);
  });

  it('decodePng caps inflate output so a high-ratio IDAT cannot balloon', () => {
    // Dimensions are within the pixel-count budget but the IDAT (64KB of zeros)
    // inflates larger than the tiny declared frame implies -> inflateSync must
    // hit maxOutputLength and throw rather than allocating the full expansion.
    const png = bombPng(4, 4); // expected raw = 4*(16+1)=68 bytes, far under IDAT
    assert.throws(() => decodePng(png), /Buffer larger|maxOutputLength|too short|ERR_BUFFER/i);
  });

  it('shrinkPixels degrades a decode-bomb PNG to ok:false in milliseconds (passthrough)', async () => {
    const png = bombPng(20000, 20000).toString('base64'); // 400M pixels declared
    const t0 = Date.now();
    const r = await shrinkPixels(png);
    const ms = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.ok(ms < 2000, `shrinkPixels took ${ms}ms — bomb not short-circuited`);
  });

  it('maybeShrinkImage forwards a decode-bomb PNG unchanged instead of crashing', async () => {
    // Header declares 16000x16000 (oversizeDimensions), tiny bytes (in byte
    // budget). Re-encode can't decode the bomb -> original forwarded as-is,
    // never OOM. This is the end-to-end passthrough contract.
    const png = bombPng(16000, 16000).toString('base64');
    const r = await maybeShrinkImage({ base64_data: png, mime_type: 'image/png' });
    assert.equal(r.dropped, false);
    assert.equal(r.resized, false);
    assert.equal(r.base64_data, png); // forwarded unchanged
    assert.equal(r.oversizeDimensions, true);
  });
});


describe('maybeShrinkImage real re-encode wiring', () => {
  it('re-encodes a byte-oversized real image to JPEG instead of dropping it', async () => {
    const png = await noisyPng(1500, 1500);
    const maxBase64Len = Math.floor(png.length / 2); // force byte-oversize
    const r = await maybeShrinkImage(
      { base64_data: png, mime_type: 'image/png' },
      { maxBase64Len, maxBytes: maxBase64Len },
    );
    assert.equal(r.dropped, false);
    assert.equal(r.resized, true);
    assert.equal(r.mime_type, 'image/jpeg');
    assert.ok(r.base64_data.length <= maxBase64Len);
    assert.notEqual(r.base64_data, png);
  });

  it('downscales an oversized-dimension real image and switches mime to jpeg', async () => {
    const png = await realPng(3000, 750); // long side 3000 > 1568, tiny bytes
    const r = await maybeShrinkImage({ base64_data: png, mime_type: 'image/png' });
    assert.equal(r.dropped, false);
    assert.equal(r.resized, true);
    assert.equal(r.mime_type, 'image/jpeg');
    const decoded = decodeJpegDims(r.base64_data);
    assert.ok(Math.max(decoded.width, decoded.height) <= 1568);
  });

  it('passes a small real image through untouched (no re-encode)', async () => {
    const png = await realPng(200, 200);
    const r = await maybeShrinkImage({ base64_data: png, mime_type: 'image/png' });
    assert.equal(r.resized, false);
    assert.equal(r.dropped, false);
    assert.equal(r.base64_data, png);
    assert.equal(r.mime_type, 'image/png');
  });

  it('drops a byte-oversized GIF without re-encoding (may be animated)', async () => {
    // Header-only GIF bytes padded over the limit: format detects as gif, so the
    // animated-safe branch drops it rather than flattening to a JPEG still.
    const big = b64(Buffer.concat([gifHeader(50, 50), Buffer.alloc(2 * 1024 * 1024)]));
    const r = await maybeShrinkImage({ base64_data: big, mime_type: 'image/gif' }, { maxBase64Len: 1000 });
    assert.equal(r.dropped, true);
    assert.equal(r.format, 'gif');
    assert.match(r.reason, /GIF/);
  });

  it('extractImages still emits the strict {base64_data, mime_type} contract after a re-encode', async () => {
    // A dimension-oversized real image goes through extractImages -> pushImage
    // -> maybeShrinkImage with module defaults and must still come out as a
    // strict {base64_data, mime_type} pair.
    const bigPng = await realPng(4000, 1000); // dimension-oversize, tiny bytes
    const out = await extractImages([
      { type: 'image', source: { type: 'base64', data: bigPng, media_type: 'image/png' } },
    ]);
    assert.equal(out.images.length, 1);
    assert.deepEqual(Object.keys(out.images[0]).sort(), ['base64_data', 'mime_type']);
    assert.equal(out.images[0].mime_type, 'image/jpeg'); // re-encoded
    const decoded = decodeJpegDims(out.images[0].base64_data);
    assert.ok(Math.max(decoded.width, decoded.height) <= 1568);
  });
});
