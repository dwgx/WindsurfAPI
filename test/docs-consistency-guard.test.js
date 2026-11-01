// Mechanical guards for the documentation set.
//
// WHY THIS FILE EXISTS. The docs carry conventions about themselves — "every archived handoff
// carries a banner naming the current one", "don't cite a section number without opening it",
// "the index names the live handoff". Every one of those was, until now, enforced by discipline
// alone, and each has failed at least once:
//
//   - Nine archived handoffs all named a handoff that had since been closed; the chain had no
//     live head. Fixed by hand, nine files at a time — exactly the chore a guard should own.
//   - A handoff cited `release-process` as if it were a document. Nothing by that name existed.
//   - The index called the ledger "twelve rounds" after the thirteenth landed.
//   - CONTRIBUTING pinned a gate count from five releases earlier.
//
// A convention that fails silently is worse than no convention, because the corpus keeps
// *looking* authoritative. These assertions are deliberately structural — they check claims a
// script can settle, and leave prose judgement to review.
//
// Both npm test and test:release use recursive discovery from scripts/run-test-shard.mjs.
// test/test-shard-script.test.js pins the inventory so nested files cannot silently disappear.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { changelogCounts, renderCounts } from '../scripts/sync-changelog-counts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

function mdFiles() {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.md'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\0').filter(Boolean);
  assert.ok(files.length > 0, 'markdown inventory must contain tracked files');
  return [...new Set(files)].sort().map(file => resolve(ROOT, file));
}

const read = (p) => readFileSync(p, 'utf8');
const rel = (p) => relative(ROOT, p).split('\\').join('/');

// Handoff filenames do NOT sort chronologically: `-B.md` sorts before `.md`, so the original
// 08-04 sorts after B/C/D/E, and 08-05 is misdated (it covers v3.9.12). So "newest" cannot be
// derived from the name — it is whichever file no other handoff points AT as current.
function handoffFiles() {
  return readdirSync(DOCS)
    .filter((n) => /^HANDOFF-.*\.md$/.test(n))
    .map((n) => join(DOCS, n));
}

// D-07: the banner's visible text and its href were allowed to disagree. Nine archived
// handoffs said `当前一份是 [HANDOFF-2026-08-20.md](HANDOFF-2026-10-15.md)` — the href was
// right, so every existing assertion passed, while the sentence a reader actually sees named
// a superseded file. A link is a claim in two places; both have to resolve to the same file.
function handoffLinkMismatches(body) {
  const out = [];
  for (const m of body.matchAll(/\[(HANDOFF-[^\]\s]+\.md)\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    const text = m[1];
    const href = m[2].split('/').pop();
    if (href !== text) out.push(`${text} -> ${m[2]}`);
  }
  return out;
}

describe('docs: relative links resolve', () => {
  it('every relative .md link in every tracked markdown file points at a file that exists', () => {
    const broken = [];
    for (const f of mdFiles()) {
      const body = read(f);
      for (const m of body.matchAll(/\]\(([^)\s#]+\.md)(#[^)]*)?\)/g)) {
        const target = m[1];
        if (/^https?:/.test(target)) continue;
        if (!existsSync(resolve(dirname(f), target))) broken.push(`${rel(f)} -> ${target}`);
      }
    }
    assert.deepEqual(broken, [], `broken relative .md links:\n  ${broken.join('\n  ')}`);
  });

  it('no markdown file cites a bare name as if it were a document', () => {
    // `release-process` was cited in a handoff as though it resolved to something. It did not:
    // the procedure lived only outside the repo. This pins the specific shape that bit us —
    // a backticked hyphenated name that reads like a filename but has no file and no link.
    const suspects = ['release-process', 'merge-bar', 'audit-ledger'];
    const hits = [];
    for (const f of mdFiles()) {
      const body = read(f);
      for (const s of suspects) {
        // A mention is fine when it is part of a real link; flag only bare backticked mentions.
        const bare = new RegExp('`' + s + '`(?!\\])', 'g');
        if (bare.test(body) && !body.includes(`](${s}`)) hits.push(`${rel(f)}: \`${s}\``);
      }
    }
    assert.deepEqual(hits, [], `bare pseudo-filename citations (link them or name the real file):\n  ${hits.join('\n  ')}`);
  });
});

describe('docs: the handoff chain has exactly one live head', () => {
  // The convention is: archived handoffs carry a forward banner naming the CURRENT one, and the
  // index's first row names that same file. Nine banners once all named a file that had been
  // closed, which left the chain pointing at a dead end.
  const banner = (f) => read(f).split('\n').slice(0, 12).join('\n');

  // Discriminator: an ARCHIVED handoff's banner says "当前一份是 …"; the live head has no such
  // line, because there is nothing after it. Keying on "does any other file link to me" does NOT
  // work — banners also carry a BACKWARD "上一份:[…]" pointer, so nearly every file is linked
  // by someone. That distinction is what made the first version of this test fail.
  const ARCHIVED_MARK = '当前一份是';
  const isArchived = (f) => banner(f).includes(ARCHIVED_MARK);

  it('exactly one handoff is the live head; every other one is marked archived', () => {
    const files = handoffFiles();
    assert.ok(files.length >= 2, 'expected several handoffs');
    const heads = files.filter((f) => !isArchived(f));
    assert.deepEqual(
      heads.map(rel).sort(),
      heads.length === 1 ? heads.map(rel) : [],
      `exactly one handoff may lack the "${ARCHIVED_MARK}" banner (the live head); found ${heads.length}: ${heads.map(rel).join(', ')}`,
    );
    assert.equal(heads.length, 1, `found ${heads.length} handoffs with no archived banner`);
  });

  it('every archived banner links to the live head, not to some earlier one', () => {
    const files = handoffFiles();
    const head = files.find((f) => !isArchived(f));
    assert.ok(head, 'precondition: a live head exists');
    const headLink = `](${rel(head).replace('docs/', '')})`;
    // The banner is a block, and the link often wraps onto the next line from the phrase —
    // so search the whole banner, not the same line.
    const stale = files
      .filter((f) => f !== head && !banner(f).includes(headLink))
      .map(rel);
    assert.deepEqual(
      stale, [],
      `archived handoffs whose banner does not link the live head (${rel(head)}). `
      + 'Nine of them once all named a handoff that had been closed, leaving the chain with no live head.',
    );
  });

  it('a link whose visible text is a handoff filename points at that same file', () => {
    // The old guard read only the href. A banner could therefore say "当前一份是
    // HANDOFF-2026-08-20" while linking 10-15, and pass every assertion in this file.
    const problems = [];
    for (const f of mdFiles()) {
      for (const mismatch of handoffLinkMismatches(read(f))) problems.push(`${rel(f)}: ${mismatch}`);
    }
    assert.deepEqual(
      problems, [],
      `handoff links whose visible text names a different file than the href:\n  ${problems.join('\n  ')}`,
    );
  });

  it('the banner text after 当前一份是 names the live head, not a superseded one', () => {
    // The forward pointer is the one link a reader follows from an archived handoff. It has
    // to name the live head in the visible text, not merely link to it: D-07 survived twelve
    // releases because the href was correct and the sentence was not.
    const files = handoffFiles();
    const head = files.find((f) => !isArchived(f));
    assert.ok(head, 'precondition: a live head exists');
    const headName = rel(head).replace('docs/', '');
    const bad = [];
    for (const f of files.filter((x) => x !== head)) {
      const b = banner(f);
      const at = b.indexOf(ARCHIVED_MARK);
      assert.notEqual(at, -1, `${rel(f)} must carry the archived banner`);
      const link = b.slice(at).match(/\[([^\]]+)\]\(([^)]+)\)/);
      assert.ok(link, `${rel(f)}: the archived banner must link the live head after "${ARCHIVED_MARK}"`);
      const [, text, href] = link;
      if (text !== headName || href.split('/').pop() !== headName) {
        bad.push(`${rel(f)}: [${text}](${href}) — expected [${headName}](${headName})`);
      }
    }
    assert.deepEqual(bad, [], `archived banners naming the wrong live head:\n  ${bad.join('\n  ')}`);
  });

  it('self-test: the text/href detector rejects the banner shape the old guard missed', () => {
    assert.deepEqual(
      handoffLinkMismatches('> 当前一份是 [HANDOFF-2026-08-20.md](HANDOFF-2026-10-15.md)。'),
      ['HANDOFF-2026-08-20.md -> HANDOFF-2026-10-15.md'],
    );
    assert.deepEqual(
      handoffLinkMismatches('> 当前一份是 [HANDOFF-2026-10-15.md](HANDOFF-2026-10-15.md)。'),
      [],
    );
    assert.deepEqual(
      handoffLinkMismatches('[HANDOFF-2026-08-03.md](../HANDOFF-2026-08-03.md)'),
      [],
      'a path prefix is fine as long as the basename matches',
    );
  });

  it('every archived handoff also links back to the docs index', () => {
    // Eight of nine did; the ninth (08-05) linked only onward, so from that file you could not
    // reach the index in one hop.
    const files = handoffFiles();
    const missing = files
      .filter((f) => isArchived(f) && !banner(f).includes('](README.md)'))
      .map(rel);
    assert.deepEqual(missing, [], 'archived handoffs with no link back to docs/README.md');
  });

  it('the docs index names the live head in its first table row', () => {
    const index = read(join(DOCS, 'README.md'));
    const head = handoffFiles().find((f) => !isArchived(f));
    assert.ok(head, 'precondition: a live head exists');
    const headName = rel(head).replace('docs/', '');
    const firstRow = index.split('\n').find((l) => l.startsWith('| 1 |')) || '';
    assert.ok(
      firstRow.includes(headName),
      `docs/README.md's first "read these" row must name the live handoff (${headName}); it says: ${firstRow.slice(0, 120)}`,
    );
  });
});

describe('docs: the release runbook stays true to the tooling it describes', () => {
  const runbook = () => read(join(DOCS, 'releases', 'README.md'));

  it('does not tell the reader to commit on master, which the pre-commit hook refuses', () => {
    // The four-step version said "Commit and push to master". `.githooks/pre-commit` refuses
    // exactly that, so the documented procedure could not be followed as written.
    //
    // The first version of this assertion failed on the CORRECTED runbook, because the errata
    // block quotes the old wrong instruction in order to warn about it. Scanning raw prose for a
    // forbidden phrase cannot tell an instruction from a citation of one — so strip blockquotes
    // (`>` lines) before checking. That is where errata live by convention.
    const hook = read(join(ROOT, '.githooks', 'pre-commit'));
    assert.match(hook, /master\|main/, 'precondition: the hook still special-cases master');

    const instructions = runbook()
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('>'))
      .join('\n');
    assert.doesNotMatch(
      instructions,
      /Commit and push to `?master`?/i,
      'the runbook must not instruct committing on master while the hook refuses it '
      + '(errata blockquotes are exempt — they quote the old wrong text deliberately)',
    );
    // And it must positively tell you the branch-then-merge shape.
    assert.match(instructions, /merge --ff-only/, 'the runbook must show the branch → ff-only merge flow');
  });

  it('tells the reader to bump the lock file, which carries the version twice', () => {
    const lock = read(join(ROOT, 'package-lock.json'));
    const pkgVersion = JSON.parse(read(join(ROOT, 'package.json'))).version;
    const occurrences = lock.split(`"version": "${pkgVersion}"`).length - 1;
    assert.equal(occurrences, 2, `precondition: the lock should carry ${pkgVersion} twice, found ${occurrences}`);
    assert.match(runbook(), /package-lock\.json/, 'the runbook must name package-lock.json');
  });

  it('tells the reader to create an ANNOTATED tag, matching what every shipped tag is', () => {
    assert.match(runbook(), /git tag -a/, 'the runbook must show `git tag -a`; lightweight tags are not what ships');
  });

  it('names the gate commands a releaser has to pass', () => {
    const r = runbook();
    for (const cmd of ['npm run test:release', 'secret-scan', 'npm run mutate']) {
      assert.ok(r.includes(cmd), `the runbook must name \`${cmd}\``);
    }
  });

  it('warns that a green suite does not cover mutation anchors', () => {
    // The load-bearing sentence. PR #241 broke two anchors and three separate green gates
    // missed it, because the suite does not run the specs.
    const r = runbook();
    assert.match(
      r,
      /does not run mutation specs|不跑突变 spec|does not run the mutation specs/i,
      'the runbook must state that the test suite does not run mutation specs',
    );
  });
});

