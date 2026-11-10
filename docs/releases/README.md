# Release Notes

Per-version release notes for WindsurfAPI. Filenames follow the pattern
`RELEASE_NOTES_<major>.<minor>.<patch>.md` and are picked up automatically
by `.github/workflows/release.yml` when a `v*` tag is pushed — the file
becomes the GitHub Release body. Historical exception: v3.9.22's notes sit in
`RELEASE_NOTES_v3.9.22.md` (a `v` prefix). Do not repeat that spelling — the
workflow looks only for the exact unprefixed names (`release.yml:329-330`), so a
`v`-prefixed file is silently ignored and the release falls back to GitHub's
generated notes (`release.yml:378-379`).

The latest version's notes are also surfaced on the project homepage and
in the dashboard "About" panel.

## Adding a new release

> The four-step version this section used to carry was wrong in four ways, one of
> which **blocked execution**: it said "commit and push to `master`", and
> `.githooks/pre-commit` refuses to author a commit on `master`. It also bumped only
> `package.json` (the lock carries the version **twice**), created a *lightweight*
> tag while every shipped tag is annotated, and named no gate at all. Corrected below
> from what the last several releases actually did.

The order matters — every step below has a reason someone learned the hard way.

**1. Land your own fixes before merging anyone else's.** Master must never sit on a
commit that is in a known-bad state, so a fix that a PR depends on goes first, the
merge second.

**2. Pass the gate.** All three, on a clean tree:

```bash
npm run test:release          # per-file process isolation; this is the authoritative count
node scripts/secret-scan.mjs  # EXIT=0. Scope: tracked files; test/ is scanned except test/_research/
git diff --check              # no whitespace damage
```

`npm test` (single process) is *not* the authoritative count — its total fluctuates
with output races. If a count surprises you, diff per-file before suspecting the code.

**3. Run the mutation loop if you touched `src/`.**

```bash
for s in test/mutations/*.json; do npm run mutate -- "$s"; done
```

**The test suite does not run mutation specs, so a green gate cannot tell you an
anchor broke.** Editing a line that a spec anchors on silently invalidates it, and
adding assertions to a file a spec covers invalidates its `expectBaselinePass`. Both
have happened. The loop holds the working tree exclusively — do not edit anything
while it runs.

**4. Bump the version in BOTH files.** `package.json` once, `package-lock.json`
**twice** (top level and `packages.""`). `src/version.js` reads from `package.json`,
so that is the single source — do not hardcode a version anywhere else.

The live handoff's §0 (the `HANDOFF-*.md` the index's first row links) carries the version
twice as well: `产品 tag` and `package.json`. Update both in the release commit.
`test/docs-consistency-guard.test.js` compares them against the packaged version and the
newest reachable tag; before the tag exists, the tag line may still name the previous release.

**5. Write `RELEASE_NOTES_<new-version>.md`** in this folder. House style below.

**6. Branch, then merge — you cannot commit on `master`.** `.githooks/pre-commit`
refuses it by design (the flow is branch → review → `git merge --ff-only`, and
landing straight on master skips the point where a branch name and a diff get looked
at as a unit). Note the hook fires *after* your `git add`, so a refused commit leaves
the tree dirty.

```bash
git checkout -b chore/release-<version>
# ... commit ...
git checkout master && git merge --ff-only chore/release-<version>
git push origin master
```

**7. Tag annotated, and only after master is pushed.**

```bash
git tag -a v<version> -m "..."   # -a matters: every shipped tag is an annotated object
git push origin v<version>
```

The tag must land **on master** or `git describe` and provenance both get awkward.

The `git tag` count in `CHANGELOG.md` is checkout-invariant: `node scripts/sync-changelog-counts.mjs` subtracts the tags listed in `docs/releases/UNPUBLISHED-TAGS.txt` that this checkout carries, so a tag created locally and never pushed cannot make the row disagree with a `fetch-depth: 0` CI checkout.

