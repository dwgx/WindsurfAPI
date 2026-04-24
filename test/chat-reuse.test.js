import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseCascadeReuse } from '../src/handlers/chat.js';

describe('shouldUseCascadeReuse', () => {
  it('allows reuse for normal Cascade chat turns', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: false }), true);
  });

  it('disables reuse for tool-emulated Claude Code turns', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true }), false);
  });

  it('disables reuse outside Cascade', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: false, emulateTools: false }), false);
  });
});
