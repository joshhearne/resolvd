#!/usr/bin/env bash
# Installs the Resolvd host updater (systemd timer) for this checkout.
#
#   sudo deploy/install-updater.sh            # run as the checkout's owner
#   sudo deploy/install-updater.sh --user ops # or a specific user
#
# The updater runs as that user, which must be able to use Docker (member
# of the docker group). It never runs inside a container, and the
# containers never get Docker access.
#
# It first checks that the images for RESOLVD_IMAGE_TAG (default: stable)
# can be pulled, and changes nothing if they can't. Then it adds the shared
# token to .env, starts the stack on those images, and enables the timer.
#
# Re-running is safe: it keeps an existing RESOLVD_UPDATER_TOKEN.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${RESOLVD_UNIT_DIR:-/etc/systemd/system}"
RUN_USER="$(stat -c %U "$DIR")"
if [ "${1:-}" = "--user" ] && [ -n "${2:-}" ]; then RUN_USER="$2"; fi

if [ "$(id -u)" != 0 ]; then
  echo "Run with sudo: it installs systemd units." >&2
  exit 1
fi
if [ "$RUN_USER" != root ] && ! id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "User '$RUN_USER' isn't in the docker group. Add it (sudo usermod -aG docker $RUN_USER) or pass --user." >&2
  exit 1
fi
if [ ! -f "$DIR/.env" ]; then
  echo "No $DIR/.env yet. Set up the stack first (see README → Running on a VPS)." >&2
  exit 1
fi

# Read KEY from .env without sourcing it, as resolvd-update.sh does.
env_get() {
  sed -n "s/^$1=//p" "$DIR/.env" | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
# Run as the updater's user from the checkout (git and docker see the same
# ownership and permissions the timer will).
as_user() { (cd "$DIR" && sudo -u "$RUN_USER" env "$@"); }

# The stack must be able to run the published images before the updater can
# manage it, so check them first and change nothing if they're missing.
TAG="$(env_get RESOLVD_IMAGE_TAG)"
TAG="${TAG:-stable}"
echo "Checking the images for RESOLVD_IMAGE_TAG=$TAG ..."
if ! as_user RESOLVD_IMAGE_TAG="$TAG" docker compose pull --quiet backend frontend; then
  {
    echo
    echo "The images for '$TAG' can't be pulled, so nothing was changed."
    if [ "$TAG" = stable ]; then
      echo ":stable is published with the first release (a vX.Y.Z tag on main)."
    fi
    commit="$(as_user git rev-parse --short=7 HEAD 2>/dev/null || true)"
    if [ -n "$commit" ] && as_user RESOLVD_IMAGE_TAG="dev-$commit" docker compose pull --quiet backend frontend >/dev/null 2>&1; then
      echo "This checkout's commit has published images. To run them (Development"
      echo "channel), add this line to $DIR/.env and run the installer again:"
      echo "  RESOLVD_IMAGE_TAG=dev-$commit"
    else
      echo "Set RESOLVD_IMAGE_TAG in $DIR/.env to a published build, check out the"
      echo "matching commit, and run the installer again:"
      echo "  RESOLVD_IMAGE_TAG=v1.2.3       a release (git checkout v1.2.3)"
      echo "  RESOLVD_IMAGE_TAG=dev-<sha7>   a commit merged to dev (git checkout <sha>)"
    fi
  } >&2
  exit 1
fi

# Shared secret between the host updater and the app.
if ! grep -q '^RESOLVD_UPDATER_TOKEN=.' "$DIR/.env"; then
  sed -i '/^RESOLVD_UPDATER_TOKEN=/d' "$DIR/.env"
  printf 'RESOLVD_UPDATER_TOKEN=%s\n' "$(openssl rand -hex 32)" >>"$DIR/.env"
  echo "Added RESOLVD_UPDATER_TOKEN to .env"
fi

for unit in resolvd-update.service resolvd-update.timer; do
  sed -e "s|@DIR@|$DIR|g" -e "s|@USER@|$RUN_USER|g" "$DIR/deploy/$unit" >"$UNIT_DIR/$unit"
done

# Start the stack on the published images. The backend also picks up the
# token from .env here.
as_user docker compose up -d

systemctl daemon-reload
systemctl enable --now resolvd-update.timer
echo
echo "Installed, running $TAG. Pick a channel in Admin → System health → Updates."
echo "Logs: journalctl -u resolvd-update.service"
systemctl list-timers resolvd-update.timer --no-pager || true
