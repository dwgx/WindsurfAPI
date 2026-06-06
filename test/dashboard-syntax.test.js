import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

for (const skin of ['src/dashboard/index.html', 'src/dashboard/index-sketch.html']) {
  test(`${skin} inline scripts are syntactically valid`, () => {
    const html = readFileSync(join(root, skin), 'utf8');
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
      .map((match, index) => ({ index, attrs: match[1] || '', source: match[2] || '' }))
      .filter(({ attrs }) => !/\bsrc\s*=/.test(attrs))
      .filter(({ attrs }) => !/\btype\s*=\s*["']module["']/i.test(attrs));

    assert.ok(scripts.length > 0, `expected at least one non-module inline script in ${skin}`);
    for (const { index, source } of scripts) {
      assert.doesNotThrow(() => new Function(source), `inline script #${index} in ${skin} should parse`);
    }
  });
}

test('dashboard system prompt editor escapes prompt keys before rendering or routing', () => {
  const html = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  assert.match(html, /const safeKey = this\.esc\(key\)/);
  assert.match(html, /const keyArg = this\.escJsAttr\(key\)/);
  assert.match(html, /this\.systemPromptDomId\(key\)/);
  assert.match(html, /encodeURIComponent\(key\)/);
  assert.doesNotMatch(html, /\$\{key\}<\/code>/);
  assert.doesNotMatch(html, /resetSystemPrompt\('\$\{key\}'\)/);
});

test('dashboard batch login history uses each result proxy instead of an undefined local', () => {
  const html = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  assert.match(html, /proxy:\s*this\.getWindsurfProxyLabel\(item\.proxy\)/);
  assert.doesNotMatch(html, /proxy:\s*this\.getWindsurfProxyLabel\(proxy\),\s*\r?\n\s*status:\s*item\.success/);
});

test('dashboard proxy and abnormal-account tables use paged account summaries', () => {
  const html = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  assert.match(html, /id="proxy-accounts-pagination"/);
  assert.match(html, /id="ban-pagination"/);
  assert.match(html, /setProxyPage\(page\)/);
  assert.match(html, /setBansPage\(page\)/);
  assert.match(html, /this\.accountsListUrl\(\{\s*page:\s*this\.proxyPage,\s*pageSize:\s*this\.proxyPageSize/s);
  assert.match(html, /filter:\s*'flagged'/);
  assert.doesNotMatch(html, /pageSize=1000/);
  assert.doesNotMatch(html, /pageSize=500/);
});

test('dashboard sketch proxy and abnormal-account tables use lightweight summaries', () => {
  const html = readFileSync(join(root, 'src/dashboard/index-sketch.html'), 'utf8');
  assert.match(html, /\/accounts\?view=summary&pageSize=200/);
  assert.match(html, /\/accounts\?view=summary&filter=flagged&pageSize=200/);
  assert.doesNotMatch(html, /pageSize=1000/);
  assert.doesNotMatch(html, /pageSize=500/);
});
