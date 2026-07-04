import https from 'node:https';
import http from 'node:http';
import { lookup as dnsLookup } from 'node:dns';
import { log } from './config.js';
import { tryExtractPdf } from './pdf.js';
import { isPrivateIp, resolvePublicAddresses } from './net-safety.js';
import { decodePng } from './vendor/png.js';
import jpegDecode from './vendor/jpeg-js/decoder.js';
import jpegEncode from './vendor/jpeg-js/encoder.js';

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_BASE64_LEN = Math.ceil(MAX_SIZE * 4 / 3) + 100;
const MAX_REDIRECTS = 3;
const MIME_OK = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// ---------------------------------------------------------------------------
// Inbound image inspection (pure-Node header parsing — NO pixel decode)
//
// Algorithm/defaults adapted from ZyphrZero kiro.rs `src/image_resize.rs` (MIT) —
// thanks. Anthropic's vision encoder caps the long side at 1568px (patch-grid
// boundary); AWS Q / Windsurf upstreams enforce a hard per-field byte limit, so
// oversized inbound images either get billed at full size or fail the request.
//
// Pure-Node header parsing (format detection, dimension reads, oversize
// classification) is the cheap fast path. Actual pixel downscale / re-encode
// is done by `shrinkPixels` using vendored zero-dependency codecs (a pure-Node
// PNG decoder over node:zlib + the BSD-3 jpeg-js decode/encode, both under
// `src/vendor/`). Any decode/encode failure — including an unsupported format
// such as WebP or an exotic PNG variant — degrades to a safe passthrough rather
// than failing the request or the server.
//
// What this module does:
//   - magic-byte format detection (corrects a mislabeled media_type so the
//     upstream's strict MIME check doesn't reject the image)
//   - header-only dimension reads for PNG / JPEG / GIF / WebP (< 1ms, no decode)
//   - structured oversize classification (bytes vs. dimensions)
//   - real pixel downscale + JPEG re-encode for oversized images so they are
//     sent (like the Devin CLI / Desktop) instead of dropped or billed at full
//     size — see `shrinkPixels`
// ---------------------------------------------------------------------------

const IMAGE_MAX_LONG_SIDE = parseInt(process.env.WINDSURFAPI_IMAGE_MAX_LONG_SIDE || '1568', 10);
// Re-encode TARGET budget, measured in base64-string length (the on-the-wire
// unit the upstream per-field limit applies to). Oversized images are
// downscaled / re-encoded toward this. Default 400 KB mirrors ZyphrZero's
// `DEFAULT_MAX_BYTES` (a safe margin under the upstream hard field limit).
const IMAGE_MAX_BYTES = parseInt(process.env.WINDSURFAPI_IMAGE_MAX_BYTES || '400000', 10);
// JPEG re-encode starting quality (two-stage convergence steps down from here).
const IMAGE_JPEG_QUALITY = parseInt(process.env.WINDSURFAPI_IMAGE_JPEG_QUALITY || '85', 10);
// Hard drop ceiling: kept at the existing 5 MB so behavior does not regress.
// Only used as a last resort when even a re-encode cannot get under it (or the
// image could not be decoded). A re-encode normally lands far below this.
const IMAGE_MAX_BASE64_LEN = MAX_BASE64_LEN;

// Pixel-count ceiling for attempting a pixel decode. A crafted PNG can declare
// enormous IHDR dimensions with a few KB of high-ratio IDAT (a decode bomb);
// decoding it would allocate gigabytes. The vendored png.js rejects such
// dimensions itself, but we also predict the pixel budget here from the cheap
// header read so we never even hand oversized dimensions to the decoder. Kept
// aligned with png.js MAX_PIXELS (~40M pixels; 4K is ~8MP, so ample headroom).
const IMAGE_MAX_DECODE_PIXELS = 40 * 1024 * 1024;

// Decode a PNG or JPEG buffer to { width, height, data:RGBA } using the vendored
// zero-dependency codecs. WebP / GIF / exotic variants throw here, which the
// caller turns into a safe passthrough. Format is decided by magic bytes, not the
// declared label, so a mislabeled image still decodes.
function decodePixels(buf) {
  const b = buf.subarray(0, 4);
  // PNG magic: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return decodePng(buf);
  }
  // JPEG magic: FF D8
  if (b[0] === 0xff && b[1] === 0xd8) {
    const img = jpegDecode(buf, { useTArray: true, maxResolutionInMP: 200, maxMemoryUsageInMB: 512 });
    return { width: img.width, height: img.height, data: img.data };
  }
  throw new Error('unsupported image format for re-encode (only PNG/JPEG)');
}

