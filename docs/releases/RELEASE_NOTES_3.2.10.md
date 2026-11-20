# WindsurfAPI v3.2.10

This release keeps credential and model-access changes consistent when a save
fails or its durability is uncertain. It improves Connect and Gemini response
handling and keeps in-flight accounting attached to the account or language
server that originally accepted the request.

## Migrating from v3.141.592661

**Select v3.2.10 explicitly.** Under SemVer, `3.2.10` has lower precedence than
`3.141.592661`, even though the new release commit descends from the previous
one. The dashboard's Git-source update check and `update.sh` choose the highest
numeric stable tag reachable from the update branch. They continue to select
`v3.141.592661` while it remains the highest reachable tag. GitHub's Latest
release setting does not change that selector. The existing ancestry checks
still apply. Subsequent `3.2.x` tags need the same explicit migration while the
selector and higher legacy tag remain in place.

- **Windows or macOS.** Save a recoverable copy of the current installation and
  its operator state. Download the signed assets for the exact release tag to
  a clean directory. Run the trusted checkout's verifier with Cosign, then
  stage the verified platform package in a separate directory.

  ```sh
  node scripts/verify-release-assets.mjs --dir <download-directory> --tag v3.2.10
  ```

- **Git source.** Stage the release in a separate clean clone. Compare the
  annotated tag object and peeled commit with the public remote refs and the
  release workflow's recorded commit. Verify that the running commit is an
  ancestor of the peeled commit and that the peeled commit is an ancestor of
  `origin/master`. From the trusted existing checkout, require the signed
  attestation for that exact release commit before checking it out and
  activating the staged service. Retain the prior service and the shared
  persistent state for rollback.

  ```sh
  node scripts/verify-release-attestation.mjs \
    --mode required --repository dwgx/WindsurfAPI --tag v3.2.10 \
    --commit "$verified_release_commit" \
    --identity '^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v3\.2\.10$'
  ```

- **Docker.** Verify the release's signed image digest and the image signature
  for the exact `v3.2.10` workflow identity. Pin the verified digest for the
  staged replacement and retain the existing persistent volumes. [Release signing](../RELEASE-SIGNING.md)

A package resolver selecting the greatest SemVer also ranks the legacy
number first. The published numeric range in [GHSA-fx5f-49jr-fw6r](https://github.com/dwgx/WindsurfAPI/security/advisories/GHSA-fx5f-49jr-fw6r)
includes `3.2.10`. The v3.2.10 source descends from the published fix in
`v3.141.592661`. A scanner that uses that version range can still flag the package.

## What changed

- Credential rotation publishes the key and dashboard password together.
  Both dashboard skins distinguish an applied save with a durability or
  protection warning from a save that failed. Automatic re-login uses the
  verified account identity and the current credential generation.
- Model-access changes publish a complete policy snapshot. The dashboard
  confirms the saved policy from the verified response and keeps the existing
  view when the operation fails. Public diagnostics redact proxy credentials
  and per-user language-server identities.
- The direct Connect path projects developer text and pure-text system
  instructions consistently. Gemini preserves ordinary response text and tool
  order, and exposes thought summaries only when `includeThoughts` is enabled.
- Language-server leases and ACP account reservations settle against their
  original acquisition. The optional Connect streaming transport requires a
  terminal response and handles cancellation once.

## Verification scope

The complete local release and mutation gates were recorded on source
ancestor `507f4fca58969ed3515ab4a4d7fbfba6ec67b4aa`. The accepted source delta
`f99cfb142ca6213df062970342797cfdc238ccbe` had 649 passing tests in 34 affected
files under isolated state and network-deny setup. Exact release workflow
results and signed asset verification apply to this release's tag and commit.

## Open verification

Enterprise Cascade/LS end-to-end behavior in issue #245 and real upstream
inference are outside the scope of those selected regressions.

[Open verification register](../UNVERIFIED.md)
