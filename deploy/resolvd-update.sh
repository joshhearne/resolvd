#!/usr/bin/env bash
# Resolvd host updater. Run by deploy/resolvd-update.timer every 10 minutes
# on the Docker host, outside the containers: the app never gets Docker
# access. Install with deploy/install-updater.sh.
#
# Each run:
#   1. Reads the admin's policy from the app (Admin → System health):
#      channel = production | development | manual, update_hour, update_now.
#   2. Works out the target: the newest release tag (production) or the tip
#      of origin/dev (development). Manual installs only get "available"
#      reported.
#   3. At the update hour (or when an admin pressed "Update now"), if the
#      target is newer than what's running: backs up the database, checks
#      out the target, pins the matching images (RESOLVD_IMAGE_TAG in .env),
#      restarts the stack, and waits for /api/version to report the new
#      commit. If that doesn't happen, it rolls back to the previous commit
#      and images.
#   4. Reports the outcome to the app, with the change files
#      (backend/changes/*.md) the target build adds, so admins can preview
#      what's coming.
#
# Never moves to an older build: the target must descend from the running
# commit (the schema only migrates forward).
#
# Environment overrides: RESOLVD_DIR (checkout, default: this script's
# repo), RESOLVD_URL (default http://127.0.0.1:8090), RESOLVD_REMOTE
# (default origin), RESOLVD_HEALTH_TIMEOUT (seconds, default 180).

set -euo pipefail

