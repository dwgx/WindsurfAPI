import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

test('dashboard inline scripts are syntactically valid', () => {
  const html = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .map((match, index) => ({ index, attrs: match[1] || '', source: match[2] || '' }))
    .filter(({ attrs }) => !/\bsrc\s*=/.test(attrs))
    .filter(({ attrs }) => !/\btype\s*=\s*["']module["']/i.test(attrs));

  assert.ok(scripts.length > 0, 'expected at least one non-module inline script');
  for (const { index, source } of scripts) {
    assert.doesNotThrow(() => new Function(source), `inline script #${index} should parse`);
  }
});