// Bilinear downscale of an RGBA buffer to (dstW x dstH). Pure Node, no deps.
// Only ever called to shrink, so no special upscale handling is needed.
function scaleRGBA(src, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  // Map dst pixel centers back into src space.
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy = (dy + 0.5) * yRatio - 0.5;
    let y0 = Math.floor(sy);
    const wy = sy - y0;
    if (y0 < 0) y0 = 0;
    const y1 = Math.min(y0 + 1, srcH - 1);
    for (let dx = 0; dx < dstW; dx++) {
      const sx = (dx + 0.5) * xRatio - 0.5;
      let x0 = Math.floor(sx);
      const wx = sx - x0;
      if (x0 < 0) x0 = 0;
      const x1 = Math.min(x0 + 1, srcW - 1);
      const o = (dy * dstW + dx) * 4;
      const i00 = (y0 * srcW + x0) * 4;
      const i01 = (y0 * srcW + x1) * 4;
      const i10 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - wx) + src[i01 + c] * wx;
        const bot = src[i10 + c] * (1 - wx) + src[i11 + c] * wx;
        out[o + c] = (top * (1 - wy) + bot * wy + 0.5) | 0;
      }
    }
  }
  return out;
}

// Real pixel downscale + JPEG re-encode. Decodes the base64 image, scales it so
// the long side <= maxLongSide, then runs a two-stage convergence to fit
// maxBytes (base64-length budget): first step JPEG quality down to a floor,
// then shrink the long side and retry. GIF is skipped by the caller (may be
// animated). On ANY decode/encode failure this returns { ok:false } and the
// caller keeps the original image — a bad image must never fail the request.
// Algorithm/defaults adapted from ZyphrZero kiro.rs `src/image_resize.rs` (MIT).
export async function shrinkPixels(base64, opts = {}) {
  const maxLongSide = opts.maxLongSide ?? IMAGE_MAX_LONG_SIDE;
  const maxBytes = opts.maxBytes ?? IMAGE_MAX_BYTES;
  const startQuality = opts.quality ?? IMAGE_JPEG_QUALITY;
  const MIN_JPEG_QUALITY = 60; // quality floor before we shrink dimensions further
  // Dimension floor for the byte-convergence loop. The vendored jpeg-js encoder
  // produces larger output than jimp's for incompressible content, so allow the
  // long side to shrink further than jimp needed (128 vs the old 256) to still
  // meet a tight byte budget for near-random images. Real screenshots compress
  // well and rarely reach this floor.
  const MIN_LONG_SIDE = 128;

  try {
    const buf = Buffer.from(base64, 'base64');
    // Pre-decode budget check: read the header dimensions (cheap, no pixel
    // decode) and bail before allocating anything if the declared pixel count is
    // absurd. This shields the decoders from a crafted decode bomb (tiny bytes,
    // giant IHDR/SOF dimensions) — the vendored png.js also self-guards, but
    // refusing here means we never even attempt the multi-hundred-MB allocation.
    // Returning ok:false makes the caller keep the original image (passthrough).
    const headerDims = readImageDimensions(base64);
    if (headerDims && headerDims.width * headerDims.height > IMAGE_MAX_DECODE_PIXELS) {
      return { ok: false, error: `image ${headerDims.width}x${headerDims.height} exceeds decode pixel budget` };
    }
    const original = decodePixels(buf); // { width, height, data:RGBA }
    const srcW = original.width;
    const srcH = original.height;
    if (!srcW || !srcH) return { ok: false, error: 'decoded image has no dimensions' };

    let curLong = Math.min(maxLongSide, Math.max(srcW, srcH));
    let outBase64 = '';
    for (;;) {
      // Scale from the full-res original each pass so repeated downscales never
      // compound quality loss.
      let w = srcW, h = srcH, data = original.data;
      if (Math.max(srcW, srcH) > curLong) {
        const scale = curLong / Math.max(srcW, srcH);
        w = Math.max(1, Math.round(srcW * scale));
        h = Math.max(1, Math.round(srcH * scale));
        data = scaleRGBA(original.data, srcW, srcH, w, h);
      }
      let quality = startQuality;
      for (;;) {
        const jpg = jpegEncode({ data, width: w, height: h }, quality);
        outBase64 = jpg.data.toString('base64');
        if (outBase64.length <= maxBytes || quality <= MIN_JPEG_QUALITY) break;
        quality = Math.max(MIN_JPEG_QUALITY, quality - 10);
      }
      if (outBase64.length <= maxBytes || curLong <= MIN_LONG_SIDE) break;
      curLong = Math.max(MIN_LONG_SIDE, Math.round(curLong * 0.8));
    }
    return { ok: true, base64_data: outBase64, mime_type: 'image/jpeg' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

const FORMAT_TO_MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// Decode the leading `n` base64 chars into bytes (cheap header probe).
function decodeHead(base64, n) {
  // base64 is 4 chars -> 3 bytes; round the char count down to a 4-char boundary
  // so Buffer.from never sees a partial group.
  const chars = Math.min(base64.length, Math.ceil(n / 3) * 4) & ~3;
  if (chars <= 0) return Buffer.alloc(0);
  try { return Buffer.from(base64.slice(0, chars), 'base64'); }
  catch { return Buffer.alloc(0); }
}

// Detect the real format from magic bytes. Returns 'png'|'jpeg'|'gif'|'webp'|null.
// `null` means "undetectable" — callers keep the declared label, never drop.
export function detectImageFormat(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) return null;
  const b = decodeHead(base64, 16);
  if (b.length < 4) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  // GIF: "GIF87a" / "GIF89a"
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 &&
      b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  // WebP: "RIFF" .... "WEBP"
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readPngDimensions(b) {
  // signature(8) + len(4) + 'IHDR'(4) + width(4 BE) + height(4 BE)
  if (b.length < 24) return null;
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null; // 'IHDR'
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function readJpegDimensions(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; } // resync over fill bytes
    const marker = b[i + 1];
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (i + 4 > b.length) break;
    const segLen = b.readUInt16BE(i + 2);
    if (segLen < 2) break;
    if (JPEG_SOF_MARKERS.has(marker)) {
      // SOF: marker(2) + len(2) + precision(1) + height(2 BE) + width(2 BE)
      if (i + 9 > b.length) break;
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + segLen;
  }
  return null;
}

function readGifDimensions(b) {
  if (b.length < 10) return null;
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

function readWebpDimensions(b) {
  if (b.length < 16) return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    // Lossy: key-frame start code 9D 01 2A at offset 23, dims at 26/28 (14-bit LE).
    if (b.length < 30) return null;
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    const width = b.readUInt16LE(26) & 0x3fff;
    const height = b.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === 'VP8L') {
    // Lossless: signature 0x2F at offset 20, then 14-bit width-1 / height-1.
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6));
    return { width, height };
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit LE width-1 / height-1 at offsets 24 / 27.
    if (b.length < 30) return null;
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width, height };
  }
  return null;
}

