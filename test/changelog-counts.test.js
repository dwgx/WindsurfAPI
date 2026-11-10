// The CHANGELOG `git tag` row must be a fact about the PUBLISHED repository.
//
// WHY THIS FILE EXISTS. On 2026-11-11 the row said 230 and CI said it was wrong: the
// authoring host carried 230 tags, every `fetch-depth: 0` checkout 229, and the delta was
// `v3.141.592659` — a tag created locally, frozen on the unfixed `d5519da3`, never pushed.
// `git tag | wc -l` answers "what did this clone fetch", so the generator wrote 230, the
// guard compared 230 against 229 in CI, and the only way to make both green was to weaken
// the guard. The register (`docs/releases/UNPUBLISHED-TAGS.txt`) names the delta, and this
// file pins the property that matters: the count is unchanged by a tag that exists only
// in one checkout.
//
// The docs guard still asserts the row byte-for-byte against renderCounts(); this file
// asserts the derivation underneath it, with the tag list passed in so the two checkout
// shapes can be compared without creating or deleting a tag.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UNPUBLISHED_TAGS_FILE,
  changelogCounts,
  countPublishedTags,
  listGitTags,
  unpublishedTagVersions,
} from '../scripts/sync-changelog-counts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('changelog counts: the git tag row is the published namespace', () => {
  it('a tag that exists only in this checkout does not move the count', () => {
    // The two shapes, as data: the authoring host has the frozen tag, a CI checkout does
    // not. A derivation that returns tags.length passes exactly one of them — which is
    // how 230 shipped while CI measured 229.
    const tags = listGitTags(ROOT);
    assert.ok(tags && tags.length > 0, 'precondition: this checkout must list tags');
    const register = unpublishedTagVersions(ROOT);
    const withoutLocalOnly = tags.filter((tag) => !register.includes(tag.replace(/^v/, '')));

    assert.equal(
      countPublishedTags(tags, register),
      countPublishedTags(withoutLocalOnly, register),
      'the row must not change when a registered local-only tag is present or absent',
    );
  });

  it('a registered tag is subtracted only where this checkout has it', () => {
    assert.equal(countPublishedTags(['v1.0.0', 'v1.0.1', 'v1.0.2'], ['1.0.2']), 2);
    // The CI shape: the same register, a namespace that never fetched the tag.
    assert.equal(countPublishedTags(['v1.0.0', 'v1.0.1'], ['1.0.2']), 2);
    // No register at all is not a licence to count refs: the published count is unchanged.
    assert.equal(countPublishedTags(['v1.0.0', 'v1.0.1'], []), 2);
  });

  it('no tags at all is "cannot stand behind a count", not zero', () => {
    // A shallow clone lists only the tags its fetched history carries; rewriting the row to
    // 0 there would be a measurement nobody can stand behind. The guard skips on null.
    assert.equal(countPublishedTags([], ['1.0.2']), null);
  });

  it('the row equals the count of a checkout that never fetched the local-only tag', () => {
    // The regression this file exists for: with the derivation reverted to tags.length this
    // is 230 vs 229 on the authoring host, i.e. exactly the row CI rejected.
    const tags = listGitTags(ROOT);
    const register = unpublishedTagVersions(ROOT);
    const published = countPublishedTags(tags, register);
    assert.equal(changelogCounts(ROOT).tags, published, 'the row must equal the published count');
    assert.equal(
      published,
      countPublishedTags(tags.filter((tag) => !register.includes(tag.replace(/^v/, ''))), register),
      'and that count must be the same in a checkout without the local-only tags',
    );
  });

  it('a malformed register line is an error, not a silent zero-subtraction', () => {
    // A typo here would drop the subtraction and the count would drift by one on the host
    // only — the failure this whole mechanism exists to prevent. Refuse the line instead.
    const dir = mkdtempSync(join(tmpdir(), 'unpublished-tags-'));
    try {
      mkdirSync(join(dir, 'docs', 'releases'), { recursive: true });
      writeFileSync(join(dir, UNPUBLISHED_TAGS_FILE), '# comment\nv3.141.592659  # frozen\nnot-a-version\n');
      assert.throws(() => unpublishedTagVersions(dir), /not a version: not-a-version/);
      writeFileSync(join(dir, UNPUBLISHED_TAGS_FILE), '# comment only\n\n');
      assert.deepEqual(unpublishedTagVersions(dir), []);
      // The blob is LF, but a Windows checkout under core.autocrlf=true hands the parser
      // CRLF. A comment line must still strip to empty, and the version must still parse.
      writeFileSync(join(dir, UNPUBLISHED_TAGS_FILE), '# comment\r\nv3.141.592659  # frozen\r\n');
      assert.deepEqual(unpublishedTagVersions(dir), ['3.141.592659']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
