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
# Re-running is safe: it keeps an existing RESOLVD_UPDATER_TOKEN.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

# Shared secret between the host updater and the app.
if ! grep -q '^RESOLVD_UPDATER_TOKEN=.' "$DIR/.env"; then
  sed -i '/^RESOLVD_UPDATER_TOKEN=/d' "$DIR/.env"
  printf 'RESOLVD_UPDATER_TOKEN=%s\n' "$(openssl rand -hex 32)" >>"$DIR/.env"
  echo "Added RESOLVD_UPDATER_TOKEN to .env"
fi

for unit in resolvd-update.service resolvd-update.timer; do
  sed -e "s|@DIR@|$DIR|g" -e "s|@USER@|$RUN_USER|g" "$DIR/deploy/$unit" >"/etc/systemd/system/$unit"
done

# The backend reads the token from .env; recreate it so it picks it up.
(cd "$DIR" && sudo -u "$RUN_USER" docker compose up -d backend)

systemctl daemon-reload
systemctl enable --now resolvd-update.timer
echo
echo "Installed. Pick a channel in Admin → System health → Updates."
echo "Logs: journalctl -u resolvd-update.service"
systemctl list-timers resolvd-update.timer --no-pager || true
