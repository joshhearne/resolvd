#!/usr/bin/env bash
# Wrapper around `docker compose build` that stamps APP_VERSION /
# APP_COMMIT / BUILT_AT into the backend image so /api/version + the
# Admin → System health "Build info" card report something useful.
#
# Usage:
#   ./scripts/build-with-version.sh                  # build all services
#   ./scripts/build-with-version.sh backend          # one service
#
# Falls back to "dev" / "unknown" when run outside a git checkout.

set -euo pipefail

cd "$(dirname "$0")/.."

if git rev-parse --git-dir >/dev/null 2>&1; then
  APP_VERSION="${APP_VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
  APP_COMMIT="${APP_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
else
  APP_VERSION="${APP_VERSION:-dev}"
  APP_COMMIT="${APP_COMMIT:-unknown}"
fi
BUILT_AT="${BUILT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

export APP_VERSION APP_COMMIT BUILT_AT

echo "Building with APP_VERSION=$APP_VERSION APP_COMMIT=$APP_COMMIT BUILT_AT=$BUILT_AT"
exec docker compose build "$@"
