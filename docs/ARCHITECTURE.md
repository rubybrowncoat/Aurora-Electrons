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

Most of this directory is the electron-nuxt template's tooling; treat that part as vendored unless a change needs it. `web.js`, `web/`, `electron-smoke.js`, `smoke-pages.js`, `main-webpack.js` and `kill-tree.js` are this project's own.

- `yarn dev` runs `dev.js` and then `index.js` with `NODE_ENV=development`. It does three things:
  - webpack builds the main process from `src/main/boot/index.dev.js` into `dist/main/index.js` (config in `main-webpack.js`).
  - A forked Nuxt process (`renderer/nuxt-process.js`) builds the renderer and serves it at `http://localhost:9080`, or on `PORT`. The main bundle is built to load that port, so the Nuxt process stops `yarn dev` when the port is taken instead of falling back to another one.
  - Electron launches, and relaunches whenever the main bundle rebuilds. Closing its window stops everything. On Windows, `kill-tree.js` makes that stop use `taskkill`, because the template's ps-tree needs `wmic.exe`, which recent Windows 11 builds lack.
- `yarn build` runs `build.js` and then `index.js` with `NODE_ENV=production`. It differs from dev in two ways:
  - The main process builds from `src/main/boot/index.prod.js`.
  - Nuxt *generates* static files into `dist/renderer`, which the app serves over a custom `app://` protocol.
  
  electron-builder then packages the app using `builder.config.js`: a Windows portable exe with `splash.bmp`, a Linux deb, and a macOS dmg. It runs with `asar: false` and writes to `build/`.
- `yarn web` runs `web.js`, which builds the same renderer for a plain browser and uses the shims and database middleware in `web/`. See "Web mode" in `docs/WORKFLOW.md`.
- `yarn electron:smoke` runs `electron-smoke.js`, which builds the development main process and the renderer itself (under `dist/smoke`, on a free port) and drives the real app through Playwright. See "Electron smoke test" in `docs/WORKFLOW.md`.
- `renderer/nuxt.config.js` merges the base config into `src/renderer/nuxt.config.js`. The base config sets `srcDir`, the hash router, and the generate dir, plus an `electron-renderer` webpack target with `dependencies` left external.

## Main process (`src/main/`)

- `index.js` registers three IPC handlers:
  - `request-storage-path` resolves where the save lives:
    - Packaged on Windows portable: `PORTABLE_EXECUTABLE_DIR/AuroraDB.db`.
    - Packaged elsewhere: next to the executable. On macOS that's next to the `.app` bundle.
    - Dev: `./AuroraDB.db`, relative to the working directory, which is the repo root. Set `headGame` to `true` to read `../AuroraDB.db` instead, which is useful when the repo is checked out inside the Aurora install folder.
    
    In practice, users drop the exe into their Aurora folder.
  - `save-png` opens a save dialog and writes the base64 PNG that the map exports.
  - `read-flag` returns a race's flag as a data URL, or `null` when it is missing or unreadable. Aurora keeps its flags in a `Flags` folder beside `AuroraDB.db`, and `FCT_Race.FlagPic` holds the file name. The handler reads `path.join(path.dirname(<storage path>), 'Flags', path.basename(name))`, so a name from the save never leaves that folder, and only image extensions are served. It tries the exact name, then a case-insensitive match. A `file://` image would be blocked in a packaged build, hence the data URL. Dev mode has no `Flags` folder (its save is the repo's `AuroraDB.db`), and web mode's shim answers `null`, so both show initials.
- `mainWindow.js` and `BrowserWinHandler.js` create a 1200×800 window with `nodeIntegration: true` and `contextIsolation: false`, so the renderer `require`s Node modules (sqlite3, chokidar, electron-store) directly. `webSecurity` is enabled only in production.
- `boot/index.dev.js` opens devtools, installs Vue devtools, and adds a "Relaunch electron" menu item (Ctrl/Cmd+E). `boot/index.prod.js` registers the `app://` protocol and removes the menu.

## Renderer (`src/renderer/`)

### Data flow

