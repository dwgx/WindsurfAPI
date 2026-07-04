import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnthropicVersion } from '../src/server.js';

// G1: resolveAnthropicVersion is an exported pure function, so we can test the
// three policies (legal→as-is, missing→default, unknown→accept) directly
// without standing up a server, mirroring the extractToken test style.

describe('G1 resolveAnthropicVersion', () => {
  it('returns a known version unchanged', () => {
    assert.equal(
      resolveAnthropicVersion({ headers: { 'anthropic-version': '2023-06-01' } }),
      '2023-06-01',
    );
    assert.equal(
      resolveAnthropicVersion({ headers: { 'anthropic-version': '2023-01-01' } }),
      '2023-01-01',
    );
  });

  it('falls back to the default when the header is missing', () => {
    assert.equal(resolveAnthropicVersion({ headers: {} }), '2023-06-01');
  });

  it('does not throw and returns the default when headers/req are absent', () => {
    assert.equal(resolveAnthropicVersion({}), '2023-06-01');
    assert.equal(resolveAnthropicVersion(undefined), '2023-06-01');
    assert.equal(resolveAnthropicVersion(null), '2023-06-01');
  });

  it('accepts an unknown/future version as-is without failing', () => {
    assert.equal(
      resolveAnthropicVersion({ headers: { 'anthropic-version': '2099-12-31' } }),
      '2099-12-31',
    );
  });

  it('treats a whitespace-only value as missing and returns the default', () => {
    assert.equal(
      resolveAnthropicVersion({ headers: { 'anthropic-version': '   ' } }),
      '2023-06-01',
    );
  });
});

describe('G1 resolveAnthropicVersion warn behavior', () => {
  let originalWarn;
  let warnCount;

  beforeEach(() => {
    originalWarn = console.warn;
    warnCount = 0;
    console.warn = () => { warnCount += 1; };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it('warns once when the header is missing', () => {
    resolveAnthropicVersion({ headers: {} });
    assert.equal(warnCount, 1);
  });

  it('warns once when the version is unrecognized', () => {
    resolveAnthropicVersion({ headers: { 'anthropic-version': '2099-12-31' } });
    assert.equal(warnCount, 1);
  });

  it('does not warn for a known version', () => {
    resolveAnthropicVersion({ headers: { 'anthropic-version': '2023-06-01' } });
    assert.equal(warnCount, 0);
  });
});
