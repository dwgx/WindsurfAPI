#!/usr/bin/env bash
# update.sh — one-click update: pull latest + update LS binary + restart PM2
set -e

cd "$(dirname "$0")"

PORT="${PORT:-3003}"
NAME="${PM2_NAME:-windsurf-api}"
STABLE_TAG_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
REQUESTED_TAG=""
REQUESTED_LINE="${WINDSURFAPI_UPDATE_RELEASE_LINE:-}"
LINE_COMMIT=""
if [ "$#" -ne 0 ]; then
  if [ "$#" -eq 1 ] && { [ "$1" = "--help" ] || [ "$1" = "-h" ]; }; then
    echo "Usage: bash update.sh [--tag vX.Y.Z]"
    echo "  --tag  Fast-forward to this signed stable release for this run only."
    echo "  --line <major>.x  Follow stable signed descendants on that major's release line (e.g. 3.x, 4.x)."
    exit 0
  fi
  if [ "$#" -eq 2 ] && [ "$1" = "--line" ] && [ -z "$REQUESTED_LINE" ]; then
    REQUESTED_LINE="$2"
    [[ "$REQUESTED_LINE" =~ ^[0-9]+\.x$ ]] || { echo "Expected --line <major>.x" >&2; exit 2; }
  elif [ "$#" -ne 2 ] || [ "$1" != "--tag" ] || ! [[ "$2" =~ $STABLE_TAG_PATTERN ]]; then
    echo "✗ Expected a stable release tag: bash update.sh --tag vX.Y.Z" >&2
    exit 2
  else
    REQUESTED_TAG="$2"
  fi
fi
if [ -n "$REQUESTED_LINE" ]; then
  if ! [[ "$REQUESTED_LINE" =~ ^[0-9]+\.x$ ]] || [ -n "$REQUESTED_TAG" ]; then
    echo "Choose exactly one signed tag or a <major>.x release line" >&2; exit 2
  fi
fi
if [ -n "$REQUESTED_TAG$REQUESTED_LINE" ]; then
  if [ "${WINDSURFAPI_UPDATE_FORCE:-0}" = "1" ] || [ "${WINDSURFAPI_UPDATE_FORCE_RESET:-0}" = "1" ]; then
    echo "✗ --tag cannot be combined with WINDSURFAPI_UPDATE_FORCE or WINDSURFAPI_UPDATE_FORCE_RESET" >&2
    exit 2
  fi
  # An elected release is checked out using the actual signed Git objects.
  export GIT_NO_REPLACE_OBJECTS=1
fi

# Cross-process serialization for update.sh. mkdir is atomic on every platform
# supported by this script (including macOS hosts without flock). A second
# updater must fail before fetch/stash/reset rather than relying on git's index
# lock after rollback metadata and service lifecycle have already raced.
GIT_DIR_PATH="$(git rev-parse --git-dir)"
UPDATE_LOCK_DIR="$GIT_DIR_PATH/windsurfapi-update.lock"
UPDATE_LOCK_TOKEN="$$-$(date +%s)-${RANDOM}-${RANDOM}"
UPDATE_TARGET_TREE_TMP=""
UPDATE_TAG_LIST_TMP=""
UPDATE_IGNORED_ROOTS_TMP=""
UPDATE_IGNORED_PATHS_TMP=""
OWNED_STASH_OID=""
SERVICE_STOP_FAILED=0

lock_process_is_alive() {
  local candidate_pid="$1"
  if kill -0 "$candidate_pid" 2>/dev/null; then
    return 0
  fi
  # kill -0 also fails with EPERM when another user owns a live process. Only
  # recover when a second read-only process-table check proves the PID absent;
  # if ps is unavailable or inconclusive, stay fail-closed.
  if command -v ps >/dev/null 2>&1; then
    [ -n "$(ps -p "$candidate_pid" -o pid= 2>/dev/null || true)" ] && return 0
    return 1
  fi
  return 0
}

