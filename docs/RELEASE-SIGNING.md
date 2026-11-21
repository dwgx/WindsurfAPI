# Release signing

**Use Cosign v3 or newer** to verify the published Sigstore bundles.
The v3.2.11 bundles were verified with Cosign v3. Cosign v2.4.1 with the
commands below cannot verify this bundle format.

Binary and checksum signing began with v3.10.0 on October 24, 2026.
The subsequently published v3.2.10 and v3.2.11 are also signed. The current
release workflow uses GitHub OIDC and signs the source attestation and Docker
digest in addition to the four platform assets and checksum manifest.

## What a release publishes

`.github/workflows/release.yml` attaches five signed binary/manifest blobs to
the GitHub Release, plus one Sigstore bundle for each one. It also publishes the
source-OTA attestation described below (with its own bundle):

| Blob | Produced by |
|---|---|
| `windsurfapi.exe` | Windows single-exe (`@yao-pkg/pkg` + esbuild) |
| `windsurfapi-windows.zip` | exe + tray launcher scripts |
| `windsurfapi-macos-arm64` | macOS arm64 binary |
| `windsurfapi-macos.zip` | arm64 binary (x64 if the optional job succeeded) + launch scripts |
| `SHA256SUMS` | `sha256sum` over exactly the four assets above |

For every row, the release also carries one file:

| Artifact | Contents | Use |
|---|---|---|
| `<name>.sigstore.json` | Sigstore bundle: certificate, signature, Rekor inclusion proof | **authoritative** — verifies after the certificate expires |

The bundle is the durable proof. A Fulcio certificate lives for minutes, and
`cosign verify-blob --certificate` checks it against the current time unless a
signed timestamp is supplied. Verify the bundle; there is no detached `.sig` or
`.pem` pair attached to these signed releases.

The `docker` job additionally publishes the image's content address:

| Artifact | Contents | Use |
|---|---|---|
| `image-digest.txt` | the `sha256:` manifest digest of the pushed GHCR image | the only digest Docker OTA may deploy |
| `image-digest.txt.sigstore.json` | Sigstore bundle for `image-digest.txt` | proves the digest file came from this workflow |

The `release` job also publishes the source-OTA attestation:

| Artifact | Contents | Use |
|---|---|---|
| `release-attestation.json` | tag, commit, tree and the SHA-256 of every published asset | binds the release tag to the exact commit and asset bytes |
| `release-attestation.json.sigstore.json` | Sigstore bundle for the attestation | proves the binding came from this workflow at this tag |

The manifest uses the **asset names as they appear on the release page** (flat),
so `sha256sum -c SHA256SUMS` works in the directory where the assets were
downloaded.

## Verify a download

Download every asset and signature file into one empty directory, then either
run the helper or the commands it wraps.

### Helper

```bash
node scripts/verify-release-assets.mjs /path/to/download
# or, from this checkout with the default directory:
node scripts/verify-release-assets.mjs --dir /path/to/download
```

