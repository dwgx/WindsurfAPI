import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('native bridge documentation guardrails', () => {
  it('documents the default native bridge scope as Bash-only and lab-gates non-command tools', () => {
    const envExample = readFileSync('.env.example', 'utf8');
    const readmeEn = readFileSync('README.en.md', 'utf8');
    const notes = readFileSync('docs/native-bridge-protocol-notes.md', 'utf8');

    for (const text of [envExample, readmeEn, notes]) {
      assert.match(text, /Bash/);
      assert.match(text, /shell_command/);
      assert.match(text, /run_command/);
    }

    assert.match(readmeEn, /Read.*Grep.*Glob.*WebSearch.*WebFetch.*protocol-lab scope/i);
    assert.match(notes, /Do not recommend `all_mapped` as a general fix/);
    assert.doesNotMatch(readmeEn, /Defaults include aliases such as `read_file`/);
  });

  it('documents SWE-1.6 as a special-agent route, not a catalog fix', () => {
    const readmeEn = readFileSync('README.en.md', 'utf8');
    assert.match(readmeEn, /lab-only special-agent backend/i);
    assert.match(readmeEn, /not a normal catalog-model fix/i);
  });
});