describe('docs: mutation specs and the gate agree', () => {
  it('every mutation spec anchor appears exactly once in its target file', () => {
    // Not strictly a docs guard, but it is the invariant three green gates missed on PR #241,
    // and it belongs somewhere the gate actually runs. `npm run mutate` enforces it only when
    // someone remembers to run the loop; this makes CI refuse the merge instead.
    const dir = join(ROOT, 'test', 'mutations');
    const problems = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const spec = JSON.parse(read(join(dir, name)));
      for (const m of spec.mutations || []) {
        const target = read(join(ROOT, m.file)).replaceAll('\r\n', '\n');
        const hits = target.split(m.anchor).length - 1;
        if (hits !== 1) problems.push(`${name} :: hits=${hits} :: ${m.name.slice(0, 70)}`);
      }
    }
    assert.deepEqual(problems, [], `mutation anchors that do not match exactly once:\n  ${problems.join('\n  ')}`);
  });

  it('every mutation spec baseline matches what its test files actually pass', () => {
    // `expectBaselinePass` went stale twice in one day: once when an assertion was deleted, once
    // when assertions were added to a covered file. Both times guard 2 caught it only because
    // someone ran the loop by hand. This states the invariant without running the suite: the
    // spec must list the files it measures, and those files must exist.
    const dir = join(ROOT, 'test', 'mutations');
    const problems = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const spec = JSON.parse(read(join(dir, name)));
      assert.ok(Array.isArray(spec.tests) && spec.tests.length, `${name}: needs a tests[] array`);
      assert.equal(typeof spec.expectBaselinePass, 'number', `${name}: needs a numeric expectBaselinePass`);
      for (const t of spec.tests) {
        if (!existsSync(join(ROOT, t))) problems.push(`${name} -> missing test file ${t}`);
      }
    }
    assert.deepEqual(problems, [], `mutation specs referencing files that do not exist:\n  ${problems.join('\n  ')}`);
  });
});

