import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const scriptPath = resolve('scripts/web-search-direct-probe.mjs');

describe('web search direct probe script', () => {
  it('does not treat the gateway API_KEY as an upstream Windsurf account key', () => {
    const source = readFileSync(scriptPath, 'utf8');
    assert.doesNotMatch(source, /process\.env\.API_KEY\b/);
    assert.match(source, /WEB_SEARCH_PROBE_API_KEY/);
    assert.match(source, /CODEIUM_API_KEY/);
    assert.match(source, /accounts\.json/);
  });

  it('is a direct API probe, not a WebFetch/native bridge rollout', () => {
    const source = readFileSync(scriptPath, 'utf8');
    assert.match(source, /getWebSearchResults/);
    assert.doesNotMatch(source, /read_url_content/);
    assert.doesNotMatch(source, /WINDSURFAPI_NATIVE_TOOL_BRIDGE/);
  });
});