# Everything lives in main(), which bash reads in full before running:
# the checkout (this file included) changes underneath us mid-run.
main() {
  DIR="${RESOLVD_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  URL="${RESOLVD_URL:-http://127.0.0.1:8090}"
  REMOTE="${RESOLVD_REMOTE:-origin}"
  HEALTH_TIMEOUT="${RESOLVD_HEALTH_TIMEOUT:-180}"
  cd "$DIR"

  # One run at a time.
  exec 9>"$DIR/.resolvd-update.lock"
  if ! flock -n 9; then
    log "another update run is in progress; skipping"
    return 0
  fi

  TOKEN="$(env_get RESOLVD_UPDATER_TOKEN)"
  if [ -z "$TOKEN" ]; then
    log "RESOLVD_UPDATER_TOKEN missing from $DIR/.env; run deploy/install-updater.sh"
    return 1
  fi

  local policy
  if ! policy="$(curl -fsS -m 20 -H "Authorization: Bearer $TOKEN" "$URL/api/system-updates/policy")"; then
    log "could not read the update policy from $URL (is the stack up?)"
    return 1
  fi
  CHANNEL="$(policy_get channel <<<"$policy")"
  UPDATE_HOUR="$(policy_get update_hour <<<"$policy")"
  UPDATE_NOW="$(policy_get update_now <<<"$policy")"
  HANDLED=0
  PENDING_ARGS=()

  CURRENT_COMMIT="$(git rev-parse HEAD)"
  CURRENT_TAG="$(env_get RESOLVD_IMAGE_TAG)"
  CURRENT_TAG="${CURRENT_TAG:-stable}"

  # The remote is the source of truth for release tags: --force/--prune-tags
  # replace local tags that differ (e.g. from before a history rewrite)
  # instead of rejecting them. Not --quiet: it hides git's reasons for
  # rejected refs, so a failure would report no cause at all.
  local fetch_out fetch_rc=0
  fetch_out="$(git fetch --prune --prune-tags --force --tags "$REMOTE" 2>&1)" || fetch_rc=$?
  if [ "$fetch_rc" != 0 ]; then
    report waiting "git fetch from $REMOTE failed (exit $fetch_rc): $(printf '%s\n' "$fetch_out" | grep -v '^[[:space:]]*$' | head -n 3 | tr '\n' ' ' | head -c 400)"
    return 1
  fi
  local latest_release
  latest_release="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | grep -v -- '-' | head -n1 || true)"

  local target_commit target_tag
  case "$CHANNEL" in
    manual)
      AVAILABLE="$latest_release"
      if [ -n "$latest_release" ]; then
        collect_pending "$(git rev-parse "refs/tags/$latest_release^{commit}")"
      fi
      report manual "Manual updates: the newest release is ${latest_release:-not published yet}."
      return 0
      ;;
    production)
      if [ -z "$latest_release" ]; then
        report waiting "No release has been published yet."
        return 0
      fi
      target_commit="$(git rev-parse "refs/tags/$latest_release^{commit}")"
      target_tag="$latest_release"
      ;;
    development)
      target_commit="$(git rev-parse "refs/remotes/$REMOTE/dev")"
      target_tag="dev-${target_commit:0:7}"
      ;;
    *)
      log "unknown channel '$CHANNEL' in policy"
      return 1
      ;;
  esac
  AVAILABLE="$target_tag"
  collect_pending "$target_commit"

  if [ "$target_commit" = "$CURRENT_COMMIT" ] && [ "$target_tag" = "$CURRENT_TAG" ]; then
    [ "$UPDATE_NOW" = 1 ] && HANDLED=1
    report up_to_date "Running $target_tag, the newest $CHANNEL build."
    return 0
  fi

  local hour
  hour="$(date +%H)"
  if [ "$UPDATE_NOW" != 1 ] && [ "$((10#$hour))" != "$UPDATE_HOUR" ]; then
    report waiting "$target_tag is available; it installs at $(printf '%02d' "$UPDATE_HOUR"):00 server time."
    return 0
  fi
  [ "$UPDATE_NOW" = 1 ] && HANDLED=1

  # Don't retry a build that already failed here every 10 minutes for the
  # rest of the hour (each attempt restarts the stack). A newer build, or
  # an admin pressing "Update now", clears it.
  FAILED_FILE="$DIR/.resolvd-update.failed"
  if [ "$UPDATE_NOW" != 1 ] && [ "$(cat "$FAILED_FILE" 2>/dev/null)" = "$target_tag" ]; then
    report waiting "$target_tag failed to install earlier (see the update history); skipping it until a newer $CHANNEL build or Update now."
    return 0
  fi

  if ! git merge-base --is-ancestor "$CURRENT_COMMIT" "$target_commit"; then
    report waiting "$target_tag is not newer than the running build ($CURRENT_TAG at ${CURRENT_COMMIT:0:7}), so it would be a downgrade. Waiting for a newer $CHANNEL build."
    return 0
  fi

  if ! git diff --quiet HEAD --; then
    echo "$target_tag" >"$FAILED_FILE"
    report failed "The checkout at $DIR has local changes to tracked files; not updating. Commit or discard them." "$CURRENT_TAG" "$target_tag"
    return 1
  fi

  # Images come from CI a few minutes after a push; if they aren't there
  # yet, try again next run.
  if ! RESOLVD_IMAGE_TAG="$target_tag" docker compose pull --quiet backend frontend; then
    HANDLED=0
    report waiting "Images for $target_tag aren't published yet (or the registry is unreachable); retrying next run."
    return 0
  fi

  log "updating $CURRENT_TAG (${CURRENT_COMMIT:0:7}) -> $target_tag (${target_commit:0:7})"
  backup "$CURRENT_TAG" || {
    echo "$target_tag" >"$FAILED_FILE"
    report failed "Pre-update database backup failed; not updating." "$CURRENT_TAG" "$target_tag"
    return 1
  }

  # A failed `up` is caught by the health check, which triggers the rollback.
  deploy "$target_commit" "$target_tag" || log "deploying $target_tag failed"
  if wait_healthy "$target_commit"; then
    docker image prune -f >/dev/null 2>&1 || true
    rm -f "$FAILED_FILE"
    PENDING_ARGS=(--data-urlencode "pending_changes_sent=1")
    report updated "Updated $CURRENT_TAG -> $target_tag." "$CURRENT_TAG" "$target_tag"
    return 0
  fi

  log "$target_tag did not come up healthy; rolling back to $CURRENT_TAG"
  echo "$target_tag" >"$FAILED_FILE"
  deploy "$CURRENT_COMMIT" "$CURRENT_TAG" || log "redeploying $CURRENT_TAG failed"
  if wait_healthy "$CURRENT_COMMIT"; then
    report rolled_back "$target_tag did not pass its health check; rolled back to $CURRENT_TAG. The pre-update backup is in backups/." "$CURRENT_TAG" "$target_tag"
  else
    log "rollback did not come up healthy either"
    report failed "$target_tag failed its health check and the rollback to $CURRENT_TAG did not come up either. Check 'docker compose logs backend'. The pre-update backup is in backups/." "$CURRENT_TAG" "$target_tag" || true
  fi
  return 1
}