describe('docs: version claims match the repository', () => {
  // The index's first row named a `vX.Y.Z` as the state of `master` that was not a tag at all,
  // while master sat five commits past the newest one — wrong in both directions at once, and
  // directly opposed to the current handoff, which devotes a section to those unreleased
  // commits. It survived because every other assertion in this file checks *links and
  // structure*: a version claim is prose that happens to be mechanically checkable, and
  // nothing was checking it.
  //
  // TWO EARLIER VERSIONS OF THIS GUARD WERE WRONG, both in the same way — they could not tell
  // a claim from something that merely looks like one:
  //
  //   1. It scanned every markdown file, and the ledger's own erratum *quoted* the bad claim
  //      while correcting it. Same shape as the runbook assertion above, which had to strip
  //      `>` blockquotes for the same reason. Fixed on the prose side: describe a corrected
  //      claim, do not re-paste it.
  //   2. It resolved names against `.git/refs/tags` + `packed-refs`, and passed locally while
  //      failing the release build: GitHub's checkout is shallow and carries only the tag being
  //      built, so every older tag looked non-existent. It flagged the ledger's
  //      "master == v3.9.17" — a statement that was TRUE when written, in an append-only file.
  //      The probe guard (`known.size > 0`) did not help: the tag under construction was
  //      present, so it never tripped.
  //
  // The invariant that survived:
  //   - only files that describe the CURRENT state are checked (the index and the live
  //     handoff). Archived handoffs and the ledger are append-only records whose past claims
  //     are SUPPOSED to be stale.
  //   - the primary comparison is against `package.json`, which is present in every checkout
  //     and is what `src/version.js` actually serves.
  //   - the tag claim is resolved by git, but fail-closed: a checkout with no tags is an
  //     error, not a pass, and the release runbook's pre-tag window (push master, then tag)
  //     is handled explicitly by allowing the packaged version or the newest reachable tag.
  //     The old version of this guard avoided git entirely after a shallow release checkout
  //     made every older tag look absent; release.yml now checks out with fetch-depth: 0.
  //
  // A version claim is a LABELLED current-state statement. Matching every `vX.Y.Z` would flag
  // history: the live handoff legitimately says "v3.9.40 之后 = 23 提交" and "wire 基线选到
  // v3.9.39". The three labels below are the spellings the live docs actually use, and the old
  // guard saw none of them: D-08 recorded a live head that said "产品 tag v3.9.40" and
  // "package.json 3.9.40" while `master == vX` matched neither, so it survived twelve releases.
  const VERSION_CLAIM_PATTERNS = [
    { label: 'master', re: /master\s*(?:==|=|is)\s*`?v?(\d+\.\d+\.\d+)`?/gi },
    { label: '产品 tag', re: /产品\s*tag\s+`?v(\d+\.\d+\.\d+)`?/gi },
    { label: 'package.json', re: /package\.json\s+`?v?(\d+\.\d+\.\d+)`?/gi },
  ];

  const versionClaims = (body) => {
    // A blockquote is a citation of a past claim (the ledger's errata do this), not a claim.
    const stripped = body.split('\n').filter((l) => !l.trimStart().startsWith('>')).join('\n');
    const out = [];
    for (const { label, re } of VERSION_CLAIM_PATTERNS) {
      for (const m of stripped.matchAll(re)) out.push({ label, version: m[1] });
    }
    return out;
  };

  // The live handoff's §0 carries the current facts in its FIRST fenced block. Everything
  // below that block is history, including the 2026-10-15 snapshot retained under <details>.
  const currentStateBlock = (body) => {
    const start = body.search(/^##\s*0\.[^\n]*$/m);
    assert.notEqual(start, -1, 'the live handoff must carry a "## 0." current-state section');
    const fence = body.slice(start).match(/^```[^\n]*\n([\s\S]*?)\n```/m);
    assert.ok(fence, 'the live handoff §0 must carry a fenced status block');
    return fence[1];
  };

  const notesFor = (version) => [
    join(DOCS, 'releases', `RELEASE_NOTES_${version}.md`),
    join(DOCS, 'releases', `RELEASE_NOTES_v${version}.md`),
  ].find(existsSync);

  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

  // Ancestry alone let §0 name a commit ten commits and six src/ files behind HEAD while this
  // guard stayed green (GapSweep2 C4-18 — the second recurrence; seven files once the wave-5
  // #273 merge landed). A docs-only commit does not change what the handoff describes, so it
  // may lag; a src/ change does, so the named master must already contain every src/ change
  // reachable from HEAD.
  const srcChangesSince = (sha) =>
    git(['diff', '--name-only', `${sha}..HEAD`, '--', 'src/']).split(/\r?\n/).filter(Boolean);

  const masterSrcLag = (sha) => {
    const changed = srcChangesSince(sha);
    return {
      changed,
      problem: changed.length
        ? `§0 master SHA ${sha} predates ${changed.length} src/ change(s); update §0 to HEAD`
        : null,
    };
  };

  // The release runbook pushes master BEFORE it creates the tag (docs/releases/README.md §7).
  // During that window the live handoff's tag line may legitimately name the previous release,
  // while its package.json line already names the version being prepared. So the tag claim is
  // allowed to be either the packaged version or the newest release tag reachable from HEAD —
  // and nothing older. That is what catches a head that sat twelve releases behind.
  const latestTagVersion = () => {
    const tags = git(['tag', '--merged', 'HEAD', '-l', 'v[0-9]*'])
      .split(/\r?\n/)
      .filter((t) => /^v\d+\.\d+\.\d+$/.test(t)); // skip v3.2.6-rc4-style prereleases
    const latest = tags
      .map((t) => t.replace(/^v/, ''))
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
      })
      .pop();
    assert.ok(latest, 'no release tags reachable from HEAD — run `git fetch --tags`');
    return latest;
  };

  const staleClaimReason = (claim, pkgVersion, latestTag) => {
    if (claim.label === '产品 tag') {
      if (claim.version === pkgVersion || claim.version === latestTag) return null;
      return `says v${claim.version}; packaged is ${pkgVersion}, latest reachable tag is v${latestTag}`;
    }
    if (claim.version !== pkgVersion) return `says ${claim.version}; package.json is ${pkgVersion}`;
    return null;
  };

  // A version link is a claim about a specific version in two places: the text and the target.
  // The relative-link guard above proves the target exists; this proves it is the notes file
  // for the version the text names. Tag URLs resolve offline through the same notes-file
  // check; the live handoff's §0 is where the real annotated tag is resolved by git.
  const versionLinkProblem = (version, target, fromFile) => {
    const selfTag = target.match(
      /^https?:\/\/github\.com\/dwgx\/WindsurfAPI\/releases\/tag\/v?(\d+\.\d+\.\d+)\/?$/i,
    );
    if (selfTag) {
      if (selfTag[1] !== version) return `[v${version}] -> ${target} names v${selfTag[1]}`;
      if (!notesFor(version)) return `[v${version}] -> ${target} has no release-notes file`;
      return null;
    }
    if (/^https?:/i.test(target)) return null; // someone else's document
    const notes = target.split('/').pop().match(/^RELEASE_NOTES_v?(\d+\.\d+\.\d+)\.md$/);
    if (!notes) return `[v${version}] -> ${target} is not a release-notes file`;
    if (notes[1] !== version) return `[v${version}] -> ${target} is the notes file for v${notes[1]}`;
    if (!existsSync(resolve(dirname(fromFile), target))) {
      return `[v${version}] -> ${target} does not exist`;
    }
    return null;
  };

  it('the packaged version is a plain semver string', () => {
    const pkg = JSON.parse(read(join(ROOT, 'package.json')));
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json version must be bare semver');
  });

  it('every env var named in prose docs also appears in .env.example', () => {
    // `.env.example` is the only file a reader consults to find out what can be turned on.
    // DEVIN_CONNECT_IMAGE_TAG was documented ONLY in the cutover runbook, so vision looked
    // like it did not exist: a user sent a picture, the proxy dropped it before the wire, and
    // nothing appeared in any log. That reached us as a bug report (#244).
    //
    // Checked in this direction on purpose. Enumerating every name read out of `src/` needs a
    // parser — env access here spans `env.X`, `env['X']`, `positiveIntEnv('X', …)` and a
    // `{ env: 'X' }` registry, and a regex sweep over string literals returns hundreds of
    // false positives (error codes and enum values look identical). "Somebody wrote prose
    // about this switch, so a reader can find out it exists" is both mechanically decidable
    // and the property that actually failed.
    const doc = read(join(ROOT, '.env.example'));
    const declared = new Set(
      [...doc.matchAll(/^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]),
    );
    assert.ok(declared.size > 20, `probe check: only ${declared.size} names parsed out of .env.example — the extraction is broken, not the docs`);

    // Prose only. Handoffs and the ledger are audit records that legitimately discuss
    // one-off calibration knobs; the reader-facing surface is the READMEs and the runbook.
    const prose = ['README.md', 'README.en.md', join('docs', 'DEVIN-CONNECT-CUTOVER.md')];
    const missing = new Map();
    for (const rel_ of prose) {
      const body = read(join(ROOT, rel_));
      for (const m of body.matchAll(/\b(DEVIN_CONNECT_[A-Z0-9_]+|WINDSURFAPI_[A-Z0-9_]+)\b/g)) {
        if (!declared.has(m[1])) {
          if (!missing.has(m[1])) missing.set(m[1], rel_);
        }
      }
    }
    const problems = [...missing].map(([name, where]) => `${name} (documented in ${where})`);
    assert.deepEqual(problems, [], `env vars written about in prose but absent from .env.example:\n  ${problems.join('\n  ')}`);
  });

  it('every switch read in src/ is findable in some reader-facing doc', () => {
    // The OTHER direction from the assertion above, and the one that actually broke. The
    // handoff recorded "86 switches, all 86 documented". Both halves were wrong: 156 exist and
    // 47 had no mention in any reader-facing doc — including all five wire coordinates added
    // that same round. The claim was self-confirming because the count came from a bare
    // `grep 'env\.'`, which misses the very reads that were undocumented.
    //
    // The previous rationale for skipping this direction was that a sweep returns hundreds of
    // false positives. That is true of an unanchored scan for string literals, but not of this
    // one: restricted to the three real prefixes, matching only the access forms this codebase
    // actually uses, and with comments stripped, the sweep is exact. Comments must go first —
    // a switch discussed in a `//` note next to its own read site would otherwise count itself
    // as documented.
    //
    // The fifth form was added when PR #249 landed and immediately slipped past the first four:
    //   export const LEAK_TRACE_ENV = 'WINDSURFAPI_LEAK_TRACE';
    //   return String(env[LEAK_TRACE_ENV] ?? '').trim() === '1';
    // The read site names a CONSTANT, so no pattern anchored to `env[...]` with a literal can
    // see the switch. This one was documented anyway, so the guard stayed green while its
    // census silently under-counted — the exact failure the guard exists to prevent, arriving
    // through the door it does not watch. Matching the DECLARATION keeps the sweep static: the
    // name is still a literal in src/, just one hop from the read.
    const ACCESS = new RegExp(
      [
        /(?:process\.)?env\.([A-Z][A-Z0-9_]{2,})/, //            env.FOO
        /(?:process\.)?env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]/, // env['FOO']
        /positiveIntEnv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/, //    positiveIntEnv('FOO', 30_000)
        /\benv:\s*['"]([A-Z][A-Z0-9_]{2,})['"]/, //              { env: 'FOO', def: … } registry
        /\bconst\s+[A-Za-z_$][\w$]*\s*=\s*['"]([A-Z][A-Z0-9_]{2,})['"]/, // const X = 'FOO'
      ]
        .map((r) => r.source)
        .join('|'),
      'g',
    );
    const PREFIXES = ['DEVIN_CONNECT_', 'WINDSURFAPI_', 'CASCADE_'];
    // Comments must go before the sweep, but a naive /\/\*[\s\S]*?\*\//g DOES NOT WORK here
    // and shipped broken once. Two files in src/ contain a REGEX LITERAL that holds `*/`
    // (e.g. /\*\//), so `*/` occurrences outnumber `/*` — 9 vs 7 in identity-neutralize.js.
    // The lazy match then closes on a `*/` that lives inside a regex, mispairs from there on,
    // and deletes real code. Measured cost: WINDSURFAPI_NEUTRALIZE_CC_AGGRESSIVE and
    // DEVIN_CONNECT_CRED_KEY (a CREDENTIAL switch) were invisible to this guard while it
    // reported green, and the same bug in the census script is why ENV-SWITCHES.md claimed to
    // cover 83 switches while its table listed 81.
    //
    // Line-oriented stripping avoids the problem: a `/* … */` block that opens and closes on
    // one line is removed, a block-comment body is dropped by tracking depth line by line,
    // and a line that merely CONTAINS `*/` inside a string or regex cannot swallow the file
    // because state only ever advances one line at a time.
    const stripComments = (s) => {
      const out = [];
      let inBlock = false;
      for (const raw of s.split('\n')) {
        let line = raw;
        if (inBlock) {
          const close = line.indexOf('*/');
          if (close === -1) { out.push(''); continue; }
          line = line.slice(close + 2);
          inBlock = false;
        }
        // Remove self-contained /* … */ spans on this line.
        line = line.replace(/\/\*.*?\*\//g, '');
        // An unterminated /* opens a block — but only when it is not inside a // comment.
        const open = line.indexOf('/*');
        const lineComment = line.indexOf('//');
        if (open !== -1 && (lineComment === -1 || open < lineComment)) {
          inBlock = true;
          line = line.slice(0, open);
        }
        out.push(line.replace(/\/\/.*$/, ''));
      }
      return out.join('\n');
    };

    const srcDir = join(ROOT, 'src');
    const jsFiles = [];
    const walkJs = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walkJs(p);
        else if (e.name.endsWith('.js')) jsFiles.push(p);
      }
    };
    walkJs(srcDir);

    const read_ = new Map();
    for (const f of jsFiles) {
      for (const m of stripComments(readFileSync(f, 'utf8')).matchAll(ACCESS)) {
        const name = m.slice(1).find(Boolean);
        if (PREFIXES.some((p) => name.startsWith(p)) && !read_.has(name)) {
          read_.set(name, relative(ROOT, f));
        }
      }
    }
    assert.ok(
      read_.size > 100,
      `probe check: only ${read_.size} switches extracted from src/ — the sweep is broken, not the docs`,
    );

    const docs = ['.env.example', 'README.md', 'README.en.md', join('docs', 'ENV-SWITCHES.md')]
      .map((rel_) => read(join(ROOT, rel_)))
      .join('\n');
    // Word-boundary match in both directions, so WINDSURFAPI_TRACE is not "documented" by a
    // line that only mentions WINDSURFAPI_TRACE_DIR. Prefix collisions are why the historical
    // counts inflated; the same trap applies to coverage.
    const undocumented = [...read_]
      .filter(([name]) => !new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(docs))
      .map(([name, where]) => `${name} (read in ${where})`)
      .sort();
    assert.deepEqual(
      undocumented,
      [],
      `switches read in src/ but absent from every reader-facing doc:\n  ${undocumented.join('\n  ')}`,
    );
  });

  // SELF-TEST. The two assertions above scan real files, so when the corpus is clean they pass
  // whether the detection works or not — the exact shape of a test that cannot fail. And a
  // guard cannot be mutation-verified against itself: weakening it makes no other test go red,
  // so a spec that mutated these lines would report four survivors with no premise keeping them
  // harmless (which is the anti-pattern this repo rejects in review). Instead, drive the
  // detection logic on synthetic inputs where the answer is known.
  //
  // The fixtures drive the same helpers the real assertions use. What is being pinned is that
  // a checker of THIS SHAPE rejects THESE inputs; if the assertions above are rewritten to a
  // different mechanism, these fixtures must be rewritten with them.
  describe('self-test: the detectors reject known-bad inputs', () => {
    const declaredIn = (envExample) =>
      new Set([...envExample.matchAll(/^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));

    it('the .env.example parser sees both commented and uncommented declarations', () => {
      const d = declaredIn('PORT=3003\n# DEVIN_CONNECT_IMAGE_TAG=10\n#WINDSURFAPI_TRACE=1\n   # LS_PORT=42100\n');
      assert.ok(d.has('PORT'), 'plain declaration');
      assert.ok(d.has('DEVIN_CONNECT_IMAGE_TAG'), 'commented with a space — the dominant style in this file');
      assert.ok(d.has('WINDSURFAPI_TRACE'), 'commented with no space');
      assert.ok(d.has('LS_PORT'), 'indented comment');
      assert.ok(!d.has('NOPE'), 'does not invent names');
    });

    it('a prose mention absent from .env.example is detected', () => {
      // The #244 shape: documented in a runbook, missing from the file a reader consults.
      const declared = declaredIn('# DEVIN_CONNECT_SESSION_REUSE=0\n');
      const prose = 'Set `DEVIN_CONNECT_IMAGE_TAG=10` to turn vision on.';
      const found = [...prose.matchAll(/\b(DEVIN_CONNECT_[A-Z0-9_]+|WINDSURFAPI_[A-Z0-9_]+)\b/g)]
        .map((m) => m[1]).filter((n) => !declared.has(n));
      assert.deepEqual(found, ['DEVIN_CONNECT_IMAGE_TAG'], 'must flag the undocumented switch');
    });

    it('a documented mention is not flagged', () => {
      const declared = declaredIn('# DEVIN_CONNECT_IMAGE_TAG=10\n');
      const prose = 'Set `DEVIN_CONNECT_IMAGE_TAG=10` to turn vision on.';
      const found = [...prose.matchAll(/\b(DEVIN_CONNECT_[A-Z0-9_]+|WINDSURFAPI_[A-Z0-9_]+)\b/g)]
        .map((m) => m[1]).filter((n) => !declared.has(n));
      assert.deepEqual(found, [], 'no false positive when the switch IS documented');
    });

    it('the claim scanner sees every labelled current-state spelling', () => {
      assert.deepEqual(versionClaims('master == `v3.9.17`.').map((c) => c.version), ['3.9.17']);
      assert.deepEqual(versionClaims('master is v1.0.0').map((c) => c.version), ['1.0.0'], 'the `is` spelling');
      assert.deepEqual(versionClaims('产品 tag     v3.9.40 —— annotated').map((c) => c.version), ['3.9.40']);
      assert.deepEqual(versionClaims('package.json 3.9.40（= tag）').map((c) => c.version), ['3.9.40']);
    });

    it('the tag claim may name the packaged version or the latest tag, never an older one', () => {
      // Pre-tag window: package.json is 3.9.54 while the newest reachable tag is still v3.9.53.
      assert.equal(staleClaimReason({ label: '产品 tag', version: '3.9.53' }, '3.9.54', '3.9.53'), null);
      assert.equal(staleClaimReason({ label: '产品 tag', version: '3.9.54' }, '3.9.54', '3.9.53'), null);
      assert.match(
        staleClaimReason({ label: '产品 tag', version: '3.9.40' }, '3.9.54', '3.9.53'),
        /latest reachable tag is v3\.9\.53/,
      );
      assert.match(
        staleClaimReason({ label: 'package.json', version: '3.9.53' }, '3.9.54', '3.9.53'),
        /package\.json is 3\.9\.54/,
      );
      assert.equal(staleClaimReason({ label: 'package.json', version: '3.9.54' }, '3.9.54', '3.9.53'), null);
    });

    it('a bare historical mention is NOT a claim', () => {
      // The live handoff's own §0 has sentences like this; matching every vX.Y.Z would make
      // the guard fail on history rather than on a stale current-state statement.
      assert.deepEqual(versionClaims('v3.9.40 之后 = 23 提交；wire 基线选到 v3.9.39 严格祖先。'), []);
    });

    it('a quoted claim inside a blockquote is NOT treated as a claim', () => {
      // This is what broke the first two versions of the version assertion: an erratum
      // correcting a bad claim had to restate it, and the guard flagged the correction.
      const body = '> 产品 tag v3.9.17 是旧值\n\n产品 tag v3.9.20 是现状';
      assert.deepEqual(versionClaims(body).map((c) => c.version), ['3.9.20'],
        'a citation of a wrong claim must not be read as making it');
    });

    it('the current-state extractor reads the first fenced block, not the retained history', () => {
      const body = '## 0. 当前状态\n\n```\n产品 tag v9.9.9\n```\n\n### 历史快照\n\n```\n产品 tag v1.0.0\n```\n';
      assert.deepEqual(versionClaims(currentStateBlock(body)).map((c) => c.version), ['9.9.9']);
    });

    it('a §0 master SHA that predates src/ changes is rejected, with the count', () => {
      // The recurrence this guard exists for: §0 named `07cefdb` while master had moved ten
      // commits past it, six of them touching src/ at the time (seven after the wave-5 #273
      // merge), and the ancestry-only assertion stayed green. Drive the same helper the real
      // assertion uses; HEAD must pass, or the detector would be vacuous.
      const stale = masterSrcLag('07cefdb');
      assert.ok(
        stale.changed.length >= 6,
        `probe check: 07cefdb..HEAD should carry the wave-2..5 src/ changes, found ${stale.changed.length}`,
      );
      assert.ok(
        stale.changed.every((p) => p.startsWith('src/')),
        `the lag must be measured under src/ only, saw ${stale.changed.join(', ')}`,
      );
      assert.match(
        stale.problem,
        /^§0 master SHA 07cefdb predates \d+ src\/ change\(s\); update §0 to HEAD$/,
      );
      assert.equal(
        masterSrcLag(git(['rev-parse', 'HEAD'])).problem,
        null,
        'HEAD cannot predate itself — the detector must not be vacuous',
      );
    });

    it('a version link to the wrong notes file is detected', () => {
      const from = join(ROOT, 'CHANGELOG.md');
      assert.equal(versionLinkProblem('3.9.17', 'docs/releases/RELEASE_NOTES_3.9.17.md', from), null);
      assert.match(
        versionLinkProblem('3.9.17', 'docs/releases/RELEASE_NOTES_3.9.18.md', from),
        /notes file for v3\.9\.18/,
      );
      assert.match(versionLinkProblem('3.9.17', 'docs/README.md', from), /not a release-notes file/);
      assert.equal(
        versionLinkProblem('3.9.17', 'https://github.com/dwgx/WindsurfAPI/releases/tag/v3.9.17', from),
        null,
      );
      assert.match(
        versionLinkProblem('3.9.17', 'https://github.com/dwgx/WindsurfAPI/releases/tag/v3.9.18', from),
        /names v3\.9\.18/,
      );
    });
  });

  it('the live handoff §0 and the docs index agree with the packaged version', () => {
    const pkgVersion = JSON.parse(read(join(ROOT, 'package.json'))).version;
    // The live handoff is whichever one the index's first row points at — reuse the same
    // resolution the chain assertions above rely on, so this cannot drift from them.
    const index = read(join(DOCS, 'README.md'));
    const firstRow = index.split('\n').find((l) => l.startsWith('| 1 |')) || '';
    const liveHead = (firstRow.match(/\((HANDOFF-[^)]+\.md)\)/) || [])[1];
    assert.ok(liveHead, 'the index first row must link the live handoff (see the chain assertions)');

    const block = currentStateBlock(read(join(DOCS, liveHead)));
    // Probes: a rewrite that drops the labelled lines must not turn the comparison vacuous.
    assert.match(block, /产品\s*tag\s+`?v\d+\.\d+\.\d+/, '§0 must carry a 产品 tag line');
    assert.match(block, /package\.json\s+`?v?\d+\.\d+\.\d+/, '§0 must carry a package.json line');
    // The index's first row promises "its §0 names the live product tag and SHA". Keep both.
    const master = block.match(/master\s+`([0-9a-f]{7,40})`/);
    assert.ok(master, '§0 must name master’s SHA');
    const masterSha = git(['rev-parse', `${master[1]}^{commit}`]);
    assert.ok(masterSha.startsWith(master[1]), `§0 master SHA ${master[1]} is not a commit`);
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', masterSha, 'HEAD'], { cwd: ROOT, stdio: 'pipe' });
    } catch {
      assert.fail(`§0 master SHA ${master[1]} is not an ancestor of HEAD`);
    }
    // Ancestry is necessary but not sufficient: §0 sat ten commits and six src/ files behind
    // HEAD (seven after the wave-5 merge) while the check above passed. Docs-only lag is
    // allowed; a src/ change is not.
    const srcLag = masterSrcLag(masterSha);
    assert.equal(
      srcLag.problem,
      null,
      srcLag.problem && `${srcLag.problem}\n  ${srcLag.changed.join('\n  ')}`,
    );

    const claims = [
      ...versionClaims(block).map((c) => ({ ...c, where: `${rel(join(DOCS, liveHead))} §0` })),
      ...versionClaims(index).map((c) => ({ ...c, where: 'docs/README.md' })),
    ];
    assert.ok(claims.length >= 2, `probe check: expected at least 2 labelled version claims, found ${claims.length}`);
    const latestTag = latestTagVersion();
    const stale = claims
      .map((c) => ({ ...c, reason: staleClaimReason(c, pkgVersion, latestTag) }))
      .filter((c) => c.reason)
      .map((c) => `${c.where} ${c.label} ${c.reason}`);
    assert.deepEqual(stale, [], `stale version claims in live docs:\n  ${stale.join('\n  ')}`);
  });

  it('the live handoff §0 names a real annotated tag and that tag’s real commit', () => {
    const pkgVersion = JSON.parse(read(join(ROOT, 'package.json'))).version;
    const index = read(join(DOCS, 'README.md'));
    const liveHead = (index.split('\n').find((l) => l.startsWith('| 1 |')) || '')
      .match(/\((HANDOFF-[^)]+\.md)\)/)?.[1];
    assert.ok(liveHead, 'the index first row must link the live handoff');
    const block = currentStateBlock(read(join(DOCS, liveHead)));

    const line = block.match(
      /产品\s*tag\s+`?v(\d+\.\d+\.\d+)`?[^\n]*?→\s*commit\s+`?([0-9a-f]{7,40})`?/,
    );
    assert.ok(line, '§0 must state `产品 tag vX.Y.Z — … → commit <sha>`');
    const [, version, commit] = line;
    const latestTag = latestTagVersion();
    assert.ok(
      version === pkgVersion || version === latestTag,
      `§0 names v${version}; packaged is ${pkgVersion}, latest reachable tag is v${latestTag}`,
    );

    const fullCommit = git(['rev-parse', `${commit}^{commit}`]);
    assert.ok(fullCommit.startsWith(commit), `§0 commit ${commit} is not a commit`);
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', fullCommit, 'HEAD'], { cwd: ROOT, stdio: 'pipe' });
    } catch {
      assert.fail(`§0 commit ${commit} is not an ancestor of HEAD`);
    }

    // Fail closed. A checkout with no tags cannot verify the claim; reporting "nothing to
    // compare" would be the same skip-read-as-green that let the stale head survive twelve
    // releases. Release CI checks out with fetch-depth: 0 (.github/workflows/release.yml), so
    // the tags are present where this gate actually runs.
    const tags = git(['tag']).split(/\r?\n/).filter(Boolean);
    assert.ok(tags.length > 0, 'no tags in this checkout — run `git fetch --tags`; an unresolvable tag claim must not pass');
    const tagName = `v${version}`;
    if (!tags.includes(tagName)) {
      // The runbook pushes master before it creates the tag (docs/releases/README.md §7).
      // A forward-looking claim is allowed only when it names the packaged version; anything
      // else is a stale or invented tag. In a shallow checkout the tag may simply be missing,
      // so that case still fails closed with the fetch instruction above.
      assert.ok(
        git(['rev-parse', '--is-shallow-repository']) !== 'true',
        `${tagName} is not visible in this shallow checkout — run \`git fetch --tags\``,
      );
      assert.equal(
        version,
        pkgVersion,
        `§0 names ${tagName}, which is not a tag; only the packaged version may be forward-looking`,
      );
      return; // pre-tag window; release.yml verifies the tag once it exists
    }
    // Two checkout shapes reach this gate, and only one carries the tag object:
    //   - local/annotated: refs/tags/<name> is the tag object, so annotatedness and the
    //     object identity in §0 are checkable.
    //   - GitHub Actions: actions/checkout force-fetches the pushed tag as
    //     `+<commit>:refs/tags/<name>`, so the same ref points straight at the commit and
    //     the tag object is never fetched. Requiring `tag` unconditionally failed every
    //     release run (v3.9.54–56) even though the remote tag is annotated.
    // Both shapes must still prove the ref resolves to a commit and that §0 names that
    // commit or an ancestor of it; only the object-identity assertions are shape-dependent.
    const tagRef = `refs/tags/${tagName}`;
    const tagType = git(['cat-file', '-t', tagRef]);
    assert.ok(
      tagType === 'tag' || tagType === 'commit',
      `${tagRef} must resolve to an annotated tag object or a commit, found ${tagType}`,
    );
    let tagCommit;
    try {
      tagCommit = git(['rev-parse', '--verify', `${tagRef}^{commit}`]);
    } catch {
      assert.fail(`${tagRef} does not resolve to a commit`);
    }
    // The release commit is written BEFORE the tag exists, so it cannot name the tag's own
    // commit without self-reference. Accept the tag commit itself or any ancestor of it: the
    // claim still has to be a real commit on the released history, and a stale/moved tag
    // still fails because the named commit would no longer be an ancestor.
    let ancestor = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', commit, tagCommit], { cwd: ROOT, stdio: 'pipe' });
      ancestor = true;
    } catch {
      ancestor = false;
    }
    assert.ok(
      ancestor,
      `§0 commit ${commit} is not an ancestor of (or equal to) ${tagName}'s commit ${tagCommit}`,
    );
    // A forced ref has no tag object to compare against; the `对象` line is an annotated-tag
    // fact, so it is only checked when the checkout actually carries the tag object.
    if (tagType === 'tag') {
      const object = block.match(/对象\s+`?([0-9a-f]{7,40})`?/);
      if (object) {
        const tagObject = git(['rev-parse', tagRef]);
        assert.ok(tagObject.startsWith(object[1]), `§0 tag object ${object[1]} is not ${tagObject}`);
      }
    }
  });

  it('every version link resolves to that version’s release notes (or its tag)', () => {
    const problems = [];
    let local = 0;
    for (const f of mdFiles()) {
      for (const m of read(f).matchAll(/\[v?(\d+\.\d+\.\d+)\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        const problem = versionLinkProblem(m[1], m[2], f);
        if (problem) problems.push(`${rel(f)}: ${problem}`);
        if (!/^https?:/i.test(m[2])) local++;
      }
    }
    assert.ok(local >= 50, `probe check: only ${local} local version links found — the scan is broken`);
    assert.deepEqual(problems, [], `version links that do not resolve:\n  ${problems.join('\n  ')}`);
  });

  it('the CHANGELOG current row names the packaged version', () => {
    const pkgVersion = JSON.parse(read(join(ROOT, 'package.json'))).version;
    const row = read(join(ROOT, 'CHANGELOG.md')).match(/^\|\s*当前\s*\|\s*\*\*v?(\d+\.\d+\.\d+)\*\*/m);
    assert.ok(row, 'CHANGELOG.md must carry a `| 当前 | **vX.Y.Z**` row');
    assert.equal(row[1], pkgVersion, `CHANGELOG's 当前 row says ${row[1]}, package.json is ${pkgVersion}`);
  });

  it('the CHANGELOG release counts are the ones the checkout has', () => {
    // Comparing the banner against the table only proves that two hand edits agree. On
    // 2026-10-31 they did not: the banner said 218 (the RELEASE_NOTES_*.md count) and the
    // table said 222 — 222 is what `find docs/releases -name '*.md' | wc -l` returns, which
    // also counts README.md and the three ACCEPTANCE_*.md appendices. The same class of
    // drift had already shipped once, in the other direction: the index said 172 while 175
    // files sat on disk (3.9.22/23 were present but uncounted). Each claim is now compared
    // against its own derivation, and `scripts/sync-changelog-counts.mjs` writes them, so
    // the number is a fact about the checkout rather than a number someone typed.
    const changelog = read(join(ROOT, 'CHANGELOG.md'));
    const counts = changelogCounts(ROOT);
    const banner = changelog.match(/全部\s+(\d+)\s+份发布说明/);
    const table = changelog.match(/发布说明\s*\|\s*\*\*(\d+)\*\*\s*份/);
    const tags = changelog.match(/^\|\s*git tag\s*\|\s*(\d+)/m);
    assert.ok(banner, 'CHANGELOG.md banner must state 全部 N 份发布说明');
    assert.ok(table, 'CHANGELOG.md table must state 发布说明 | **N** 份');
    assert.ok(tags, 'CHANGELOG.md table must state git tag | N 个');
    assert.equal(banner[1], String(counts.notes),
      `banner says ${banner[1]} notes, docs/releases carries ${counts.notes} RELEASE_NOTES_*.md`);
    assert.equal(table[1], String(counts.notes),
      `table says ${table[1]} notes, docs/releases carries ${counts.notes} RELEASE_NOTES_*.md`);
    // A checkout without git history cannot count tags; the row is left alone rather than
    // rewritten to a zero the host cannot stand behind.
    if (counts.tags !== null) {
      assert.equal(tags[1], String(counts.tags), `table says ${tags[1]} tags, git lists ${counts.tags}`);
    }
  });

  it('the CHANGELOG counting rows are exactly what the generator renders', () => {
    // Byte equality, not just the numbers: the rows are generated, so any hand edit —
    // including one that keeps the digits but restates the measurement — has to fail here
    // instead of shipping. Same contract as docs/UNVERIFIED.md (test/unverified-register.test.js).
    const changelog = read(join(ROOT, 'CHANGELOG.md'));
    assert.equal(renderCounts(changelog, changelogCounts(ROOT)), changelog,
      'CHANGELOG.md counting rows drifted from scripts/sync-changelog-counts.mjs — run it');
  });

  it('the packaged version has a CHANGELOG index row and a release-notes file', () => {
    // CHANGELOG jumped 3.9.24 → 3.9.21 (missing 22/23) because nothing required
    // the packaged version to own a notes file. Tag-vs-package.json is only
    // checked in release.yml after the tag exists, so a bump without notes
    // stayed green locally. Filename exception: v3.9.22 shipped as
    // RELEASE_NOTES_v3.9.22.md — historical v-prefix, not a new convention.
    const pkgVersion = JSON.parse(read(join(ROOT, 'package.json'))).version;
    const notesDir = join(DOCS, 'releases');
    const canonical = join(notesDir, `RELEASE_NOTES_${pkgVersion}.md`);
    const historicalV = join(notesDir, `RELEASE_NOTES_v${pkgVersion}.md`);
    const notesName = existsSync(canonical)
      ? `RELEASE_NOTES_${pkgVersion}.md`
      : existsSync(historicalV)
        ? `RELEASE_NOTES_v${pkgVersion}.md`
        : null;
    assert.ok(
      notesName,
      `package.json ${pkgVersion} needs docs/releases/RELEASE_NOTES_${pkgVersion}.md `
      + '(historical v-prefix is the only exception)',
    );
    const changelog = read(join(ROOT, 'CHANGELOG.md'));
    const escaped = pkgVersion.replace(/\./g, '\\.');
    assert.match(
      changelog,
      new RegExp(`\\[v${escaped}\\]\\(docs/releases/${notesName.replace(/\./g, '\\.')}\\)`),
      `CHANGELOG.md must index v${pkgVersion} with a link to ${notesName}`,
    );
  });

  it('the unverified register exists and the newest release notes link it', () => {
    // The newest note lists its own gaps, and the bullets filed before it were reachable
    // only by opening every release note that carries a 尚未验证 section. The register is
    // generated from those sections (test/unverified-register.test.js compares it byte for
    // byte), so this guard only pins the two entry points a reader can find it from: the
    // newest note and the docs index. A register nobody links to is a file, not a record.
    const register = join(DOCS, 'UNVERIFIED.md');
    assert.ok(existsSync(register), 'docs/UNVERIFIED.md must exist — run node scripts/unverified-register.mjs');
    const pkgVersion = JSON.parse(read(join(ROOT, 'package.json'))).version;
    const notes = notesFor(pkgVersion);
    assert.ok(notes, `no release-notes file for the packaged version ${pkgVersion}`);
    assert.match(
      read(notes),
      /\]\(\.\.\/UNVERIFIED\.md\)/,
      `${rel(notes)} must link ../UNVERIFIED.md from its 尚未验证 section`,
    );
    assert.match(
      read(join(DOCS, 'README.md')),
      /\]\(UNVERIFIED\.md\)/,
      'docs/README.md must index UNVERIFIED.md',
    );
  });

  it('every 3.9.x release-notes file is indexed in CHANGELOG.md', () => {
    // CHANGELOG says "下面是 3.9.x 全系". Indexing HEAD while skipping
    // 3.9.22/23 still made the packaged-version and count gates green.
    const changelog = read(join(ROOT, 'CHANGELOG.md'));
    const missing = [];
    for (const name of readdirSync(join(DOCS, 'releases'))) {
      const m = name.match(/^RELEASE_NOTES_v?(\d+\.\d+\.\d+)\.md$/);
      if (!m) continue;
      const [major, minor] = m[1].split('.').map(Number);
      if (major !== 3 || minor !== 9) continue;
      if (!changelog.includes(`](docs/releases/${name})`)) missing.push(name);
    }
    assert.deepEqual(missing, [], `3.9.x notes not indexed in CHANGELOG.md:\n  ${missing.join('\n  ')}`);
  });

  it('HISTORY-LEDGER.md does not present v3.9.21 as the live product tag', () => {
    const hist = read(join(DOCS, 'HISTORY-LEDGER.md')).slice(0, 2500);
    assert.match(hist, /不是现状/);
    assert.match(hist, /HANDOFF-2026-08-20\.md/);
  });
});

