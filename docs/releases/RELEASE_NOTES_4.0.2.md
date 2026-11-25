# WindsurfAPI v4.0.2

WindsurfAPI 4.0.2 includes the 4.0 changes and repairs the release job time budget. It improves model routing, account recovery and request diagnostics across its OpenAI, Anthropic and Gemini HTTP interfaces.

## Publication fix

The v4.0.0 tag's release job was cancelled at its 20-minute total limit after
673 of 685 test files completed with no failures. Its separate CI run passed
all 685 files. Version 4.0.1 raised the job budget to 30 minutes. Its CI then identified an
assertion still pinned to 20 minutes, so that publication was stopped before
building artifacts. Version 4.0.2 aligns the assertion with the 30-minute
job budget and keeps
the existing per-file timeout and test assertions, and retains the same product
source. The v4.0.0 tag remains available as the record of that interrupted job.

## Upgrade changes

- Unknown model names return HTTP 400 with model_not_found. The previous strict-model opt-out is removed.
- Rate-limited Claude variants keep their requested identity. Optional variant fallback requires WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT=1.
- A model unavailable in every eligible account's catalog returns a non-retryable model_unavailable response.
- The 4.x version line sorts above the historical v3.141.592661 release for source and container updates.

Back up the installation's configuration and account data before upgrading. The previous signed [v3.2.11 release](https://github.com/dwgx/WindsurfAPI/releases/tag/v3.2.11) remains available for rollback.

## Account sign-in

A direct local instance can sign in through Devin from the account dialog. Enable DEVIN_BROWSER_LOGIN=1 with HOST=127.0.0.1, then choose **Sign in → Sign in to WindsurfAPI with Devin → Continue in Devin**. After Devin returns to the same instance, confirm account addition in the original dialog.

The gateway creates a fresh PKCE transaction. It clears one-time material after use, cancellation or expiry and rejects callbacks with the wrong state. The local callback requires a direct connection to 127.0.0.1. Remote dashboards can use their existing supported credential intake. Model access remains subject to the selected account's provider permissions and quota.

The obsolete browser redirect has been retired. Existing email sign-in, credential import and account-bound credential replacement continue through their current routes. Account status and failure messages give the next usable action.

## Dashboard and request diagnostics

- The model catalog supports search and pagination. Runtime and session sections use a compact layout, and billed-turn history offers page-size choices.
- Statistics cards retain their compact layout at desktop and narrower window sizes.
- Public request IDs can be searched after statistics reload. Request details show observed dispatches, timing, stream outcomes and disconnect information.
- The cost card identifies local rate estimates and UTC daily totals. Per-dispatch provider reports preserve explicit zero values and distinguish missing reports.
- Tool-stream termination, cancellation and persistence fixes are included alongside the existing protocol compatibility work.

## Validation and downloads

On the product source used for this release, a fresh Devin browser login admitted the selected account and its provider identity was checked. Native OMP completed separate file-read and file-write tasks on that same instance with swe-1-7-medium. Four model requests produced one read-tool execution and one write-tool execution. The written file was reopened after the client exited and matched the requested bytes.

The tagged release workflow executes the full release suite, checks mutation baselines, builds the Windows and macOS packages, publishes the container image and verifies the uploaded asset set. Release success is reported by that workflow.

Windows previously reached the default 90-second per-file limit in the concurrency-stream-flow test during a full local run. The same file completed under the default limit when run individually. The root cause of that full-run slowdown remains unresolved. The complete mutation sweep and a final provider invoice are outside this release's executed validation.

Download **windsurfapi-windows.zip** for Windows, or the corresponding macOS package. Verify SHA256SUMS and the Sigstore bundles using the instructions in [Release signing](https://github.com/dwgx/WindsurfAPI/blob/v4.0.2/docs/RELEASE-SIGNING.md). The source attestation and signed container digest are included with the release.

[Open verification register](https://github.com/dwgx/WindsurfAPI/blob/v4.0.2/docs/UNVERIFIED.md) · [Roadmap](https://github.com/dwgx/WindsurfAPI/blob/v4.0.2/docs/ROADMAP.md)
