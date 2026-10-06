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
7. **History lives in its own file.** Open question 3 is settled as a second electron-store file, `history.json`, beside `config.json`, keyed `game.<GameID>.race.<RaceID>`. Settings stay small, and the history can be cleared or deleted on its own.
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
- Their ships' cargo, berths, tonnage and cargo shuttle bays (components named `Cargo Shuttle Bay%`).
- Their orders in sequence, each with where it sends the fleet and where the fleet is afterwards (both the same for a body):
  - jump point (1): entry at `DestinationID`, exit at `NewWarpPointID` or the entry's `WPLink`;
  - body (2, 15): the body's current position;
  - Lagrange jump (12): from `DestinationID` to `DestinationItemID` in `FCT_LagrangePoint`.

  Each order also carries whether its colony has a spaceport or cargo shuttle station.

**Rules** (`utilities/hauling.js`):

| Rule | Status |
|---|---|
| Round trip: in-system legs between successive order positions, closing back to the first; a route whose positions jump systems is flagged | Plan § 6, extended to types 12 and 15 |
| Cycle = round trip / fleet speed + cargo handling + order delays | Fleet speed is the set speed |
| Handling per stop: the slowest ship's cargo × 20 s (colonists × 10 s) / ((bays + 1 with a spaceport or station) × shuttle technology); ships up to 500 t land; a ship with no way to load is flagged | Docs `logistics` |
| Per trip: capacity for each cargo kind loaded; minerals capped by the summed `MaxItems` when every mineral load is a "Load Mineral Type" | Sample (above) |
| Fuel a year = engine power × fuel efficiency (litres an hour) × hours under way | Plan § 6 |
| Load actions 4, 165, 176, 178, 223; unload actions 6, 63, 96, 165, 177 | `DIM_MoveAction` |

**Layout.**

- Tiles: freighters and colony ships with cargo space and berths, repeating routes (and how many trace), what they move a year, and route fuel a year.
- A routes table: fleet, stops, round trip, cycle (a tooltip splits moving from handling, and flags a stop the fleet can't load at), trips a year, what it moves a year, fuel a year. Expanding a row lists its legs.
- Deliveries by destination and cargo kind (a route that unloads at several stops splits evenly between them).
- Freighter classes: ships, cargo, berths, speed, reach a year and cargo × distance.

**Sample checks.**

- 95 freighters and colony ships, 2.44 Mt of cargo space, 1,102,900 berths.
- 46 routes, all traced.
- Cargo Group 001 matches the plan: 99.01 bn km, and 21.2 days moving. Handling adds about 11 hours, for a 21.6-day cycle, 16.9 trips and 8.44 Mt of installations a year. Conveyor routes add about 2.9 hours per cycle.
- The fleet moves 96.15 Mt a year (82.91 Mt minerals, 13.24 Mt installations) and 2.61 M colonists, and burns 34.19 ML of fuel on its routes.

**Caveats.**

- Commander, governor and admin Logistics bonuses aren't applied, so handling errs long.
- Bodies sit at their current place in orbit, and refuelling stops, overhauls and Aurora's increment rounding aren't counted.
- Fuel assumes the set speed throughout.
- Tractor-and-trailer pairs aren't modelled.
- The page carries an "Estimates" chip.

## Empire History

**What it answers.** How has my empire grown? The save keeps a year of wealth data and a few weeks of the mineral ledger, nothing more, so the app keeps its own record.

**Recording** (`plugins/history.js`, `utilities/history.js`):

- Each time the save is opened or changes (the `database` swap the file watcher already triggers), the plugin snapshots every player race in the save (`NPR = 0`, every game), then commits `history/recorded` so an open History page re-reads.
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
- Merge rules:
  - another game name under the same IDs starts over;
  - a snapshot at a recorded time replaces it;
  - an earlier time (an older save loaded) drops everything after it, since that future didn't happen.
- Past 2,000 snapshots per race, the older half is thinned to every other one, so a long campaign keeps its whole span at a coarser grain: about 1 MB per race at the cap.
- A failed snapshot is logged and skipped; the next save tries again.

**Layout.**

- A header with the count and span, a chart/table toggle, CSV export and Clear (with a confirmation).
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

**Checks** (Playwright on a scratch copy):

- Opening the copy recorded 1 snapshot. Five simulated saves 30–90 days apart made 6, with population rising from 15.261 bn to 15.325 bn.
- Moving the time back 100 days left 5, the later ones dropped. Saving the same time again kept 5.
- The web shim stored it under its own key (`aurora-electrons:history`), apart from the settings.
- Clear emptied the record and showed the "starts here" notice.
- The merge and thinning helpers pass five Node cases: order, replace, rewind, new game, and thinning that keeps the span and the recent half.

**Caveats.**

- History starts when this version is installed, and only grows while the app is open when Aurora saves.
- Web mode stores it in localStorage through the shim. Electron's real `history.json` (its path, and electron-store in the renderer with a store name) isn't exercised in web mode.

## Open items

- `information.vue`'s doubled shuttle technology (above).
- The Commanders page could assign governors greedily by importance, as Aurora does, instead of counting overlaps.
- Hauling could add travel between systems once the jump graph (G2) exists. Each fleet's route already walks its own jumps.
