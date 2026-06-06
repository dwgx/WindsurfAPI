# v2.0.130

- Native bridge Read protocol fix: `parseTrajectorySteps()` now recognizes the newer `type=14` / `field=19` view-file wrapper observed in live LS traces and promotes it to the existing `view_file` native tool-call path.
- Native proposal mode now returns a cascade-native tool proposal before surfacing same-batch remote executor errors, so OpenAI clients can execute the tool locally instead of receiving the LS workspace failure.
- Read tool-call repair now maps internal `/home/user/projects/workspace-*` and `/tmp/windsurf-workspace` paths back to caller cwd-relative paths before sanitization. The repair is conservative and only runs for Read/read_file/view_file arguments that already contain one of those internal workspace paths.
- Added focused tests for Read wrapper decoding, same-batch error handling, and path repair. Default native bridge scope remains unchanged: Read/Grep/Glob/WebSearch/WebFetch still require explicit gray allowlists.
