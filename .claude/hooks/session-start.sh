#!/bin/bash
# Cloud-session bootstrap: sample save + lint-ready node_modules.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# The app reads ./AuroraDB.db in dev; keep any existing copy (it may hold local edits).
if [ ! -f AuroraDB.db ]; then
  unzip -o -q fixtures/AuroraDB.zip AuroraDB.db -d .
  echo "Extracted sample AuroraDB.db from fixtures/AuroraDB.zip"
fi

# The project installs with bun (bun.lock); fetch it if the container lacks it.
if ! command -v bun >/dev/null 2>&1; then
  npm install -g bun 1>&2
fi

# --ignore-scripts skips the preinstall check and the Electron rebuild (postinstall).
# Enough for `bun run lint` and `bun run web`; not enough for `bun run dev`/`bun run build`.
bun install --frozen-lockfile --ignore-scripts 1>&2

# Web mode (`bun run web`) runs Sequelize in Node, so fetch sqlite3's prebuilt Node binary if bun didn't.
if ! ls node_modules/sqlite3/build/Release/node_sqlite3.node >/dev/null 2>&1; then
  (cd node_modules/sqlite3 && ../.bin/prebuild-install -r napi) 1>&2
fi
