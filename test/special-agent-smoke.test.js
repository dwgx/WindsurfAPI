import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(resolve('scripts/special-agent-smoke.mjs'), 'utf8');

describe('special-agent smoke script', () => {
  it('preflights backend status before sending SWE smoke traffic', () => {
    assert.match(script, /\/health\?verbose=1/);
    assert.match(script, /SPECIAL_AGENT_SMOKE_REQUIRE_ENABLED/);
    assert.match(script, /special-agent backend is disabled/);
  });

  it('keeps the POC text-only and tool-free', () => {
    assert.match(script, /swe-1\.6-fast/);
    assert.doesNotMatch(script, /\btools\s*:/);
    assert.doesNotMatch(script, /image_url|input_image/);
  });
});
