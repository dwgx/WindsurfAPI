# WindsurfAPI v3.2.11

This release improves account admission and retry on Devin Connect, fixes
dashboard account import and request history, and makes ACP and language-server
shutdown more predictable. It also updates schema validation, HTTPS streaming,
portable build identity and the public project history.

## Changes since v3.2.10

- **Devin Connect and account scheduling.** Requests admitted as free-only during
  a quota drought stay on eligible pooled accounts through initial selection,
  pin waits and retries. A numeric zero in the executing account's own catalog
  counts as free evidence. Unknown pricing stays ineligible for this exception.
  Connect requires a pooled lease when the pool is configured and forwards rate
  limit retry hints while preserving other streaming error bodies. Pin waits can
  wake at expected account recovery and check the request deadline before
  acquiring a slot.
- **Dashboard.** Smart import handles pasted email and session-token pairs
  through the existing token path and reports skipped rows accurately in both
  skins. Request history paginates in recording order. Its cursors expire when
  their ring or anchor is gone, including after a reset or restart.
- **ACP.** Request cancellation and the route time budget carry through
  process-slot waits and prompt issuance. The adapter decodes split UTF-8
  sequences, accepts content updates only during the corresponding pending
  prompt, declines permission requests and keeps agent-owned tool activity
  out of caller tool calls. Request-level RPC errors are handled separately
  from account health. Operator logs distinguish launch arguments, requested
  model and session-reported model. [OpenCode setup](https://github.com/dwgx/WindsurfAPI/blob/v3.2.11/docs/README.md#use-opencode-as-an-acp-agent)
- **Response cache and Cascade streaming.** Clearing the response cache
  prevents completions from before the clear from repopulating it. Cache-key
  serialization preserves literal own JSON field names. Direct Cascade
  streaming retains its compatibility behavior when it cannot use detached
  response delivery.
- **Language-server lifecycle.** Global stop invalidates starts and restart
  continuations queued before the stop, including per-proxy restarts and
  automatic retry timers. A new explicit start can proceed after the stop
  drain.
- **Schemas, HTTPS relay and packaging.** The quality changes through
  `68cceb09` validate Gemini native response-schema types and compare object
  members without depending on key order. The HTTPS relay keeps downloading
  streamed responses after the upload ends and closes the upstream response on
  client cancellation. Portable builds from a clean Git checkout carry the
  actual source commit and check packaged asset identity. Builds without
  available source identity leave that identity unset.
- **Project history.** The existing Pages history now has a source-linked
  view of public issues, pull requests, releases and Git metadata, with the
  snapshot date and activity coverage visible. [Project history](https://dwgx.github.io/WindsurfAPI/HISTORY-LEDGER-VIZ.html#history)

## Signed upgrade

Select **v3.2.11** explicitly on Windows, macOS, Git source or Docker.
The legacy Git-source updater sorts reachable stable tags by numeric SemVer.
It selects `v3.141.592661` while that tag remains the highest reachable version.
GitHub's Latest release setting is independent of this selection.

- **Windows or macOS.** Back up the installation and operator state. Download
  this exact tag's assets to a clean directory and verify them with Cosign
  using a trusted checkout. Stage the verified platform package separately.

  ```sh
  download_dir='/path/to/downloads'
  node scripts/verify-release-assets.mjs --dir "$download_dir" --tag v3.2.11
  ```

- **Git source.** Stage in a clean clone. Compare the remote annotated tag,
  peeled commit and release workflow's source commit. Confirm that the running
  commit is an ancestor of the peeled commit and that the release commit is
  reachable from `origin/master`. Verify its signed attestation from a
  trusted checkout before activating it.

  ```sh
  node scripts/verify-release-attestation.mjs --mode required \
    --repository dwgx/WindsurfAPI --tag v3.2.11 \
    --commit "$verified_release_commit" \
    --identity '^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/v3\.2\.11$'
  ```

- **Docker.** Verify the signed image digest and image signature for the
  exact tag's release workflow identity, then stage the image pinned by
  digest. Keep the existing persistent volumes and prior image for rollback.
  [Release signing](https://github.com/dwgx/WindsurfAPI/blob/v3.2.11/docs/RELEASE-SIGNING.md)

Preserve operator state and confirm the staged build and health before switching
traffic. Keep the previous installation available for rollback.

## Verification scope

Source regression coverage includes the account scheduler, both dashboard
skins, the ACP and language-server lifecycle, streamed HTTP, schema validation
and native packaging. The release workflow supplies the checks and signed
artifacts for the published revision.

## Open verification / 尚未验证

- Enterprise Cascade behavior in [issue #245](https://github.com/dwgx/WindsurfAPI/issues/245)
  remains open pending a confirmed result on the reported client and account type.
- Fixture tests exercise admission, response-cache behavior and retry boundaries.
  Any claim about upstream billing needs a provider-side receipt from an
  authorized run.

[Open verification register](https://github.com/dwgx/WindsurfAPI/blob/v3.2.11/docs/UNVERIFIED.md) · [Roadmap](https://github.com/dwgx/WindsurfAPI/blob/v3.2.11/docs/ROADMAP.md)