1. The `plugins/database.js` plugin is client-only. It asks the main process for the storage path, then watches that file with chokidar (`awaitWriteFinish`).
2. When the file is added or changes, it dispatches the root `renew` action. That action calls `resetDatabase(storagePath)` from `utilities/database.js`, which builds a **new** Sequelize instance with every model and association, and stores it as `database`.
3. Every page reads data in `asyncComputed` getters that depend on `database`, `GameID`, and `RaceID`. Saving the game in Aurora therefore swaps the `database` instance and refreshes every open view automatically.
4. The layout loads the empire list with `loadEmpires` (`utilities/empires.js`: one query, every game's races with the capital, its system and the colony count). `components/navigation/EmpireList.vue` shows it, in the rail's Empires flyout and, until a race is selected, in the "Pick a game" panel the layout shows instead of the page. Each race row has an avatar (its flag from `read-flag`, else its initials on a `color-hash` colour), its title, a kind chip and a details line. The chip is Player (outlined), NPR (an ordinary NPR empire, `SpecialNPRID` 0, filled neutral) or the special faction's name from `SPECIAL_NPR_NAMES` in `utilities/aurora.js` (red, skull icon). The list shows only player races unless the `spyNPR` setting is on. Clicking a game header with a single race selects that race. Otherwise the user picks a row, and `changeGame` sets `GameID`, `RaceID`, `StartYear`, `GameTime`, and `CivilianShippingLinesActive`.

Each row names the capital and its system as that race knows them (the capital's own `PopName`, the system from the race's own `FCT_RaceSysSurvey` row), never `FCT_System`. For NPR rows that is the spy setting's sanctioned view. A capital with nobody left reads "… · no population", a race with no capital and no population reads "No colonies", and a capital named "Unknown" (the Eldar's) shows only its system.

If there's no `AuroraDB.db` at the resolved path, `database` stays `null`, the game list is empty, and the picker panel says "No games found in the save."

The `plugins/history.js` plugin (client-only, after the database plugin) also watches `database`. Each time it changes, it snapshots every player race and NPR empire in the save, and what each knows of the other races (`utilities/history.js`, `recordHistory`), reading it all in one read transaction so a save written mid-pass can't mix two saves (a rollback-journal save makes the game wait to commit for that moment; web mode's shim has no real transaction), writes each game's history file once, and commits `history/recorded` after each game's file is written, so an open Empire History page re-reads even if a later game in the pass fails. Each database replacement bumps a counter, and a pass whose database has since been replaced stops before writing: two quick saves run two passes that can finish in either order, and the older one's write would trim the newer one's snapshots as if the save had been rewound. A game that can't be read or written (electron-store and the web shim's whole-store setter both throw) is logged and listed in `history/failures` with which of the two failed, and a pass that can't read the save at all lists every game. The History page shows the matching warning until a later pass saves the game.

### Store (`store/`)

