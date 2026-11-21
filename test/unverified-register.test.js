// Pins for docs/UNVERIFIED.md — the cross-release register of "尚未验证" bullets.
//
// The register is generated, so the interesting failure is not "the file has a typo", it is
// "the file no longer equals what the release notes say". Byte equality catches that; the
// per-bullet position check catches the narrower case where the generator silently drops a
// section (or a bullet) and the register still looks plausible.
//
// The register's status column is only as good as the markers in the notes. Four historical
// notes (3.9.39/40/41/59) carried 14 bullets with no marker at all — the sweep counted them
// by hand because a register cannot classify what it cannot see. That backfill is pinned
// here so the denominator cannot quietly shrink.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STATUS,
  collectEntries,
  parseUnverifiedSections,
  renderRegister,
  versionOf,
} from '../scripts/unverified-register.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASES = join(ROOT, 'docs', 'releases');
const REGISTER = join(ROOT, 'docs', 'UNVERIFIED.md');
const SCRIPT = join(ROOT, 'scripts', 'unverified-register.mjs');

const read = (path) => readFileSync(path, 'utf8');
const sectionFiles = () => readdirSync(RELEASES)
  .filter((name) => /^RELEASE_NOTES_.*\.md$/.test(name))
  .filter((name) => parseUnverifiedSections(read(join(RELEASES, name))).length > 0)
  .sort();

