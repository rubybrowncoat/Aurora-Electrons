# Third build: Commanders, Hauling Planner and Empire History

This build covers features 9, 12 and 14 of the [ranked plan](README.md).

| Plan item | Page | Tab | File |
|---|---|---|---|
| 9. Commanders | Commanders | Commanders | `pages/commanders.vue`, `utilities/commanders.js` |
| 14. Hauling Planner | Hauling Planner | Hauling | `pages/hauling.vue`, `utilities/hauling.js` |
| 12. Empire History | Empire History | History | `pages/history.vue`, `utilities/history.js`, `plugins/history.js`, `store/history.js` |

Commanders and Hauling read the save like the other pages and use `utilities/load-tracking.js`, so a failed read shows a named error with Retry. Empire History is different: the app writes its own record (never to the save), so it adds a recorder plugin, a store module and a second electron-store file.

All SQL was run read-only on the sample save (GameID 140, RaceID 784). The sample has no research projects and no ship that a better officer could take over, so those branches were checked with synthetic helper cases and on a scratch copy with an injected project. Empire History was checked on a scratch copy whose game time was moved forwards and back.

## What the analysis changed

1. **The ship posts are confirmed.** The plan labelled `CommandType` 8, 9, 10, 11 and 15 as inferred. On the sample, every officer in each post has the bonus the docs (`crew-and-commanders`) give that post, and serves on a ship with its command module:

   | CommandType | Post | Bonus every holder has | Module on every holder's ship | Holders |
   |---|---|---|---|---|
   | 8 | Executive officer | 1 Crew Training | Auxiliary Control | 374 |
   | 9 | Chief engineer | 28 Engineering | Main Engineering | 574 |
   | 10 | Science officer | 2 Survey | Science Department | 27 |
   | 11 | Tactical officer | 21 Tactical | Combat Information Centre | 356 |
   | 15 | Commander, air group | 7 Carrier Operations | Primary Flight Control | 34 |

   The other codes: 0 unassigned, 1 captain, 3 governor, 4 sector governor, 5 ground formation, 7 research project, 12 naval admin command, 17 academy commandant (1 on the sample).
2. **The plan's rank level holds, and extends to secondary officers.** A rank's level is the lowest rank's `Priority` minus its own, plus 1. For all 1,407 captains it equals their class's `RankRequired`, so the page compares officers with posts by level. Secondary officers serve one rank below the captain (docs), so a science officer's level is `RankRequired` − 1.
3. **Governors rank the game's way.** Docs (`crew-and-commanders`, automated assignments): a candidate must have the colony's first required bonus, and candidates rank by it, then by the second, then the third. The plan's sample run found one colony, Chronos, where the first bonus decides. The page finds it too, plus 12 more where the first bonus ties and a later one decides.
4. **Every cycling fleet's route can be walked.** The plan's SQL costed 33 of 46 fleets. The rest use two order types it skipped:
   - Type 12, a Lagrange-point jump. `FCT_LagrangePoint` has coordinates: entry is `DestinationID`, exit `DestinationItemID`.
   - Type 15, which targets a body like type 2.

   All 46 now trace.
5. **"Load Mineral Type" sets its own amount.** All 101 such orders (action 178) on the sample carry `MaxItems` tonnes, so a route that only loads named minerals moves the sum of those, capped at capacity, rather than a full hold.
6. **Loading time matters, and the docs give it.** Without it, short routes look absurd: Lyceum → Tianguan cycles in half a day. The docs (`logistics`, Logistics and Cargo Handling) give the handling time per stop: cargo points × 20 s (colonists × 10 s), divided by the ship's shuttle bays plus one when the colony has a spaceport or cargo shuttle station, times the race's shuttle technology (`FCT_Race.CargoShuttleLoadModifier`). Ships up to 500 t land and need no shuttles. With it, routes are no longer upper bounds in the plan's sense, though they still err long (see caveats).
7. **History lives in its own files, one per game.** Open question 3 is settled as an electron-store file per game, `history/game-<GameID>.json` in the app's settings folder beside `config.json`. Settings stay small, a long campaign doesn't slow down a new game's writes, and each game's history can be deleted on its own. (The first version used a single `history.json`; it was never released.)
8. **The Information page counts shuttle technology twice** (`information.vue` ~261). A class's `CargoShuttleStrength` is already its bays × the bay's strength (Conveyor: 1 bay, 50; Horizon Dawn: 20 bays, 1,000), and the page multiplies it by the race's `CargoShuttleLoadModifier` (50) again. On the sample its loading times come out 50 times too short. Added to the plan's "Found along the way"; not fixed here.

