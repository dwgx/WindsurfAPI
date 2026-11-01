#!/usr/bin/env node
/**
 * Derive CHANGELOG.md's release counts from the checkout instead of typing them.
 *
 * WHY THIS EXISTS. The banner and the 版本节奏 table both state how many release notes
 * exist, and both were maintained by hand. On 2026-10-31 they disagreed:
 *
 *     banner   218   ← the number of RELEASE_NOTES_*.md files
 *     table    222   ← `find docs/releases -name '*.md' | wc -l`
 *
 * 222 was a *wrong measurement*, not a different fact: that `find` also counts README.md
 * and the three ACCEPTANCE_*.md appendices, which are not release notes. Two hand-written
 * numbers plus one wrong command produced a document that looked authoritative and failed
 * the guard test — and nothing regenerated it on the next release, so it would have
 * drifted again regardless of which number was right.
 *
 * So the numbers are now derived: this script rewrites the banner count and the two
 * counting rows from the filesystem and `git tag`. `--check` reports drift without
 * writing, and `test/docs-consistency-guard.test.js` asserts the same derivation, so a
 * hand edit fails before it can ship.
 *
 * Run:  node scripts/sync-changelog-counts.mjs [--check]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CHANGELOG_FILE = 'CHANGELOG.md';
export const RELEASES_DIR = 'docs/releases';
/** The v-prefix is a historical filename variant (v3.9.22), not a new convention. */
export const NOTE_FILE_RE = /^RELEASE_NOTES_v?(\d+\.\d+\.\d+)\.md$/;

const BANNER_RE = /全部\s+\d+\s+份发布说明/;
const NOTES_ROW_RE = /^\|\s*发布说明\s*\|.*$/m;
const TAG_ROW_RE = /^\|\s*git tag\s*\|.*$/m;

const semver = (version) => version.split('.').map(Number);
const compareSemver = (a, b) => {
  const left = semver(a);
  const right = semver(b);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
};

/** Every release-notes version on disk, oldest first. ACCEPTANCE_*.md and README.md are not notes. */
export function releaseNoteVersions(root = ROOT) {
  const names = readdirSync(join(root, RELEASES_DIR));
  // A notes file whose name does not carry a version is not silently skipped: the count
  // would drop by one and every reader would believe it.
  const malformed = names.filter((name) => name.startsWith('RELEASE_NOTES_') && !NOTE_FILE_RE.test(name));
  if (malformed.length) {
    throw new Error(`release-notes files without a version in the name: ${malformed.join(', ')}`);
  }
  return names
    .map((name) => NOTE_FILE_RE.exec(name)?.[1])
    .filter(Boolean)
    .sort(compareSemver);
}

/**
 * `git tag` counts annotated and lightweight tags alike, which is what the row claims.
 * Returns null — "cannot stand behind a count" — in the two cases where the number would
 * be a lie rather than a fact: no git history at all (a tarball checkout), and an empty
 * tag list (a shallow clone lists only the tags its fetched history carries, so
 * `fetch-depth: 1` reports zero for a repository that has hundreds). The caller keeps the
 * existing row instead of rewriting it to a zero. Every project workflow checks out with
 * `fetch-depth: 0`, so the count is real where it is asserted.
 */
export function countGitTags(root = ROOT) {
  try {
    const out = execFileSync('git', ['tag', '--list'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tags = out.split('\n').filter((line) => line.trim());
    return tags.length ? tags.length : null;
  } catch {
    return null;
  }
}

export function changelogCounts(root = ROOT) {
  const versions = releaseNoteVersions(root);
  if (!versions.length) throw new Error(`no RELEASE_NOTES_*.md files under ${RELEASES_DIR}`);
  return { notes: versions.length, first: versions[0], last: versions.at(-1), tags: countGitTags(root) };
}

const notesRow = (counts) => `| 发布说明 | **${counts.notes}** 份,`
  + `v${counts.first} → v${counts.last}`
  + `（生成：\`node scripts/sync-changelog-counts.mjs\`；口径 \`ls docs/releases/RELEASE_NOTES_*.md \\| wc -l\`） |`;

const tagRow = (counts) => `| git tag | ${counts.tags} 个`
  + `（生成：\`node scripts/sync-changelog-counts.mjs\`；口径 \`git tag \\| wc -l\`） |`;

function replaceExactlyOnce(text, pattern, replacement, what) {
  const hits = [...text.matchAll(new RegExp(pattern.source, 'gm'))];
  if (hits.length !== 1) throw new Error(`CHANGELOG.md must carry exactly one ${what}, found ${hits.length}`);
  return text.replace(pattern, replacement);
}

/**
 * Pure: the CHANGELOG with its counts set to `counts`. Throws rather than guess when a row
 * is missing or duplicated — a generator that silently skips a row is how the banner and
 * the table drifted apart in the first place.
 */
export function renderCounts(text, counts) {
  let out = replaceExactlyOnce(text, BANNER_RE, `全部 ${counts.notes} 份发布说明`, 'banner count (全部 N 份发布说明)');
  out = replaceExactlyOnce(out, NOTES_ROW_RE, notesRow(counts), '发布说明 table row');
  if (counts.tags !== null) out = replaceExactlyOnce(out, TAG_ROW_RE, tagRow(counts), 'git tag table row');
  return out;
}

/** The rows the two counts live in, for a drift report. */
export function countClaims(text) {
  const banner = text.match(BANNER_RE)?.[0]?.match(/\d+/)?.[0] ?? null;
  const table = text.match(NOTES_ROW_RE)?.[0]?.match(/\*\*(\d+)\*\*/)?.[1] ?? null;
  const tag = text.match(TAG_ROW_RE)?.[0]?.match(/git tag\s*\|\s*(\d+)/)?.[1] ?? null;
  return { banner, table, tag };
}

function parseArgs(argv) {
  const options = { check: false };
  for (const arg of argv) {
    if (arg === '--check') { options.check = true; continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main(argv) {
  const { check } = parseArgs(argv);
  const path = join(ROOT, CHANGELOG_FILE);
  const before = readFileSync(path, 'utf8');
  const counts = changelogCounts(ROOT);
  const after = renderCounts(before, counts);
  const truth = `notes=${counts.notes} tags=${counts.tags ?? 'unavailable'}`;
  if (before === after) {
    console.log(`CHANGELOG.md counts are current (${truth})`);
    return 0;
  }
  if (check) {
    const claims = countClaims(before);
    console.error(`CHANGELOG.md counts are stale (${truth}):`
      + ` banner=${claims.banner} table=${claims.table} tag=${claims.tag}`);
    console.error('run: node scripts/sync-changelog-counts.mjs');
    return 1;
  }
  writeFileSync(path, after, 'utf8');
  console.log(`CHANGELOG.md counts updated (${truth})`);
  return 0;
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 2;
  }
}
