#!/usr/bin/env bash
# Install / update the Windsurf language server binary.
#
# Usage:
#   ./install-ls.sh                        # auto: WindsurfAPI release → maintained LS mirror → Exafunction fallback
#   ./install-ls.sh /path/to/local.bin     # install a local file
#   ./install-ls.sh --file /path/to.bin    # same as above
#   ./install-ls.sh --url <direct-url>     # install from a custom URL
#
# Auto-detects platform (Linux / macOS) and architecture (x64 / arm64).
# Override install path with LS_INSTALL_PATH env var.
set -euo pipefail

OUR_RELEASE='https://github.com/dwgx/WindsurfAPI/releases/latest/download'
EXAFUNCTION_API='https://api.github.com/repos/Exafunction/codeium/releases/latest'
# Maintained mirror for LS binaries extracted from official Windsurf/Devin Desktop builds.
WINDSURF_LS_RELEASE="${WINDSURFAPI_LS_RELEASE:-https://github.com/dwgx/windsurf-ls-release/releases/latest/download}"

log() { echo -e "\033[1;34m==>\033[0m $*"; }
err() { echo -e "\033[1;31m!!\033[0m  $*" >&2; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 127
  fi
}

verify_release_asset_checksum() {
  local release_base="$1"
  local asset="$2"
  local file="$3"
  local checksums_file="${TMP_CHECKSUMS:-${file}.SHA256SUMS}"
  local checksums_url="${release_base}/SHA256SUMS"

  log "Trying checksum file: $checksums_url"
  if ! curl -fsL -o "$checksums_file" "$checksums_url"; then
    rm -f "$checksums_file"
    log "SHA256SUMS not available; skipping mirror checksum verification"
    return 0
  fi

  local expected
  expected="$(awk -v asset="$asset" '$2 == asset && length($1) == 64 && $1 ~ /^[0-9a-fA-F]+$/ { print tolower($1); exit }' "$checksums_file")"
  rm -f "$checksums_file"
  if [[ -z "$expected" ]]; then
    err "SHA256SUMS from $release_base does not list $asset"
    return 1
  fi

  local actual
  if ! actual="$(sha256_file "$file")"; then
    log "No sha256 tool available; skipping mirror checksum verification"
    return 0
  fi

  if [[ "$actual" != "$expected" ]]; then
    err "Checksum mismatch for $asset"
    err "Expected: $expected"
    err "Actual:   $actual"
    return 1
  fi

  log "Verified $asset against SHA256SUMS"
}

# ─── Platform detection ────────────────────────────────
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Linux)
    case "$arch" in
      x86_64|amd64)  ASSET='language_server_linux_x64' ;;
      aarch64|arm64) ASSET='language_server_linux_arm' ;;
      *) err "Unsupported Linux arch: $arch"; exit 1 ;;
    esac
    DEFAULT_PATH="/opt/windsurf/${ASSET}"
    ;;
  Darwin)
    case "$arch" in
      x86_64)        ASSET='language_server_macos_x64' ;;
      arm64)         ASSET='language_server_macos_arm' ;;
      *) err "Unsupported macOS arch: $arch"; exit 1 ;;
    esac
    DEFAULT_PATH="$HOME/.windsurf/${ASSET}"
    ;;
  *)
    err "Unsupported OS: $os (only Linux and macOS are supported)"
    exit 1
    ;;
esac

TARGET="${LS_INSTALL_PATH:-$DEFAULT_PATH}"
log "Platform: $os $arch → asset=$ASSET"
log "Target:   $TARGET"

mkdir -p "$(dirname "$TARGET")"

# Write to a sibling tmp file then atomic-rename onto the target. If the
# target is currently being executed (LS process has it mmap'd as the
# program text), Linux refuses an in-place open(O_WRONLY|O_TRUNC) with
# ETXTBSY ("file busy"). A rename(2), by contrast, just swaps the dirent
# pointer to a new inode — running processes keep their old inode and
# we get a fresh binary in place for the next exec.
TMP_TARGET="${TARGET}.new.$$"
TMP_CHECKSUMS="${TMP_TARGET}.SHA256SUMS"
trap 'rm -f "$TMP_TARGET" "$TMP_CHECKSUMS"' EXIT

if [[ $# -gt 0 && "$1" == "--file" && -n "${2:-}" ]]; then
  log "Installing from local file: $2"
  cp -f "$2" "$TMP_TARGET"
elif [[ $# -gt 0 && "$1" != "--url" && "$1" != "--file" && -f "$1" ]]; then
  log "Installing from local file: $1"
  cp -f "$1" "$TMP_TARGET"
elif [[ $# -ge 2 && "$1" == "--url" ]]; then
  url="$2"
  log "Downloading from: $url"
  curl -fL --progress-bar -o "$TMP_TARGET" "$url"
else
  # Try our own GitHub release first, then the maintained public LS mirror,
  # then the older Exafunction/codeium release as a last resort.
  our_url="${OUR_RELEASE}/${ASSET}"
  log "Trying WindsurfAPI release: $our_url"
  if curl -fL --progress-bar -o "$TMP_TARGET" "$our_url" 2>/dev/null; then
    log "Downloaded from WindsurfAPI release"
  else
    log "Not found in WindsurfAPI release, trying maintained Windsurf LS mirror..."
    ws_url="${WINDSURF_LS_RELEASE}/${ASSET}"
    log "Trying maintained Windsurf LS mirror: $ws_url"
    if curl -fL --progress-bar -o "$TMP_TARGET" "$ws_url"; then
      log "Downloaded from maintained Windsurf LS mirror"
      verify_release_asset_checksum "$WINDSURF_LS_RELEASE" "$ASSET" "$TMP_TARGET"
    else
      log "Not found in maintained Windsurf LS mirror, falling back to Exafunction..."
      if command -v jq >/dev/null 2>&1; then
        url="$(curl -fsSL "$EXAFUNCTION_API" | jq -r \
          --arg asset "$ASSET" '.assets[] | select(.name == $asset) | .browser_download_url')"
      else
        url="$(curl -fsSL "$EXAFUNCTION_API" | \
          grep -oE "https://[^\"]+/${ASSET}" | head -1)"
      fi
      if [[ -z "$url" ]]; then
        err "Could not find asset '$ASSET' in any release."
        err "Download manually from Windsurf desktop app:"
        err "  macOS: ~/Library/Application Support/Windsurf/.../bin/$ASSET"
        err "  Linux: ~/.windsurf/bin/$ASSET"
        exit 1
      fi
      log "Downloading: $url"
      curl -fL --progress-bar -o "$TMP_TARGET" "$url"
    fi
  fi
fi

chmod +x "$TMP_TARGET"
mv -f "$TMP_TARGET" "$TARGET"
trap - EXIT
size="$(du -h "$TARGET" | cut -f1)"
if full_sha="$(sha256_file "$TARGET")"; then
  sha="$(printf '%s' "$full_sha" | cut -c1-16)"
else
  sha="(no sha256 tool)"
fi
log "Installed: $TARGET ($size, sha256:$sha...)"

if [[ "$os" == "Darwin" ]]; then
  log ""
  log "macOS users: set this in your .env:"
  log "  LS_BINARY_PATH=$TARGET"
fi
