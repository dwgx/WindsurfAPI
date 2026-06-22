import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const templateDir = join(root, '.github', 'ISSUE_TEMPLATE');

test('issue templates use the maintained bilingual forms only', () => {
  const files = readdirSync(templateDir).filter(name => name.endsWith('.yml')).sort();
  assert.deepEqual(files, ['bug.yml', 'config.yml', 'feature.yml']);
});

test('bug template requests current routing and diagnostic evidence', () => {
  const body = readFileSync(join(templateDir, 'bug.yml'), 'utf8');
  for (const expected of [
    'needs-triage',
    '/v1/chat/completions',
    '/v1/messages',
    '/v1/responses',
    'Probe[...]',
    'ToolRoute[...]',
    'BridgeResult[...]',
    'WINDSURFAPI_NATIVE_TOOL_BRIDGE',
    'WINDSURFAPI_LS_RELEASE',
  ]) {
    assert.match(body, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('feature template asks for acceptance criteria and starts in triage', () => {
  const body = readFileSync(join(templateDir, 'feature.yml'), 'utf8');
  assert.match(body, /needs-triage/);
  assert.match(body, /Minimum acceptance criteria/);
  assert.match(body, /模型名|model names/);
});
