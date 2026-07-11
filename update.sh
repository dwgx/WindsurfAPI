#!/usr/bin/env bash
# update.sh — one-click update: pull latest + update LS binary + restart PM2
set -e

cd "$(dirname "$0")"

PORT="${PORT:-3003}"
NAME="${PM2_NAME:-windsurf-api}"

echo "=== [1/5] Pull latest ==="
git fetch --quiet origin
BEFORE=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)
DIRTY=$(git status --porcelain)
AHEAD=$(git rev-list --count "${REMOTE}..HEAD")
FORCE_RESET="${WINDSURFAPI_UPDATE_FORCE_RESET:-0}"

if [ "$FORCE_RESET" = "1" ]; then
  if [ -n "$DIRTY" ]; then
    echo "    ! preserving local changes in a stash before forced reset"
    git stash push --include-untracked -m "WindsurfAPI pre-update"
  fi
  echo "    ! forced reset to origin/master"
  git reset --hard "$REMOTE"
else
  if [ -n "$DIRTY" ] || [ "$AHEAD" -gt 0 ]; then
    echo "    ! local changes or commits detected; refusing destructive update"
    echo "      review them first, or set WINDSURFAPI_UPDATE_FORCE_RESET=1"
    exit 1
  fi
  git pull --ff-only --quiet
fi

AFTER=$(git rev-parse HEAD)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "    已是最新 / Already up to date"
else
  echo "    $BEFORE → $AFTER"
  git log --oneline "$BEFORE..$AFTER" 2>/dev/null | head -10 || true
fi

echo ""
echo "=== [2/5] Update LS binary ==="
LS_PATH="${LS_BINARY_PATH:-/opt/windsurf/language_server_linux_x64}"
if [ -f .env ]; then
  _lp="$(awk '
    /^[[:space:]]*(export[[:space:]]+)?LS_BINARY_PATH[[:space:]]*=/ {
      sub(/^[[:space:]]*(export[[:space:]]+)?LS_BINARY_PATH[[:space:]]*=[[:space:]]*/, "")
      if (substr($0, 1, 1) != "\"" && substr($0, 1, 1) != "'\''") {
        sub(/[[:space:]]+#.*/, "")
      }
      sub(/[[:space:]]*$/, "")
      if ((substr($0, 1, 1) == "\"" && substr($0, length($0), 1) == "\"") ||
          (substr($0, 1, 1) == "'\''" && substr($0, length($0), 1) == "'\''")) {
        $0 = substr($0, 2, length($0) - 2)
      }
      print $0
      exit
    }
  ' .env 2>/dev/null || true)"
  [ -n "$_lp" ] && LS_PATH="$_lp"
fi
if [ ! -f install-ls.sh ]; then
  echo "    ! install-ls.sh not found; cannot update LS binary"
  exit 1
fi
echo "    Updating via install-ls.sh -> $LS_PATH"
if LS_INSTALL_PATH="$LS_PATH" bash install-ls.sh; then
  echo "    LS binary update finished"
else
  _ls_rc=$?
  if [ -s "$LS_PATH" ]; then
    echo "    ! LS binary update failed (exit $_ls_rc); keeping existing binary at $LS_PATH"
  else
    echo "    ! LS binary update failed and no existing binary exists at $LS_PATH"
    exit "$_ls_rc"
  fi
fi

echo ""
echo "=== [3/5] Stop service ==="
pm2 stop "$NAME" >/dev/null 2>&1 || true
pm2 delete "$NAME" >/dev/null 2>&1 || true
fuser -k "$PORT"/tcp >/dev/null 2>&1 || true
pkill -f "node.*WindsurfAPI/src/index.js" >/dev/null 2>&1 || true

for i in $(seq 1 30); do
  if ! ss -ltn 2>/dev/null | grep -q ":$PORT "; then break; fi
  sleep 1
done

echo ""
echo "=== [4/5] Start service ==="
pm2 start src/index.js --name "$NAME" --cwd "$(pwd)"
pm2 save >/dev/null 2>&1 || true

echo ""
echo "=== [5/5] Health check ==="
sleep 3
# audit #5: `curl -sf ... | head` returned head's exit code (always 0), so a 500
# /health or an unbound port passed the check. Capture first — curl -sf's own
# exit code (nonzero on HTTP >=400 / connection failure) is now authoritative.
HEALTH_OUT="$(curl -sf "http://localhost:$PORT/health")" && HEALTH_OK=1 || HEALTH_OK=0
if [ "$HEALTH_OK" = 1 ]; then
  echo "$HEALTH_OUT" | head -200
  echo ""
  echo ""
  echo "✓ Update complete. Dashboard: http://\$YOUR_IP:$PORT/dashboard"
else
  echo ""
  echo "✗ Health check failed. Check 'pm2 logs $NAME' for details."
  exit 1
fi