function runGenerator(out) {
  return spawnSync(process.execPath, [SCRIPT, '--out', out], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

describe('docs: the unverified register is generated, not written', () => {
  it('the generator reproduces docs/UNVERIFIED.md byte for byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-unverified-'));
    try {
      const out = join(dir, 'UNVERIFIED.md');
      const result = runGenerator(out);
      assert.equal(result.status, 0, `generator failed:\n${result.stdout}\n${result.stderr}`);
      const generated = read(out);
      const committed = read(REGISTER);
      if (generated !== committed) {
        // Report the first divergent line instead of dumping two 72-row tables.
        const a = generated.split('\n');
        const b = committed.split('\n');
        const index = a.findIndex((line, i) => line !== b[i]);
        const at = index < 0 ? Math.min(a.length, b.length) : index;
        assert.fail(
          `docs/UNVERIFIED.md is stale at line ${at + 1} — run \`node scripts/unverified-register.mjs\`\n`
          + `  generated: ${JSON.stringify(a[at] ?? '(end of file)')}\n`
          + `  committed: ${JSON.stringify(b[at] ?? '(end of file)')}`,
        );
      }
      assert.equal(generated, committed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the generator is idempotent: a second run produces identical bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-unverified-'));
    try {
      const first = join(dir, 'first.md');
      const second = join(dir, 'second.md');
      assert.equal(runGenerator(first).status, 0);
      assert.equal(runGenerator(second).status, 0);
      assert.equal(read(first), read(second), 'two runs over the same tree must agree byte for byte');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every release note with a 尚未验证 section links the register', () => {
    const files = sectionFiles();
    assert.ok(files.length >= 24, `probe check: only ${files.length} release notes carry a 尚未验证 section`);
    const missing = [];
    for (const name of files) {
      const body = read(join(RELEASES, name));
      const taggedLink = '](https://github.com/dwgx/WindsurfAPI/blob/v'
        + versionOf(name) + '/docs/UNVERIFIED.md)';
      if (!body.includes('](../UNVERIFIED.md)') && !body.includes(taggedLink)) missing.push(name);
    }
    assert.deepEqual(
      missing,
      [],
      `release notes whose 尚未验证 section lacks a relative or exact-tag register link:\n  ${missing.join('\n  ')}`,
    );
    assert.ok(existsSync(join(ROOT, 'docs', 'UNVERIFIED.md')), 'the link target must exist');
  });

  it('the register lists every bullet of every section with its file:line', () => {
    const { entries } = collectEntries({ root: ROOT });
    const expected = new Map();
    for (const entry of entries) {
      for (const section of entry.sections) {
        for (const bullet of section.bullets) {
          expected.set(`${entry.name}:${bullet.line}`, bullet.status);
        }
      }
    }
    assert.ok(expected.size > 0, 'probe check: no bullets parsed out of the release notes');

    const body = read(REGISTER);
    const rows = [...body.matchAll(/^\| \d+ \| `([^`]+)` \|.*\| `?\[?([^|\]]+)\]?`? \| ([^|]+) \|$/gm)]
      .map((m) => [m[1], m[3].trim()]);
    const seen = new Map();
    for (const [position, status] of rows) {
      assert.ok(!seen.has(position), `register lists ${position} twice`);
      seen.set(position, status);
    }
    assert.equal(seen.size, expected.size, `register has ${seen.size} bullet rows, notes have ${expected.size}`);
    for (const [position, status] of expected) {
      assert.equal(seen.get(position), status, `${position} is missing from the register or has the wrong status`);
    }
  });

  it('the 14 historical bullets in 3.9.39/3.9.40/3.9.41/3.9.59 carry a marker', () => {
    // The sweep counted these by hand: 3 + 3 + 6 + 2 bullets filed under a 尚未验证 heading
    // with no marker, which is why the register could not classify them at all.
    const files = [
      'RELEASE_NOTES_3.9.39.md',
      'RELEASE_NOTES_3.9.40.md',
      'RELEASE_NOTES_3.9.41.md',
      'RELEASE_NOTES_3.9.59.md',
    ];
    let total = 0;
    for (const name of files) {
      const bullets = parseUnverifiedSections(read(join(RELEASES, name))).flatMap((s) => s.bullets);
      const unmarked = bullets.filter((bullet) => !bullet.marker).map((bullet) => `${name}:${bullet.line}`);
      assert.deepEqual(unmarked, [], `unmarked 尚未验证 bullets:\n  ${unmarked.join('\n  ')}`);
      total += bullets.length;
    }
    assert.equal(total, 14, '3.9.39/3.9.40/3.9.41/3.9.59 must still hold the 14 bullets the sweep counted');
  });

  it('markers map to 已复核 / 仍缺 / 已修 and an unmarked bullet counts as 仍缺', () => {
    const fixture = [
      '# v9.9.9',
      '',
      '## 尚未验证',
      '',
      '- `[UNVERIFIED]` still open',
      '- `[VERIFIED]` re-checked: `gh run view 1` → success',
      '- `[FIXED]` gap closed',
      '- no marker at all',
      '- **[UNVERIFIED]** bold spelling',
      '- `[NOTE]` unknown tag stays in the text',
      '- wrapped first line',
      '  wrapped second line',
      '',
      '## 验证记录',
      '',
      '- not part of the section',
    ].join('\n');
    const sections = parseUnverifiedSections(fixture);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, '尚未验证');
    assert.equal(sections[0].line, 3);
    assert.deepEqual(
      sections[0].bullets.map((bullet) => [bullet.marker, bullet.status]),
      [
        ['UNVERIFIED', STATUS.UNVERIFIED],
        ['VERIFIED', STATUS.VERIFIED],
        ['FIXED', STATUS.FIXED],
        [null, STATUS.UNVERIFIED],
        ['UNVERIFIED', STATUS.UNVERIFIED],
        [null, STATUS.UNVERIFIED],
        [null, STATUS.UNVERIFIED],
      ],
    );
    assert.equal(sections[0].bullets[5].text, '`[NOTE]` unknown tag stays in the text');
    assert.equal(sections[0].bullets[6].text, 'wrapped first line wrapped second line');
    assert.equal(STATUS.VERIFIED, '已复核');
    assert.equal(STATUS.UNVERIFIED, '仍缺');
    assert.equal(STATUS.FIXED, '已修');
  });

  it('renderRegister reports the same totals the committed file states', () => {
    const collected = collectEntries({ root: ROOT });
    const body = renderRegister(collected);
    const bullets = collected.entries.flatMap((entry) => entry.sections.flatMap((s) => s.bullets));
    const line = (label) => body.split('\n').find((row) => row.startsWith(`| ${label} |`));
    assert.equal(line('bullet'), `| bullet | ${bullets.length} 条 |`);
    assert.equal(line('已复核'), `| 已复核 | ${bullets.filter((b) => b.status === STATUS.VERIFIED).length} |`);
    assert.equal(line('仍缺'), `| 仍缺 | ${bullets.filter((b) => b.status === STATUS.UNVERIFIED).length} |`);
    assert.equal(line('已修'), `| 已修 | ${bullets.filter((b) => b.status === STATUS.FIXED).length} |`);
    assert.equal(line('无 marker'), `| 无 marker | ${bullets.filter((b) => !b.marker).length} |`);
    assert.equal(read(REGISTER), body, 'the committed register must be exactly this rendering');
  });
});