The helper requires [cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
on `PATH` (or `--cosign <path>`). It verifies the manifest bundle first, checks
the four assets against the signed manifest, then verifies each asset's own
bundle against the release identity and issuer. Exit codes: `0` verified,
`1` verification failed, `2` usage or environment error.

### Manual commands

```bash
# 1. Verify the manifest's own signature. This is the trust anchor.
cosign verify-blob \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS

# 2. Verify each asset's own bundle.
for f in windsurfapi.exe windsurfapi-windows.zip windsurfapi-macos-arm64 windsurfapi-macos.zip; do
  cosign verify-blob \
    --bundle "$f.sigstore.json" \
    --certificate-identity-regexp '^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$f"
done

# 3. Check the bytes against the now-authenticated manifest.
sha256sum -c SHA256SUMS
```

The release workflow publishes the `.sigstore.json` bundle for each signed blob; there is no
detached `.sig`/`.pem` pair to verify. The bundle is the durable proof.

On macOS use `shasum -a 256 -c SHA256SUMS`. On Windows, `Get-FileHash` replaces
step 3:

```powershell
Get-Content SHA256SUMS | ForEach-Object {
  $expected, $name = $_ -split '\s+', 2
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $name).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) { throw "MISMATCH: $name" }
}
```

### Verify the Docker image

The image signature lives in GHCR, attached to the digest, not in the release
download. Read the digest from `image-digest.txt` and verify both the file and
the image:

```bash
# The file that names the digest must itself be signed.
cosign verify-blob \
  --bundle image-digest.txt.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  image-digest.txt

# Then verify the image digest named by that file.
cosign verify ghcr.io/dwgx/windsurf-api@sha256:<digest> \
  --certificate-identity-regexp '^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The tag (`latest`, `3.141.592656`, …) is only a lookup key. Docker OTA resolves
it through the daemon's registry-metadata endpoint and refuses to pull or deploy
unless the result equals the digest in `image-digest.txt`.

The identity is the workflow ref that GitHub's OIDC token carries for a tag
push. To pin one exact release, replace the regexp with:

```text
--certificate-identity https://github.com/dwgx/WindsurfAPI/.github/workflows/release.yml@refs/tags/v3.10.0
```

### Identity and issuer

| Claim | Value |
|---|---|
| Issuer | `https://token.actions.githubusercontent.com` |
| Identity (tag build) | `https://github.com/dwgx/WindsurfAPI/.github/workflows/release.yml@refs/tags/vX.Y.Z` |

`scripts/verify-release-assets.mjs`（`--tag vX.Y.Z` 生成精确锚定的 identity，验收某个版本时用它，不要只依赖默认正则） carries the same values as
`DEFAULT_IDENTITY_REGEXP` / `DEFAULT_OIDC_ISSUER`; `test/release-signing.test.js`
fails if this page and the script drift apart.

## What the signature proves — and what it does not

It proves that the signed bytes were presented to Sigstore by the
`release.yml` workflow running in `dwgx/WindsurfAPI` for a `v*` tag, and that
the signature was recorded in the public Rekor transparency log. Anyone who can
publish or overwrite the GitHub Release but cannot obtain that OIDC identity
cannot produce a matching signature.

It does **not** prove:

- **Human review or intent.** The workflow signs whatever the tag points at.
  A compromised maintainer account that can push a tag can also run the
  workflow and produce a valid signature. Check the tag and commit out of band
  when that matters.
- **A reproducible build.** The signature attests to the produced bytes, not to
  a verifiable correspondence with the source tree.
- **That every build action is immutable.** The cosign installer is pinned by
  commit SHA and cosign to an exact release, but the rest of the workflow still
  uses major action tags (SEC-11 is not fully closed). A compromised upstream
  action runs before the signature is produced, so the signature would faithfully
  cover a malicious build.
- **The Docker image's build provenance beyond its digest.** The image is signed
  by manifest digest, so the signature attests to those bytes. It does not prove
  a reproducible build, and a tag that still points at the digest is not itself
  evidence. Verify the digest, never the tag. The release-asset helper covers
  only release assets; verify the image with `cosign verify` as shown above.

The signature is a provenance claim from a specific repository identity. It is
not a substitute for the hash check, and the hash check is not a substitute for
the signature: the manifest and the binaries used to be served from the same
release with no root of trust outside it.

## How the release job is wired

The `release` job in `.github/workflows/release.yml`:

1. assembles the Windows/macOS assets and generates `SHA256SUMS`;
2. installs `sigstore/cosign-installer` pinned by commit SHA, with
   `cosign-release: 'v3.1.4'`;
3. runs `cosign sign-blob` once per signed blob, writing one
   `<name>.sigstore.json` bundle per blob;
4. refuses to continue if any signature bundle is empty;
5. uploads the assets and all signature bundles to the GitHub Release.

The job has `permissions: contents: write` and `id-token: write`. The OIDC
permission is what lets cosign obtain a Fulcio certificate; no repository secret
is read anywhere in the signing path. A signing failure fails the job, so a
release cannot be published with the notes claiming signatures but no signature
assets.

The separate `docker` job has `packages: write` and `id-token: write`. After
`docker/build-push-action` returns the pushed digest it:

1. runs `cosign sign --yes ghcr.io/dwgx/windsurf-api@<digest>` (the signature is
   stored in GHCR next to that digest);
2. writes `image-digest.txt` with the same digest and exposes it as the job
   output `digest`;
3. runs `cosign sign-blob` over `image-digest.txt`;
4. uploads both files as the `image-digest` artifact, which the `release` job
   attaches to the GitHub Release.

A digest mismatch between the pushed image and the recorded file cannot happen
inside this job: both come from the same `steps.build.outputs.digest`, and the
step fails if it is not `sha256:<64 hex>`.

Signing depends on Sigstore (Fulcio for the certificate, Rekor for the
transparency entry, TUF for the trust root). An outage blocks the release rather
than silently shipping unsigned assets. That is deliberate: a release that says
it is signed and is not is worse than an obviously unsigned one.

## Install and self-update paths

The git self-update path verifies the release attestation (see below), not the
binary signatures: `release-attestation.json` binds the tag to the commit the
checkout will install. Docker OTA consumes `image-digest.txt` from the matching
release and refuses a tag that does not resolve to that signed digest. Do not
pretend the git path is signed.

### Dashboard `/self-update` (git checkout)

`src/dashboard/api.js` updates by fetching a stable `vX.Y.Z` tag, checking that
the tag object and peeled commit are consistent, that the commit is an ancestor
of the update branch, and that the move is a fast-forward. Before the tag can
become a mutation target, it also verifies `release-attestation.json`:

- the attested `commit` must equal the tag's peeled commit; a mismatch is
  refused in every mode;
- when `release-attestation.json.sigstore.json` is present, `cosign verify-blob`
  must verify it with the release workflow identity and issuer;
- `WINDSURFAPI_UPDATE_ATTESTATION=warn` (default) logs a warning and proceeds
  when the attestation, its bundle or cosign is missing, so an existing install
  without cosign keeps updating; `required` refuses instead.

`update.sh` runs the same check (`scripts/verify-release-attestation.mjs`)
before any stash/reset/merge. A pre-staged `WINDSURFAPI_ATTESTATION_DIR` serves
air-gapped hosts and forks.

The signature proves "this release workflow published this tag→commit binding
for these bytes", not human approval or a reproducible build. Anyone who can
push a `v*` tag can mint the same identity; tag protection and a review-gated
release environment are separate controls.

Adding `git verify-tag` is a different root of trust (a signing key that every
deployment must already have) and remains intentionally not wired.

### Select an exact signed source release

Source builds that include the release-line selector can follow a stable
release line with `bash update.sh --line <major>.x` (e.g. `3.x`, `4.x`).
The equivalent `WINDSURFAPI_UPDATE_RELEASE_LINE=<major>.x` setting also
applies to dashboard Git checks and updates. Confirm support with
`git show HEAD:update.sh` before using either option. The staged migration
in the target release's notes remains the entry point for older
installations.

The selector ranks published stable tags of the requested major numerically
**within the descendants of the v3.2.10 commit on the release branch**. It
includes future minor releases and excludes the earlier v3.141 series. It
requires an annotated tag and signed source attestation. Source updates
follow a fast-forward. Leave the setting unset for the default numeric
selector.

For an existing source installation moving to v3.2.11, follow the
[v3.2.11 staged migration](releases/RELEASE_NOTES_3.2.11.md#signed-upgrade).
Both v3.141.592661 and v3.2.11 ship the numeric stable-tag selector. The
one-shot selector described below is available in subsequent source builds
that include this change.

To check support on your trusted installation, inspect the updater source in
the current Git revision.

```bash
git show HEAD:update.sh | grep -F 'Usage: bash update.sh [--tag vX.Y.Z]'
```

If the command prints the usage line, choose a published, signed release
that is a descendant of your current checkout. Save a recoverable copy of
the installation and its operator state before applying that release.
If the line is absent, follow the staged migration in the chosen release's
own notes.

```bash
read -r -p 'Exact signed release tag to install: ' target_tag
bash update.sh --tag "${target_tag:?a release tag is required}"
```

The tag applies to this invocation. The updater requires the remote annotated
tag and its peeled commit to agree with the Git advertisement, and the commit
must be reachable from the fetched `origin/master`. Your checkout must be
clean and able to fast-forward to that commit. The updater verifies the
canonical repository, exact tag workflow identity, commit and tree in the
signed release attestation before changing the checkout. To use a downloaded
attestation and bundle, set `WINDSURFAPI_ATTESTATION_DIR` to their directory.
Cosign and the bundle are required, and both force overrides are incompatible
with `--tag`.

After the update, check the running commit in `/health`. The script uses the
existing PM2 health check and rollback and returns a failure if it rolls back
the elected update.

### Docker OTA

The dashboard one-click update (when `/var/run/docker.sock` is mounted) never
treats a tag as an execution target. It resolves the running tag through the
daemon's `GET /distribution/<repo>:<tag>/json` endpoint, then requires the
result to equal the digest in `<DATA_DIR>/image-digest.txt`; a missing file, an
unreadable digest or a mismatch refuses before any pull or container create.
The app image is pulled by digest, the `docker:24-cli` deployer is pinned by
digest in source, and every `docker compose up` uses `--no-build` so Compose can
never build from the on-disk checkout.

Download `image-digest.txt` (and verify its `.sigstore.json` bundle) from the
matching GitHub Release and place it at `<DATA_DIR>/image-digest.txt` before the
first update. A digest-pinned `WINDSURFAPI_IMAGE=repo@sha256:…` is an explicit
operator pin and needs no attestation file.

`deploy/update.sh` still pulls the reference passed by `--tag`/`--image`; pin it
to a digest by hand:

```bash
docker buildx imagetools inspect ghcr.io/dwgx/windsurf-api:<tag>
bash deploy/update.sh --image ghcr.io/dwgx/windsurf-api@sha256:<digest>
```

### Windows / manual install

The Windows distribution is a manual download. Verify before running the exe:
follow [Verify a download](#verify-a-download) with the downloaded files in one
directory. `deploy/windows/README.md` points here. A trojaned exe runs with the
user's privileges and reads the side-by-side `.env` and `accounts.json`, so this
is the path where verification matters most.

### `install-ls.sh`

This installer downloads language-server binaries from a different repository
(`windsurf-ls-release`) and verifies their own manifest/pin hashes. It is not
covered by the release-asset signatures described here.

## Manual Git-source migration from v3.141 to v3.2.x

**Select the target tag manually.** The Git-source updater sorts reachable
stable release tags by numeric major, minor and patch. It compares the lengths
of decimal components before comparing their digits. Consequently
`v3.141.592661` ranks above `v3.2.11`. Changing GitHub Latest does not select
the 3.2.x line for an installation running the legacy updater.

1. Choose the exact published 3.2.x tag and follow that tag's instructions.
   For v3.2.11, use the [signed upgrade procedure](releases/RELEASE_NOTES_3.2.11.md#signed-upgrade).
2. Back up operator state and keep the running installation available. In a
   separate clean clone, check the annotated tag, its peeled commit, ancestry,
   and signed source attestation with the exact tag's workflow identity.
3. Stage the verified checkout separately. Confirm its version and build
   commit in `/health` before switching traffic. Keep the previous checkout
   and its data backup for rollback.

The `--tag` example for `verify-release-assets.mjs` pins signature verification.
The published v3.2.11 `update.sh` uses its automatic numeric selector.

## Historical releases

- v3.10.0 introduced signing for the four platform assets and their checksum manifest.
  v3.2.10 and v3.2.11 also publish the signed source attestation and image digest.
- Docker images: signed by digest from the first release that publishes
  `image-digest.txt`; earlier images are unsigned.
- v3.9.53–v3.9.60: `SHA256SUMS` only, unsigned. v3.9.53 recorded build-tree
  paths (`dist-windows/...`, `dist-macos/...`); later releases use flat names.
- Earlier releases: no manifest and no signatures.

## Changing the identity

If the repository, workflow path, or signing mechanism changes, update the
identity in three places together: this document, `DEFAULT_IDENTITY_REGEXP` in
`scripts/verify-release-assets.mjs`, and the release workflow. The signing test
compares the document with the script so a partial update fails CI. Treat an
identity change as a trust-root change: users who pinned the old identity must
be told explicitly.
