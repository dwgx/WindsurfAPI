# v2.0.131

- Tightened the Read wrapper parser added in v2.0.130: `type=14` / `field=19` is now promoted only when the candidate value is clearly a file URI or path.
- Added a regression test for the live canary failure mode where wrapper field 2 contained the full prompt/environment text instead of a path. In that case the proxy now suppresses the native tool-call instead of emitting a bad `Read.file_path`.
- Native bridge defaults remain unchanged; Read still requires explicit gray allowlisting and is not ready for broad rollout.
