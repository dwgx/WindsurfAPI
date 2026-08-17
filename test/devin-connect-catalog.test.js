import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeCatalog,
  decodePlanName,
  __testing,
} from '../src/devin-connect-catalog.js';
import { writeStringField, writeVarintField, writeMessageField } from '../src/proto.js';

// Build a synthetic ClientModelConfig the same way the live wire does:
//   #1 label, #4 disabled, #5 supports_images, #10 provider,
//   #22 selector, #23 ModelInfo{ #23 alias }
function buildConfig({ label, disabled, supportsImages, provider, selector, alias }) {
  const parts = [];
  if (label != null) parts.push(writeStringField(1, label));
  if (disabled != null) parts.push(writeVarintField(4, disabled ? 1 : 0));
  if (supportsImages != null) parts.push(writeVarintField(5, supportsImages ? 1 : 0));
  if (provider != null) parts.push(writeVarintField(10, provider));
  if (selector != null) parts.push(writeStringField(22, selector));
  if (alias != null) parts.push(writeMessageField(23, writeStringField(23, alias)));
  return writeMessageField(1, Buffer.concat(parts));
}

function buildCatalog(configs) {
  return Buffer.concat(configs.map(buildConfig));
}

describe('decodeCatalog', () => {
  it('decodes selector, label, provider, and alias for each model', () => {
    const raw = buildCatalog([
      { label: 'Claude Opus 4.8 Medium', supportsImages: true, provider: 3, selector: 'claude-opus-4-8-medium', alias: 'claude-opus-4.8' },
      { label: 'SWE-1.6 Slow', supportsImages: false, provider: 1, selector: 'swe-1-6-slow', alias: 'swe-1.6-slow' },
    ]);
    const models = decodeCatalog(raw);
    assert.equal(models.length, 2);
    assert.deepEqual(models[0], {
      selector: 'claude-opus-4-8-medium',
      label: 'Claude Opus 4.8 Medium',
      providerId: 3,
      provider: 'anthropic',
      alias: 'claude-opus-4.8',
      isFreeDefault: false,
      supportsImages: true,
    });
  });

  it('keeps supports_images=false as explicit capability data', () => {
    const raw = buildCatalog([{ selector: 'text-only', supportsImages: false }]);
    assert.equal(decodeCatalog(raw)[0].supportsImages, false);
  });

  it('omits disabled models from the callable catalog', () => {
    const raw = buildCatalog([
      { selector: 'disabled-model', disabled: true, supportsImages: true },
      { selector: 'enabled-model', disabled: false, supportsImages: false },
    ]);
    assert.deepEqual(decodeCatalog(raw).map((m) => m.selector), ['enabled-model']);
  });

  it('flags swe-1-6-slow as the free default', () => {
    const raw = buildCatalog([{ label: 'SWE-1.6 Slow', provider: 1, selector: 'swe-1-6-slow' }]);
    const [m] = decodeCatalog(raw);
    assert.equal(m.isFreeDefault, true);
    assert.equal(m.provider, 'cognition');
  });

  it('maps every known provider id to a name', () => {
    const raw = buildCatalog([
      { selector: 's1', provider: 1 }, { selector: 's2', provider: 2 },
      { selector: 's3', provider: 3 }, { selector: 's4', provider: 4 },
      { selector: 's7', provider: 7 }, { selector: 's9', provider: 9 },
    ]);
    const names = decodeCatalog(raw).map((m) => m.provider);
    assert.deepEqual(names, ['cognition', 'openai', 'anthropic', 'google', 'moonshot', 'zhipu']);
  });

  it('reports unknown provider ids by their numeric value', () => {
    const raw = buildCatalog([{ selector: 'x', provider: 99 }]);
    assert.equal(decodeCatalog(raw)[0].provider, '99');
  });

  it('skips configs that carry no selector', () => {
    const raw = buildCatalog([
      { label: 'no selector', provider: 1 },
      { label: 'has one', provider: 1, selector: 'swe-1-6' },
    ]);
    const models = decodeCatalog(raw);
    assert.equal(models.length, 1);
    assert.equal(models[0].selector, 'swe-1-6');
  });

  it('returns an empty list for an empty response', () => {
    assert.deepEqual(decodeCatalog(Buffer.alloc(0)), []);
  });
});

describe('decodePlanName', () => {
  it('extracts the lowercased plan name from #2.#2', () => {
    // GetUserStatusResponse { #2 status { #2 planName } }
    const raw = writeMessageField(2, writeStringField(2, 'Free'));
    assert.equal(decodePlanName(raw), 'free');
  });

  it('returns empty string when the status submessage is absent', () => {
    const raw = writeStringField(1, 'no status here');
    assert.equal(decodePlanName(raw), '');
  });

  it('handles a paid plan name', () => {
    const raw = writeMessageField(2, writeStringField(2, 'Teams'));
    assert.equal(decodePlanName(raw), 'teams');
  });
});

describe('catalog client metadata envelope', () => {
  it('embeds the single (un-doubled) token as field #3 of client metadata', () => {
    const meta = __testing.buildClientMetadata('devin-session-token$abc');
    // field #3 is length-delimited; the token must appear verbatim, exactly once
    const occurrences = meta.toString('utf8').split('devin-session-token$abc').length - 1;
    assert.equal(occurrences, 1);
  });
});