log() { echo "resolvd-update: $*"; }

# Read KEY from .env without sourcing it (values may hold shell syntax).
env_get() {
  [ -f "$DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$DIR/.env" | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# Set KEY=value in .env, replacing an existing line or appending one.
env_set() {
  if grep -q "^$1=" "$DIR/.env"; then
    sed -i "s|^$1=.*|$1=$2|" "$DIR/.env"
  else
    printf '%s=%s\n' "$1" "$2" >>"$DIR/.env"
  fi
}

policy_get() { sed -n "s/^$1=//p" | head -n1; }

# report STATUS MESSAGE [PREVIOUS_VERSION TARGET_VERSION]
report() {
  local status="$1" message="$2"
  log "$status: $message"
  curl -fsS -m 20 -o /dev/null -H "Authorization: Bearer $TOKEN" \
    --data-urlencode "status=$status" \
    --data-urlencode "message=$message" \
    --data-urlencode "channel=$CHANNEL" \
    --data-urlencode "previous_version=${3:-}" \
    --data-urlencode "target_version=${4:-}" \
    --data-urlencode "current_version=$(env_get RESOLVD_IMAGE_TAG)" \
    --data-urlencode "current_commit=$(git rev-parse --short HEAD)" \
    --data-urlencode "available_version=${AVAILABLE:-}" \
    --data-urlencode "host_time=$(date -Iseconds)" \
    --data-urlencode "host_tz=$(date +%Z)" \
    --data-urlencode "handled_request=$HANDLED" \
    ${PENDING_ARGS[@]+"${PENDING_ARGS[@]}"} \
    "$URL/api/system-updates/report" || log "could not send the report to $URL"
}

# Change files the target commit adds over the running one, as report
# fields ("<name>\n<contents>"). Nothing when the target isn't newer.
# Stops at ~30 KB of text (up to 3x that once URL-encoded) so the report
# stays under the app's 100 KB form limit;
# pending_changes_total still counts every file.
collect_pending() {
  PENDING_ARGS=(--data-urlencode "pending_changes_sent=1")
  git merge-base --is-ancestor "$CURRENT_COMMIT" "$1" 2>/dev/null || return 0
  local files f body size=0 total=0
  files="$(git diff --no-renames --name-only --diff-filter=A "$CURRENT_COMMIT" "$1" -- backend/changes/ \
    | grep '\.md$' | grep -vi '/readme\.md$' || true)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    total=$((total + 1))
    [ "$size" -lt 30000 ] || continue
    body="$(git show "$1:$f" 2>/dev/null | head -c 2000)"
    size=$((size + ${#body}))
    PENDING_ARGS+=(--data-urlencode "pending_change=$(basename "$f" .md)
$body")
  done <<<"$files"
  PENDING_ARGS+=(--data-urlencode "pending_changes_total=$total")
}

# Gzipped pg_dump into backups/, keeping the newest 7 pre-update dumps.
backup() {
  mkdir -p "$DIR/backups"
  local file
  file="$DIR/backups/pre-update-$(date +%Y%m%d-%H%M%S)-$1.sql.gz"
  if ! docker compose exec -T postgres pg_dump -U resolvd resolvd | gzip >"$file"; then
    rm -f "$file"
    return 1
  fi
  ls -1t "$DIR"/backups/pre-update-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
  log "database backed up to $file"
}

deploy() {
  git checkout --quiet --detach "$1"
  env_set RESOLVD_IMAGE_TAG "$2"
  docker compose up -d --remove-orphans
}

# Healthy = the backend answers /api/version with the expected commit.
wait_healthy() {
  local want="$1" deadline=$((SECONDS + HEALTH_TIMEOUT)) body
  while [ "$SECONDS" -lt "$deadline" ]; do
    if body="$(curl -fsS -m 5 "$URL/api/version" 2>/dev/null)" && [[ "$body" == *"\"commit\":\"$want"* ]]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

main "$@"; exit $?
