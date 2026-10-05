# Workflow

## Local setup

1. Install Node 20 (`.nvmrc`; `>=20.17` is enforced) and Yarn 1. npm is rejected by the preinstall check.
2. Run `yarn install`. The `postinstall` script rebuilds native modules (sqlite3) for Electron and also runs `yarn lint:fix` across `src/`. After installing, check `git status` and drop any unrelated rewrites.
3. Put a save at the repo root as `AuroraDB.db`. Either:
   - extract the sample: `unzip fixtures/AuroraDB.zip` (this creates `./AuroraDB.db`), or
   - copy or symlink a real save from your Aurora install, or set `headGame` in `src/main/index.js` to read `../AuroraDB.db`.

   `AuroraDB*.db` is git-ignored. Never commit a save.
4. Run `yarn dev`. Nuxt serves the renderer on `:9080`, and Electron opens with devtools. Ctrl/Cmd+E relaunches Electron. The app watches the save, so saving in Aurora, or replacing the file, reloads every view.

## Cloud sessions (Claude Code on the web)

`.claude/hooks/session-start.sh` runs at session start, and only when `CLAUDE_CODE_REMOTE=true`. It does two things:

- extracts `fixtures/AuroraDB.zip` to `./AuroraDB.db` if that file is missing, and
- runs `yarn install --frozen-lockfile --ignore-scripts --ignore-engines`.

`--ignore-scripts` skips the Electron and native rebuilds and the `lint:fix` postinstall. Lint works afterwards, but `yarn dev` and `yarn build` don't, and there's no display anyway. In the cloud, verification therefore means lint plus running SQL against the sample. State clearly when UI behaviour hasn't been checked at runtime.

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
5. **For a new page,** add `pages/<name>.vue`, a `<v-tab to="/<name>" nuxt>` entry, and a `title()` case in `layouts/default.vue`.
6. **For a new column or model,** extend `resetDatabase()` in `utilities/database.js`. Map renamed columns with `field:`, and add associations next to the existing ones.

## Verifying

- **Lint what you touched:** `node_modules/.bin/eslint --ext .js,.vue -f ./node_modules/eslint-friendly-formatter <files>`. You can add `--fix` for those files only. The repo-wide baseline isn't clean: at the time of writing, `yarn lint` reports 17 errors and 119 warnings. Don't fix unrelated problems, and don't introduce new ones.
- **SQL:** run the final query against the sample, as above, and sanity-check the counts.
- **UI:** run `yarn dev` locally, select "Aurelian Empire" (race 784) in the sidebar, and exercise the page. Some sample tables are empty (see `docs/DATABASE.md`), so research, shipyard-task, and training views will be blank.
- There is no automated test suite and no CI.

## Releasing

1. Bump `version` in `package.json` and commit it, e.g. `👌 0.9.14`.
2. Run `yarn build`. Artifacts land in `build/` as `aurora-electrons-<version>.<ext>`: a Windows portable exe, a Linux deb, and a macOS dmg.
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
