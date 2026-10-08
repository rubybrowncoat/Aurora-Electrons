# The move to electron-vite and Electron 44

The `refactor/modern-stack` branch replaces the Nuxt 2 and webpack 4 build with electron-vite, and moves the app from Electron 16 to Electron 44. It had two goals: the portable exe had to start faster, and the stack had to be one that still gets updates. The single exe still works the same way for users. They drop it into their Aurora folder, and it reads `AuroraDB.db` from beside it.

This page explains why startup was slow, what each step changed, what was measured, and what is left for a later decision.

## Why the portable exe started slowly

On Windows, electron-builder's `portable` target is an NSIS exe. On every launch it extracts the whole app into `%TEMP%`, runs it, and deletes it afterwards. Its template deletes the old folder before extracting, so `unpackDirName` doesn't help.

Version 0.10.1 packaged with `asar: false`, and its renderer loaded the packages in `dependencies` from `node_modules` at runtime instead of bundling them. Every file of pixi, cytoscape, moment, Sequelize and even `node-gyp` shipped, and the package held 7,551 files (304 MB), 7,399 of them under `node_modules`. The exe extracted all of them on every launch, and it took 49 to 118 s to show a window.

File count was the problem more than size. A test build of the same 0.10.1 files, packed into one `app.asar`, made an exe of the same 78 MB with 76 files in it, and showed its window in 6.7 to 8.3 s. So the fix was to bundle what the window needs and to pack the app into an asar. The Nuxt 2 template was also what held Electron at 16, so the build tooling had to change before Electron could move.

## The steps

The plan had four steps:

1. Turn on asar and bundle the dependencies on the old stack. It was skipped as a step of its own, because steps 2 and 3 do the same work.
2. Replace the build tooling. Done in `b0ae960`.
3. Upgrade Electron, electron-builder and sqlite3, and turn on asar. Done in `7883610`.
4. Optional, for a later decision: see "Step 4" below.

### Step 2: electron-vite and Vite instead of Nuxt 2 and webpack 4

- electron-vite 5 on Vite 7 builds the main process, a new preload script and the renderer into `out/`. Nuxt, webpack 4, node-sass (replaced by `sass`), the `@xpda-dev` packages and the electron-nuxt template are gone. The project's own scripts moved from `.electron-nuxt/` to `scripts/`.
- The renderer starts from `src/renderer/index.html` and `src/renderer/main.js`. `src/renderer/app/router.js` makes a route of each file in `pages/`, and `src/renderer/app/store.js` loads each file in `store/` as a Vuex module, as Nuxt did.
- Vite bundles everything the renderer uses. Only Sequelize and sqlite3 stay in `dependencies` and ship as node modules.
- The window no longer has Node integration. `src/preload/index.js` hands Electron's `ipcRenderer` and `shell`, Sequelize, chokidar and electron-store to the page as `window.__aurora`, and `src/renderer/bridge/` re-exports them under their usual import names. Context isolation stays off, so the page gets the real objects.
- `yarn web` and `yarn electron:smoke` build the renderer from the app's own Vite config (`scripts/renderer-config.mjs`). Web mode swaps the bridge for the shims in `scripts/web/shims/`.
- Sentry moved from `@nuxtjs/sentry` to `@sentry/vue`, set up in `src/renderer/main.js`.

### Step 3: Electron 44, electron-builder 26, sqlite3 6 and an asar

- `src/main/boot.js` serves the built renderer through `protocol.handle` and `net.fetch`, which replaced `protocol.registerFileProtocol`. It loads electron-devtools-installer 4 with a dynamic `import()`, only under `yarn dev`.
- `builder.config.js` sets `asar: true`. electron-builder unpacks sqlite3, which holds a native binary, into `app.asar.unpacked`.
- sqlite3 6 ships an N-API binary that Electron loads as installed, so the build still doesn't rebuild native modules. `scripts/check-native.js` checks for the binary before and after packaging.
- electron-store went from 8 to 11. It is ESM-only now, which doesn't matter because the preload bundles it.

| Package | 0.10.1 | Now |
|---|---|---|
| Electron | 16 | 44.7.0 |
| electron-builder | 22.14 | 26.15.3 |
| Build tooling | Nuxt 2.15, webpack 4, node-sass | electron-vite 5.0.0, Vite 7.3.7, sass |
| sqlite3 | 5.1.5 | 6.0.1 |
| electron-store | 8 | 11.0.2 |
| Sentry | `@nuxtjs/sentry` 7 | `@sentry/vue` 11.5.0 |
| Node for development | `>=20.17` (`.nvmrc` 20) | `>=22.12` (`.nvmrc` 24) |
| Vue, Vuetify, Vuex, vue-router | 2.7, 2.7, 3.6, 3.6 | unchanged |
| Sequelize, pixi.js | 6.37, 6.5 | unchanged |

