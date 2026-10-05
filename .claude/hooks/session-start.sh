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

# --ignore-scripts skips the Electron/native rebuilds and the `yarn lint:fix` postinstall,
# which would rewrite files. Enough for `yarn lint`; not enough for `yarn dev`/`yarn build`.
yarn install --frozen-lockfile --ignore-scripts --ignore-engines 1>&2
