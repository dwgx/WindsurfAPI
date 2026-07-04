// Minimal pure-Node PNG decoder — original to WindsurfAPI, built on node:zlib.
//
// Scope: 8-bit non-interlaced PNG in grayscale / grayscale+alpha / RGB / RGBA /
// palette (indexed) color types. This covers the overwhelming majority of real
// screenshots and vision inputs. Anything outside that scope (16-bit depth,
// Adam7 interlacing, unknown color type) throws — callers (src/image.js) treat a
// throw as "cannot re-encode" and fall back to forwarding the original image, so
// an unsupported PNG never fails the request.
//
// Output contract mirrors the vendored jpeg-js decoder: { width, height, data }
// where `data` is a Buffer of RGBA bytes (4 per pixel), row-major, top-to-bottom.

import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Decode bombs guard. A crafted IHDR can declare enormous dimensions (e.g.
// 16000x16000) while a few KB of high-ratio IDAT inflates to gigabytes — the
// unfilter/toRGBA allocations then push peak RSS past 1GB and OOM-abort the
// single process. We cap the per-side dimension and the total pixel count up
// front (both must hold), and separately cap inflate output to exactly what the
// validated dimensions imply. Anything larger throws — src/image.js turns a
// decode throw into a safe passthrough (original image forwarded unchanged), so
// a monster PNG degrades gracefully instead of crashing. A 32767-per-side /
// ~40MP budget covers any real screenshot or photo (4K is ~8MP) with headroom.
const MAX_DIMENSION = 0x7fff;              // 32767 px per side
const MAX_PIXELS = 40 * 1024 * 1024;       // ~40M pixels total (width * height)

// Bytes-per-pixel for each PNG color type at 8-bit depth (the sample count).
// 0=grayscale 2=RGB 3=palette 4=grayscale+alpha 6=RGBA
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paethPredictor(a, b, c) {
  // a = left, b = above, c = upper-left
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Reverse the per-scanline filter (PNG spec §9.2). `raw` holds all scanlines,
// each prefixed by a 1-byte filter type. Returns the unfiltered pixel bytes.
function unfilter(raw, height, bytesPerRow, bpp) {
  const out = Buffer.alloc(height * bytesPerRow);
  let rawPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const outRow = y * bytesPerRow;
    const prevRow = outRow - bytesPerRow;
    for (let x = 0; x < bytesPerRow; x++) {
      const rawByte = raw[rawPos++];
      const a = x >= bpp ? out[outRow + x - bpp] : 0;         // left
      const b = y > 0 ? out[prevRow + x] : 0;                 // above
      const c = (y > 0 && x >= bpp) ? out[prevRow + x - bpp] : 0; // upper-left
      let val;
      switch (filter) {
        case 0: val = rawByte; break;                         // None
        case 1: val = rawByte + a; break;                     // Sub
        case 2: val = rawByte + b; break;                     // Up
        case 3: val = rawByte + ((a + b) >> 1); break;        // Average
        case 4: val = rawByte + paethPredictor(a, b, c); break; // Paeth
        default: throw new Error(`PNG: unknown filter type ${filter}`);
      }
      out[outRow + x] = val & 0xff;
    }
  }
  return out;
}

// Expand decoded pixel bytes into a flat RGBA buffer.
function toRGBA(pixels, width, height, colorType, palette, trns) {
  const rgba = Buffer.alloc(width * height * 4);
  const n = width * height;
  if (colorType === 6) return pixels.subarray(0, n * 4); // already RGBA
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (colorType === 0) {              // grayscale
      const g = pixels[i];
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
    } else if (colorType === 4) {       // grayscale + alpha
      const g = pixels[i * 2];
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = pixels[i * 2 + 1];
    } else if (colorType === 2) {       // RGB
      rgba[o] = pixels[i * 3]; rgba[o + 1] = pixels[i * 3 + 1]; rgba[o + 2] = pixels[i * 3 + 2]; rgba[o + 3] = 255;
    } else if (colorType === 3) {       // palette
      const idx = pixels[i];
      const p = idx * 3;
      rgba[o] = palette[p]; rgba[o + 1] = palette[p + 1]; rgba[o + 2] = palette[p + 2];
      rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return rgba;
}

// Decode a PNG Buffer to { width, height, data:RGBA }. Throws on malformed or
// unsupported input.
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('PNG: bad signature');
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos); pos += 4;
    const type = buf.toString('ascii', pos, pos + 4); pos += 4;
    const dataStart = pos;
    if (dataStart + len > buf.length) throw new Error('PNG: truncated chunk');

    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
      if (bitDepth !== 8) throw new Error(`PNG: unsupported bit depth ${bitDepth} (only 8)`);
      if (interlace !== 0) throw new Error('PNG: interlaced not supported');
      if (!(colorType in CHANNELS)) throw new Error(`PNG: unsupported color type ${colorType}`);
      // Reject decode bombs at the header, before any allocation or inflate.
      if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new Error(`PNG: dimensions ${width}x${height} exceed limit ${MAX_DIMENSION}`);
      }
      if (width * height > MAX_PIXELS) {
        throw new Error(`PNG: pixel count ${width * height} exceeds limit ${MAX_PIXELS}`);
      }
    } else if (type === 'PLTE') {
      palette = buf.subarray(dataStart, dataStart + len);
    } else if (type === 'tRNS') {
      trns = buf.subarray(dataStart, dataStart + len);
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + len + 4; // skip data + CRC
  }

  if (!width || !height) throw new Error('PNG: missing IHDR dimensions');
  if (colorType === 3 && !palette) throw new Error('PNG: palette image without PLTE');
  if (idat.length === 0) throw new Error('PNG: no IDAT data');

  const channels = CHANNELS[colorType];
  const bytesPerRow = width * channels;
  const bpp = channels; // 8-bit -> bytes-per-pixel == channels
  // A valid non-interlaced PNG inflates to exactly one filter byte + one row of
  // pixel bytes per scanline. Cap inflate output there (dimensions already
  // bounded above), so a high-ratio IDAT can never balloon past the pixel budget
  // — inflateSync throws ERR_BUFFER_TOO_LARGE, which callers treat as passthrough.
  const expectedRaw = height * (bytesPerRow + 1);
  const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expectedRaw });
  if (raw.length < expectedRaw) throw new Error('PNG: inflated data too short');

  const pixels = unfilter(raw, height, bytesPerRow, bpp);
  const data = toRGBA(pixels, width, height, colorType, palette, trns);
  return { width, height, data };
}

export default decodePng;