Vite 7 is pinned on purpose. electron-vite 5 and `@vitejs/plugin-vue2` both stop at Vite 7.

## Startup measurements

Each run used a fresh `--user-data-dir` and the sample save. The portable exe ran from `%TEMP%` with `AuroraDB.db` beside it. A throwaway script timed the launch over the Chrome DevTools Protocol: "window" is when the renderer page exists, and "list" is when "Aurelian Empire" shows on the Empires page. The baseline's unpacked times used the window title instead.

| Build | Exe | Package | Portable: window | Portable: list | Unpacked: window, list |
|---|---|---|---|---|---|
| 0.10.1 (Nuxt, Electron 16, no asar) | 78 MB | 7,551 files, 304 MB | 49–118 s | not measured | 1.2–1.9 s, 2.0–2.8 s |
| Test: 0.10.1 packed into an asar | 78 MB | 76 files | 6.7–8.3 s | not measured | not measured |
| Step 2 (Vite, Electron 16, no asar) | 64.6 MB | app folder 3,119 files, 42 MB | 18.3–24.6 s | 20.5–29.0 s | 0.5 s, 2.4–2.8 s |
| Step 3 (Vite, Electron 44, asar) | 110.7 MB | 90 files, 407 MB, `app.asar` 33.7 MB | 9.3–9.9 s | 10.6–11.5 s | 0.4 s, 1.3–1.4 s |

The unpacked times are warm runs. The first unpacked run after a build was slower: 5.0 s and 7.4 s for step 2, 2.0 s and 3.4 s for step 3.

The portable exe now starts in about 10 s instead of one to two minutes, and the unpacked app shows the race list about twice as fast as before. The portable window takes about 9 s longer than the unpacked one, and that difference is the extraction. Electron 44's own files are most of what gets extracted: `Aurora Electrons.exe` is 234.9 MB, `dxcompiler.dll` 24.6 MB, `LICENSES.chromium.html` 19.5 MB, `resources.pak` 11.9 MB, `icudtl.dat` 10.4 MB, and the 55 locale files 49 MB. Electron 44's runtime is larger than Electron 16's, which is why the exe grew from 78 MB to 110.7 MB, and why step 3 starts a little slower than the asar test on Electron 16.

## Why the Vite commands run from a junction

Vite cuts module ids at `#`, as it would cut a URL at its fragment. A checkout inside Aurora's own `Aurora C#` folder has a `#` in its path, and there Vite builds empty modules and its dev client gets a 404.

`scripts/run-vite.js` works around it. When the project path contains `#`, it creates or repoints a directory junction, `%TEMP%\aurora-electrons-<hash>`, that leads back to the project. Then it re-runs the command from the junction with Node's `--preserve-symlinks`. The Vite configs set `resolve.preserveSymlinks` too, so neither the project's files nor Vite's own see the `#`. A junction needs no admin rights on Windows. `yarn dev`, `yarn build`, `yarn web` and `yarn electron:smoke` all go through it, and on a path without `#` it runs the command in place.

## What behaves differently

- Development needs Node 22.12 or newer. `scripts/check-engines.js` stops `yarn install` and the Vite commands on older versions. With nvm, run `nvm use 24`.
- Sentry reports only from packaged builds (`import.meta.env.MODE === 'production'`). `yarn dev` used to report too. `yarn dev`, `yarn web` and the smoke tests now never do.
- `yarn dev` lost its Ctrl/Cmd+E "Relaunch electron" menu item. electron-vite's `--watch` restarts Electron when a file under `src/main` or `src/preload` changes. Dev keeps Electron's default menu, and packaged builds still have none.
- Dev runs keep their settings and Empire History in `%APPDATA%\aurora-electrons-new`, the `name` in `package.json`, instead of `%APPDATA%\Electron`. The old dev settings don't carry over. Packaged builds are unaffected.
- `webSecurity` is on in development too, as it always was in packaged builds.
- Roboto and the Material Design Icons load from the bundle (`roboto-fontface`, `@mdi/font`) instead of Google Fonts and jsDelivr.
- electron-devtools-installer 4 logs Electron deprecation warnings for `session.loadExtension` and `session.getAllExtensions` when `yarn dev` installs Vue devtools. They come from the library, not from this app.

## Smaller follow-ups

Neither change below has been measured.

