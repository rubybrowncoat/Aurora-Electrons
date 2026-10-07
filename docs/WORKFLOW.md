# Workflow

## Local setup

1. Install Node 20 (`.nvmrc`; `>=20.17` is enforced) and Yarn 1. npm is rejected by the preinstall check.
2. Run `yarn install`. The `postinstall` script rebuilds native modules (sqlite3) for Electron and also runs `yarn lint:fix` across `src/`. After installing, check `git status` and drop any unrelated rewrites.
3. Put a save at the repo root as `AuroraDB.db`. Either:
   - extract the sample: `unzip fixtures/AuroraDB.zip` (this creates `./AuroraDB.db`), or
   - copy or symlink a real save from your Aurora install, or set `headGame` in `src/main/index.js` to read `../AuroraDB.db`.

   `AuroraDB*.db` is git-ignored. Never commit a save.
4. Run `yarn dev`. Nuxt serves the renderer on `:9080`, and Electron opens with devtools. Ctrl/Cmd+E relaunches Electron, and closing its window stops `yarn dev`. The app watches the save, so saving in Aurora, or replacing the file, reloads every view. If port 9080 is taken, `yarn dev` stops with an error; free it, or run with `PORT=<free port>`. Dev runs keep their settings and history in `%APPDATA%\Electron` (the unpackaged app's name), apart from the installed app's.

## Cloud sessions (Claude Code on the web)

`.claude/hooks/session-start.sh` runs at session start, and only when `CLAUDE_CODE_REMOTE=true`. It does three things:

- extracts `fixtures/AuroraDB.zip` to `./AuroraDB.db` if that file is missing,
- runs `yarn install --frozen-lockfile --ignore-scripts --ignore-engines`, and
- fetches sqlite3's prebuilt Node binary if it's missing.

`--ignore-scripts` skips the Electron and native rebuilds and the `lint:fix` postinstall. Lint and web mode work afterwards, but `yarn dev` and `yarn build` don't. In the cloud, verification means lint, SQL against the sample, and web mode.

## Web mode

`yarn web` serves the renderer as a plain browser app on `http://localhost:9080`, with no Electron involved:

- `.electron-nuxt/web.js` builds the Nuxt renderer for a `web` webpack target. Electron bundles nothing from `dependencies`, but web mode bundles all of them.
- Node and Electron modules are swapped for the shims in `.electron-nuxt/web/shims/`:
  - `electron` answers the `request-storage-path` and `save-png` IPC calls; PNG export becomes a browser download.
  - `electron-store` persists to `localStorage`, one key per store (`aurora-electrons:config` for settings, `aurora-electrons:history/game-<GameID>` for each game's Empire History). Clear them in the browser's devtools to start fresh.
  - `chokidar` polls the database file's mtime, so replacing `./AuroraDB.db` still reloads the views.
  - `sequelize` exports only `Op` and `QueryTypes`.
  - `utilities/database.js` is replaced by a proxy that forwards `query()` and read-only `findAll`/`findOne`/`findByPk`/`count`/`findAndCountAll` calls to the dev server.
- `.electron-nuxt/web/database-middleware.js` handles those calls at `/__aurora-db/*`. It runs the **real** models from `src/renderer/utilities/database.js` against `./AuroraDB.db`; set `AURORA_DB=path/to/save.db` to use another file. Because it executes raw SQL, the server listens on localhost only, and the middleware answers only the web-mode page. Requests need a `localhost` Host header, a same-origin Origin, a JSON body, and the per-run token from the page's `aurora-web-token` meta tag, sent as `X-Aurora-Web-Token`. To call it with curl, read the token from the page first.
- Sentry is disabled in web mode, and so is Nuxt's `/__open-in-editor` dev endpoint, which would otherwise answer any origin.
- Web mode transpiles `chart.js` (and `@kurkle/color`), because webpack 4 can't parse their static class fields. Electron loads them through Node, which can.

With `yarn web` running, `yarn web:smoke` drives Chromium through Playwright, a pinned dev dependency. Locally, run `npx playwright install chromium` once to download the browser; cloud containers already provide it. It selects the sample race, visits every tab plus settings, prints `ok`/`FAIL` per page with console errors, page errors, and failed database calls, and saves a screenshot of each page. You can configure it with these environment variables:

- `SMOKE_PAGES=/,/map` limits the run to those routes. Add `/engines` to include the hidden WIP page.
- `SMOKE_OUT=dir` sets where screenshots go. The default is a temporary directory.
- `AURORA_GAME` and `AURORA_RACE` select a different game and race.

Fonts and icons load from Google Fonts and jsDelivr. In the cloud those requests can fail, and the script reports them as notes rather than failures.

`yarn web` stops at startup if sqlite3 can't load, and prints the command that fetches its binary. Any `yarn install` that relinks sqlite3 removes the binary, because `--ignore-scripts` skips its download. If port 9080 is taken (another `yarn web`, or `yarn dev`), Nuxt falls back to a random port. `yarn web` then prints the real URL, which you pass to the smoke test as `BASE_URL`.

Limits: web mode doesn't run main-process code (IPC handlers, storage-path resolution, the window, packaging). Writes still happen: map → Save Positions updates `./AuroraDB.db`. Re-extract the fixture to reset it.

## Electron smoke test

`yarn electron:smoke` drives the real Electron app, so it covers what web mode can't: the main process, the storage-path IPC, electron-store's files, the save watcher, and native sqlite3 inside Electron. It needs the full local install (Electron's binary), not the cloud setup. It's self-contained:

- It builds the development main process into `dist/smoke/main` and serves the renderer from its own Nuxt server on a free port, with its own build folder and Sentry off. A running `yarn dev` or `yarn web` is left alone.
- It launches Electron through Playwright on a copy of the save, with `--user-data-dir` pointing at a fresh folder. The run folder, `dist/smoke/run`, keeps the save copy and the user data until the next run.
- It selects the sample race, visits the same pages as `web:smoke`, and saves screenshots. A page fails on console or page errors, main-process errors, failed database calls, or database calls that never go quiet; for those it names the pending, repeated and slowest queries and how long the main thread was blocked.
- Then it checks the app itself: the save loaded through the storage-path IPC, the `read-flag` IPC returns a flag from a `Flags` folder beside the save and refuses names that point outside it, `config.json` sits in user data, `history/game-<GameID>.json` holds snapshots for the race, and rewriting the save makes the watcher reopen the database and record again without adding snapshots for the same save.

It takes about 90 seconds. `SMOKE_PAGES`, `SMOKE_OUT`, `AURORA_GAME` and `AURORA_RACE` work as in `web:smoke`; `AURORA_DB` picks the save to copy. In Git Bash, prefix route lists with `MSYS_NO_PATHCONV=1`, or Bash rewrites `/habitability` into a Windows path.

## Making a change

1. **Find the page.** See the page table in `docs/ARCHITECTURE.md`. Data comes from `asyncComputed` getters, and derived values from `computed`.
2. **Write the query against the sample first.** Open it read-only and run your SQL with the sample's IDs (GameID 140, RaceID 784):

   ```bash
   python3 - <<'EOF'
   import sqlite3
   db = sqlite3.connect('file:AuroraDB.db?mode=ro', uri=True)
   db.row_factory = sqlite3.Row
   rows = db.execute('''
     select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population
     from FCT_Population
     where FCT_Population.GameID = ? and FCT_Population.RaceID = ?
     order by FCT_Population.Population desc limit 5
   ''', (140, 784)).fetchall()
   for row in rows: print(dict(row))
   EOF
   ```

3. **Port it into the component** using the existing pattern:

   ```js
   asyncComputed: {
     things: {
       async get () {
         if (!this.database || !this.GameID || !this.RaceID) {
           return []
         }

         return await this.database.query(`select ... where FCT_X.GameID = ${this.GameID} and FCT_X.RaceID = ${this.RaceID}`).then(([items]) => items)
       },
       default: [],
     },
   },
   ```

   Scope by `GameID` and `RaceID`, and go through the race-knowledge tables so the page doesn't leak spoilers (`docs/DATABASE.md`). Pass user-entered values as Sequelize `replacements`, never by interpolation.
4. **Choose where state lives.** If it must survive a restart, use `this.config.get/set` (electron-store). Use `game.<GameID>.race.<RaceID>.<key>` for per-race keys. If it only needs to last the session, use a Vuex module in `src/renderer/store/`.
5. **For a new page,** add `pages/<name>.vue` and one entry in `PAGES` in `src/renderer/utilities/navigation.js`: `route`, `section` (one of `SECTIONS`, or `null` for a page outside the nav), `tab`, `title`, `icon`, `blurb` and `keywords`. Add `wip: true` for a work in progress, `requiresHistory: true` for a page that needs Empire History, or `hidden: true` to keep it out of the navigation, the palette and the default smoke list. The layout and `smoke-pages.js` pick it up from there.
6. **For a new column or model,** extend `resetDatabase()` in `utilities/database.js`. Map renamed columns with `field:`, and add associations next to the existing ones.

## Verifying

- **Lint what you touched:** `node_modules/.bin/eslint --ext .js,.vue -f ./node_modules/eslint-friendly-formatter <files>`. You can add `--fix` for those files only. The repo-wide baseline isn't clean: at the time of writing, `yarn lint` reports 17 errors and 119 warnings. Don't fix unrelated problems, and don't introduce new ones.
- **SQL:** run the final query against the sample, as above, and sanity-check the counts.
- **UI:** run `yarn web` (in the background), then `yarn web:smoke`, and look at the screenshots. Locally, also run `yarn electron:smoke` when a change touches the main process, settings or history storage, the save watcher, or anything that differs between Electron and the web shims. You can also use `yarn dev` and select "Aurelian Empire" (race 784) in the game picker. Some sample tables are empty (see `docs/DATABASE.md`), so research, shipyard-task, and training views will be blank.
- There is no automated test suite and no CI.

## Dependency updates

Dependabot opens security-update PRs against `master`. Most of them only bump a transitive entry in `yarn.lock`.

- To check one, fetch it with `git fetch origin pull/<n>/head:dependabot-<n>` and merge it into a scratch branch. Then run `yarn install --frozen-lockfile --ignore-scripts --ignore-engines`, re-fetch sqlite3's binary, lint, and run `yarn web` plus `yarn web:smoke`. The per-page row and text counts should match a run on `master`.
- Lockfile PRs can conflict with one another in `yarn.lock`. Don't hand-edit the file. Either run `yarn install` without `--frozen-lockfile` on the conflicted file, which makes yarn merge it, or comment `@dependabot rebase` on the PR.
- An Electron major upgrade is a migration, not a merge. It touches the main process (`enableRemoteModule`/`remote`, `protocol.registerFileProtocol`), electron-builder, electron-devtools-installer, and native modules, and web mode can't test any of that.

## Releasing

1. Bump `version` in `package.json` and commit it, e.g. `👌 0.9.14`.
2. Run `yarn build`. Artifacts land in `build/` as `aurora-electrons-<version>.<ext>`: a Windows portable exe, a Linux deb, and a macOS dmg. The build fails when sqlite3's `node_sqlite3.node` is missing from `node_modules` or from a package; restore it with the command it prints. Don't run `yarn install` or `npm rebuild` while a `yarn web` or `yarn dev` session has the binary loaded: on Windows that leaves it missing.
3. Users place the executable in their Aurora folder, next to `AuroraDB.db`.

## Sample fixture

`fixtures/AuroraDB.zip` contains a single `AuroraDB.db` at the archive root. To replace it:

```bash
zip -j fixtures/AuroraDB.zip path/to/AuroraDB.db
rm -f AuroraDB.db && unzip fixtures/AuroraDB.zip
```

Commit the replacement as `🍱 Update sample AuroraDB fixture`. If its game or race IDs differ from 140/784, update the docs too. `.gitattributes` marks `*.zip` and `*.db` as binary. The repo-wide `* text eol=lf` would otherwise corrupt them.

## Commits and PRs

- **Format:** `<gitmoji> Summary description`. Capitalize the summary, with no trailing period. Prefer one change per commit. An optional body lists additional changes, one `<gitmoji> description` per line.
- **Core gitmoji** (this repo's own usage):

  | Gitmoji | Use for | Example |
  |---|---|---|
  | ✨ | New feature, page, warning, filter | `✨ New terraformation` |
  | 🐛 | Bug fix | `🐛 Fixed ancient constructs orbital populations` |
  | 👌 | Improvement or polish of existing behaviour; version bumps | `👌 Persist log filtering in session` |
  | 🔨 | Refactor, rework, performance, logic adjustment | `🔨 Faster map loading` |

- **Extras** for what the core set doesn't cover: 📝 docs, 🔧 config/tooling, 🍱 assets/fixtures, ⬆️ dependency upgrades.
- **No byline:** no `Co-Authored-By`, `Claude-Session`, or other trailers, and no "Generated with Claude Code" lines, in commit messages or PR descriptions.
- **Author:** `Matsor Browncoat <prunkstation@gmail.com>`. In a fresh container, set it repo-locally before committing:

  ```bash
  git config user.name "Matsor Browncoat" && git config user.email "prunkstation@gmail.com"
  ```

- **Branching:** `master` is the default branch. Work on a feature branch, and open PRs only when asked.

## Delegating to subagents

Claude Code sessions in this repo route delegated work through the tiered subagents in `.claude/agents/`. CLAUDE.md § Subagent Selection Policy covers which agent to use and when to escalate.