// Read pixel dimensions from the header only. Returns {width,height} or null.
// `format` is a hint ('png'|'jpeg'|'gif'|'webp'); detection falls back to magic
// bytes when the hint is missing/unknown.
export function readImageDimensions(base64, format) {
  if (typeof base64 !== 'string' || base64.length === 0) return null;
  // Magic-byte detection always wins: a mislabeled media_type (e.g. jpeg bytes
  // tagged image/png) must not pick the wrong header parser. The hint is only a
  // fallback for the rare case detection can't classify the bytes.
  const fmt = detectImageFormat(base64) || ((format && FORMAT_TO_MIME[format]) ? format : null);
  if (!fmt) return null;
  // JPEG SOF can sit behind large EXIF/ICC segments; decode a generous head.
  const headBytes = fmt === 'jpeg' ? 256 * 1024 : 64;
  const b = decodeHead(base64, headBytes);
  switch (fmt) {
    case 'png': return readPngDimensions(b);
    case 'jpeg': return readJpegDimensions(b);
    case 'gif': return readGifDimensions(b);
    case 'webp': return readWebpDimensions(b);
    default: return null;
  }
}

function mimeToFormat(mime) {
  const sub = String(mime || '').toLowerCase().split('/')[1] || '';
  if (sub === 'jpg' || sub === 'jpeg') return 'jpeg';
  if (sub === 'png') return 'png';
  if (sub === 'gif') return 'gif';
  if (sub === 'webp') return 'webp';
  return null;
}

