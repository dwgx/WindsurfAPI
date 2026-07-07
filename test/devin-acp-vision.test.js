import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAcpPromptBlocks, acpVisionEnabled } from '../src/devin-acp.js';

// Vision over ACP: the clean image route. The real devin CLI builds the
// downstream wire and the server signs its own thinking turns, so we never forge
// the un-forgeable #12 signature that blocks the DEVIN_CONNECT synthetic path.
// Verified end-to-end against opus-4-8 (route A inline base64): the model saw a
// red/blue image and answered "Red and blue; red is on top."

describe('acpVisionEnabled', () => {
  it('is OFF by default and for falsey values', () => {
    assert.equal(acpVisionEnabled({}), false);
    assert.equal(acpVisionEnabled({ DEVIN_ACP_VISION: '0' }), false);
    assert.equal(acpVisionEnabled({ DEVIN_ACP_VISION: 'off' }), false);
    assert.equal(acpVisionEnabled({ DEVIN_ACP_VISION: '' }), false);
  });
  it('is ON for 1/on/true', () => {
    assert.equal(acpVisionEnabled({ DEVIN_ACP_VISION: '1' }), true);
    assert.equal(acpVisionEnabled({ DEVIN_ACP_VISION: 'on' }), true);
    assert.equal(acpVisionEnabled({ DEVIN_ACP_VISION: 'true' }), true);
  });
});

describe('buildAcpPromptBlocks', () => {
  it('string prompt → single text block (back-compat, model hint prefixed)', () => {
    assert.deepEqual(buildAcpPromptBlocks('hello', 'M\n'), [{ type: 'text', text: 'M\nhello' }]);
  });

  it('null/undefined prompt → empty text block, never throws', () => {
    assert.deepEqual(buildAcpPromptBlocks(null, ''), [{ type: 'text', text: '' }]);
    assert.deepEqual(buildAcpPromptBlocks(undefined, ''), [{ type: 'text', text: '' }]);
  });

  it('structured prompt with gate OFF drops images (degrade to text)', () => {
    const blocks = buildAcpPromptBlocks(
      { text: 'colors?', images: [{ base64_data: 'AAAA', mime_type: 'image/png' }] },
      '', {},
    );
    assert.deepEqual(blocks, [{ type: 'text', text: 'colors?' }]);
  });

  it('structured prompt with gate ON emits an inline image content block', () => {
    const blocks = buildAcpPromptBlocks(
      { text: 'colors?', images: [{ base64_data: 'AAAA', mime_type: 'image/jpeg' }] },
      '', { DEVIN_ACP_VISION: '1' },
    );
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], { type: 'text', text: 'colors?' });
    assert.deepEqual(blocks[1], { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
  });

  it('defaults mimeType to image/png and accepts data/mimeType aliases', () => {
    const blocks = buildAcpPromptBlocks(
      { text: 'x', images: [{ data: 'BBBB' }] },
      '', { DEVIN_ACP_VISION: '1' },
    );
    assert.deepEqual(blocks[1], { type: 'image', data: 'BBBB', mimeType: 'image/png' });
  });

  it('emits multiple image blocks and skips entries with no data', () => {
    const blocks = buildAcpPromptBlocks(
      { text: 'two', images: [
        { base64_data: 'AAAA', mime_type: 'image/png' },
        { mime_type: 'image/png' }, // no data → skipped
        { base64_data: 'CCCC', mime_type: 'image/webp' },
      ] },
      '', { DEVIN_ACP_VISION: '1' },
    );
    // text + 2 valid images (the dataless one is skipped)
    assert.equal(blocks.length, 3);
    assert.equal(blocks[1].data, 'AAAA');
    assert.equal(blocks[2].data, 'CCCC');
    assert.equal(blocks[2].mimeType, 'image/webp');
  });

  it('structured prompt with no images → just the text block', () => {
    assert.deepEqual(
      buildAcpPromptBlocks({ text: 'plain' }, '', { DEVIN_ACP_VISION: '1' }),
      [{ type: 'text', text: 'plain' }],
    );
  });
});