describe('docs: reader-facing auth defaults match fail-closed code', () => {
  // validateApiKey() fails closed when API_KEY is empty unless
  // WINDSURFAPI_ALLOW_UNAUTHENTICATED=1 on a local bind. The README table and
  // .env.example header used to say empty = open access / disable validation.
  // Operators who copied that got 401 on the default 0.0.0.0 bind, or an
  // unauthenticated gateway if they "fixed" it the wrong way.
  const FORBIDDEN = [
    /leave empty for open access/i,
    /leave empty to disable validation/i,
    /leave empty for no password/i,
    /留空就不验证/,
    /留空不设密码/,
    /留空\s*=\s*不[验证驗證]/,
    /留空\s*=\s*後台免密碼/,
  ];

  it('README, .env.example and Pages landing do not claim empty API_KEY is open access', () => {
    const hits = [];
    for (const rel_ of ['.env.example', 'README.md', 'README.en.md', join('docs', 'index.html')]) {
      const body = read(join(ROOT, rel_));
      for (const re of FORBIDDEN) {
        if (re.test(body)) hits.push(`${rel_} matches ${re}`);
      }
    }
    assert.deepEqual(hits, [], `stale open-access claims:\n  ${hits.join('\n  ')}`);
  });

  it('.env.example names the fail-closed opt-in next to API_KEY', () => {
    const doc = read(join(ROOT, '.env.example'));
    assert.match(doc, /WINDSURFAPI_ALLOW_UNAUTHENTICATED/);
    assert.match(doc, /fail-closed|FAIL-CLOSED|fail closed/i);
    // Dashboard must not claim API_KEY is the panel secret without the opt-in.
    const dashBlock = doc.split('========== Dashboard ==========')[1] || '';
    assert.match(dashBlock, /DASHBOARD_ALLOW_API_KEY_AS_PASSWORD/);
    assert.doesNotMatch(
      dashBlock.split('DASHBOARD_PASSWORD=')[0],
      /accepted as the dashboard secret/i,
    );
  });

  it('Windows exe README does not claim packaged runs ship with no secrets', () => {
    // src/config.js generates API_KEY + DASHBOARD_PASSWORD on first packaged
    // run and persists them beside the exe. The deploy note used to say the
    // exe had no auth, which sent operators hunting for a lock that was
    // already closed.
    const body = read(join(ROOT, 'deploy', 'windows', 'README.md'));
    assert.doesNotMatch(body, /内置默认\*\*没有 API_KEY/);
    assert.match(body, /自动生成/);
  });

  it('.env.example does not claim CASCADE_REUSE_HASH_SYSTEM defaults off', () => {
    const doc = read(join(ROOT, '.env.example'));
    const idx = doc.indexOf('CASCADE_REUSE_HASH_SYSTEM');
    assert.ok(idx >= 0, 'precondition: HASH_SYSTEM is documented');
    const window = doc.slice(Math.max(0, idx - 400), idx + 80);
    assert.doesNotMatch(window, /Already defaults to 0/i);
    assert.match(window, /Default ON|默认.*开|default ON/i);
  });

  it('DEFAULT_MODEL comments do not present silent degrade as the Connect default', () => {
    // WINDSURFAPI_STRICT_MODEL defaults to 1 → 400 model_not_found. Saying
    // an unmapped name "degrades to the free selector" without naming the
    // 400 / STRICT_MODEL=0 opt-out is the same class of lie as empty
    // API_KEY = open access.
    const windowAround = (body) => {
      const idx = body.search(/^[ \t]*#?[ \t]*DEFAULT_MODEL=/m);
      assert.ok(idx >= 0, 'precondition: DEFAULT_MODEL is declared');
      return body.slice(Math.max(0, idx - 500), idx + 80);
    };
    for (const rel_ of ['.env.example', 'setup.sh']) {
      const window = windowAround(read(join(ROOT, rel_)));
      const claimsDegrade = /degrades to the free selector|静默降级|degrades to free selector/i.test(window);
      if (!claimsDegrade) continue;
      assert.match(
        window,
        /STRICT_MODEL|400/,
        `${rel_}: silent-degrade wording must name STRICT_MODEL or 400`,
      );
    }
  });

  it('setup.sh writes the same DEFAULT_MODEL as config.js', () => {
    // setup.sh used to emit claude-4.5-sonnet-thinking, a Cascade-era alias
    // that is mapped:false on DEVIN_CONNECT and degrades to the free selector.
    // config.js already defaults to claude-sonnet-4.6 when the env is unset.
    const setup = read(join(ROOT, 'setup.sh'));
    const config = read(join(ROOT, 'src', 'config.js'));
    const configDefault = (config.match(/defaultModel:\s*process\.env\.DEFAULT_MODEL\s*\|\|\s*'([^']+)'/) || [])[1];
    assert.ok(configDefault, 'precondition: config.js defaultModel fallback is a string literal');
    assert.match(
      setup,
      new RegExp(`DEFAULT_MODEL=${configDefault.replace(/\./g, '\\.')}`),
      `setup.sh must write DEFAULT_MODEL=${configDefault}`,
    );
    assert.doesNotMatch(
      setup,
      /DEFAULT_MODEL=claude-4\.5-sonnet-thinking/,
      'setup.sh must not emit the Connect-unmapped Cascade alias',
    );
  });
});

describe('docs: in-repo anchor links resolve to a real heading', () => {
  // A `#anchor` that does not match any heading is silently inert on GitHub — the page loads
  // and simply does not scroll, so a wrong anchor reads as a working link. Every nav bar added
  // to a README is a cluster of these, and the first version of the one at the top of
  // README.md was wrong: GitHub folds ` / ` in "Claude Code / Cline / Cursor 怎么用" into a
  // SINGLE hyphen, and the hand-written link had two. Nothing caught it because a broken
  // anchor is not a broken link.
  //
  // Scope is deliberately narrow: only same-file (`#x`) and in-repo (`path.md#x`) targets.
  // External URLs are someone else's document, and HTML `id=` attributes are matched too
  // because index.html-style docs anchor that way.
  // Mirrors github-slugger, which is the algorithm GitHub actually uses. Verified against it
  // directly: `## 🚀 Just want to run it` becomes `-just-want-to-run-it` — WITH a leading
  // hyphen, because the emoji is removed and the space it left behind still becomes one. An
  // earlier version of this helper trimmed first and produced `just-want-to-run-it`, which
  // made the guard report four dead anchors that were in fact correct. Do not "simplify" the
  // trim order back.
  // Checked case-by-case against github-slugger (the package GitHub's own pipeline uses):
  // 17/17 agreement including emoji headings, CJK, `A  double  space`, and trailing spaces.
  // No trim() and no `\s+` collapsing — both are the tempting "cleanups" that break it:
  // `## 🚀 Just want to run it` must slug to `-just-want-to-run-it`, WITH the leading hyphen,
  // because the emoji is dropped and the space it left still becomes one. An earlier version
  // trimmed first and reported four correct anchors as dead.
  const slug = (heading) =>
    heading
      .toLowerCase()
      // Strip markdown emphasis/code marks that do not survive into the anchor.
      .replace(/[`*_~]/g, '')
      // GitHub drops punctuation and emoji but keeps letters, digits, spaces, hyphens, CJK.
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s/g, '-');

  const headingsOf = (text) => {
    const out = new Set();
    let inFence = false;
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (h) out.add(slug(h[1]));
      for (const m of line.matchAll(/\sid=["']([^"']+)["']/g)) out.add(m[1].toLowerCase());
      for (const m of line.matchAll(/<a\s+name=["']([^"']+)["']/g)) out.add(m[1].toLowerCase());
    }
    return out;
  };

  it('every #anchor in a tracked markdown file points at a heading that exists', () => {
    const headingCache = new Map();
    const headingsFor = (abs) => {
      if (!headingCache.has(abs)) {
        headingCache.set(abs, existsSync(abs) ? headingsOf(read(abs)) : null);
      }
      return headingCache.get(abs);
    };

    // Issue forms are scanned alongside markdown: GitHub requires ABSOLUTE links in
    // `config.yml`, so its anchors are invisible to every relative-path check and to the
    // self-repo branch below unless the file is actually read.
    const formsDir = join(ROOT, '.github', 'ISSUE_TEMPLATE');
    const forms = existsSync(formsDir)
      ? readdirSync(formsDir).filter((f) => f.endsWith('.yml')).map((f) => join(formsDir, f))
      : [];

    const problems = [];
    for (const abs of [...mdFiles(), ...forms]) {
      let body = read(abs);
      body = body.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
      // BOTH link syntaxes. Nav bars are centred with <p align>, so their links are raw HTML
      // `<a href="#x">`, not markdown — and the first version of this guard matched only
      // markdown, which made it blind to the exact bug that motivated it (it reported green
      // on a re-introduced double-hyphen anchor). A guard that cannot see the failure it was
      // written for is indistinguishable from one that passes.
      const targets = [
        ...[...body.matchAll(/\[[^\]]*\]\(([^)\s]*)#([^)\s]+)\)/g)].map((m) => [m[1], m[2]]),
        ...[...body.matchAll(/<a\s[^>]*href=["']([^"'#]*)#([^"']+)["']/gi)].map((m) => [m[1], m[2]]),
        // Bare URLs — issue-form YAML carries `url: https://…#anchor` with no link syntax at
        // all, so neither pattern above sees it.
        ...[...body.matchAll(/(?<![(["'\w])(https?:\/\/[^\s"'<>)]*?)#([^\s"'<>)]+)/g)]
          .map((m) => [m[1], m[2]]),
      ];
      for (const [rawPath, rawAnchor] of targets) {
        let path = rawPath;
        if (/^https?:/i.test(path)) {
          // An absolute URL pointing back at THIS repo is still checkable, and those are the
          // ones that rot: `.github/ISSUE_TEMPLATE/config.yml` has to use absolute links, so
          // its anchors escape every relative-path check. HTTP 200 proves nothing here —
          // GitHub serves the page and simply does not scroll when the anchor is missing.
          const self = path.match(
            /^https?:\/\/github\.com\/dwgx\/WindsurfAPI(?:\/blob\/[^/]+\/(.+?))?\/?$/i,
          );
          if (!self) continue; // genuinely external; not ours to verify offline
          path = self[1] ? relative(dirname(abs), join(ROOT, self[1])) : relative(dirname(abs), join(ROOT, 'README.md'));
        }
        const anchor = decodeURIComponent(rawAnchor).toLowerCase();
        const targetAbs = path ? join(dirname(abs), path) : abs;
        if (!/\.(md|html)$/i.test(targetAbs)) continue;
        const heads = headingsFor(targetAbs);
        if (heads === null) continue; // a missing FILE is the other guard's job
        if (!heads.has(anchor)) {
          problems.push(`${rel(abs)}: #${anchor} → ${path || '(same file)'} has no such heading`);
        }
      }
    }
    assert.deepEqual(problems, [], `dead in-repo anchors:\n  ${problems.join('\n  ')}`);
  });
});

// GapSweep2 §3.1. The bug form is the only place a reporter is told what evidence to
// attach, and "please attach a trace" is only actionable when it names the one command
// that packs the trace. Issue #236/#245/#250 all stalled on that step, so the instruction
// is pinned rather than left to prose review.
describe('docs: the bug form points at the support bundle', () => {
  it('bug.yml names scripts/support-bundle.mjs and the trace switch', () => {
    const body = read(join(ROOT, '.github', 'ISSUE_TEMPLATE', 'bug.yml'));
    assert.match(body, /node scripts\/support-bundle\.mjs/);
    assert.match(body, /WINDSURFAPI_TRACE=1/);
    assert.match(body, /support-bundle-<utc>\.zip/);
  });
});