## Commanders

**What it answers.** Who's available, and who would do a job better?

**Data.**

- One row per living, free commander: type, rank and its level, age, health risk, post with the name of what they lead, research field, bonuses and traits (each aggregated once with `group_concat`).
- Bonus types and traits from `DIM_CommanderBonusType` and `DIM_TraitsList`.
- Colonies with their required bonuses (`BonusOne`–`BonusThree`), importance and governor.
- Specialist ships with their class's terraformers, mining modules, harvesters and Science Department, captain and science officer.
- Research projects with their field, labs and lead scientist.

**Rules** (`utilities/commanders.js`):

| Rule | Status |
|---|---|
| Age = species `GraduationAge` + years since `CareerStart` | Plan; a species on the sample graduates at 30 |
| Governor candidates: unassigned administrators with the colony's first bonus, ranked by first, second, then third bonus; a missing bonus counts as none | Docs `crew-and-commanders` |
| Terraformers and miners (mining modules or harvesters) use the captain's full Terraforming or Mining bonus | Docs; matches the production maths |
| Survey ships use the science officer's full Survey bonus when the class has a Science Department, otherwise half the captain's | Docs |
| A better officer must be unassigned and hold exactly the post's rank level, as automatic assignment picks; better officers at other ranks are counted | Rank level checked on 1,407 captains (above) |
| Research multiplier: in the scientist's field 4 × bonus − 3, outside it the bonus | `index.vue`'s rule; docs: changing field cuts the bonus by 75% |
| A research lead's Research Administration rating (the most labs they can run) must cover the project's labs | Docs |

**Layout.**

- Tiles: commanders by type, unassigned, colonies without a governor and specialist ships without their officer, and better assignments.
- "Better assignments" with three views: Governors (colony, its wanted bonuses, the governor and the better candidate, how many other colonies that candidate is also best for), Specialist ships, and Research.
- The roster: type toggle, "Unassigned only", search, "Sort by bonus" (adds the bonus as a column), field filter for scientists, the top six bonuses as chips, and traits in a tooltip. Health risk is shown raw, as the plan advised; 6 and above is highlighted.

**Sample checks.**

- 19,853 commanders (8,022 naval, 7,930 ground, 1,702 administrators, 2,199 scientists); 13,653 unassigned.
- 13 better governors. Chronos: Damon Valance (Terraforming +35%) over Hida Yumi (+30%). Elosha Manticore is the best candidate for three colonies, Lín Hui Long for four.
- No colony without a governor; one specialist ship without a captain; no better specialist officer; no research projects.
- Helper checks: 14 synthetic cases (ranking ties, missing bonuses, rank levels, half Survey for captains, field and lab rules) pass. On a scratch copy with an injected project, the Research view names the better scientist.

**Caveats.**

- Suggestions are per colony, ship or project. A candidate can be best for several; Aurora assigns greedily by colony importance, and the page only counts the overlaps.
- The administrator's rating (Colony Administration, 25) is shown but not required: the docs don't say whether a colony needs a minimum.

## Hauling Planner

**What it answers.** How much do my freighters move, and at what cost?

**Data.**

- Freighter and colony-ship classes with cargo, berths, speed, fuel use and hull (`FCT_HullDescription.HullAbbr`), counting only ships outside shipping lines.
- Cycling fleets (`CycleMoves = 1`, not a shipping line) with their set speed and the race's shuttle technology.
- Their ships' cargo, berths, tonnage, cargo shuttle bays (components named `Cargo Shuttle Bay%`) and crew (`FCT_Ship.CurrentCrew`, `FCT_ShipClass.Crew`).
- Their orders in sequence, each with where it sends the fleet and where the fleet is afterwards (both the same for a body):
  - jump point (1): entry at `DestinationID`; for a transit (`DIM_MoveAction.TransitOrder > 0`) the exit is at `NewWarpPointID` or the entry's `WPLink`, for any other order (a plain Move to Location) the fleet stays at the entry;
  - body (2, 15): the body's current position;
  - Lagrange point (12): an Intra-system Jump (action 124) goes from `DestinationID` to `DestinationItemID` in `FCT_LagrangePoint`; any other order stays at `DestinationID`.

  Each order also carries whether its colony has a spaceport or cargo shuttle station.

**Rules** (`utilities/hauling.js`):

