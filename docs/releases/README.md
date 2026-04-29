# Release Notes

Per-version release notes for WindsurfAPI. Filenames follow the pattern
`RELEASE_NOTES_<major>.<minor>.<patch>.md` and are picked up automatically
by `.github/workflows/release.yml` when a `v*` tag is pushed — the file
becomes the GitHub Release body.

The latest version's notes are also surfaced on the project homepage and
in the dashboard "About" panel.

## Adding a new release

1. Bump `package.json#version`
2. Write `docs/releases/RELEASE_NOTES_<new-version>.md`
3. Commit and push to `master`
4. Tag: `git tag v<new-version> && git push origin v<new-version>`

The release workflow builds the GHCR image and publishes the GitHub
Release. The body comes from the matching file in this folder.