| Module | Holds | Lifetime |
|---|---|---|
| `index.js` | `config` (electron-store instance), `database`, selected `GameID`/`RaceID` and the race's `RaceNPR`/`RaceSpecialNPRID`, `StartYear`, `GameTime`, `CivilianShippingLinesActive`; getter `historyRecorded`; actions `renew`, `changeGame` | session |
| `production.js` | Production-recap type filters | session |
| `tables.js` | Habitability/minerals rows-per-page and sort | session |
| `log.js` | Log filters per context key | session |
| `engine.js` | Engine-planner inputs | session |
| `snackbar.js` | Global snackbar | session |
| `navigation.js` | Back/forward history of visited pages (`entries`, `index`, `pending`) and `lastInSection`, the last page used in each section. Getters `canBack`, `canForward`, `backEntries`, `forwardEntries`, `recents`, `trail` (the entries from seven before the current one to three after, for the app bar's trail); actions `back`, `forward`, `jump`. `plugins/navigation.js` feeds every route change into it | session |
| `history.js` | `revision`, bumped each time the recorder writes snapshots; `failures`, the games whose latest snapshots couldn't be read or written (`[{ GameID, stage }]`, GameID null for the whole save). Getter `snapshotSummary(GameID, RaceID)`: the count and last time of a race's snapshots, read from the file once per `revision` | session |
| `peeks.js` | The live lines under each page in the section flyout (`lines[route]`, a string or null), cached for one database instance, game, race, history revision and separator. Action `load(routes)` runs the missing peeks and never rejects | session |

Anything that must survive a restart goes to electron-store through `this.config` instead. That's a `config.json` in Electron's userData directory. The renderer's stores get that folder from the main process, so `src/main/index.js` calls `Store.initRenderer()`. Before it did, settings landed in conf's fallback folder (`%APPDATA%\electron-store-nodejs\Config` on Windows); a packaged build copies that file into userData once. Keys in use:

- App-wide: `darkMode`, `spyNPR`, `selectedSeparator`.
- Habitability: `habitabilitySystems`, `habitabilityTerraformers`, and the `habitabilityFilter*` keys (`OwnPopulations`, `OtherPopulations`, `Uninhabited`, `NonTerraformable`, `DoneTerraforming`, `WithoutMinerals`).
- Minerals: `mineralsFilterOrbitalEligibility`.
- Designed tech: `designedTechCategoryId`, `designedTechFilterObsolete`, `designedTechFilterCivilian`, `designedTechFilterCommercial`.
- Colony Outlook: `colonyOutlookHorizon`, `colonyOutlookAttentionOnly`. Logistics: `logisticsView`, `logisticsShowIdleLocations`. Finances: `financesWindowDays`. Survey Progress: `surveyShowSurveyed`. Commanders: `commandersType`, `commandersUnassignedOnly`. Empire History: `historyMinerals`, `historyRivalsMetric`.
- Per race: `game.<GameID>.race.<RaceID>.maintenanceThreshold` and `.maintenanceExclusions`; the Warnings page's idle-fleet choices `.idleFleetsAtColonies` and `.idleFleetExclusions` (fleet IDs); Empire History's `.historyInstallations`; Intelligence's selected alien race `.intelligenceAlien`.

Empire History keeps its snapshots in one electron-store file per game, `history/game-<GameID>.json` in the same userData folder as `config.json` (`new Config({ cwd: 'history', name: 'game-<GameID>' })`, through `historyConfig(GameID)` in `utilities/history.js`). A file holds `{ gameName, races: { <RaceID>: { raceName, npr, snapshots } }, intel: { <ViewRaceID>: { <AlienRaceID>: { name, snapshots } } } }` for the game's player races and NPR empires, and is written once per save. Intelligence snapshots are kept only when something besides the time changed. Nothing is written to the save. In web mode the shim keeps each file under its own localStorage key, `aurora-electrons:history/game-<GameID>`.

### Pages

`src/renderer/utilities/navigation.js` is the page registry and the single source of truth for what the navigation shows. It exports `SECTIONS` (id, title, icon, and the `slot` of the section's colour in `components/charts/theme.js`'s categorical palette), `PAGES` (`route`, `section`, `tab`, `title`, `icon`, `blurb`, `keywords`, and the optional `wip`, `requiresHistory`, `hidden` and `planned`), the derived `sectionById` and `pageByRoute`, and `FORUM_URL`. It's plain CommonJS so `.electron-nuxt/smoke-pages.js` can `require` it from Node. A new page is `pages/<name>.vue` plus one `PAGES` entry. A `planned` entry has no page file: the flyout lists it dimmed with a "Planned" chip, and it is never navigable and appears in no tab strip, palette, history or smoke list (the Shipyard Planner, Route Finder, Lagrange Points and the Colonization Planner, which will replace Habitability, are planned). Delete `planned` when its page ships.

`layouts/default.vue` is driven by the registry:

- A rail of the seven sections with Settings at the bottom and the Empires entry on top (the selected race's flag or initials). Clicking a section returns to the last page used in it (`navigation/lastInSection`) or its first enabled page. Hovering a section, or the section name in the breadcrumb, opens `SectionFlyout` listing its pages; hovering the Empires entry, or clicking it, opens the empire list in the same `FlyoutPanel`. Esc and leaving close either.
- Under each page in a section flyout, a monospace line from `utilities/peeks.js` (route -> `async ({ database, GameID, RaceID, … }) => string | null`), for example "1'414 bodies in 132 systems". The layout loads a flyout's lines when it opens, for that section's enabled pages only, through `peeks/load`, and the store keeps them until the database, race, history revision or separator setting changes, so a reopened flyout makes no queries. A failing peek logs `console.warn` and shows nothing. Habitability, Transport and the pages that aren't enabled have no peek, and the Warnings peek names only two of its checks, never a total. Peeks scope by `GameID` and `RaceID` and go through the race's survey tables, like the pages. `/history` reads the history store's cached `snapshotSummary`, not the save. The registry itself stays CommonJS for Node, which is why the peeks live beside it.
- An app bar with back and forward buttons (`HistoryButtons`, with a right-click menu of earlier or later pages), a breadcrumb of section and page title, the Ctrl+K "Go to page" button and the dark-mode toggle. The bar's 44 px extension is always shown, so the bar's height is constant (the map's height maths relies on 108 px): the section's tabs on the left when it has more than one page, then a divider and `PageTrail`, the history entries around the current one as chips (a section-coloured dot and the page's tab label, the current one filled, forward ones dashed). Clicking a chip jumps to it through the store's `jump`. The trail never wraps: it hides its "Trail" label first, then scrolls so the current chip stays in view. Pages with `requiresHistory` are disabled when `historyRecorded` is false, in the tabs, flyout and palette.
- `PagePalette`, the Ctrl+K dialog: recent pages, then every page, filtered as you type over title, tab, section and keywords.
- Window shortcuts: Ctrl/Cmd+K, Alt+Left and Alt+Right, Ctrl/Cmd+1 to 7 for the sections, and the mouse's back and forward buttons.
- A footer with an optional link to the forum thread. Set `FORUM_URL` in the registry to show it. It opens in the system browser through Electron's `shell`.

Section colours come from the chart palette (`components/navigation/section-style.js` turns a section into the `--sc`, `--sc-soft` and `--sc-tint` custom properties).

| Route | Section | Tab | File | Shows |
|---|---|---|---|---|
| `/` | Command | Production | `pages/index.vue` | Production recap: research projects and queues, industrial projects, shipyard tasks and upgrades, ground-unit training, and terraforming. Each item shows its remaining time, with planet, sector, commander, and naval-admin bonuses applied. |
| `/warnings` | Command | Warnings | `pages/warnings.vue` | About 40 checks grouped into Contacts, Economy, Ships, Fleets, Populations, Administrations, and Others. Examples: intruders, wasted mining or terraforming capacity, mining colonies with nowhere to send minerals, damaged, under-crewed and low-maintenance ships, idle fleets, cargo or survey orders that can't complete, idle labs and factories, governorless populations, lifepods, wrecks, unexploited ancient constructs, and dangerous rifts. |
| `/minerals` | Economy | Minerals | `pages/minerals.vue` | Mineral deposits on surveyed bodies. Filters include system, orbital-mining eligibility, and accessibility totals. A CMC chip marks bodies with enough of a qualifying mineral for a civilian mining complex (minerals set in Settings). |
| `/mineral-outlook` | Economy | Outlook | `pages/mineral-outlook.vue` | Mineral runway and depletion forecast. Stock, production and use per mineral from the game's mineral ledger, with years of stock left. Sources and uses by purpose, a stock and output projection per mineral, and every mined deposit's years to half-mined and to empty. |
| `/colony-outlook` | Colonies | Outlook | `pages/colony-outlook.vue` | Per colony: population growth and a projection over a chosen horizon, how full the body is, the infrastructure cap and when growth hits it, the worker split (services, agriculture, workers needed, free or short) now and at the horizon, and colonists or installations on their way. |
| `/logistics` | Logistics | Fuel & MSP | `pages/logistics.vue` | Fuel: stock in colonies, tankers and ships, refinery and harvester output, Sorium cover, an estimated burn range and burn by class. Maintenance supplies: per maintenance location, stock, production, maintained tonnage against capacity, MSP used, net and how long it lasts; supply ships. |
| `/finances` | Economy | Finances | `pages/finances.vue` | Wealth income and spending by category from the save's year of history: totals, a per-cycle stacked chart with the net, a ranked list and the treasury worked back from today. |
| `/hauling` | Logistics | Hauling | `pages/hauling.vue` | Repeating freight routes (fleets on cycling orders): stops, round trip, cycle time with cargo handling, trips, cargo and colonists moved, and fuel burned a year; deliveries by destination; freighter classes with their reach. |
| `/history` | Empire | History | `pages/history.vue` | Empire History: the app's own snapshots of the race, one per save it sees, charted over game time (population, wealth, fleet tonnage, research and exploration, minerals, installations, fuel and MSP), with a table view, CSV export, Clear and the file's path. In spy mode, a Rivals chart compares every recorded race in the game. The tab is disabled for Aurora's special factions, which aren't recorded. |
| `/intelligence` | Galaxy | Intelligence | `pages/intelligence.vue` | What the race knows of every alien race it has met: stance, communication, diplomatic points against the treaty lines, treaties both ways, tracked ships and losses (rebuilt back to first contact), race intelligence and its discoveries, and the observed classes, colonies, sensors, ground units, systems and species. Recorded with Empire History; disabled for special factions. |
| `/habitability` | Colonies | Habitability | `pages/habitability.vue` | Colony cost per species and body, plus terraforming plans and their costs, with persistent filters. |
| `/survey-progress` | Galaxy | Survey | `pages/survey-progress.vue` | Survey work left: a map of known systems coloured by the gravitational and geological survey left, per-system locations and bodies with points, survey fleets with their points a day and what they're doing, and ground-survey sites. |
| `/commanders` | Empire | Commanders | `pages/commanders.vue` | The commander roster (type, rank, age, health risk, post, bonuses, traits) with filters and bonus sorting, and better assignments: governors ranked by the colony's wanted bonuses, officers for terraformers, miners and survey ships, and research leads. |
| `/information` | Logistics | Transport | `pages/information.vue` | Transport capacity: civilian and military freight and colonists per year over a chosen distance. Also civilian network work orders, meaning installation supply and demand. |
| `/map` | Galaxy | Map | `pages/map.vue`, `components/SystemView.vue` | Galaxy map of the systems and jump points the race knows, with sectors, controllers, and survey progress. Includes a per-system PIXI view, PNG export, and **Save Positions**, which writes back to the save. |
| `/log` | Command | Log | `pages/log.vue` | The full game log with event-type filters, coloured with the race's event colours. |
| `/designed-tech` | Research | Designed | `pages/designed-tech.vue` | The race's designed components by category. |
| `/technologies` | Research | Tech Tree | `pages/technologies.vue` | The tech tree by research field, with researched techs highlighted and RP costs. |
| `/settings` | none (rail, bottom) | Settings | `pages/settings.vue` | NPR visibility, the thousands separator, the minerals that qualify a body for a civilian mining complex (`cmcMinerals`, default Duranium and Gallicite), and the per-race maintenance threshold and excluded classes. |
| `/engines` | none | hidden | `pages/engines.vue` | An engine planner. It's a work in progress, so its registry entry is `hidden` and it has a title but no navigation entry. Open it by URL. |

### Utilities (`utilities/`)

- `database.js` has `resetDatabase(storagePath)`, which holds every Sequelize model and association. See `docs/DATABASE.md`.
- `aurora.js` has the game-domain helpers:
  - `gameTime(startYear, seconds)` returns a UTC dayjs date.
  - `systemBodyName`, `modelSystemBodyName`, `starName`, and `populationName` build names the way Aurora does.
  - `eventColorToRGBA` converts log event colours.
  - `toNumber` and `toBoolean` coerce the save's loosely typed values.
  - `SPECIAL_NPR_NAMES` maps `FCT_Race.SpecialNPRID` to the special faction's name (1 Precursors, 2 Swarm, 3 Invaders, 4 Rakhas, 5 Eldar, 6 Ancients).
- `math.js` has rounding helpers, `separatedNumber` for thousands separators, `thousandsSeparator` (the character behind the `selectedSeparator` setting's name), `scaleValue` (a piecewise-linear scaler used by the map), and `safeModulo360`.
- `peeks.js` has the section flyout's live lines (see Pages). `empires.js` has `loadEmpires`, `empireKind` and `empireDetails` for the empire list. `flags.js` has `flagUrl(name)`, which asks the main process's `read-flag` once per file name per session. `color.js` has `hashColor`, the `color-hash` colour used for the Tech Tree and the initials avatars.
- `generic.js` has `convertDisplayBase`, which turns star component numbers into letters, and `areSetsEqual`.
- `map.js` has the `Vector2` and `Vector3` classes used by the map.
- `minerals.js` has the mineral maths: surface and orbital mining rates, the deposit depletion forecast (`depositForecast`, `depositStateAt`), the ledger's flow groups, the industry queue's yearly mineral demand, and naval-admin radius, required ranks and bonus chains, and `compact` (tons at a readable precision).
- `naval-admins.js` has `loadNavalAdmins(database, { GameID, RaceID, bonusId, share })`: the race's admin commands with one commander bonus (6 Mining with the Industrial share, 2 Survey with the Survey share), their eligibility and the systems in range, ready for `navalAdminChainBonus`.
- `colonies.js` has the colony maths: body capacity, population growth, infrastructure per million and cap, the worker split, a month-by-month projection, and `people` (millions of people at a readable precision).
- `logistics.js` has `compact` (litres at a readable precision), refinery and MSP production, maintenance capacity, maintenance locations with their Effective Maintenance Rate, full-power fuel burn and harvester output.
- `commanders.js` has the post labels (`POSTS`), bonus parsing and formatting, and the better-assignment rules: `governorSuggestions`, `specialistPost` and `shipSuggestions`, `researchMultiplier` and `researchSuggestions`.
- `hauling.js` has the hauling maths: `walkRoute` (a cycling fleet's legs and round trip), `cycleCargo` (the cargo followed through the orders: what each stop moves and what a cycle delivers where), `stopHandling` and `cycleHandling` (cargo-handling time at a stop and over a cycle), `routeYear` and `classYear`.
- `history.js` has Empire History's storage and recorder: `historyConfig(GameID)`, `recordsHistory` (which races are recorded), `takeSnapshot`, `recordHistory`, and the pure `mergeGame` and `thinSnapshots` rules. `recordHistory` returns `{ recorded, failed, superseded }`, each failure carrying its `stage` (`read` or `write`).
- `intelligence.js` has the intelligence codes and labels (stance, communication, species, engine type, class role), the diplomacy lines and standing bands, the colony intelligence levels, the known-races query (`alienRacesSql`), the recorded snapshot (`intelSnapshot`, `intelChanged`, `takeIntel`), the tracked-fleet rebuild and the discovery marks.
- `load-tracking.js` has `tracked(key, getter)`, which records each async-computed read's state in the page's `loadErrors` (undefined before the first read settles and while a re-read is in flight, null once it succeeds, the message while it fails; a failed read keeps its message while its retry runs), plus `allLoaded` and `joinLabels`. Pages use it to show an error with a Retry button instead of partial numbers while a read fails, and to hold their panels back while any read is being repeated (a race switch, a save reload, a window change), so they never mix a new read with the previous one's value.

### Mixins and charts

- `mixins/production-modifiers.js` loads every population's production modifiers and provides the construction, ordnance and fighter capacity helpers. The Production, Mineral Outlook, Colony Outlook and Logistics pages share it. Its read is tracked, so a page with `loadErrors` can wait for it.
- `components/charts/ChartCanvas.vue` wraps Chart.js. Pass `type`, `data` and `options`. It applies the design-system colours for the current theme, a crosshair on line charts, and labelled vertical markers (`options.plugins.guides.markers`) and labelled dashed horizontal levels (`options.plugins.guides.levels`). `components/charts/theme.js` holds those colours and the validated categorical palette. In light mode three of its hues are under 3:1 on white, so any chart that uses them needs a table view.

### Leftovers

Leftovers from the template and older code: `components/header.vue` (Buefy, unused), `components/SystemInformation.vue` (template sample, unused), `src/extraResources/*` (template sample files, still copied by electron-builder), and `assets/electron-nuxt.png`.
