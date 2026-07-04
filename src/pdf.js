/**
 * Zero-dependency PDF text extraction.
 *
 * Handles PDF 1.x text streams: decompress FlateDecode streams with
 * Node.js built-in zlib, then extract text from Tj/TJ operators.
 * Not a full PDF parser — designed for text-layer PDFs (reports, docs).
 * Scanned PDFs (image-only) return empty text.
 */

import { inflateSync } from 'zlib';
import { log } from './config.js';

const MAX_STREAMS = 200;
const MAX_STREAM_DECODED = 5 * 1024 * 1024;
const MAX_TOTAL_DECODED = 25 * 1024 * 1024;

/**
 * Extract text from a PDF buffer.
 * @param {Buffer} buf - Raw PDF bytes
 * @returns {string} Extracted text, or empty string if no text layer
 */
export function extractPdfText(buf) {
  const pages = [];
  let streamCount = 0;
  let totalDecoded = 0;

  // Find all stream...endstream blocks
  let pos = 0;
  while (pos < buf.length) {
    const streamStart = buf.indexOf('stream\n', pos);
    if (streamStart === -1) break;

    const dataStart = streamStart + 7; // skip "stream\n"
    // Handle \r\n after "stream"
    const actualStart = buf[streamStart + 6] === 0x0d ? dataStart + 1 : dataStart;

    const endStream = buf.indexOf('\nendstream', actualStart);
    if (endStream === -1) break;

    const streamData = buf.subarray(actualStart, endStream);
    streamCount++;
    if (streamCount > MAX_STREAMS) throw new Error('PDF stream count exceeds safety limit');

    // Check if this stream has FlateDecode by looking back at the dictionary
    const dictStart = Math.max(0, streamStart - 500);
    const dictText = buf.subarray(dictStart, streamStart).toString('latin1');
    const isFlate = dictText.includes('FlateDecode');

    let decoded;
    try {
      if (isFlate) {
        const inflated = inflateSync(streamData, { maxOutputLength: MAX_STREAM_DECODED });
        if (inflated.length > MAX_STREAM_DECODED) throw new Error('PDF decoded content exceeds safety limit');
        totalDecoded += inflated.length;
        if (totalDecoded > MAX_TOTAL_DECODED) throw new Error('PDF decoded content exceeds safety limit');
        decoded = inflated.toString('latin1');
      } else {
        totalDecoded += streamData.length;
        if (streamData.length > MAX_STREAM_DECODED || totalDecoded > MAX_TOTAL_DECODED) throw new Error('PDF decoded content exceeds safety limit');
        decoded = streamData.toString('latin1');
      }
    } catch (e) {
      if (/limit|exceed|maxOutputLength|Buffer larger/i.test(e.message) || e.code === 'ERR_BUFFER_TOO_LARGE') throw e;
      pos = endStream + 10;
      continue;
    }

    // Extract text from PDF operators
    const text = extractTextOps(decoded);
    if (text.trim()) pages.push(text.trim());

    pos = endStream + 10;
  }

  return pages.join('\n\n');
}

/**
 * Extract text from PDF content stream operators.
 * Handles: (text) Tj, [(text)] TJ, Td/Tm for positioning
 */
function extractTextOps(stream) {
  const lines = [];
  let currentLine = '';

  // Find BT...ET text-object blocks with a linear, forward-only indexOf scan.
  // The old /BT[\s\S]*?ET/g regex degraded to O(n^2) on a "many BT, no ET"
  // stream: each of N 'BT' starts re-scanned the entire tail looking for an 'ET'
  // that never comes (5MB of 'BT' blocked the event loop ~26 min). indexOf pairs
  // each BT with the next ET after it and stops the instant no ET remains, so the
  // whole pass is O(n) regardless of how the input is crafted.
  const blocks = [];
  let scan = 0;
  while (scan < stream.length) {
    const bt = stream.indexOf('BT', scan);
    if (bt === -1) break;
    const et = stream.indexOf('ET', bt + 2);
    if (et === -1) break; // no closing ET anywhere ahead -> done (forward-only)
    blocks.push(stream.slice(bt, et + 2));
    scan = et + 2;
  }
  if (blocks.length === 0) return '';

  for (const block of blocks) {
    // (string) Tj — show string
    const tjMatches = block.matchAll(/\(([^)]*)\)\s*Tj/g);
    for (const m of tjMatches) {
      currentLine += decodePdfString(m[1]);
    }

    // [...] TJ — show strings with spacing.
    // Linear regex (single negated class, no nested quantifier) — the old
    // /\[((?:[^[\]]*|\([^)]*\))*)\]\s*TJ/ form was catastrophic-backtracking
    // ReDoS: an unclosed '[' in attacker PDF content hung the event loop for
    // tens of seconds (single-request DoS, proxy ingests untrusted PDFs). The
    // tradeoff is a TJ array containing a literal ']' inside a (...) string is
    // skipped — rare, and text extraction is best-effort anyway.
    const tjArrayMatches = block.matchAll(/\[([^\]]*)\]\s*TJ/gi);
    for (const m of tjArrayMatches) {
      const inner = m[1];
      const parts = inner.matchAll(/\(([^)]*)\)|(-?\d+(?:\.\d+)?)/g);
      for (const p of parts) {
        if (p[1] !== undefined) {
          currentLine += decodePdfString(p[1]);
        } else if (p[2] !== undefined) {
          const kern = parseFloat(p[2]);
          if (kern < -100) currentLine += ' ';
        }
      }
    }

    // Td/TD/Tm — text positioning (new line heuristic)
    if (/\d+\s+(?:-?\d+(?:\.\d+)?)\s+T[dD]/g.test(block)) {
      if (currentLine.trim()) {
        lines.push(currentLine.trim());
        currentLine = '';
      }
    }
  }

  if (currentLine.trim()) lines.push(currentLine.trim());
  return lines.join('\n');
}

/**
 * Decode PDF string escapes: \n, \r, \t, \\, \(, \), octal
 */
function decodePdfString(s) {
  return s.replace(/\\([nrtbf()\\]|\d{1,3})/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === 't') return '\t';
    if (c === 'b') return '\b';
    if (c === 'f') return '\f';
    if (c === '(' || c === ')' || c === '\\') return c;
    return String.fromCharCode(parseInt(c, 8));
  });
}

/**
 * Try to extract text from base64-encoded PDF.
 * @param {string} base64Data - Base64 encoded PDF
 * @returns {{ text: string, pageCount: number } | null}
 */
export function tryExtractPdf(base64Data) {
  try {
    const buf = Buffer.from(base64Data, 'base64');
    if (buf.length < 5 || buf.subarray(0, 5).toString() !== '%PDF-') return null;

    const text = extractPdfText(buf);
    if (!text.trim()) {
      log.warn('PDF has no extractable text layer (scanned/image-only PDF)');
      return { text: '', pageCount: 0 };
    }

    const pageCount = (buf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
    return { text, pageCount };
  } catch (e) {
    log.warn(`PDF extraction failed: ${e.message}`);
    if (/exceeds safety limit|maxOutputLength|too large|Buffer larger/i.test(e.message) || e.code === 'ERR_BUFFER_TOO_LARGE') {
      return { text: 'PDF 内容无法提取', pageCount: 0 };
    }
    return null;
  }
}