| Rule | Status |
|---|---|
| Round trip: in-system legs between successive order positions, closing back to the first; a route whose positions jump systems is flagged | Plan § 6, extended to types 12 and 15 |
| Cycle = round trip / fleet speed + cargo handling + order delays | Fleet speed is the set speed |
| Handling per stop: the slowest ship's cargo × 20 s (colonists × 10 s) / ((bays + 1 with a spaceport or station) × shuttle technology × crew fraction), where the crew fraction is Current Crew / Class Crew capped at 1 (`crewFraction`, shared with Mineral Outlook; docs `crew-and-commanders`, v2.6: loading takes Class Crew / Current Crew times as long) and a ship with no crew can't load, and the cargo is what that order moves (its own share of each ship's capacity, from the cargo model below), not a cycle-wide share; ships up to 500 t land; a fleet with a ship that has no way to load at a stop is flagged, shows no cycle or yearly numbers, and is left out of the totals | Docs `logistics` |
| Cargo follows the orders: each load takes what is asked (a set `MaxItems` for the Mineral Type orders, otherwise all the free space) and each unload empties what the fleet holds, repeated until the hold settles. A cycle's cargo is what its unloads deliver, so load@A, unload@B, load@B, unload@A counts two holds; minerals and installations share the cargo hold, colonists have their own berths. "Load/Unload Minerals to Reserve Level" (165) unloads what the fleet holds, else loads | Sample (above) |
| Fuel a year = engine power × fuel efficiency (litres an hour) × hours under way | Plan § 6 |
| Load actions 4, 62, 165, 176, 178, 180, 223; unload actions 6, 63, 96, 165, 177, 179. "Load All Minerals" (62) and "Until Full" (223) fill the hold, assuming the colony has the stock; "Load Mineral Type" (178) and "Load Mineral when X available" (180) carry up to their set amount. The sample's fleets use only 4, 6, 63, 96, 165, 176, 178, 223 | `DIM_MoveAction`; the forum's v1.12 notes for "Until Full" (same as Load All Minerals, repeated until full, reserve levels respected) |

**Layout.**

- Tiles: freighters and colony ships with cargo space and berths, repeating routes (and how many are counted: the rest can't be traced or can't load), what they move a year, and route fuel a year.
- A routes table: fleet, stops, round trip, cycle (a tooltip splits moving from handling; a fleet that can't load at a stop shows why instead of numbers), trips a year, what it moves a year, fuel a year. Expanding a row lists its legs.
- Deliveries by destination and cargo kind: each unload is credited with what the fleet holds at that point.
- Freighter classes: ships, cargo, berths, speed, reach a year and cargo × distance.

**Sample checks.**

- 95 freighters and colony ships, 2.44 Mt of cargo space, 1,102,900 berths.
- 46 routes, all traced.
- Cargo Group 001 matches the plan: 99.01 bn km, and 21.2 days moving. Handling adds about 11 hours, for a 21.6-day cycle, 16.9 trips and 8.44 Mt of installations a year. Conveyor routes add about 2.9 hours per cycle.
- The fleet moves 95.75 Mt a year (82.51 Mt minerals, 13.24 Mt installations) and 2.82 M colonists, and burns 34.20 ML of fuel on its routes. The Korhal passenger route loads and unloads twice a cycle, so it moves two holds (415,575 a year, not 207,788); the mineral routes with a "Load/Unload to Reserve Level" stop carry only their set amounts, not a full hold (the old count treated that stop as an unset load).

**Caveats.**

- Commander, governor and admin Logistics bonuses aren't applied, so handling errs long.
- Bodies sit at their current place in orbit, and refuelling stops, overhauls and Aurora's increment rounding aren't counted.
- Fuel assumes the set speed throughout.
- Tractor-and-trailer pairs aren't modelled.
- The page carries an "Estimates" chip.

## Empire History

**What it answers.** How has my empire grown? The save keeps a year of wealth data and a few weeks of the mineral ledger, nothing more, so the app keeps its own record.

**Recording** (`plugins/history.js`, `utilities/history.js`):

- Each time the save is opened or changes (the `database` swap the file watcher already triggers), the plugin snapshots every recorded race in the save, in every game, then commits `history/recorded` so an open History page re-reads.
- Recorded races are player races and NPR empires: `NPR = 0`, or `SpecialNPRID = 0` (`recordsHistory`). Aurora's special factions (Precursors, Invaders, Rakhas, Eldar, Ancients) have no empire to chart and are skipped; their History tab is disabled, and the page says why if it's open when one is picked. NPR history is recorded whether or not spy mode is on, since it can't be rebuilt later, and it's only visible in spy mode, which is the only way to select an NPR.
- Each game has one file, `history/game-<GameID>.json`, holding `{ gameName, races: { <RaceID>: { raceName, npr, snapshots } } }`. All of a game's races are snapshotted first, then the file is written once (`store.store = …`): electron-store rewrites the whole file on every write, so a per-race write would cost one full rewrite per race.
- Where it is: a `history` folder inside Electron's userData folder, next to the settings' `config.json`. That's `%APPDATA%\<app name>\history\` on Windows, `~/Library/Application Support/<app name>/history/` on macOS and `~/.config/<app name>/history/` on Linux, where the app name is the packaged product name (`Aurora Electrons`) or the package name (`aurora-electrons-new`), depending on what Electron reports. The History page shows the exact path.
- A snapshot holds, at `t` (game seconds):
  - population and populated colonies;
  - treasury and annual income;
  - fuel and MSP in colonies;
  - the eleven mineral stockpiles;
  - military and commercial ships and tonnage;
  - installations by type;
  - research (the summed cost of researched techs);
  - known systems and living commanders.

  It's about 500 bytes.
- Merge rules (`mergeGame`):
  - another game name under the same GameID starts the file over;
  - every race loses its snapshots at or after the save's time, so a snapshot at a recorded time replaces it and an earlier time (an older save loaded) drops everything after it, since that future didn't happen;
  - a race missing from the save keeps its past, so a destroyed empire's history stays.
- Past 2,000 snapshots per race, the older half is thinned to every other one, so a long campaign keeps its whole span at a coarser grain: about 1 MB per race at the cap. On the sample, a snapshot takes about 450 ms for the player race and 60 ms for each NPR (measured in Python on the same SQL).
- A failed snapshot is logged and skipped; the next save tries again.

**Layout.**

- A header with the count and span, where the file is saved, a chart/table toggle, CSV export and Clear (with a confirmation). Clear removes only the selected race.
- **Rivals**, in spy mode only: one line per recorded race in the game, players first, the selected race drawn thicker, on population, colonies, fleet tonnage, military tonnage, research, known systems or treasury (`historyRivalsMetric`). These are the true numbers, which is why it needs spy mode; Intelligence History (plan item 16) is the fog-of-war counterpart.
- Tiles: population, treasury, fleet tonnage and research, each with its change since the first snapshot.
- Line charts over the game year:
  - population and colonies;
  - treasury and annual income;
  - military and commercial tonnage;
  - research and known systems;
  - mineral stockpiles (pick minerals, `historyMinerals`);
  - installations (pick types; the top five by default, kept per race);
  - fuel and MSP.
- With a single snapshot, the page says history starts here.

**Checks** (Playwright on scratch copies):

- Player race only: opening the copy recorded 1 snapshot. Five simulated saves 30–90 days apart made 6, with population rising from 15.261 bn to 15.325 bn. Moving the time back 100 days left 5; saving the same time again kept 5. Clear emptied the record.
- With NPRs: on a copy where the Eldar and Precursors were made ordinary NPRs (`SpecialNPRID` 0):
  - opening it recorded the player race, the Eldar and the Precursors, and nothing for the 12 special factions;
  - three simulated saves wrote the game's file three times, once per save, giving 4 snapshots per race;
  - with spy mode off there's no Rivals chart; with it on, Rivals shows all three races, the selected one thicker, on every metric;
  - picking the Eldar shows their own history; picking the Ancients disables the History tab and shows the notice;
  - rewinding 100 days trimmed every race to 3 snapshots; clearing the Eldar left the other two races untouched.
- The web shim stored it under its own key (`aurora-electrons:history/game-140`), apart from the settings.
- The merge helpers pass eleven Node cases: per-race order, replace, a race missing from a save, rewind across races, a race emptied by a rewind, a new game, names and NPR flags, which races are recorded (including text booleans), and thinning.

**Caveats.**

- History starts when this version is installed, and only grows while the app is open when Aurora saves.
- Web mode stores it in localStorage through the shim, so only `yarn electron:smoke` exercises the real files.
- Checked in Electron: without `Store.initRenderer()` in the main process, the renderer's stores got no folder. Settings fell back to conf's default (`%APPDATA%\electron-store-nodejs\Config\config.json` on Windows) and every history write failed (`path.join` on an undefined folder). The main process now calls it, so settings and `history/game-<GameID>.json` live in the app's user-data folder, and a packaged build copies the old settings file over once.

## Open items

- `information.vue`'s doubled shuttle technology (above).
- Intelligence History (plan item 16) would record into the same per-game files.
- The Commanders page could assign governors greedily by importance, as Aurora does, instead of counting overlaps.
- Hauling could add travel between systems once the jump graph (G2) exists. Each fleet's route already walks its own jumps.