**8. Verify the terminal state of every job — do not read intent from comments.**
The macOS x64 job showed as `queued` for four consecutive releases while its real
terminal state was `cancelled`; the workflow comment saying "x64 may queue for hours"
was believed four times. Check the artifact instead: `windsurfapi-macos.zip` is
~22 MB without the x64 binary and ~45 MB with it.

### Should this even be a release?

**The test is "is there anything a user needs to install", not "how many lines
changed."** A `v*` tag triggers four artifact builds; if those artifacts behave
identically to the previous tag, the release asks users to download nothing.

- Zero behaviour change (docs, tests, dead-code removal) → **do not tag**. Let the
  commits ride along with the next release that does change behaviour.
- One `opt-in`, default-off feature → **do tag**. A default-off switch changes nothing
  for anyone who does not set it, which is exactly why it is safe to ship.
- A fix whose absence makes an already-published release note *false* → **do tag**.
  v3.9.19 shipped for this reason: v3.9.18's notes described a fix that landed after
  its tag, and rewording the notes would have left users on the version with the hole.

The release workflow builds the GHCR image and publishes the GitHub Release. The body
comes from the matching file in this folder.

### Release assets and verification

The release job attaches four assets plus `SHA256SUMS`, and — from v3.10.0 —
cosign keyless signature bundles for each of the five signed blobs
(`<name>.sigstore.json` — signature, Fulcio certificate and Rekor proof in one
file; since v3.10.0 this is the only signature artifact attached). The manifest uses the **flat asset names**
(`windsurfapi.exe`, `windsurfapi-windows.zip`, `windsurfapi-macos-arm64`,
`windsurfapi-macos.zip`), so `sha256sum -c SHA256SUMS` works in the directory
where the files were downloaded. Do not change it back to build-tree paths
(`dist-windows/...`): v3.9.53, the first release with a manifest, shipped that
shape, and it made the documented command fail for three of the four files.
`test/release-workflow.test.js` pins the flat form; `test/release-signing.test.js`
pins the signed file list and the upload globs.

Releases from v3.10.0 are signed with cosign keyless (GitHub OIDC; no repository
key or signing secret). Verify `SHA256SUMS.sigstore.json` first, then the hashes,
or run `node scripts/verify-release-assets.mjs <download-dir>`. A signing failure
fails the release job: never publish assets whose notes claim signatures but
which carry no `.sigstore.json`. The git and Docker OTA paths still verify
tags/ancestry and health, not these signatures, because they do not download
release assets. The trust boundary and the exact commands are in
[RELEASE-SIGNING.md](../RELEASE-SIGNING.md).

## House style for the notes themselves

These files are **published** — each one becomes a GitHub Release body — and they are
**append-only history** afterwards. Both facts shape how to write them.

- **User-visible first, engineering second.** Open with what changes for someone
  running the proxy. A reader deciding whether to upgrade should not have to parse a
  diff summary.
- **State the mechanism and the measured number, never a changelog line.**
  "修了个 bug" tells nobody anything. "上游在带 tools 的轮次里只发 reasoning、不给
  tool call,实测 25% 的 agentic 轮次" is a mechanism plus a measurement.
- **Every number must be re-measurable, and say what produced it.** A number that
  cannot answer "who ran this, and with what command" will be assumed and then
  inherited. One handoff carried a mutation total that was *correct* but had never
  been run — which is harder to catch than a wrong one, because the numbers beside it
  were real and lent it their credibility.
- **Name the blast radius when a fix is conditional.** "Only affects deployments that
  set X" is the sentence an operator is looking for.
- **Correcting a published note:** fix it in place **and** leave an errata block saying
  what it said before. Silent edits to something already published are worse than the
  original error, because the next reader cannot tell the note changed. Version
  attributions especially — they drive "which release do I upgrade from".
- Notes for a superseded claim get a forward pointer, not a rewrite.
