#!/usr/bin/env bash
set -e

echo "=== WindsurfAPI Setup ==="

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS:$ARCH" in
  Darwin:arm64)   LS_PATH="$HOME/.windsurf/language_server_macos_arm"; LS_DATA_DIR="$HOME/.windsurf/data" ;;
  Darwin:x86_64)  LS_PATH="$HOME/.windsurf/language_server_macos_x64"; LS_DATA_DIR="$HOME/.windsurf/data" ;;
  Linux:x86_64|Linux:amd64)
                  LS_PATH="/opt/windsurf/language_server_linux_x64"; LS_DATA_DIR="/opt/windsurf/data" ;;
  Linux:aarch64|Linux:arm64)
                  LS_PATH="/opt/windsurf/language_server_linux_arm"; LS_DATA_DIR="/opt/windsurf/data" ;;
  *)              LS_PATH="/opt/windsurf/language_server_linux_x64"; LS_DATA_DIR="/opt/windsurf/data" ;;
esac

# Create directories
echo "[1/4] Creating directories..."
mkdir -p "$(dirname "$LS_PATH")"
mkdir -p "$LS_DATA_DIR/db"
mkdir -p /tmp/windsurf-workspace

# Check LS binary
if [ -f "$LS_PATH" ]; then
  chmod +x "$LS_PATH"
  echo "[2/4] Language Server found at $LS_PATH"
else
  echo "[2/4] WARNING: Language Server not found at $LS_PATH"
  echo "       Download it and place it there before starting the server"
  echo "       chmod +x $LS_PATH"
fi

# Generate .env if not exists
if [ ! -f .env ]; then
  echo "[3/4] Generating .env..."
  cat > .env << ENVEOF
PORT=3003
API_KEY=
DATA_DIR=
DEFAULT_MODEL=claude-4.5-sonnet-thinking
MAX_TOKENS=8192
LOG_LEVEL=info
DASHBOARD_PASSWORD=
ALLOW_PRIVATE_PROXY_HOSTS=

# ===== Backend: DEVIN_CONNECT (recommended, binary-less) =====
# Pure HTTP to Devin cloud — no language_server binary needed. Set to 1 and add
# a Devin account (dashboard "登录取号" page, or scripts/devin-connect-login.mjs).
# The LS_* lines below are only for the legacy Cascade backend; leave as-is if
# you use DEVIN_CONNECT.
# DEVIN_CONNECT=1
# DEVIN_CONNECT_AUTO_RELOGIN=1
# DEVIN_CONNECT_CRED_KEY=

# ===== Legacy Cascade backend (language server) =====
LS_BINARY_PATH=$LS_PATH
LS_DATA_DIR=$LS_DATA_DIR
LS_PORT=42100
ENVEOF
  echo "       Edit .env to set your API_KEY and DASHBOARD_PASSWORD"
  echo "       For the Devin backend: uncomment DEVIN_CONNECT=1 and add an account"
else
  echo "[3/4] .env already exists, skipping"
fi

# Check Node.js version
NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VER" ]; then
  echo "[4/4] WARNING: Node.js not found. Install Node.js >= 20"
elif [ "$NODE_VER" -lt 20 ]; then
  echo "[4/4] WARNING: Node.js v$NODE_VER detected, need >= 20"
else
  echo "[4/4] Node.js v$(node -v) OK"
fi

echo ""
echo "=== Done ==="
echo "Start:     node src/index.js"
echo "Dev:       node --watch src/index.js"
echo "Dashboard: http://localhost:3003/dashboard"