// Inbound image gate. Inspects one image, corrects its declared mime from the
// real magic bytes, classifies oversize (bytes vs. dimensions), and — for a
// byte-oversized image — attempts a real pixel downscale + JPEG re-encode via
// `shrinkPixels` so the image is sent (like the Devin CLI/Desktop) instead of
// dropped. Async because the re-encode decodes pixels.
//   - mime corrected from magic bytes (prevents upstream MIME mismatch)
//   - oversized dimensions within byte budget -> forwarded as-is (token cost only)
//   - byte-oversized -> re-encode; only if the re-encode still can't fit (or the
//     image is a GIF / undecodable) is it dropped, with a structured reason
//
// Returns { base64_data, mime_type, format, width, height, base64Len,
//           oversizeBytes, oversizeDimensions, resized, dropped, reason }.
// `dropped:true` means the caller should skip sending this image. `resized:true`
// means base64_data/mime_type were replaced with the re-encoded JPEG.
export async function maybeShrinkImage(img, opts = {}) {
  const base64 = img?.base64_data || '';
  const declaredMime = (img?.mime_type || 'image/png').toLowerCase();
  const maxLongSide = opts.maxLongSide ?? IMAGE_MAX_LONG_SIDE;
  const maxBase64Len = opts.maxBase64Len ?? IMAGE_MAX_BASE64_LEN;
  const maxBytes = opts.maxBytes ?? IMAGE_MAX_BYTES;
  const quality = opts.quality ?? IMAGE_JPEG_QUALITY;

  const base64Len = base64.length;
  const detected = detectImageFormat(base64);
  const declaredFormat = mimeToFormat(declaredMime);
  // Correct the format only when detection succeeds and disagrees with the label.
  const format = detected || declaredFormat || null;
  const mime_type = (detected && FORMAT_TO_MIME[detected]) || declaredMime;

  const dims = readImageDimensions(base64, format);
  const width = dims?.width ?? null;
  const height = dims?.height ?? null;

  const oversizeDimensions = dims ? Math.max(width, height) > maxLongSide : false;
  const oversizeBytes = base64Len > maxBase64Len;

  // Byte-oversized: try a real downscale + re-encode to rescue the image rather
  // than forwarding it (would fail the whole upstream request) or dropping it.
  // GIF is left alone (may be animated); a re-encode to JPEG would kill the
  // animation, so a byte-oversized GIF is still dropped.
  if (oversizeBytes) {
    if (format !== 'gif') {
      const shrunk = await shrinkPixels(base64, { maxLongSide, maxBytes, quality });
      if (shrunk.ok && shrunk.base64_data.length <= maxBase64Len) {
        return {
          base64_data: shrunk.base64_data, mime_type: shrunk.mime_type, format: 'jpeg',
          width, height, base64Len: shrunk.base64_data.length,
          oversizeBytes: false, oversizeDimensions: false, resized: true, dropped: false,
          reason: `re-encoded ${base64Len}B -> ${shrunk.base64_data.length}B JPEG (was byte-oversized)`,
        };
      }
      return {
        base64_data: base64, mime_type, format, width, height, base64Len,
        oversizeBytes: true, oversizeDimensions, resized: false, dropped: true,
        reason: shrunk.ok
          ? `base64 length ${base64Len} exceeds limit ${maxBase64Len}; re-encode reached ${shrunk.base64_data.length} but still over limit`
          : `base64 length ${base64Len} exceeds limit ${maxBase64Len} and re-encode failed: ${shrunk.error}`,
      };
    }
    return {
      base64_data: base64, mime_type, format, width, height, base64Len,
      oversizeBytes: true, oversizeDimensions, resized: false, dropped: true,
      reason: `base64 length ${base64Len} exceeds limit ${maxBase64Len} and GIF is not re-encoded (may be animated)`,
    };
  }

  // Within the hard byte budget but the long side is over the cap: downscale +
  // re-encode so we send a correctly-sized image (saves tokens, avoids upstream
  // re-downscaling). GIF stays untouched. A failed re-encode forwards as-is.
  if (oversizeDimensions && format !== 'gif') {
    const shrunk = await shrinkPixels(base64, { maxLongSide, maxBytes, quality });
    if (shrunk.ok && shrunk.base64_data.length <= maxBase64Len) {
      return {
        base64_data: shrunk.base64_data, mime_type: shrunk.mime_type, format: 'jpeg',
        width, height, base64Len: shrunk.base64_data.length,
        oversizeBytes: false, oversizeDimensions: false, resized: true, dropped: false,
        reason: `re-encoded long side ${Math.max(width, height)}px -> <=${maxLongSide}px JPEG`,
      };
    }
    // Re-encode failed or didn't help: forward the original (token cost only).
    return {
      base64_data: base64, mime_type, format, width, height, base64Len,
      oversizeBytes: false, oversizeDimensions: true, resized: false, dropped: false,
      reason: `long side ${Math.max(width, height)}px exceeds ${maxLongSide}px (forwarded as-is; re-encode unavailable)`,
    };
  }

  return {
    base64_data: base64, mime_type, format, width, height, base64Len,
    oversizeBytes: false, oversizeDimensions, resized: false, dropped: false,
    reason: oversizeDimensions
      ? `long side ${Math.max(width, height)}px exceeds ${maxLongSide}px (GIF forwarded as-is)`
      : null,
  };
}
// http/https `lookup` hook: runs in place of the default DNS resolution.
// Rejecting here means the request never opens a socket to the internal
// address, closing the DNS-rebinding gap in the string-based host check.
function safeLookup(hostname, options, callback) {
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const addrs = Array.isArray(address) ? address : [{ address, family }];
    for (const a of addrs) {
      if (isPrivateIp(a.address)) {
        return callback(new Error(`Image URL resolves to private address: ${a.address}`));
      }
    }
    callback(null, address, family);
  });
}

function validateImageUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid image URL'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('Image URL must be http or https');
  if (String(parsed.hostname).toLowerCase() === 'localhost' || isPrivateIp(parsed.hostname))
    throw new Error('Image URL targets a private/internal address');
  return parsed;
}

export function parseDataUrl(url) {
  const clean = url.replace(/\s/g, '');
  const m = clean.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) return null;
  if (m[2].length > MAX_BASE64_LEN) throw new Error(`Image data URL exceeds ${MAX_SIZE} byte limit`);
  return { base64_data: m[2], mime_type: m[1].toLowerCase() };
}

// Extract base64 body from a data URL of any mime type. Used for PDF
// payloads which don't match parseDataUrl's image-only regex.
export function parseGenericDataUrl(url) {
  const clean = url.replace(/\s/g, '');
  const m = clean.match(/^data:([a-z0-9][a-z0-9.+/-]+);base64,(.+)$/i);
  if (!m) return null;
  if (m[2].length > MAX_BASE64_LEN) throw new Error(`Data URL exceeds ${MAX_SIZE} byte limit`);
  return { base64_data: m[2], mime_type: m[1].toLowerCase() };
}

export async function assertPublicUrlHost(urlOrHost, lookupFn = dnsLookup) {
  let host = urlOrHost;
  try { host = new URL(urlOrHost).hostname; } catch {}
  return resolvePublicAddresses(host, lookupFn);
}

// Gate one image through `maybeShrinkImage`, then either push it (corrected
// mime, real downscale/re-encode when oversized) or log a structured skip.
// Async because `maybeShrinkImage` may decode pixels to re-encode. Returns the
// pushed image object or null.
export async function pushImage(images, image) {
  if (!image || !image.base64_data) return null;
  const decision = await maybeShrinkImage(image);
  if (decision.dropped) {
    log.warn(`Image skipped: ${decision.reason} (format=${decision.format || 'unknown'}, ${decision.width || '?'}x${decision.height || '?'})`);
    return null;
  }
  if (decision.resized) {
    log.info(`Image re-encoded: ${decision.reason}`);
  } else if (decision.oversizeDimensions) {
    log.warn(`Image oversized: ${decision.reason}`);
  }
  const out = { base64_data: decision.base64_data, mime_type: decision.mime_type };
  images.push(out);
  return out;
}