acquire_update_lock() {
  if mkdir "$UPDATE_LOCK_DIR" 2>/dev/null; then
    return 0
  fi
  # Recover only a lock whose numeric owner PID is provably gone. Missing,
  # malformed, inaccessible, or still-live ownership stays fail-closed.
  local lock_pid="" lock_token="" legacy="0"
  if [ -r "$UPDATE_LOCK_DIR/owner" ]; then
    read -r lock_pid lock_token < "$UPDATE_LOCK_DIR/owner" || true
    [[ "$lock_pid" =~ ^[0-9]+$ ]] || return 1
    [[ "$lock_token" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  elif [ -r "$UPDATE_LOCK_DIR/pid" ]; then
    IFS= read -r lock_pid < "$UPDATE_LOCK_DIR/pid" || true
    legacy="1"
    lock_token="legacy"
  else
    return 1
  fi
  [[ "$lock_pid" =~ ^[0-9]+$ ]] || return 1
  lock_process_is_alive "$lock_pid" && return 1

  # O_EXCL recovery claim closes the stale-lock ABA: exactly one contender may
  # rename the still-existing stale directory. A crash in this tiny recovery
  # window intentionally leaves a fail-closed claim for manual inspection.
  local claim_path="$UPDATE_LOCK_DIR/recovery"
  if ! ( set -o noclobber; printf '%s %s\n' "$$" "$UPDATE_LOCK_TOKEN" > "$claim_path" ) 2>/dev/null; then
    return 1
  fi
  local verify_pid="" verify_token="" verify_legacy="0"
  if [ -r "$UPDATE_LOCK_DIR/owner" ]; then
    read -r verify_pid verify_token < "$UPDATE_LOCK_DIR/owner" || true
  elif [ -r "$UPDATE_LOCK_DIR/pid" ]; then
    IFS= read -r verify_pid < "$UPDATE_LOCK_DIR/pid" || true
    verify_token="legacy"
    verify_legacy="1"
  fi
  if [ "$verify_pid" != "$lock_pid" ] || [ "$verify_token" != "$lock_token" ] || [ "$verify_legacy" != "$legacy" ]; then
    rm -f "$claim_path"
    return 1
  fi
  local quarantine="$UPDATE_LOCK_DIR.stale-$UPDATE_LOCK_TOKEN"
  if ! mv "$UPDATE_LOCK_DIR" "$quarantine" 2>/dev/null; then
    rm -f "$claim_path"
    return 1
  fi
  rm -f "$quarantine/recovery" "$quarantine/owner" "$quarantine/pid"
  rmdir "$quarantine" 2>/dev/null || true
  if mkdir "$UPDATE_LOCK_DIR" 2>/dev/null; then
    return 0
  fi
  return 1
}
if ! acquire_update_lock; then
  echo "✗ Another WindsurfAPI update is already in progress ($UPDATE_LOCK_DIR)"
  exit 1
fi
if ! ( set -o noclobber; printf '%s %s\n' "$$" "$UPDATE_LOCK_TOKEN" > "$UPDATE_LOCK_DIR/owner" ) 2>/dev/null; then
  rmdir "$UPDATE_LOCK_DIR" 2>/dev/null || true
  echo "✗ Could not initialize WindsurfAPI update lock ownership"
  exit 1
fi
if ! ( set -o noclobber; printf '%s\n' "$$" > "$UPDATE_LOCK_DIR/pid" ) 2>/dev/null; then
  rm -f "$UPDATE_LOCK_DIR/owner"
  rmdir "$UPDATE_LOCK_DIR" 2>/dev/null || true
  echo "✗ Could not initialize WindsurfAPI update lock compatibility PID"
  exit 1
fi
cleanup_update_lock() {
  local owner_pid="" owner_token=""
  [ -r "$UPDATE_LOCK_DIR/owner" ] || return 0
  read -r owner_pid owner_token < "$UPDATE_LOCK_DIR/owner" || true
  [ "$owner_pid" = "$$" ] && [ "$owner_token" = "$UPDATE_LOCK_TOKEN" ] || return 0
  rm -f "$UPDATE_LOCK_DIR/owner" "$UPDATE_LOCK_DIR/pid"
  rmdir "$UPDATE_LOCK_DIR" 2>/dev/null || true
}
cleanup_ignored_target_probe_files() {
  [ -n "$UPDATE_TARGET_TREE_TMP" ] && rm -f -- "$UPDATE_TARGET_TREE_TMP"
  [ -n "$UPDATE_IGNORED_ROOTS_TMP" ] && rm -f -- "$UPDATE_IGNORED_ROOTS_TMP"
  [ -n "$UPDATE_IGNORED_PATHS_TMP" ] && rm -f -- "$UPDATE_IGNORED_PATHS_TMP"
  UPDATE_TARGET_TREE_TMP=""
  UPDATE_IGNORED_ROOTS_TMP=""
  UPDATE_IGNORED_PATHS_TMP=""
  return 0
}
cleanup_update_probe_files() {
  cleanup_ignored_target_probe_files
  [ -n "$UPDATE_TAG_LIST_TMP" ] && rm -f -- "$UPDATE_TAG_LIST_TMP"
  UPDATE_TAG_LIST_TMP=""
  # An empty final path is a normal no-op. Keep the EXIT trap successful so a
  # completed update does not return 1 (and skip lock cleanup) under `set -e`.
  return 0
}
cleanup_update_state() {
  cleanup_update_probe_files
  cleanup_update_lock
}
trap cleanup_update_state EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

check_ignored_target_conflicts() {
  local target_commit="$1"
  local -a target_paths=()
  local -a target_paths_folded=()
  local -a roots_folded=()
  local -a local_roots=()
  local -a local_pathspecs=()
  local -a conflicts=()
  local path="" folded="" root="" root_folded="" existing="" ignored="" ignored_root="" left="" right="" duplicate="0"
  local i=0

  cleanup_ignored_target_probe_files
  UPDATE_TARGET_TREE_TMP="$(mktemp "$GIT_DIR_PATH/windsurfapi-target-tree.XXXXXX")" || return 2
  UPDATE_IGNORED_ROOTS_TMP="$(mktemp "$GIT_DIR_PATH/windsurfapi-ignored-roots.XXXXXX")" || return 2
  UPDATE_IGNORED_PATHS_TMP="$(mktemp "$GIT_DIR_PATH/windsurfapi-ignored-paths.XXXXXX")" || return 2
  if ! git ls-tree -r -z --name-only "$target_commit" > "$UPDATE_TARGET_TREE_TMP"; then
    echo "    ! could not inspect the update target tree; refusing a destructive checkout"
    return 2
  fi
  while IFS= read -r -d '' path; do
    target_paths+=("$path")
    folded="$(printf '%s' "$path" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
    target_paths_folded+=("$folded")
    root="${path%%/*}"
    root_folded="$(printf '%s' "$root" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
    duplicate="0"
    for existing in "${roots_folded[@]}"; do
      [ "$existing" = "$root_folded" ] && duplicate="1" && break
    done
    if [ "$duplicate" = "0" ]; then
      roots_folded+=("$root_folded")
    fi
  done < "$UPDATE_TARGET_TREE_TMP"
  [ "${#target_paths[@]}" -gt 0 ] || return 0

  # Inventory ignored roots in collapsed form first. This avoids descending
  # into wholly ignored trees such as node_modules while discovering the real
  # on-disk spelling of roots whose case differs from the target. Do not trust
  # core.ignorecase here: it can be absent or stale on a case-insensitive FS.
  if ! git ls-files --others --ignored --exclude-standard --directory -z > "$UPDATE_IGNORED_ROOTS_TMP"; then
    echo "    ! could not inventory ignored runtime roots; refusing a destructive checkout"
    return 2
  fi
  while IFS= read -r -d '' ignored; do
    ignored="${ignored%/}"
    ignored_root="${ignored%%/*}"
    left="$(printf '%s' "$ignored_root" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
    duplicate="0"
    for right in "${roots_folded[@]}"; do
      [ "$left" = "$right" ] || continue
      for existing in "${local_roots[@]}"; do
        [ "$existing" = "$ignored_root" ] && duplicate="1" && break
      done
      if [ "$duplicate" = "0" ]; then
        local_roots+=("$ignored_root")
        local_pathspecs+=(":(top,literal)$ignored_root")
      fi
      break
    done
  done < "$UPDATE_IGNORED_ROOTS_TMP"
  [ "${#local_roots[@]}" -gt 0 ] || return 0

  if ! git ls-files --others --ignored --exclude-standard -z -- "${local_pathspecs[@]}" > "$UPDATE_IGNORED_PATHS_TMP"; then
    echo "    ! could not inspect ignored runtime paths; refusing a destructive checkout"
    return 2
  fi
  while IFS= read -r -d '' ignored; do
    left="$(printf '%s' "$ignored" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
    for ((i = 0; i < ${#target_paths_folded[@]}; i++)); do
      right="${target_paths_folded[$i]}"
      if [ "$left" = "$right" ] || [[ "$left" == "$right/"* ]] || [[ "$right" == "$left/"* ]]; then
        conflicts+=("$ignored")
        break
      fi
    done
  done < "$UPDATE_IGNORED_PATHS_TMP"

  if [ "${#conflicts[@]}" -gt 0 ]; then
    echo "    ! update target would overwrite ignored runtime data; move or back up these paths first:"
    local shown="0"
    for path in "${conflicts[@]}"; do
      echo "      $path"
      shown=$((shown + 1))
      [ "$shown" -ge 20 ] && break
    done
    return 1
  fi
  return 0
}

stable_tag_is_newer() {
  local left="${1#v}" right="${2#v}"
  local left_major="" left_minor="" left_patch=""
  local right_major="" right_minor="" right_patch=""
  IFS=. read -r left_major left_minor left_patch <<< "$left"
  IFS=. read -r right_major right_minor right_patch <<< "$right"
  local -a left_parts=("$left_major" "$left_minor" "$left_patch")
  local -a right_parts=("$right_major" "$right_minor" "$right_patch")
  local index="0" position="0" left_part="" right_part="" left_digit="" right_digit=""
  while [ "$index" -lt 3 ]; do
    left_part="${left_parts[$index]}"
    right_part="${right_parts[$index]}"
    if [ "${#left_part}" -ne "${#right_part}" ]; then
      [ "${#left_part}" -gt "${#right_part}" ]
      return
    fi
    if [ "$left_part" != "$right_part" ]; then
      position="0"
      while [ "$position" -lt "${#left_part}" ]; do
        left_digit="${left_part:$position:1}"
        right_digit="${right_part:$position:1}"
        if [ "$left_digit" != "$right_digit" ]; then
          [ "$left_digit" -gt "$right_digit" ]
          return
        fi
        position=$((position + 1))
      done
    fi
    index=$((index + 1))
  done
  return 1
}

is_git_object_id() {
  local oid="$1"
  [[ "$oid" =~ ^[0-9a-f]+$ ]] || return 1
  [ "${#oid}" -eq 40 ] || [ "${#oid}" -eq 64 ]
}

is_nonnegative_git_count() {
  local value="$1"
  [[ "$value" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  # Bash's `[` accepts decimal strings syntactically but emits `integer
  # expected` and returns false for values outside its signed integer range.
  # Every caller branches on the result, so accepting an oversized count here
  # would turn an unknown count into zero and could allow a destructive reset.
  # Keep the bound below both Bash's range and JavaScript's safe-integer limit,
  # and reject before any arithmetic comparison is attempted.
  [ "${#value}" -le 16 ] || return 1
  if [ "${#value}" -eq 16 ] && [ "$value" -gt 9007199254740991 ]; then
    return 1
  fi
  return 0
}

port_listener_probe() {
  local output="" rc=0
  if command -v ss >/dev/null 2>&1; then
    if ! output="$(ss -ltn 2>/dev/null)"; then
      return 2
    fi
    printf '%s\n' "$output" | grep -q ":$PORT "
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1
    rc=$?
    [ "$rc" -eq 0 ] && return 0
    [ "$rc" -eq 1 ] && return 1
    return 2
  fi
  return 2
}

pm2_process_is_live() {
  local pids="" pid="" found=""
  PM2_LIVE_PID=""
  if ! pids="$(pm2 pid "$NAME" 2>/dev/null)"; then
    return 1
  fi
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      [ -z "$found" ] || return 1
      found="$pid"
    fi
  done <<< "$pids"
  [ -n "$found" ] || return 1
  PM2_LIVE_PID="$found"
  return 0
}

# A rollback must prove that the failed target is no longer represented by the
# named PM2 app before Git moves the checkout back. Real PM2 exits successfully
# and prints an empty result for a deleted name, while a stopped entry reports
# `0`. Any positive PID is still a PM2 record even when that OS process has just
# died: accepting it based on `kill -0` would race PM2's restart/accounting and
# could move Git underneath a process that comes back from the failed target.
pm2_named_process_is_absent() {
  local pids="" pid=""
  if ! pids="$(pm2 pid "$NAME" 2>/dev/null)"; then
    return 1
  fi
  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    [ "$pid" = "0" ] && continue
    return 1
  done <<< "$pids"
  return 0
}

health_response_matches_commit() {
  local body="$1" expected="$2" expected_pid="$3"
  [[ "$expected_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$expected" =~ ^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$ ]] || return 1
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$body" | node -e '
      const fs = require("node:fs");
      let body;
      try { body = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
      const expectedCommit = process.argv[1].toLowerCase();
      const expectedPid = Number(process.argv[2]);
      const actualCommit = typeof body?.commit === "string"
        ? body.commit.trim().toLowerCase()
        : "";
      const commitMatches = /^[0-9a-f]{7,64}$/.test(actualCommit)
        && (actualCommit === expectedCommit || expectedCommit.startsWith(actualCommit));
      if (!body || Array.isArray(body) || body.status !== "ok" || !commitMatches
          || !Number.isSafeInteger(body.pid) || body.pid !== expectedPid) process.exit(1);
    ' "$expected" "$expected_pid" >/dev/null 2>&1
    return $?
  fi
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq -e --arg expected "$expected" --argjson expectedPid "$expected_pid" \
      'type == "object" and .status == "ok" and (.commit | type == "string") and
       ((.commit | ascii_downcase) as $actual |
         ($expected | ascii_downcase) as $wanted |
         ($actual | test("^[0-9a-f]{7,64}$")) and
         ($actual == $wanted or ($wanted | startswith($actual)))) and
       (.pid | type == "number") and .pid == $expectedPid' \
      >/dev/null 2>&1
    return $?
  fi
  return 1
}

if ! command -v pm2 >/dev/null 2>&1; then
  echo "✗ pm2 is required for a safe update; refusing to mutate Git or the LS installation"
  exit 1
fi

echo "=== [1/5] Pull latest ==="
# Fetch only the release branch here. Published-tag authority comes from
# `ls-remote` below; importing/pruning the remote tag namespace would either keep
# revoked local refs alive or destroy operator-owned local tags.
if [ -n "$REQUESTED_TAG$REQUESTED_LINE" ]; then
  git fetch --quiet --no-tags origin refs/heads/master
  REMOTE_HEAD=$(git rev-parse 'FETCH_HEAD^{commit}')
  BEFORE_REF=$(git rev-parse --symbolic-full-name HEAD)
else
  git fetch --quiet --no-tags origin master
  REMOTE_HEAD=$(git rev-parse origin/master)
fi
BEFORE=$(git rev-parse HEAD)
DIRTY=$(git status --porcelain)
if [ -n "$REQUESTED_TAG$REQUESTED_LINE" ]; then
  if ! DIRTY=$(git status --porcelain --ignore-submodules=none --untracked-files=all) || [ -n "$DIRTY" ]; then
    echo "    ! --tag needs a clean checkout before attestation verification"
    exit 1
  fi
fi
if [ -n "$REQUESTED_LINE" ]; then
  selection=$(node scripts/select-release-line.mjs "$REQUESTED_LINE" "$REMOTE_HEAD") || exit 1
  read -r REQUESTED_TAG LINE_COMMIT LINE_OBJECT <<< "$selection"
fi
FORCE_RESET="${WINDSURFAPI_UPDATE_FORCE_RESET:-0}"
FORCE_UPDATE="${WINDSURFAPI_UPDATE_FORCE:-0}"

# 版本门禁（tag gate）: normal OTA installs the newest published tag, not
# origin/master HEAD. Post-tag release notes, generated assets, and work for
# the next release must not make the published release impossible to install.
# WINDSURFAPI_UPDATE_FORCE=1 explicitly opts into the untagged branch HEAD.
# Filter exact stable semver before choosing. The remote ref namespace is the
# publication authority: `git fetch --tags` never removes a revoked tag, so
# selecting from `git tag --list` can reinstall a release deleted upstream.
# Each candidate is fetched only into FETCH_HEAD, preserving all local tags.
LATEST_TAG=""
RELEASE_COMMIT=""
TAG_PATTERNS=('refs/tags/v[0-9]*')
if [ -n "$REQUESTED_TAG" ]; then
  TAG_PATTERNS=("refs/tags/$REQUESTED_TAG" "refs/tags/$REQUESTED_TAG^{}")
fi
UPDATE_TAG_LIST_TMP="$(mktemp "$GIT_DIR_PATH/windsurfapi-release-tags.XXXXXX")"
if ! git ls-remote --tags origin "${TAG_PATTERNS[@]}" > "$UPDATE_TAG_LIST_TMP"; then
  echo "    ! could not verify published release tags; refusing update"
  exit 1
fi

REMOTE_TAG_NAMES=()
REMOTE_TAG_OBJECTS=()
REMOTE_TAG_PEELED=()
while IFS= read -r advertised_line || [ -n "$advertised_line" ]; do
  if [[ "$advertised_line" != *$'\t'* ]] || [[ "${advertised_line#*$'\t'}" == *$'\t'* ]]; then
    echo "    ! remote tag enumeration returned a malformed record; refusing update"
    exit 1
  fi
  advertised_oid="${advertised_line%%$'\t'*}"
  advertised_ref="${advertised_line#*$'\t'}"
  if [ -z "$advertised_oid" ] || [ -z "$advertised_ref" ] \
      || ! is_git_object_id "$advertised_oid" || [[ "$advertised_ref" != refs/tags/* ]]; then
    echo "    ! remote tag enumeration returned a malformed record; refusing update"
    exit 1
  fi
  advertised_name="${advertised_ref#refs/tags/}"
  advertised_peeled="0"
  if [[ "$advertised_name" == *'^{}' ]]; then
    advertised_name="${advertised_name:0:${#advertised_name}-3}"
    advertised_peeled="1"
  fi
  if [ -z "$advertised_name" ] || [[ "$advertised_name" == .* ]] \
      || [[ "$advertised_name" == *. ]] || [[ "$advertised_name" == */ ]] \
      || [[ "$advertised_name" == *'..'* ]] || [[ "$advertised_name" == *'//'* ]] \
      || [[ "$advertised_name" == *'@{'* ]] || [[ "$advertised_name" =~ [[:space:]~^:?*\[\\] ]]; then
    echo "    ! remote tag enumeration returned an invalid ref name; refusing update"
    exit 1
  fi
  [[ "$advertised_name" =~ $STABLE_TAG_PATTERN ]] || continue
  [ -z "$REQUESTED_TAG" ] || [ "$advertised_name" = "$REQUESTED_TAG" ] || continue

  advertised_index="-1"
  for index in "${!REMOTE_TAG_NAMES[@]}"; do
    if [ "${REMOTE_TAG_NAMES[$index]}" = "$advertised_name" ]; then
      advertised_index="$index"
      break
    fi
  done
  if [ "$advertised_peeled" = "1" ]; then
    if [ "$advertised_index" -lt 0 ] || [ -n "${REMOTE_TAG_PEELED[$advertised_index]:-}" ]; then
      echo "    ! remote tag enumeration returned an orphan/duplicate peeled ref; refusing update"
      exit 1
    fi
    REMOTE_TAG_PEELED[$advertised_index]="$advertised_oid"
  else
    if [ "$advertised_index" -ge 0 ]; then
      echo "    ! remote tag enumeration returned a duplicate tag ref; refusing update"
      exit 1
    fi
    REMOTE_TAG_NAMES+=("$advertised_name")
    REMOTE_TAG_OBJECTS+=("$advertised_oid")
    REMOTE_TAG_PEELED+=("")
  fi
done < "$UPDATE_TAG_LIST_TMP"

# Consider stable versions from newest to oldest, selecting the first whose
# exact remote object peels correctly and is reachable from origin/master.
REMOTE_TAG_USED=()
while true; do
  newest_index="-1"
  for index in "${!REMOTE_TAG_NAMES[@]}"; do
    [ "${REMOTE_TAG_USED[$index]:-0}" = "1" ] && continue
    if [ "$newest_index" -lt 0 ] || stable_tag_is_newer "${REMOTE_TAG_NAMES[$index]}" "${REMOTE_TAG_NAMES[$newest_index]}"; then
      newest_index="$index"
    fi
  done
  [ "$newest_index" -ge 0 ] || break
  REMOTE_TAG_USED[$newest_index]="1"

  candidate="${REMOTE_TAG_NAMES[$newest_index]}"
  expected_object="${REMOTE_TAG_OBJECTS[$newest_index]}"
  expected_peeled="${REMOTE_TAG_PEELED[$newest_index]:-}"
  if ! git fetch --quiet --no-tags origin "refs/tags/$candidate"; then
    echo "    ! could not fetch remote release tag $candidate; refusing update"
    exit 1
  fi
  if ! fetched_object=$(git rev-parse FETCH_HEAD 2>/dev/null) \
      || ! is_git_object_id "$fetched_object" || [ "$fetched_object" != "$expected_object" ]; then
    echo "    ! remote release tag $candidate changed during verification; refusing update"
    exit 1
  fi
  if ! fetched_commit=$(git rev-parse 'FETCH_HEAD^{commit}' 2>/dev/null) \
      || ! is_git_object_id "$fetched_commit" \
      || ! fetched_type=$(git cat-file -t "$fetched_object" 2>/dev/null); then
    echo "    ! remote release tag $candidate did not resolve to a verified commit; refusing update"
    exit 1
  fi
  if [ -n "$expected_peeled" ]; then
    if [ "$fetched_type" != "tag" ] || [ "$fetched_commit" != "$expected_peeled" ]; then
      echo "    ! annotated remote tag $candidate failed peeled-commit correspondence; refusing update"
      exit 1
    fi
  elif [ "$fetched_type" != "commit" ] || [ "$fetched_commit" != "$fetched_object" ]; then
    echo "    ! lightweight remote tag $candidate did not name one commit; refusing update"
    exit 1
  fi

  release_branch="origin/master"
  if [ -n "$REQUESTED_TAG" ]; then
    if [ "$fetched_type" != "tag" ]; then
      echo "    ! --tag requires an annotated release tag; refusing $candidate"
      exit 1
    fi
    release_branch="$REMOTE_HEAD"
  fi
  if [ -n "$LINE_COMMIT" ] && { [ "$LINE_COMMIT" != "$fetched_commit" ] || [ "$LINE_OBJECT" != "$fetched_object" ]; }; then
    echo "    ! release line selection changed during verification"; exit 1
  fi
  if git merge-base --is-ancestor "$fetched_commit" "$release_branch"; then
    LATEST_TAG="$candidate"
    RELEASE_COMMIT="$fetched_commit"
    break
  else
    ancestor_status=$?
    if [ "$ancestor_status" -ne 1 ]; then
      echo "    ! could not verify whether $candidate is reachable from origin/master; refusing update"
      exit 1
    fi
    if [ -n "$REQUESTED_TAG" ]; then
      echo "    ! $candidate is not reachable from origin/master; refusing update"
      exit 1
    fi
  fi
done

if [ -n "$REQUESTED_TAG" ] && [ -z "$LATEST_TAG" ]; then
  echo "    ! $REQUESTED_TAG is not advertised by origin; refusing update"
  exit 1
fi
if [ "$FORCE_UPDATE" = "1" ]; then
  TARGET="$REMOTE_HEAD"
elif [ -z "$LATEST_TAG" ]; then
  echo "    ! no stable release tag is reachable from origin/master; refusing to follow an unverified branch HEAD"
  echo "      set WINDSURFAPI_UPDATE_FORCE=1 only if you intentionally want origin/master"
  exit 1
else
  TARGET="$RELEASE_COMMIT"
fi
if [ -n "$LATEST_TAG" ]; then
  if ! UNRELEASED=$(git rev-list --count "${RELEASE_COMMIT}..${REMOTE_HEAD}" 2>/dev/null); then
    echo "    ! could not verify commits after the latest release; refusing update"
    exit 1
  fi
  if ! is_nonnegative_git_count "$UNRELEASED"; then
    echo "    ! Git returned an invalid release-distance count; refusing update"
    exit 1
  fi
  if [ "${UNRELEASED:-0}" -gt 0 ]; then
    echo "    i 远端有 ${UNRELEASED} 个未发布提交；本次只安装 ${LATEST_TAG}"
    if [ "$FORCE_UPDATE" = "1" ]; then
      echo "      WINDSURFAPI_UPDATE_FORCE=1：改为跟随 origin/master"
    fi
  fi
fi

if ! TO_TARGET=$(git rev-list --count "HEAD..${TARGET}" 2>/dev/null); then
  echo "    ! could not verify whether the target is ahead; refusing update"
  exit 1
fi
if ! is_nonnegative_git_count "$TO_TARGET"; then
  echo "    ! Git returned an invalid target-ahead count; refusing update"
  exit 1
fi
if ! PAST_TARGET=$(git rev-list --count "${TARGET}..HEAD" 2>/dev/null); then
  echo "    ! could not verify whether this checkout is past the target; refusing update"
  exit 1
fi
if ! is_nonnegative_git_count "$PAST_TARGET"; then
  echo "    ! Git returned an invalid target-past count; refusing update"
  exit 1
fi
if ! UNPUSHED=$(git rev-list --count "${REMOTE_HEAD}..HEAD" 2>/dev/null); then
  echo "    ! could not verify local commits against origin/master; refusing update"
  exit 1
fi
if ! is_nonnegative_git_count "$UNPUSHED"; then
  echo "    ! Git returned an invalid local-commit count; refusing update"
  exit 1
fi

if [ -n "$REQUESTED_TAG" ] && [ "$PAST_TARGET" -gt 0 ]; then
  echo "    ! --tag requires a fast-forward from HEAD to $REQUESTED_TAG; refusing update"
  exit 1
fi
if [ "${TO_TARGET:-0}" -gt 0 ] && [ "${PAST_TARGET:-0}" -gt 0 ]; then
  echo "    ! 当前 HEAD 与更新目标 ${TARGET:0:7} 已分叉；拒绝非 fast-forward 更新"
  exit 1
fi

RESET_TARGET="$TARGET"
if [ "$FORCE_RESET" = "1" ] && [ "${TO_TARGET:-0}" -eq 0 ] && [ "${PAST_TARGET:-0}" -gt 0 ] && [ "${UNPUSHED:-0}" -eq 0 ]; then
  RESET_TARGET="$BEFORE"
fi
MUTATION_TARGET=""
MUTATION_EXIT=0
if [ "$FORCE_RESET" = "1" ]; then
  MUTATION_TARGET="$RESET_TARGET"
elif [ "${TO_TARGET:-0}" -gt 0 ]; then
  MUTATION_TARGET="$TARGET"
fi
if [ -n "$MUTATION_TARGET" ]; then
  if ! check_ignored_target_conflicts "$MUTATION_TARGET"; then
    exit 1
  fi
fi

# ── D9 source-OTA attestation ─────────────────────────────────────────
# The selected release tag must carry a release-attestation.json whose commit
# equals the peeled tag commit, signed by the release workflow identity. This
# runs before any stash/reset/merge and before the service restart.
#   warn (default): missing attestation/bundle/cosign logs a warning and the
#                   update proceeds, so existing installs keep working;
#   required:       missing material refuses the update.
# A present but mismatched or invalid attestation is always fatal. An explicit
# tag always requires the canonical workflow identity for that exact tag.
ATTESTATION_MODE="${WINDSURFAPI_UPDATE_ATTESTATION:-warn}"
case "$ATTESTATION_MODE" in
  warn|required) ;;
  *)
    echo "    ! invalid WINDSURFAPI_UPDATE_ATTESTATION='$ATTESTATION_MODE' (expected warn or required); refusing update"
    exit 1
    ;;
esac
if [ -n "$LATEST_TAG" ] && [ "$FORCE_UPDATE" != "1" ] \
    && { [ -z "$MUTATION_TARGET" ] || [ "$MUTATION_TARGET" = "$TARGET" ]; }; then
  ATTESTATION_REPOSITORY=""
  ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
  case "$ORIGIN_URL" in
    https://github.com/dwgx/WindsurfAPI|https://github.com/dwgx/WindsurfAPI.git|git@github.com:dwgx/WindsurfAPI.git|ssh://git@github.com/dwgx/WindsurfAPI.git)
      ATTESTATION_REPOSITORY="dwgx/WindsurfAPI"
      ;;
  esac
  ATTESTATION_ARGS=(--tag "$LATEST_TAG" --commit "$RELEASE_COMMIT" --mode "$ATTESTATION_MODE")
  if [ -n "$REQUESTED_TAG" ]; then
    ATTESTATION_MODE="required"
    RELEASE_TREE=$(git rev-parse "$RELEASE_COMMIT^{tree}")
    IDENTITY_TAG=${LATEST_TAG//./\\.}
    ATTESTATION_ARGS=(--tag "$LATEST_TAG" --commit "$RELEASE_COMMIT" --tree "$RELEASE_TREE" --mode "$ATTESTATION_MODE"
      --repository dwgx/WindsurfAPI
      --identity '^https://github\.com/dwgx/WindsurfAPI/\.github/workflows/release\.yml@refs/tags/'"$IDENTITY_TAG"'$')
  elif [ -n "$ATTESTATION_REPOSITORY" ]; then
    ATTESTATION_ARGS+=(--repository "$ATTESTATION_REPOSITORY")
  fi
  [ -n "${WINDSURFAPI_ATTESTATION_DIR:-}" ] && ATTESTATION_ARGS+=(--dir "$WINDSURFAPI_ATTESTATION_DIR")
  [ -n "${COSIGN:-}" ] && ATTESTATION_ARGS+=(--cosign "$COSIGN")
  if command -v node >/dev/null 2>&1 && [ -f scripts/verify-release-attestation.mjs ]; then
    if ! node scripts/verify-release-attestation.mjs "${ATTESTATION_ARGS[@]}"; then
      echo "    ! release attestation verification failed for $LATEST_TAG; refusing update before any Git mutation"
      exit 1
    fi
  elif [ "$ATTESTATION_MODE" = "required" ]; then
    echo "    ! node or scripts/verify-release-attestation.mjs is missing; WINDSURFAPI_UPDATE_ATTESTATION=required refuses update"
    exit 1
  else
    echo "    ! node or the release attestation verifier is missing; continuing because WINDSURFAPI_UPDATE_ATTESTATION=warn"
  fi
fi

MERGE_ARGS=(--ff-only --quiet)
if [ -n "$REQUESTED_TAG" ]; then
  if [ "$(git rev-parse HEAD)" != "$BEFORE" ] || [ "$(git rev-parse --symbolic-full-name HEAD)" != "$BEFORE_REF" ]; then
    echo "    ! HEAD moved while the signed update was being verified; refusing update"
    exit 1
  fi
  DIRTY=$(git status --porcelain --ignore-submodules=none)
  MERGE_ARGS+=(--no-overwrite-ignore)
fi

if [ "$FORCE_RESET" = "1" ]; then
  if [ -n "$DIRTY" ]; then
    echo "    ! preserving local changes in a stash before forced reset"
    STASH_BEFORE=$(git for-each-ref --format='%(objectname)' refs/stash)
    STASH_MARKER="windsurfapi-pre-update-${UPDATE_LOCK_TOKEN}"
    git stash push --include-untracked -m "$STASH_MARKER"
    STASH_LISTING=$(git stash list --format='%H%x09%gs')
    OWNED_STASH_OID=$(printf '%s\n' "$STASH_LISTING" | awk -v marker="$STASH_MARKER" '
      index($0, marker) { count++; oid=$1 }
      END { if (count > 1) exit 2; if (count == 1) print oid }
    ')
    if [ -n "$OWNED_STASH_OID" ] && [[ ! "$OWNED_STASH_OID" =~ ^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$ ]]; then
      echo "    ! protective stash resolved to an invalid object ID; refusing reset"
      exit 1
    fi
    if [ -z "$OWNED_STASH_OID" ]; then
      STASH_AFTER=$(git for-each-ref --format='%(objectname)' refs/stash)
      if [ "$STASH_AFTER" != "$STASH_BEFORE" ]; then
        echo "    ! refs/stash changed but this updater could not identify its own stash; refusing reset"
        exit 1
      fi
      echo "    i no protective stash was created; the working tree was cleaned before stash"
    fi
  fi
  # force-reset normally means "clean my working tree and continue updating".
  # If this checkout already contains the release target and is itself on the
  # remote branch, resetting to the tag would be an accidental downgrade.
  echo "    ! forced reset to ${RESET_TARGET:0:7}"
  if git reset --hard "$RESET_TARGET"; then
    :
  else
    MUTATION_EXIT=$?
  fi
else
  if [ -n "$DIRTY" ] || [ "${UNPUSHED:-0}" -gt 0 ]; then
    echo "    ! local changes or commits detected; refusing destructive update"
    echo "      review them first, or set WINDSURFAPI_UPDATE_FORCE_RESET=1"
    exit 1
  fi
  if [ "${TO_TARGET:-0}" -gt 0 ]; then
    if git merge "${MERGE_ARGS[@]}" "$TARGET"; then
      :
    else
      MUTATION_EXIT=$?
    fi
  fi
fi

if ! AFTER=$(git rev-parse HEAD); then
  echo "    ! could not verify HEAD after the Git mutation; refusing to continue"
  exit 1
fi
if [ -n "$MUTATION_TARGET" ]; then
  if ! TRACKED_AFTER=$(git status --porcelain --untracked-files=no --ignore-submodules=none); then
    echo "    ! could not verify tracked state after the Git mutation; refusing to continue"
    exit 1
  fi
  if [ "$AFTER" != "$MUTATION_TARGET" ] || [ -n "$TRACKED_AFTER" ]; then
    echo "    ! Git did not reach the expected clean target; refusing to report update success"
    echo "      expected: $MUTATION_TARGET"
    echo "      actual:   $AFTER"
    if [ -n "$TRACKED_AFTER" ]; then
      echo "      tracked changes remain:"
      printf '%s\n' "$TRACKED_AFTER" | head -20
    fi
    if [ -n "$OWNED_STASH_OID" ]; then
      echo "      protective stash remains at $OWNED_STASH_OID"
    fi
    exit 1
  fi
  if [ "$MUTATION_EXIT" -ne 0 ]; then
    echo "    ! Git returned exit $MUTATION_EXIT after reaching the verified clean target; continuing"
  fi
elif [ "$MUTATION_EXIT" -ne 0 ]; then
  echo "    ! Git mutation failed with exit $MUTATION_EXIT"
  exit "$MUTATION_EXIT"
fi
if [ -n "$REQUESTED_TAG" ] && {
    [ "$AFTER" != "$TARGET" ] || [ "$(git rev-parse --symbolic-full-name HEAD)" != "$BEFORE_REF" ];
  }; then
  echo "    ! checkout changed while selecting $REQUESTED_TAG; refusing to restart the service"
  exit 1
fi
if [ "$BEFORE" = "$AFTER" ]; then
  echo "    已是最新 / Already up to date"
else
  echo "    $BEFORE → $AFTER"
  git log --oneline "$BEFORE..$AFTER" 2>/dev/null | head -10 || true
fi

echo ""
check_signed_rollback_state() {
  [ -n "$REQUESTED_TAG" ] || return 0
  local rollback_changes
  if [ "$(git rev-parse HEAD)" != "$TARGET" ] || [ "$(git rev-parse --symbolic-full-name HEAD)" != "$BEFORE_REF" ]; then
    echo "✗ Automatic rollback refused: the checkout moved after the signed update."
    return 1
  fi
  if ! rollback_changes=$(git status --porcelain --ignore-submodules=none --untracked-files=all) || [ -n "$rollback_changes" ]; then
    echo "✗ Automatic rollback refused: local changes need to be preserved."
    return 1
  fi
}

# The previous process is still running until phase 3. Restore its checkout
# if the elected release cannot prepare its language server.
restore_signed_checkout_before_stop() {
  [ -n "$REQUESTED_TAG" ] && [ "$AFTER" != "$BEFORE" ] || return 0
  check_signed_rollback_state || return 1
  check_ignored_target_conflicts "$BEFORE" || return 1
  git reset --keep "$BEFORE" || return 1
  [ "$(git rev-parse HEAD)" = "$BEFORE" ] && [ "$(git rev-parse --symbolic-full-name HEAD)" = "$BEFORE_REF" ]
}

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
  restore_signed_checkout_before_stop || exit 1
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
    restore_signed_checkout_before_stop || exit 1
    exit "$_ls_rc"
  fi
fi

echo ""
echo "=== [3/5] Stop service ==="
pm2 stop "$NAME" >/dev/null 2>&1 || true
pm2 delete "$NAME" >/dev/null 2>&1 || true
# Never fall back to a command-line substring kill here: another checkout or
# an unrelated service can also contain `src/index.js`. PM2 owns the named app;
# the remaining fallback is bounded to this deployment's configured port.
fuser -k "$PORT"/tcp >/dev/null 2>&1 || true
PORT_RELEASED=0
for i in $(seq 1 30); do
  # `set -e` must not turn the probe's meaningful 1 (free) or 2 (unknown)
  # result into an unverified process exit before the state machine handles it.
  if port_listener_probe; then
    probe_rc=0
  else
    probe_rc=$?
  fi
  if [ "$probe_rc" -eq 1 ]; then
    PORT_RELEASED=1
    break
  fi
  if [ "$probe_rc" -ne 0 ]; then
    echo "    ! could not verify whether service port $PORT is free; entering verified rollback"
    SERVICE_STOP_FAILED=1
    break
  fi
  sleep 1
done
if [ "$PORT_RELEASED" -ne 1 ]; then
  if [ "$SERVICE_STOP_FAILED" -eq 0 ]; then
    echo "    ! service port $PORT remains occupied after stop; entering verified rollback"
  fi
  SERVICE_STOP_FAILED=1
fi

echo ""
echo "=== [4/5] Start service ==="
PM2_START_EXIT=0
if [ "$SERVICE_STOP_FAILED" -eq 1 ]; then
  PM2_START_EXIT=125
else
  if pm2 start src/index.js --name "$NAME" --cwd "$(pwd)"; then
    pm2 save >/dev/null 2>&1 || true
    if ! pm2_process_is_live; then
      PM2_START_EXIT=126
      echo "    ! pm2 reported success but the named app has no live process; entering verified rollback"
    fi
  else
    PM2_START_EXIT=$?
    echo "    ! pm2 start failed with exit $PM2_START_EXIT; entering verified rollback"
  fi
fi

echo ""
echo "=== [5/5] Health check + rollback on failure ==="
# audit #5: `curl -sf ... | head` returned head's exit code (always 0), so a 500
# /health or an unbound port passed the check. Capture first — curl -sf's own
# exit code (nonzero on HTTP >=400 / connection failure) is now authoritative.
HEALTH_OUT=""
HEALTH_OK=0
if [ "$PM2_START_EXIT" -eq 0 ]; then
  sleep 3
  if HEALTH_OUT="$(curl -sf --connect-timeout 5 --max-time 15 "http://localhost:$PORT/health")" \
      && health_response_matches_commit "$HEALTH_OUT" "$AFTER" "$PM2_LIVE_PID"; then
    HEALTH_OK=1
  else
    HEALTH_OK=0
    echo "    ! /health did not identify the expected running commit ${AFTER:0:12}"
  fi
fi
if [ "$HEALTH_OK" = 1 ]; then
  echo "$HEALTH_OUT" | head -200
  echo ""
  echo ""
  echo "✓ Update complete. Dashboard: http://\$YOUR_IP:$PORT/dashboard"
else
  echo ""
  echo "✗ Health check failed after update. Auto-rolling back to $BEFORE ..."
  check_signed_rollback_state || exit 1
  # Stop/delete the failed target before changing the checkout.  A bare
  # `pm2 start --name` retry is not a rollback: real PM2 can reject a duplicate
  # name, reuse the old process identity, or leave the target code resident in
  # memory after Git has moved back.  Keep the proof separate from the initial
  # stop gate so a health failure is audited again on its own path.
  ROLLBACK_SERVICE_STOP_FAILED=0
  pm2 stop "$NAME" >/dev/null 2>&1 || true
  pm2 delete "$NAME" >/dev/null 2>&1 || true
  if ! pm2_named_process_is_absent; then
    echo "    ! could not prove that the failed PM2 app $NAME is absent"
    ROLLBACK_SERVICE_STOP_FAILED=1
  fi
  fuser -k "$PORT"/tcp >/dev/null 2>&1 || true
  ROLLBACK_PORT_RELEASED=0
  for i in $(seq 1 30); do
    if port_listener_probe; then
      rollback_probe_rc=0
    else
      rollback_probe_rc=$?
    fi
    if [ "$rollback_probe_rc" -eq 1 ]; then
      ROLLBACK_PORT_RELEASED=1
      break
    fi
    if [ "$rollback_probe_rc" -ne 0 ]; then
      echo "    ! could not verify whether service port $PORT is free during rollback"
      ROLLBACK_SERVICE_STOP_FAILED=1
      break
    fi
    sleep 1
  done
  if [ "$ROLLBACK_PORT_RELEASED" -ne 1 ]; then
    if [ "$ROLLBACK_SERVICE_STOP_FAILED" -eq 0 ]; then
      echo "    ! service port $PORT remains occupied during rollback"
    fi
    ROLLBACK_SERVICE_STOP_FAILED=1
  fi
  if [ "$ROLLBACK_SERVICE_STOP_FAILED" -eq 0 ] && ! pm2_named_process_is_absent; then
    echo "    ! the failed PM2 app $NAME reappeared while waiting for its listener to stop"
    ROLLBACK_SERVICE_STOP_FAILED=1
  fi
  if [ "$ROLLBACK_SERVICE_STOP_FAILED" -eq 1 ]; then
    echo "✗ Automatic rollback refused before changing Git because the failed service could not be proven stopped."
    echo "  The failed target remains checked out at $AFTER; no stash was restored."
    if [ -n "$OWNED_STASH_OID" ]; then
      echo "  Protective stash remains at $OWNED_STASH_OID."
    fi
    exit 1
  fi
  if ! check_ignored_target_conflicts "$BEFORE"; then
    echo "✗ Automatic rollback refused because checking out $BEFORE could overwrite ignored owner data."
    echo "  The failed target remains checked out; preserve the reported paths and recover manually."
    if [ -n "$OWNED_STASH_OID" ]; then
      echo "  Protective stash remains at $OWNED_STASH_OID."
    fi
    exit 1
  fi

  ROLLBACK_MUTATION_EXIT=0
  rollback_mode=--hard
  if [ -n "$REQUESTED_TAG" ]; then
    check_signed_rollback_state || exit 1
    rollback_mode=--keep
  fi
  if git reset "$rollback_mode" "$BEFORE"; then
    :
  else
    ROLLBACK_MUTATION_EXIT=$?
  fi
  if ! ROLLBACK_HEAD=$(git rev-parse HEAD); then
    echo "✗ Could not verify HEAD after automatic rollback; manual recovery required."
    [ -n "$OWNED_STASH_OID" ] && echo "  Protective stash remains at $OWNED_STASH_OID."
    exit 1
  fi
  if ! ROLLBACK_TRACKED=$(git status --porcelain --untracked-files=no --ignore-submodules=none); then
    echo "✗ Could not verify tracked state after automatic rollback; manual recovery required."
    [ -n "$OWNED_STASH_OID" ] && echo "  Protective stash remains at $OWNED_STASH_OID."
    exit 1
  fi
  if [ "$ROLLBACK_HEAD" != "$BEFORE" ] || [ -n "$ROLLBACK_TRACKED" ]; then
    echo "✗ Automatic rollback did not reach the expected clean target; manual recovery required."
    echo "  expected: $BEFORE"
    echo "  actual:   $ROLLBACK_HEAD"
    if [ -n "$ROLLBACK_TRACKED" ]; then
      echo "  tracked changes remain:"
      printf '%s\n' "$ROLLBACK_TRACKED" | head -20
    fi
    [ -n "$OWNED_STASH_OID" ] && echo "  Protective stash remains at $OWNED_STASH_OID."
    exit 1
  fi
  if [ "$ROLLBACK_MUTATION_EXIT" -ne 0 ]; then
    echo "    ! Git returned exit $ROLLBACK_MUTATION_EXIT after reaching the verified clean rollback target; continuing"
  fi

  STASH_RESTORE_OK=1
  if [ -n "$OWNED_STASH_OID" ]; then
    echo "    restoring exact protective stash ${OWNED_STASH_OID:0:12} (backup remains in git stash)"
    if ! git stash apply "$OWNED_STASH_OID" 2>/dev/null; then
      STASH_RESTORE_OK=0
      echo "    ! local changes were NOT restored; backup remains at $OWNED_STASH_OID"
    fi
  fi
  if pm2 start src/index.js --name "$NAME" --cwd "$(pwd)" >/dev/null 2>&1; then
    pm2 save >/dev/null 2>&1 || true
    if ! pm2_process_is_live; then
      ROLLBACK_PM2_START_EXIT=126
      echo "✗ Code rolled back to $BEFORE, but the named PM2 app has no live process; manual recovery required."
      exit 1
    fi
  else
    ROLLBACK_PM2_START_EXIT=$?
    echo "✗ Code rolled back to $BEFORE, but PM2 restart failed with exit $ROLLBACK_PM2_START_EXIT; manual recovery required."
    exit 1
  fi
  sleep 3
  if ROLLBACK_OUT="$(curl -sf --connect-timeout 5 --max-time 15 "http://localhost:$PORT/health")" \
      && health_response_matches_commit "$ROLLBACK_OUT" "$BEFORE" "$PM2_LIVE_PID"; then
    ROLLBACK_OK=1
  else
    ROLLBACK_OK=0
    echo "    ! rollback /health did not identify the expected commit ${BEFORE:0:12}"
  fi
  if [ "$ROLLBACK_OK" = 1 ]; then
    echo "$ROLLBACK_OUT" | head -200
    echo ""
    if [ "$STASH_RESTORE_OK" != 1 ]; then
      echo "✗ Code rolled back to $BEFORE and the service is healthy, but local changes still require manual recovery from $OWNED_STASH_OID."
      exit 1
    fi
    echo "✓ Rolled back to $BEFORE — service healthy. Check 'pm2 logs $NAME' for the original failure."
    [ -z "$REQUESTED_TAG" ] || exit 1
    exit 0
  fi
  echo "✗ Rollback also failed. Manual intervention required. Check 'pm2 logs $NAME'."
  exit 1
fi
