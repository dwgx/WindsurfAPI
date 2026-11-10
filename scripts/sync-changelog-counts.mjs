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
 * The tag row counts the PUBLISHED namespace, not this checkout's refs: `git tag` minus
 * the tags named in `docs/releases/UNPUBLISHED-TAGS.txt` that this checkout happens to
 * carry, and minus the tag this release creates (`v<package.json version>`). Without the
 * register the row is 230 on the authoring host and 229 in every `fetch-depth: 0` CI
 * checkout (measured 2026-11-11), and it can only be right in one of them. Without the
 * packaged-tag exclusion the row moves by one at the moment the release tag is pushed:
 * 229 in master CI before the push, 230 in the Release checkout after it — the same
 * split, one commit later. Excluding the tag being cut makes the row one number in the
 * authoring checkout, in master CI, and at the tag.
 *
 * Run:  node scripts/sync-changelog-counts.mjs [--check]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CHANGELOG_FILE = 'CHANGELOG.md';
export const RELEASES_DIR = 'docs/releases';
/** Tags that exist in the authoring checkout but were never pushed, one version per line. */
export const UNPUBLISHED_TAGS_FILE = 'docs/releases/UNPUBLISHED-TAGS.txt';
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

/** Every tag in this checkout, or null when git cannot answer at all. */
export function listGitTags(root = ROOT) {
  try {
    const out = execFileSync('git', ['tag', '--list'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\n').filter((line) => line.trim());
  } catch {
    return null;
  }
}

/**
 * Versions whose tag exists in some checkouts and not others: a tag created locally and
 * never pushed. The list has to live in the tree because the tag namespace does not —
 * `git tag` answers "what did this clone fetch", not "what did this repository publish".
 * Measured 2026-11-11: the authoring host carried 230 tags, every `fetch-depth: 0` CI
 * checkout 229, and the delta was `v3.141.592659`, frozen on the unfixed `d5519da3` and
 * never pushed. A count of refs is therefore 230 on one host and 229 everywhere else, and
 * the row can only be right in one of them.
 *
 * One version per line; `#` starts a comment. An entry whose tag this checkout does not
 * have is not an error — that is exactly the CI checkout — it simply is not subtracted.
 */
export function unpublishedTagVersions(root = ROOT) {
  const path = join(root, UNPUBLISHED_TAGS_FILE);
  if (!existsSync(path)) return [];
  const versions = [];
  for (const [index, raw] of readFileSync(path, 'utf8').split('\n').entries()) {
    // `#` starts a comment; no `$` anchor, because a Windows checkout under
    // core.autocrlf=true delivers CRLF and `$` does not match before `\r`.
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const match = /^v?(\d+\.\d+\.\d+)$/.exec(line);
    // A typo here would silently stop subtracting and the count would drift by one; refuse
    // the line instead, the same way releaseNoteVersions() refuses an unversioned filename.
    if (!match) throw new Error(`${UNPUBLISHED_TAGS_FILE}:${index + 1}: not a version: ${line}`);
    versions.push(match[1]);
  }
  return versions;
}

/**
 * The number the row claims: tags a PUBLISHED checkout has, excluding the tag this release
 * creates. Pure, so the invariance can be asserted without creating or deleting a tag:
 *
 *   - a registered local-only tag is subtracted where this checkout has it and ignored
 *     where it does not (the authoring host vs a `fetch-depth: 0` CI checkout);
 *   - the packaged version's tag is subtracted whether or not this checkout has it yet
 *     (master CI before the push vs the Release checkout at the tag).
 *
 * The packaged tag is excluded BY NAME, not by comparing versions. A `< package.json`
 * comparison is invariant too, but it silently drops tags that are not plain `x.y.z` —
 * this repository carries `v3.2.6-rc4`/`rc5`/`rc6` — and a count that quietly stops
 * counting tags is the defect this row exists to expose.
 *
 * Null — "cannot stand behind a count" — when git gave us no tags at all: a tarball
 * checkout has no history, and a shallow clone lists only the tags its fetched history
 * carries, so `fetch-depth: 1` reports zero for a repository that has hundreds. The caller
 * keeps the existing row instead of rewriting it to a zero.
 */
export function countPublishedTags(tags, unpublished = [], packaged = null) {
  if (!tags.length) return null;
  const localOnly = new Set(unpublished);
  const packagedTag = packaged === null ? null : `v${packaged}`;
  return tags.filter((tag) => tag !== packagedTag && !localOnly.has(tag.replace(/^v/, ''))).length;
}

export function changelogCounts(root = ROOT) {
  const versions = releaseNoteVersions(root);
  if (!versions.length) throw new Error(`no RELEASE_NOTES_*.md files under ${RELEASES_DIR}`);
  const tags = listGitTags(root);
  const { version: packaged } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return {
    notes: versions.length,
    first: versions[0],
    last: versions.at(-1),
    tags: tags === null ? null : countPublishedTags(tags, unpublishedTagVersions(root), packaged),
  };
}

const notesRow = (counts) => `| 发布说明 | **${counts.notes}** 份,`
  + `v${counts.first} → v${counts.last}`
  + `（生成：\`node scripts/sync-changelog-counts.mjs\`；口径 \`ls docs/releases/RELEASE_NOTES_*.md \\| wc -l\`） |`;

const tagRow = (counts) => `| git tag | ${counts.tags} 个`
  + `（生成：\`node scripts/sync-changelog-counts.mjs\`；口径 \`git tag \\| wc -l\` 减去`
  + ` \`${UNPUBLISHED_TAGS_FILE}\` 里本 checkout 存在的未发布 tag，再减去 \`package.json\``
  + ` 版本的 tag——本次发布自己的 tag，创建前后都不计数，所以三种 checkout 同值） |`;

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
