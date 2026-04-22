#!/usr/bin/env bash
# Install / update the Windsurf language server binary.
#
# Usage:
#   ./install-ls.sh                        # install latest from Exafunction/codeium
#   ./install-ls.sh /path/to/local.bin     # install a local file
#   ./install-ls.sh --file /path/to.bin    # same as above
#   ./install-ls.sh --url <direct-url>     # install from a custom URL
#
# Auto-detects platform (Linux / macOS) and architecture (x64 / arm64).
# Override install path with LS_INSTALL_PATH env var.
set -euo pipefail

EXAFUNCTION_API='https://api.github.com/repos/Exafunction/codeium/releases/latest'

log() { echo -e "\033[1;34m==>\033[0m $*"; }
err() { echo -e "\033[1;31m!!\033[0m  $*" >&2; }

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
    DEFAULT_PATH='/opt/windsurf/language_server_linux_x64'
    ;;
  Darwin)
    case "$arch" in
      x86_64)        ASSET='language_server_macos_x64' ;;
      arm64)         ASSET='language_server_macos_arm' ;;
      *) err "Unsupported macOS arch: $arch"; exit 1 ;;
    esac
    DEFAULT_PATH="$HOME/.windsurf/language_server_macos_${arch}"
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

if [[ $# -gt 0 && "$1" == "--file" && -n "${2:-}" ]]; then
  log "Installing from local file: $2"
  cp -f "$2" "$TARGET"
elif [[ $# -gt 0 && "$1" != "--url" && "$1" != "--file" && -f "$1" ]]; then
  log "Installing from local file: $1"
  cp -f "$1" "$TARGET"
elif [[ $# -ge 2 && "$1" == "--url" ]]; then
  url="$2"
  log "Downloading from: $url"
  curl -fL --progress-bar -o "$TARGET" "$url"
else
  log "Fetching latest Exafunction/codeium release tag..."
  if command -v jq >/dev/null 2>&1; then
    url="$(curl -fsSL "$EXAFUNCTION_API" | jq -r \
      --arg asset "$ASSET" '.assets[] | select(.name == $asset) | .browser_download_url')"
  else
    url="$(curl -fsSL "$EXAFUNCTION_API" | \
      grep -oE "https://[^\"]+/${ASSET}" | head -1)"
  fi
  if [[ -z "$url" ]]; then
    err "Could not find asset '$ASSET' in latest release."
    err "Visit https://github.com/Exafunction/codeium/releases and download manually."
    exit 1
  fi
  log "Downloading: $url"
  curl -fL --progress-bar -o "$TARGET" "$url"
fi

chmod +x "$TARGET"
size="$(du -h "$TARGET" | cut -f1)"
if command -v sha256sum >/dev/null 2>&1; then
  sha="$(sha256sum "$TARGET" | cut -c1-16)"
elif command -v shasum >/dev/null 2>&1; then
  sha="$(shasum -a 256 "$TARGET" | cut -c1-16)"
else
  sha="(no sha256 tool)"
fi
log "Installed: $TARGET ($size, sha256:$sha...)"

# Remind about .env
if [[ "$os" == "Darwin" ]]; then
  log ""
  log "macOS users: set this in your .env:"
  log "  LS_BINARY_PATH=$TARGET"
fi