- `electronLanguages: ['en-US']` in `builder.config.js` would package one locale file instead of 55, and leave out 48 of the 49 MB they take.
- The package carries all of sqlite3, including files only its install needs: `deps/sqlite-autoconf-3520000.tar.gz` (3.1 MB), `src/`, and the `tar` (2.0 MB) and `node-gyp` (1.7 MB) packages. Excluding them in `files` would shrink the package. A build would then need to check that the sqlite3 binary still loads.

## Step 4: options for a later decision

None of these affects startup. They are about how long the stack stays maintainable.

### Vue 3, Vuetify 3 or 4, and Pinia

This is the large one. Vue 2 has been out of support since 2023-12-31. For an offline tool that reads a local save, that is a maintenance cost more than a security risk, but every Vue 2 library will eventually stop getting updates.

The move touches every page and most components. At `7883610`, `src/renderer` has 22 pages and 23,299 lines of `.vue`, with:

- 187 `dense` props and 225 `text--*` classes, which Vuetify 3 replaced,
- 34 `v-data-table`s with 142 `item.*` slot templates, which Vuetify 3's data table names and shapes differently,
- 49 `v-expansion-panel-header`s, renamed to `v-expansion-panel-title`,
- 35 reads of `$vuetify.theme.dark` and 30 `.sync` modifiers, both gone in Vue 3 and Vuetify 3,
- a Vuex store with 9 namespaced modules, which can stay on Vuex 4 or move to Pinia.

The `asyncComputed` blocks in 22 files can stay: the installed vue-async-computed 4.0.1 already names Vue 3 as its peer. The counts come from these commands, run in `src/renderer`:

```bash
git grep -o -E '\bdense\b' -- '*.vue' | wc -l
git grep -o -E 'text--[a-z]' -- '*.vue' | wc -l
git grep -o -E '<v-data-table' -- '*.vue' | wc -l
git grep -o -E '<template (v-slot:|#)\[?`?item\.' -- '*.vue' | wc -l
git grep -o -E '<v-expansion-panel-header' -- '*.vue' | wc -l
git grep -o -E 'vuetify\.theme\.dark' -- '*.vue' '*.js' | wc -l
git grep -o -E '\.sync=' -- '*.vue' | wc -l
git grep -l asyncComputed -- '*.vue' '*.js' | wc -l
```

The work can happen page by page only with the Vue 3 migration build (`@vue/compat`), and Vuetify 2 doesn't run on it. In practice, Vuetify forces one large switch.

### Sequelize to a thin query layer

This is medium-sized. The app uses Sequelize mostly as a way to run SQL: 136 raw `query()` calls in 26 files, 18 model finder calls (`findAll`, `findOne`, `findByPk`, `findAndCountAll`), and one write, the map's `UPDATE FCT_RaceSysSurvey` in `pages/map.vue`. `utilities/database.js` defines 23 models in 1,034 lines, and it reaches into Sequelize's `connectionManager` to queue queries and to interrupt the one that runs too long.

A small module over sqlite3 could keep the `query(sql, { replacements })` shape that pages use and own the connection directly. Three things would follow:

- The package loses Sequelize and its dependencies. Sequelize, moment, moment-timezone and validator take 10.1 MB of the 33.7 MB `app.asar`.
- The query queue and the timeout no longer depend on Sequelize's internals.
- The database can move to the main process behind IPC. The preload would then pass only data, and the window could turn context isolation on. That is the remaining gap in the window's isolation, and the reason the preload shares the page's JavaScript world today.

The 18 model calls and the models' associations would turn into SQL. The 136 raw queries would carry over with small changes.

### Pixi 8

Not worth it. Only `components/SystemView.vue` uses pixi.js, and v8 breaks the `settings`, `generateTexture`, Graphics and Text calls it makes. Nothing in the app needs what v8 adds.

### If 10 seconds is still too slow

An Electron app can't run as one exe without extracting its runtime first, so the follow-ups above are the last cheap gains. Two larger choices remain:

- Ship a zip, or an installer, instead of the portable exe. The unpacked app shows the race list in about 1.4 s, but users would no longer drop one file into their Aurora folder.
- Move to Tauri. Its single exe is about 10 to 20 MB, uses the WebView2 that Windows 10 and 11 already have, and doesn't extract anything. The Vue code would carry over. The database access, save watcher, flags, PNG export and settings would have to be rewritten as Rust commands, which is a rewrite of the back end, not an upgrade.

### Recommendation

Do the Sequelize layer first, if anything. It is the smaller job, it shrinks the package, and it is what context isolation waits on. Leave Vue 3 until something concrete forces it, such as a dependency that drops Vue 2, or a Chromium change that breaks Vuetify 2. When that happens, plan it as one switch, not a gradual move. Leave Pixi 6 as it is.
