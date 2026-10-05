# Architecture

Aurora Electrons is an Electron desktop app whose renderer is a Nuxt 2 single-page app. It reads the save database of Aurora (C#), `AuroraDB.db`, and presents dashboards for one selected game and race.

## Stack

| Concern | Library |
|---|---|
| Shell | Electron 16, packaged with electron-builder 22 |
| Renderer | Nuxt 2.15 (`ssr: false`, `target: 'static'`, hash router), Vue 2, Vuetify 2, Vuex 3 |
| Data | Sequelize 6 over `sqlite3` 5.1.5, mostly raw SQL |
| Async data in components | `vue-async-computed` (`asyncComputed` blocks) |
| Preferences | `electron-store` 8 |
| File watching | `chokidar` 4 |
| Galaxy map | `cytoscape` with cola, cose-bilkent, fcose, cxtmenu, layout-utilities, and navigator plugins |
| System view | `pixi.js` 6, `pixi-viewport`, `@timohausmann/quadtree-js` |
| Charts | `chart.js` 4, through `components/charts/ChartCanvas.vue` |
| Misc | `dayjs` (UTC), `lodash`, `d3-color`/`d3-interpolate`, `color-hash`, `romanum` |
| Error reporting | `@nuxtjs/sentry`, with the DSN in `src/renderer/nuxt.config.js` |

Node `>=20.17` (`.nvmrc`: 20) and Yarn 1 are enforced by `.electron-nuxt/check-engines.js`.

## Build pipeline (`.electron-nuxt/`)

Most of this directory is the electron-nuxt template's tooling; treat that part as vendored unless a change needs it. `web.js` and `web/` are this project's own.

- `yarn dev` runs `dev.js` and then `index.js` with `NODE_ENV=development`. It does three things:
  - webpack builds the main process from `src/main/boot/index.dev.js` into `dist/main/index.js`.
  - A forked Nuxt process (`renderer/nuxt-process.js`) builds the renderer and serves it at `http://localhost:9080`.
  - Electron launches, and relaunches whenever the main bundle rebuilds.
- `yarn build` runs `build.js` and then `index.js` with `NODE_ENV=production`. It differs from dev in two ways:
  - The main process builds from `src/main/boot/index.prod.js`.
  - Nuxt *generates* static files into `dist/renderer`, which the app serves over a custom `app://` protocol.
  
  electron-builder then packages the app using `builder.config.js`: a Windows portable exe with `splash.bmp`, a Linux deb, and a macOS dmg. It runs with `asar: false` and writes to `build/`.
- `yarn web` runs `web.js`, which builds the same renderer for a plain browser and uses the shims and database middleware in `web/`. See "Web mode" in `docs/WORKFLOW.md`.
- `renderer/nuxt.config.js` merges the base config into `src/renderer/nuxt.config.js`. The base config sets `srcDir`, the hash router, and the generate dir, plus an `electron-renderer` webpack target with `dependencies` left external.

## Main process (`src/main/`)

- `index.js` registers two IPC handlers:
  - `request-storage-path` resolves where the save lives:
    - Packaged on Windows portable: `PORTABLE_EXECUTABLE_DIR/AuroraDB.db`.
    - Packaged elsewhere: next to the executable. On macOS that's next to the `.app` bundle.
    - Dev: `./AuroraDB.db`, relative to the working directory, which is the repo root. Set `headGame` to `true` to read `../AuroraDB.db` instead, which is useful when the repo is checked out inside the Aurora install folder.
    
    In practice, users drop the exe into their Aurora folder.
  - `save-png` opens a save dialog and writes the base64 PNG that the map exports.
- `mainWindow.js` and `BrowserWinHandler.js` create a 1200×800 window with `nodeIntegration: true` and `contextIsolation: false`, so the renderer `require`s Node modules (sqlite3, chokidar, electron-store) directly. `webSecurity` is enabled only in production.
- `boot/index.dev.js` opens devtools, installs Vue devtools, and adds a "Relaunch electron" menu item (Ctrl/Cmd+E). `boot/index.prod.js` registers the `app://` protocol and removes the menu.

## Renderer (`src/renderer/`)

### Data flow

1. The `plugins/database.js` plugin is client-only. It asks the main process for the storage path, then watches that file with chokidar (`awaitWriteFinish`).
2. When the file is added or changes, it dispatches the root `renew` action. That action calls `resetDatabase(storagePath)` from `utilities/database.js`, which builds a **new** Sequelize instance with every model and association, and stores it as `database`.
3. Every page reads data in `asyncComputed` getters that depend on `database`, `GameID`, and `RaceID`. Saving the game in Aurora therefore swaps the `database` instance and refreshes every open view automatically.
4. The sidebar in `layouts/default.vue` lists games with their races. It shows only player races unless the `spyNPR` setting is on. Clicking a game with a single race selects that race automatically. Otherwise the user picks one, and `changeGame` sets `GameID`, `RaceID`, `StartYear`, `GameTime`, and `CivilianShippingLinesActive`.

If there's no `AuroraDB.db` at the resolved path, `database` stays `null`, the game list is empty, and pages show "Select a race from the left-side menu."

### Store (`store/`)

| Module | Holds | Lifetime |
|---|---|---|
| `index.js` | `config` (electron-store instance), `database`, selected `GameID`/`RaceID`, `StartYear`, `GameTime`, `CivilianShippingLinesActive`; actions `renew`, `changeGame` | session |
| `production.js` | Production-recap type filters | session |
| `tables.js` | Habitability/minerals rows-per-page and sort | session |
| `log.js` | Log filters per context key | session |
| `engine.js` | Engine-planner inputs | session |
| `snackbar.js` | Global snackbar | session |

Anything that must survive a restart goes to electron-store through `this.config` instead. That's a `config.json` in Electron's userData directory. Keys in use:

- App-wide: `darkMode`, `spyNPR`, `selectedSeparator`.
- Habitability: `habitabilitySystems`, `habitabilityTerraformers`, and the `habitabilityFilter*` keys (`OwnPopulations`, `OtherPopulations`, `Uninhabited`, `NonTerraformable`, `DoneTerraforming`, `WithoutMinerals`).
- Minerals: `mineralsFilterOrbitalEligibility`.
- Designed tech: `designedTechCategoryId`, `designedTechFilterObsolete`, `designedTechFilterCivilian`, `designedTechFilterCommercial`.
- Per race: `game.<GameID>.race.<RaceID>.maintenanceThreshold` and `.maintenanceExclusions`.

### Pages

Tabs are declared in `layouts/default.vue`. Each page also needs a case in that file's `title()`.

| Route | Tab | File | Shows |
|---|---|---|---|
| `/` | Production | `pages/index.vue` | Production recap: research projects and queues, industrial projects, shipyard tasks and upgrades, ground-unit training, and terraforming. Each item shows its remaining time, with planet, sector, commander, and naval-admin bonuses applied. |
| `/warnings` | Warnings | `pages/warnings.vue` | About 30 checks grouped into Contacts, Economy, Ships, Populations, Administrations, and Others. Examples: intruders, wasted mining or terraforming capacity, damaged and low-maintenance ships, idle labs and factories, governorless populations, lifepods, wrecks, unexploited ancient constructs, and dangerous rifts. |
| `/minerals` | Minerals | `pages/minerals.vue` | Mineral deposits on surveyed bodies. Filters include system, orbital-mining eligibility, and accessibility totals. A CMC chip marks bodies with enough of a qualifying mineral for a civilian mining complex (minerals set in Settings). |
| `/mineral-outlook` | Outlook | `pages/mineral-outlook.vue` | Mineral runway and depletion forecast. Stock, production and use per mineral from the game's mineral ledger, with years of stock left. Sources and uses by purpose, a stock and output projection per mineral, and every mined deposit's years to half-mined and to empty. |
| `/habitability` | Habitability | `pages/habitability.vue` | Colony cost per species and body, plus terraforming plans and their costs, with persistent filters. |
| `/information` | Information | `pages/information.vue` | Transport capacity: civilian and military freight and colonists per year over a chosen distance. Also civilian network work orders, meaning installation supply and demand. |
| `/map` | Map (WIP) | `pages/map.vue`, `components/SystemView.vue` | Galaxy map of the systems and jump points the race knows, with sectors, controllers, and survey progress. Includes a per-system PIXI view, PNG export, and **Save Positions**, which writes back to the save. |
| `/log` | Log | `pages/log.vue` | The full game log with event-type filters, coloured with the race's event colours. |
| `/designed-tech` | Designed Tech (WIP) | `pages/designed-tech.vue` | The race's designed components by category. |
| `/technologies` | Tech Tree | `pages/technologies.vue` | The tech tree by research field, with researched techs highlighted and RP costs. |
| `/settings` | wrench icon | `pages/settings.vue` | NPR visibility, the thousands separator, the minerals that qualify a body for a civilian mining complex (`cmcMinerals`, default Duranium and Gallicite), and the per-race maintenance threshold and excluded classes. |
| `/engines` | hidden | `pages/engines.vue` | An engine planner. It's a work in progress, and its tab is commented out. |

### Utilities (`utilities/`)

- `database.js` has `resetDatabase(storagePath)`, which holds every Sequelize model and association. See `docs/DATABASE.md`.
- `aurora.js` has the game-domain helpers:
  - `gameTime(startYear, seconds)` returns a UTC dayjs date.
  - `systemBodyName`, `modelSystemBodyName`, `starName`, and `populationName` build names the way Aurora does.
  - `eventColorToRGBA` converts log event colours.
  - `toNumber` and `toBoolean` coerce the save's loosely typed values.
- `math.js` has rounding helpers, `separatedNumber` for thousands separators, `scaleValue` (a piecewise-linear scaler used by the map), and `safeModulo360`.
- `generic.js` has `convertDisplayBase`, which turns star component numbers into letters, and `areSetsEqual`.
- `map.js` has the `Vector2` and `Vector3` classes used by the map.
- `minerals.js` has the mineral maths: surface and orbital mining rates, the deposit depletion forecast (`depositForecast`, `depositStateAt`), the ledger's flow groups, the industry queue's yearly mineral demand, and naval-admin radius, required ranks and bonus chains.

### Mixins and charts

- `mixins/production-modifiers.js` loads every population's production modifiers and provides the construction, ordnance and fighter capacity helpers. The Production and Mineral Outlook pages share it.
- `components/charts/ChartCanvas.vue` wraps Chart.js. Pass `type`, `data` and `options`. It applies the design-system colours for the current theme, a crosshair on line charts, and labelled vertical markers (`options.plugins.guides.markers`). `components/charts/theme.js` holds those colours and the validated categorical palette. In light mode three of its hues are under 3:1 on white, so any chart that uses them needs a table view.

### Leftovers

Leftovers from the template and older code: `components/header.vue` (Buefy, unused), `components/SystemInformation.vue` (template sample, unused), `src/extraResources/*` (template sample files, still copied by electron-builder), and `assets/electron-nuxt.png`.
