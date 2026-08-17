import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());

function makeWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), 'wa-check-i18n-'));

  const srcDir = join(workspace, 'src');
  const dashboardDir = join(srcDir, 'dashboard');
  const i18nDir = join(dashboardDir, 'i18n');

  mkdirSync(srcDir, { recursive: true });
  mkdirSync(dashboardDir, { recursive: true });
  mkdirSync(i18nDir, { recursive: true });
  copyFileSync(join(ROOT, 'package.json'), join(workspace, 'package.json'));
  copyFileSync(join(ROOT, 'src/dashboard/check-i18n.js'), join(dashboardDir, 'check-i18n.js'));
  copyFileSync(join(ROOT, 'src/dashboard/index.html'), join(dashboardDir, 'index.html'));
  copyFileSync(join(ROOT, 'src/dashboard/api.js'), join(dashboardDir, 'api.js'));
  copyFileSync(join(ROOT, 'src/dashboard/i18n/en.json'), join(i18nDir, 'en.json'));
  copyFileSync(join(ROOT, 'src/dashboard/i18n/zh-CN.json'), join(i18nDir, 'zh-CN.json'));

  return workspace;
}

function runCheck(workspace) {
  return spawnSync(process.execPath, ['src/dashboard/check-i18n.js'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 20000,
  });
}

describe('scripts/check-i18n.js', () => {
  it('passes on clean dashboard sources', () => {
    const workspace = makeWorkspace();
    try {
      const result = runCheck(workspace);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /All i18n checks passed/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails when a locale uses unsupported single-brace placeholders', () => {
    const workspace = makeWorkspace();
    try {
      const localePath = join(workspace, 'src', 'dashboard', 'i18n', 'en.json');
      const locale = JSON.parse(readFileSync(localePath, 'utf8'));
      locale.status.rolledBack = 'Rolled back to {commit}';
      writeFileSync(localePath, `${JSON.stringify(locale, null, 2)}\n`, 'utf8');

      const result = runCheck(workspace);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /en\.json:status\.rolledBack/);
      assert.match(result.stdout, /use \{\{name\}\} placeholders/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails with nonzero exit and reports violation when Chinese text is introduced', () => {
    const workspace = makeWorkspace();
    try {
      const indexPath = join(workspace, 'src', 'dashboard', 'index.html');
      const marker = '\n      <!-- i18n test violation -->\n      <div>這是中文硬编码示例</div>\n';
      writeFileSync(indexPath, `${readFileSync(indexPath, 'utf8')}${marker}`, 'utf8');

      const result = runCheck(workspace);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /No hardcoded Chinese found in HTML|hardcoded Chinese/i);
      assert.match(result.stdout, /Found [0-9]+ violation/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  // Check #8: hardcoded English string literals in the App <script> region.
  // The English scan (#7) stops at <script>, so JS-generated copy that bypasses
  // I18n.t() used to ship untranslated with a green gate. #8 flags it WARN-FIRST
  // (visible, but does not fail the build) so a regression is caught without
  // blocking unrelated PRs on the large existing script region.

  // Inject a snippet just before the App IIFE opener so it lands inside the
  // <script> region that check #8 scans.
  function injectIntoScript(indexPath, snippet) {
    const html = readFileSync(indexPath, 'utf8');
    const bodyStart = html.indexOf('<body>');
    const scriptOpen = html.indexOf('<script>', bodyStart);
    const insertAt = scriptOpen + '<script>'.length;
    const patched = `${html.slice(0, insertAt)}\n${snippet}\n${html.slice(insertAt)}`;
    writeFileSync(indexPath, patched, 'utf8');
  }

  it('warns (does NOT fail) on hardcoded English literals in the App <script> region', () => {
    const workspace = makeWorkspace();
    try {
      const indexPath = join(workspace, 'src', 'dashboard', 'index.html');
      injectIntoScript(indexPath, `
        el.textContent = 'Save all changes';
        node.innerHTML = '<span>Loading data now</span>';
        input.placeholder = 'Type your search here';
      `);

      const result = runCheck(workspace);
      // WARN-first: violations are reported but the gate stays green.
      assert.equal(result.status, 0, 'check #8 must not fail the build (warn-first)');
      assert.match(result.stdout, /App <script> region/);
      assert.match(result.stdout, /Hardcoded English string literal/);
      assert.match(result.stdout, /Save all changes/);
      assert.match(result.stdout, /Loading data now/);
      assert.match(result.stdout, /Type your search here/);
      assert.match(result.stdout, /All i18n checks passed/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('does NOT warn on I18n.t() calls or code-shaped literals in the App <script> region', () => {
    const workspace = makeWorkspace();
    try {
      const indexPath = join(workspace, 'src', 'dashboard', 'index.html');
      injectIntoScript(indexPath, `
        el.textContent = I18n.t('nav.group.overview');
        el.className = 'seg-btn active';
        el.setAttribute('data-view', 'grid');
        node.style.color = 'var(--success)';
        const u = 'https://windsurf.com/docs';
        el.textContent = key;
        el.textContent = \`\${count} items\`;
        meta.innerHTML = \`<div>PID \${p} · RSS \${r} · Cap \${c}</div>\`;
      `);

      const result = runCheck(workspace);
      assert.equal(result.status, 0);
      // The clean OK line for #8 must appear (no findings from the injected code).
      assert.match(result.stdout, /No hardcoded English string literals in App <script> region/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
