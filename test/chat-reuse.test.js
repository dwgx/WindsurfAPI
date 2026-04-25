import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseCascadeReuse, shouldUseStrictCascadeReuse } from '../src/handlers/chat.js';

describe('shouldUseCascadeReuse', () => {
  it('allows reuse for normal Cascade chat turns', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: false, modelKey: 'claude-4.5-haiku' }), true);
  });

  it('keeps most tool-emulated turns out of reuse', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-4.5-haiku' }), false);
  });

  it('allows reuse for tool-emulated Opus 4.7 turns', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4-7-medium' }), true);
  });

  it('can disable the Opus 4.7 tool reuse override', () => {
    assert.equal(shouldUseCascadeReuse({
      useCascade: true,
      emulateTools: true,
      modelKey: 'claude-opus-4-7-medium',
      allowToolReuse: false,
    }), false);
  });

  it('disables reuse outside Cascade', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: false, emulateTools: false, modelKey: 'claude-opus-4-7-medium' }), false);
  });
});

describe('shouldUseStrictCascadeReuse', () => {
  it('strictly binds tool-emulated Opus 4.7 reuse by default', () => {
    assert.equal(shouldUseStrictCascadeReuse({
      emulateTools: true,
      modelKey: 'claude-opus-4-7-medium',
      strict: false,
      allowOpus47Strict: true,
    }), true);
  });

  it('does not strictly bind other models unless the global flag is on', () => {
    assert.equal(shouldUseStrictCascadeReuse({
      emulateTools: true,
      modelKey: 'claude-4.5-haiku',
      strict: false,
      allowOpus47Strict: true,
    }), false);
  });
});