export function fetchImageUrl(url, timeoutMs = 8000, _depth = 0) {
  if (_depth > MAX_REDIRECTS) return Promise.reject(new Error('Too many image redirects'));
  validateImageUrl(url);

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { 'Accept': 'image/*' }, lookup: safeLookup }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchImageUrl(res.headers.location, timeoutMs, _depth + 1).then(
          v => done(resolve, v), e => done(reject, e)
        );
      }
      if (res.statusCode !== 200) {
        res.resume();
        return done(reject, new Error(`Image fetch HTTP ${res.statusCode}`));
      }
      const mime = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!MIME_OK.has(mime)) {
        res.resume();
        return done(reject, new Error(`Unsupported image type: ${mime}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        if (settled) return;
        size += d.length;
        if (size > MAX_SIZE) { res.destroy(); done(reject, new Error(`Image exceeds ${MAX_SIZE} bytes`)); }
        else chunks.push(d);
      });
      res.on('end', () => done(resolve, { base64_data: Buffer.concat(chunks).toString('base64'), mime_type: mime }));
      res.on('error', (e) => done(reject, e));
    });
    req.on('error', (e) => done(reject, e));
    req.on('timeout', () => { req.destroy(); done(reject, new Error('Image fetch timeout')); });
  });
}

export async function extractImages(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return { text: String(contentBlocks ?? ''), images: [] };

  let text = '';
  const images = [];

  for (const block of contentBlocks) {
    if (!block || typeof block === 'string') { text += block || ''; continue; }

    if (block.type === 'text') {
      text += block.text || '';
    } else if (block.type === 'document') {
      const src = block.source || {};
      const mime = (src.media_type || '').toLowerCase();
      if (mime === 'application/pdf' && src.data) {
        const pdf = tryExtractPdf(src.data);
        if (pdf?.text) {
          text += `\n[PDF Document — ${pdf.pageCount} page(s)]\n${pdf.text}\n`;
          log.info(`PDF extracted: ${pdf.pageCount} pages, ${pdf.text.length} chars`);
        } else {
          text += '\n[PDF Document — no extractable text (scanned/image-only PDF)]\n';
        }
      }
    } else if (block.type === 'image') {
      const src = block.source || {};
      const mime = (src.media_type || '').toLowerCase();
      if (mime === 'application/pdf' && src.data) {
        const pdf = tryExtractPdf(src.data);
        if (pdf?.text) {
          text += `\n[PDF Document — ${pdf.pageCount} page(s)]\n${pdf.text}\n`;
        }
        continue;
      }
      try {
        if ((src.type === 'base64' || !src.type) && src.data) {
          await pushImage(images, { base64_data: src.data, mime_type: src.media_type || 'image/png' });
        } else if (src.type === 'url' && src.url) {
          await pushImage(images, await fetchImageUrl(src.url));
        }
      } catch (e) { log.warn(`Image extraction failed: ${e.message}`); }
    } else if (block.type === 'image_url') {
      const url = block.image_url?.url || '';
      try {
        if (url.startsWith('data:')) {
          // PDF-as-data-URL: let the model "see" it via text extraction
          // rather than treating it as an unsupported image type.
          const lower = url.slice(0, 40).toLowerCase();
          if (lower.startsWith('data:application/pdf')) {
            const g = parseGenericDataUrl(url);
            if (g?.base64_data) {
              const pdf = tryExtractPdf(g.base64_data);
              if (pdf?.text) {
                text += `\n[PDF Document — ${pdf.pageCount} page(s)]\n${pdf.text}\n`;
                log.info(`PDF extracted (image_url data URL): ${pdf.pageCount} pages, ${pdf.text.length} chars`);
              } else {
                text += '\n[PDF Document — no extractable text (scanned/image-only PDF)]\n';
              }
            }
            continue;
          }
          const parsed = parseDataUrl(url);
          if (parsed) await pushImage(images, parsed);
        } else if (url.startsWith('https://') || url.startsWith('http://')) {
          await pushImage(images, await fetchImageUrl(url));
        }
      } catch (e) { log.warn(`Image fetch failed: ${e.message}`); }
    } else if (block.type === 'file' || block.type === 'input_file') {
      // OpenAI PDF input: { type:'file', file:{ filename, file_data:'data:application/pdf;base64,...' } }
      // or file_id (uploaded via Files API — we can't fetch, so ignore).
      const file = block.file || {};
      const dataUrl = file.file_data || file.url || '';
      if (dataUrl.startsWith('data:application/pdf')) {
        const g = parseGenericDataUrl(dataUrl);
        if (g?.base64_data) {
          const pdf = tryExtractPdf(g.base64_data);
          if (pdf?.text) {
            const label = file.filename ? ` "${file.filename}"` : '';
            text += `\n[PDF Document${label} — ${pdf.pageCount} page(s)]\n${pdf.text}\n`;
            log.info(`PDF extracted (OpenAI file block): ${pdf.pageCount} pages, ${pdf.text.length} chars`);
          } else {
            text += '\n[PDF Document — no extractable text (scanned/image-only PDF)]\n';
          }
        }
      } else if (dataUrl && !file.file_id) {
        log.warn(`Unsupported file block data URL: ${dataUrl.slice(0, 40)}...`);
      } else if (file.file_id) {
        log.warn(`File block references file_id=${file.file_id} — upload API not supported, skipping`);
      }
    }
  }

  return { text, images };
}
