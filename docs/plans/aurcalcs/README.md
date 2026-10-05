# New pages from Aur_Calcs: ranked plan

> **Status:** Mineral Runway (1) and Mining Outlook (2) are built, together as the **Outlook** tab (`pages/mineral-outlook.vue`), with Chart.js for charts (G3) and the shared production mixin (G1, partly). The rest is waiting for prioritisation.

This plan lists features from the Aur_Calcs workbook (`references/aurcalcs/`) and its companion SQL collection (`references/queries/`) that Aurora Electrons doesn't have yet. It ranks them by utility and beauty, and gives a short action plan for each. The status line above says what's built. Pick the order for the rest, and comment on the PR with changes.

The SQL is in three appendices. Every query there was run read-only against the sample save (GameID 140, RaceID 784), and the row counts and sample rows are quoted with it:

- [`sql-mining.md`](sql-mining.md): Mining Outlook, Mineral Runway, Colonization Targets, Survey Progress.
- [`sql-economy.md`](sql-economy.md): Colony Outlook, Maintenance Budget, Fuel Balance, Shipyard Planner.
- [`sql-fleet.md`](sql-fleet.md): Finances, Commanders, Fleet hygiene warnings, Route Finder, Lagrange Points, Hauling Planner.

All of it follows the app's rules (`CLAUDE.md`):

- Every query is scoped by `GameID`, and by `RaceID` for race-owned data.
- Fog of war is respected through the race-knowledge tables.
- Nothing writes to the save.
- No views. The workbook reads 25 `vw_*` views that its author created inside their save. Each one became an inline query or CTE here, so nothing needs to be installed in users' saves.

## How the candidates were chosen

The workbook has 62 sheets:

- 25 are data sheets (`*_src`) filled from the views.
- About 12 are connecting sheets: lookups, constants, intermediate columns, scratch work. They aren't features.
- The rest are features. They were checked against what the app's pages already show, and only the new parts made the list.

The query collection was swept the same way. Its 172 scripts include at least 37 that write to the save, plus many that depend on the author's fleet-naming conventions. Only read-only, convention-free logic was kept.

Scores:

- **Utility** (1–5): how often a player would use the page, and how many decisions it informs.
- **Beauty** (1–5): how good it can look, meaning charts, timelines and map overlays, not just a table.
- **Effort**: S is about one page with one or two queries; M is a page with several queries and some maths; L is several views or shared groundwork first.

## Ranked list

| # | Page | Category | Source | Utility | Beauty | Effort |
|---|---|---|---|---|---|---|
| 1 | [Mineral Runway](#1-mineral-runway) ✅ | Mining | Minerals sheet, `mineral use.sql`, `Minerals on Ships.sql` | 5 | 5 | M |
| 2 | [Mining Outlook](#2-mining-outlook) ✅ | Mining | OrbMin, SurfMin, OrbMin_src | 5 | 4 | M |
| 3 | [Colony Outlook](#3-colony-outlook) | Colonies | Pop, Species | 5 | 4 | L |
| 4 | [Finances](#4-finances) | Economy | `Wealth Use.sql`, `WealthUseByTypeByDay.sql` | 4 | 5 | S |
| 5 | [Survey Progress](#5-survey-progress) | Exploration | Survey, GrndSurvey | 4 | 5 | M |
| 6 | [Fuel Balance](#6-fuel-balance) | Logistics | BigPlan, FuelUse, FuelFairies, SorHarv_src | 4 | 4 | M |
| 7 | [Colonization Targets](#7-colonization-targets) | Colonies | ColTargs, CCOver, TFPlan (2) | 4 | 4 | M |
| 8 | [Maintenance Budget](#8-maintenance-budget) | Logistics | Pop (MSP), BigPlan, `ShipSizeAndCostByPopulation.sql` | 4 | 3 | M |
| 9 | [Commanders](#9-commanders) | Personnel | `Commander List with Bonuses and Traits.sql`, Yearly 26/27 | 4 | 3 | M |
| 10 | [Fleet hygiene warnings](#10-fleet-hygiene-warnings) | Fleet | Yearly checklist queries | 4 | 2 | S |
| 11 | [Route Finder & Distances](#11-route-finder--distances) | Exploration | JPs, JPRoutes, SysInfo, `dfs.sql` | 3 | 5 | M |
| 12 | [Empire History](#12-empire-history) | Economy | Yearly | 3 | 5 | L |
| 13 | [Shipyard Planner](#13-shipyard-planner) | Industry | Yards, ShipyardGrowth, QCalc | 3 | 3 | M |
| 14 | [Hauling Planner](#14-hauling-planner) | Logistics | Scoop, CyclingFleets, CyclingTotals, HaulCap_src | 3 | 3 | L |
| 15 | [Lagrange Points](#15-lagrange-points) | Exploration | `AllLagrangePoints_Basic.sql` | 2 | 3 | S |

Sorted by utility, then beauty. My suggested build order is different, because some pages share groundwork; see [Suggested order](#suggested-order).

## Shared groundwork

Several pages need the same pieces. Building them once avoids four copies of the bonus maths.

- **G1. Production and bonus mixin.**
  - Move `populationProductionModifiers` and the capacity helpers out of `index.vue` (lines ~535–581, 629–658, 675–694) into a mixin. Mining Outlook, Colony Outlook, Fuel Balance, Maintenance Budget and Shipyard Planner all need them.
  - Fix the naval admin chain at the same time (see [Found along the way](#found-along-the-way)), and make it return the Mining and Survey bonuses as well as Terraforming.
- **G2. Jump graph and distances.**
  - Load the race's explored jump points and run a Dijkstra in JS, ordering routes by fewest jumps, then by distance. A Vuex module can then hold "jumps and km from the capital" for every system.
  - Route Finder is built on it. Colonization Targets, Survey Progress and Hauling use it for distances. (`sql-fleet.md` § 4)
- **G3. Charts.** ✅ Built with Mineral Outlook.
  - Seven of these pages want line, area or stacked-bar charts. Before this work, the app had no charting library (cytoscape and pixi.js only).
  - Chart.js, used directly behind one small wrapper, `components/charts/ChartCanvas.vue`, that takes series and follows the Vuetify theme. The palette and theme tokens are in `components/charts/theme.js`.
- **G4. Mineral ledger.**
  - Aurora 2.6+ logs every mining, usage and transfer event per mineral in `FCT_RaceMineralData`.
  - It's the most accurate production and consumption source for Mineral Runway, and it validated the surface-mining formula used by Mining Outlook: across 385 colony × mineral series, the median error is 1e-15. (`sql-mining.md` § 2a)

## Features

### 1. Mineral Runway

*Mining · Utility 5 · Beauty 5 · Effort M · SQL: `sql-mining.md` § 2*

**What it answers.** Will I run out of Gallicite, and when? Per mineral it shows:

- stockpile, and minerals in transit on ships
- production and consumption per year
- net per year, and years of stock left
- what the industrial queue will consume over the next year

**What it shows.**
- 11 mineral cards with stock, net/yr and a runway bar, red when under N years.
- A stacked area chart of the ledger (production against usage by purpose) over the history the save holds.
- A "next year's queue demand" bar next to stock.

**Action plan.**
1. G4: load `FCT_RaceMineralData` grouped by mineral, type and increment.
2. Add stock, ships' cargo (`CargoTypeID = 3`) and mass-driver packets in flight (§ 2a).
3. Queue demand: project the mineral costs of `FCT_IndustrialProjects`, capped at one year, adding queued items until the year is used (§ 2b). Reuse the construction-capacity helpers from G1.
4. Fallback for pre-2.6 saves without a ledger: production from Mining Outlook's rates, consumption from queue demand only.
5. Add a page with a `<v-tab>` and a `title()` case, or a tab inside Minerals (open question 2).

**Caveats.** The ledger keeps only recent history (about 40 days in the sample), so the chart shows the recent trend. Totals are annualised from it.

### 2. Mining Outlook

*Mining · Utility 5 · Beauty 4 · Effort M · SQL: `sql-mining.md` § 1*

**What it answers.** For every deposit the race mines (mines, automines, CMCs, orbital miners): its current accessibility, the rate with all bonuses, the years until it starts losing accessibility (half mined), and the years until it runs dry.

**What it shows.**
- A table sorted by years to depletion, coloured by urgency.
- Per deposit, an expandable chart of accessibility and output over time, with a marker at the halfway point.
- A "colonies whose best mineral runs out within N years" summary.

**Action plan.**
1. Surface query, one row per colony × deposit, with mines split into manned (scaled by `FCT_Population.Efficiency`) and automated. Governor and sector bonuses apply. (§ 1a)
2. Orbital query, one row per mining ship × deposit, with commander and naval-admin Mining bonus (§ 1b, § 1c). This needs G1's admin-chain fix.
3. Port `depositForecast()` and `depositSeries()` from § 1d into `utilities/`.
   - They use the closed-form accessibility decline: below half, accessibility = 0.1 + (OriginalAcc − 0.1) × Amount / HalfOriginalAmount.
   - The fit was confirmed on 37 declining deposits. The workbook's own total double-counts the above-half tonnage; the formula here doesn't.
4. Cap the display at "> 10,000 y". The sample's colonies sit on effectively bottomless deposits, so test with the workbook's real rows quoted in § 1d.

**Caveats.**
- The orbital rate formula is the workbook's and is unverified: the sample has no player orbital miners.
- Radiation, unrest and political modifiers are in the formula but are all 1.0 in the sample.

### 3. Colony Outlook

*Colonies · Utility 5 · Beauty 4 · Effort L · SQL: `sql-economy.md` § 1*

**What it answers.** Where will growth stall, where am I short of workers or wasting them, and how much construction will the growth need? Per colony:

- growth per year, and projected population in N years
- how full the body is, and months until infrastructure caps growth
- the worker split (service, agriculture, manufacturing) and free or missing workers, now and in N years
- colonists and installations already en route

**What it shows.**
- A table with a stacked worker bar per colony.
- A population projection sparkline with the body and infrastructure caps as ceilings.
- Highlights for colonies that will hit a cap within N months.

**Action plan.**
1. G1 first.
2. Colonies query (§ 1A).
   - Use `ReqInf / Population` for infrastructure per million, not `LastColonyCost`, which is stale: it's non-zero for 34 of the sample's 39 colonies while only one has a real colony cost now.
   - The worker model reproduces the save's stored `Efficiency` for all 39 colonies (max error 0.0006), so it can be trusted.
3. Inbound colonists and installations from unload orders (§ 1B).
4. Growth projection in JS: the docs give the capacity fall-off above one third; the base rate comes from the workbook.
5. Link to the Warnings page's low-efficiency list rather than repeating it.

**Caveats.**
- The base growth rate formula is only in the workbook, so label it an estimate. One way to check it is two saves of the same game.
- Orbital (Ark) population isn't modelled.

### 4. Finances

*Economy · Utility 4 · Beauty 5 · Effort S · SQL: `sql-fleet.md` § 1*

**What it answers.** Where does my wealth come from, and where does it go? It shows income against spending by category over the last year, the current treasury, and an estimated treasury curve.

**What it shows.**
- Stacked bars per 5-day step, income above the axis and expenses below.
- Category totals as a ranked list.
- A treasury line reconstructed backwards from `WealthPoints`.

**Action plan.**
1. Totals, series and treasury queries (§ 1).
2. JS: sign each row from `DIM_WealthUse.Income`, derive the step length from the data rather than hard-coding 5 days, filter shorter windows client-side.
3. A good first page for the G3 chart component: small, all real data, and visually rich.

**Caveats.**
- The save keeps exactly one year of wealth history.
- The meaning of `AnnualWealth` is inferred, so omit it or label it.

### 5. Survey Progress

*Exploration · Utility 4 · Beauty 5 · Effort M · SQL: `sql-mining.md` § 4*

**What it answers.** How much exploration is left, and who's doing it? Per known system:

- gravitational survey locations done and remaining
- geological bodies done and remaining, with points needed
- assigned survey ships and their rates, and a points-based ETA
- ground survey teams with points per day and completion dates

**What it shows.**
- A map overlay colouring systems by remaining survey work. This is the beautiful part; it reuses the Galaxy map.
- A table per system, and a ground-survey timeline.

**Action plan.**
1. Gravitational, geological, ships, orders and ground-survey queries (§ 4a–4d).
2. Points remaining = Radius/100, × 1 for gas giants and × 10 for everything else. This was checked on a sample asteroid.
3. ETA = points / (ship sensor rate × commander Survey bonus × naval-admin Survey share). Travel time between locations needs G2.
4. Overlay: colour the map's cytoscape nodes from the per-system totals.

**Caveats.**
- The save stores no partial survey progress, so the ETA covers survey points only, not travel.
- The sensor rate unit (points per hour) is assumed.
- Whether `SurveySpeed` applies to ground teams is unsettled.

### 6. Fuel Balance

*Logistics · Utility 4 · Beauty 4 · Effort M · SQL: `sql-economy.md` § 3*

**What it answers.** Is my fuel economy sustainable? It shows:

- fuel stock in colonies and in tankers or stations
- production per year from refineries and from sorium harvesters (with the deposit they're draining)
- the sorium stock that feeds refineries
- a consumption estimate, and years of stock

**What it shows.**
- A production-against-consumption balance gauge.
- Stock as a runway.
- A per-class burn chart.
- Harvesters with their deposit's remaining amount (it reuses Mining Outlook's forecast).

**Action plan.**
1. Colony fuel and refinery query (§ 3A), harvesters with the fog-of-war guard (§ 3B), and fuel held on ships (§ 3E).
2. Consumption proxy from the save instead of the workbook's hand-typed "tank days" (§ 3C):
   - each ship's lifetime duty cycle, `DistanceTravelled / (age × MaxSpeed)`, times its burn at full power;
   - plus a "moved in the last increment" flag for current burn;
   - shown as a range, not one number.
3. Naval admin Mining bonus for harvesters (§ 3D) needs G1.

**Caveats.**
- Harvester output per module is the workbook's assumption, and the wiki says otherwise. Label it an estimate until it's checked against an in-game fleet.
- It's unknown whether the species production modifier applies to fuel.

### 7. Colonization Targets

*Colonies · Utility 4 · Beauty 4 · Effort M · SQL: `sql-mining.md` § 3*

**What it answers.** Where should I colonise or mine next? Habitability already computes colony cost, max population and terraforming time. This page adds:

- the workbook's weighted mineral score
- CMC (civilian mining complex) qualification
- distance from the capital
- a combined rank

**What it shows.**
- A bubble scatter: colony cost on one axis, max population on the other, bubble size for mineral score, colour for distance.
- A ranked table next to it.
- An optional map overlay of the top N targets.

**Action plan.**
1. Bodies query (§ 3), merged by `SystemBodyID` into Habitability's `calculatedBodies`, so the colony-cost maths isn't duplicated.
2. Mineral score: a weighted sum of accessibility over deposits above a minimum amount. The workbook's weights are the defaults; make them editable and store them in `this.config`.
3. Distance from the capital comes from G2.
4. Decide whether this is a new page or a "Targets" mode of Habitability (open question 2).

**Decided.** The qualifying minerals are a setting (`cmcMinerals`), defaulting to Duranium or Gallicite as the workbook does (the docs say Duranium only). The Minerals page already marks qualifying bodies; this page should read the same setting.

### 8. Maintenance Budget

*Logistics · Utility 4 · Beauty 3 · Effort M · SQL: `sql-economy.md` § 2*

**What it answers.** Will my fleets stay maintained? Per colony and empire-wide:

- MSP stockpile, and production per year from maintenance facilities
- upkeep per year of the ships assigned to the colony
- net per year, runway in years, and MSP carried by supply ships

It's the data behind the game's own Empire Logistics Summary, which the app doesn't show.

**What it shows.** A table with runway bars, and flags for "turn production on" and "stock above N years of upkeep, so production can stop".

**Action plan.**
1. Maintenance per colony (§ 2A) and supply ships with spare MSP (§ 2B).
2. JS:
   - MSP/yr = facilities × racial rate × 4 × modifiers. The ×4 is real: the tech value is in BP, and 1 MSP = 0.25 BP.
   - Upkeep = maintained cost / 4 plus overhaul cost, scaled by maintenance capacity coverage.
3. Pair it with Fuel Balance on one "Logistics" page, as the game's summary does (open question 2).

**Caveats.**
- MSP is drawn where a ship is, not where it's assigned. Assigned upkeep is the planning figure, so show in-orbit tonnage next to it.
- It's unknown whether the species production modifier applies to MSP.

### 9. Commanders

*Personnel · Utility 4 · Beauty 3 · Effort M · SQL: `sql-fleet.md` § 2*

**What it answers.** Who's available, and who would do a job better? It has:

- a filterable roster: type, rank, assignment, age, health, bonuses and traits
- candidate views:
  - idle administrators who beat a colony's governor on its priority bonuses
  - idle same-field scientists who'd run a project faster
  - idle officers with Mining, Terraforming or Survey bonuses for specialist ships

**What it shows.**
- The roster with bonus chips, paginated: the sample race has 19,853 commanders.
- "Suggested swaps" cards.

**Action plan.**
1. Roster query, with bonuses aggregated once in a CTE (0.2 s for 19,853 rows), and lookups for bonus types and traits (§ 2).
2. Server-side filtering with Sequelize `replacements` for typed text, as `CLAUDE.md` requires.
3. Candidate queries (SQL B–G in § 2).
   - Ranking in JS. For scientists, reuse the research-bonus formula in `index.vue`: in field 4b − 3, out of field b.
   - Assign greedily down the colony importance list, as Aurora does.
4. Age = species `GraduationAge` + years since `CareerStart`. Don't hard-code 21: the sample has a species at 30.

**Caveats.**
- The labels for secondary ship posts (`CommandType` 8, 9, 10, 11, 15) are inferred.
- The `HealthRisk` scale is undocumented, so show the raw value.

### 10. Fleet hygiene warnings

*Fleet · Utility 4 · Beauty 2 · Effort S · SQL: `sql-fleet.md` § 3*

**What it answers.** What's quietly broken in my fleets? These are new sections for the Warnings page. Each is a convention-free version of the author's yearly checklist:

- W1 idle fleets
- W2 cargo with no orders
- W3 survey orders without the matching sensor
- W4 orbital miners at bodies they can't mine
- W6 mining colonies without a mass-driver destination
- W7 ships missing crew
- W8 classes with an outdated crew design efficiency
- W9 prototypes marked for research with no project
- W10 fleets assigned to a population that no longer exists

**Action plan.**
1. One `asyncComputed` per warning, in the Warnings page's list style.
2. W1 is noisy in saves where home fleets are parked on purpose (134 of 136 in the sample). Default to "not at an own colony", add a toggle, and store per-fleet ignores under `game.<GameID>.race.<RaceID>.idleFleetExclusions`.
3. W6 excludes hubs (colonies that other colonies send to), replacing the author's `%HUB%` naming convention.

**Caveats.**
- Most return 0 rows on the sample. They were proven on a copy of the save with injected rows.
- W5 (mines without deposits) already exists as `wastedMiningCapacity`.

### 11. Route Finder & Distances

*Exploration · Utility 3 · Beauty 5 · Effort M · SQL: `sql-fleet.md` § 4*

**What it answers.** How do I get from A to B, and how far away is everything? It finds the shortest jump route between two known systems over explored jump points, with the in-system leg distances, the total distance and the travel time at a chosen speed.

**What it shows.**
- The route highlighted on the Galaxy map, with a leg-by-leg list.
- A "distance from capital" layer.

**Action plan.**
1. Node, edge and capital queries (§ 4); optionally Lagrange point nodes for intra-system jumps.
2. JS Dijkstra over the state (system, entry jump point), with cost ordered by jumps, then km.
   - This reproduced the exact jump sequence of 109 of 110 routes stored in the sample's move orders. Pure-distance routing matched only 92.
3. Avoid options: restricted, alien-controlled or dangerous systems, mirroring the fleet's own flags.
4. Expose distance from the capital through G2 for other pages.

**Caveats.** Body positions are current orbital positions, so the last leg is approximate.

### 12. Empire History

*Economy · Utility 3 · Beauty 5 · Effort L · no new SQL*

**What it answers.** How has my empire grown? The workbook's Yearly sheet is a hand-typed year-by-year log: population, workers, tonnage by type, installations, and income against expenses.

The save keeps no history beyond a year of wealth data and a few weeks of the mineral ledger. So this page means the app recording its own snapshots.

**Action plan.**
1. On each save change (the file watcher already fires), compute a small snapshot from existing queries: population, workers, tonnage by type, installation counts, treasury and mineral stock.
2. Store it per game and race. electron-store works but grows; a JSON file per game in the app's data folder is another option. This is open question 3.
3. Multi-series line and area charts over game time (G3).

**Caveats.**
- History starts when the feature is installed.
- It's the first thing in the app that writes data about a game (not to the save). Its size and retention need deciding.

### 13. Shipyard Planner

*Industry · Utility 3 · Beauty 3 · Effort M · SQL: `sql-economy.md` § 4*

**What it answers.** What can my yards do, and what will expanding them cost? Per shipyard:

- type, capacity, slipways, tooled class and busy slipways
- BP per year per slipway with all bonuses
- build time of its class
- cost and time to add capacity, add a slipway, or retool

It also has a what-if for any class at a chosen yard, and a "share of construction needed to build these components by a deadline" calculator (QCalc).

**Action plan.**
1. Shipyards, tasks, classes, class components and component stock queries (§ 4).
2. JS from G1, plus a closed form for continual capacity upgrades. It matches the iteration in `index.vue` to within one construction period.
3. Retool cost = class cost × (0.5 + 0.25 × slipways), from the wiki.

**Caveats.**
- The cost of adding a slipway isn't documented anywhere. Label it an estimate until a save with an add-slipway task can calibrate it.
- Light Naval yards are absent from the sample.

### 14. Hauling Planner

*Logistics · Utility 3 · Beauty 3 · Effort L · SQL: `sql-fleet.md` § 6*

**What it answers.** How much do my freighters move? It covers freighter capacity per class and the throughput of fleets on repeat orders: round-trip distance, trips per year, cargo per year and fuel per year.

**What it shows.** A table per cycling fleet. A cargo-flow diagram (destination × cargo type) is possible later.

**Action plan.**
1. Classes, cycling fleets (`CycleMoves = 1`) and orders with destination coordinates (§ 6).
2. Walk each fleet's orders to sum the round trip. 33 of the 46 sample fleets compute fully; the rest include Lagrange or other order types.
3. Later: totals by destination and cargo type (the workbook's CyclingTotals).

**Caveats.**
- The workbook's demand side (which minerals need moving where, in the Scoop sheet) needs Mining Outlook first.
- Tractor-and-trailer pairs need more design.
- The results are upper bounds: they ignore loading time and refuelling.

### 15. Lagrange Points

*Exploration · Utility 2 · Beauty 3 · Effort S · SQL: `sql-fleet.md` § 5*

**What it answers.** Which planets and moons have a stable Lagrange point, and how long would a stabilisation ship take on the others? The time is 5/√mass years, which matches the docs' 60/√mass months.

**Action plan.**
1. One query (§ 5).
2. Show it as a panel or filter on the Galaxy map or Route Finder: "cheapest LP to add", and systems with colonies.

**Caveats.** Five gas giants above the docs' "always stable" mass (150) have no Lagrange point row. Trust the row, not the mass rule.

## Suggested order

This is my recommendation for the order to build in, taking the shared groundwork into account. It's yours to change.

1. **Finances (4).** It's small and needs only real data. The chart component (G3) is already built.
2. ~~**G1 mixin + G4 ledger, then Mineral Runway (1) and Mining Outlook (2).**~~ Built as the Outlook tab. G1 is partly done: the Production page still has its own naval admin code (see [Found along the way](#found-along-the-way)).
3. **Colony Outlook (3).** It's the biggest of the high-utility pages and builds on G1.
4. **Fleet hygiene warnings (10).** These are quick wins between the larger pages.
5. **G2 jump graph, then Survey Progress (5), Route Finder (11) and Colonization Targets (7).** All three need distances.
6. **Fuel Balance (6) + Maintenance Budget (8)** as one Logistics page.
7. **Commanders (9), Shipyard Planner (13), Hauling (14), Lagrange (15), Empire History (12).**

## Not ported

**Data and connecting sheets:**
- All `*_src` sheets.
- Race, Species, BonusCheck, Lookup, NPR Chance, SysInfo (its distances become G2), JPs and JPRoutes (become G2), DistanceOverride.
- ColonyPlans (manual plan input), TFWork (scratch work with broken references), JP Math (probability scratch).

**Calculators the app already covers:**
- **Propulsion** overlaps the Engines page. A speed-against-range heat map could be added there later.
- **Sensors** overlaps Designed Tech. A "range against target size" line chart per sensor is a possible small addition.
- **Speed** is a unit cheat sheet.
- **UndergroundInfr** is a one-line formula.
- **FleetFuelBurn** is a tug-and-trailer scratchpad.

**Mostly covered:**
- **TFPlan (2)** overlaps Habitability. Its new parts (mineral score, CMC, distance) moved into Colonization Targets.
- **TFBodies'** phased terraforming plan is note-driven. The Habitability page's terraformation plan covers most of it.

**From the query collection:**
- every write script;
- queries that depend on the author's fleet names (station fleets, `___GAS`, `.zip` and so on);
- queries that read global tables without fog of war (`Survey Point Type Ratio.sql`, `Non-populated NPR-candidate Planets.sql`, `NPR Missile Stockpiles.sql`);
- queries that duplicate existing pages (damaged ships, active fire controls, colonies without a governor, shipyards).

## Found along the way

These are existing-code issues the analysis turned up. Each gets its own fix; the ones done so far are marked.

1. ~~**Fog-of-war leak in Minerals**~~ **Fixed.** The survey subquery's `left join FCT_Race` didn't filter, so deposits on bodies surveyed by any race showed up: 5,368 deposits instead of 5,327 in the sample. It's now scoped to the race's own `FCT_SystemBodySurveys` rows.
2. **Naval admin bonus chain** (`index.vue` ~660–672 and ~808). The query hard-codes commander bonus 9 and doesn't select `ParentAdminCommandID`, so the recursion never climbs past the first admin command. The sample has nested commands (1350 under 1345). G1 fixes it.
3. **`wastedMiningCapacity`** (`warnings.vue` ~716) counts every installation with `MiningProductionValue > 0`. That includes Conventional Industry and CMCs. Narrow it to mines, automated mines and forced-labour mining camps if false positives show up.
4. **`FCT_Population.LastColonyCost` is stale.** The app doesn't use it, but any future page should use `ReqInf` instead (Colony Outlook).
5. **The Production page never applies naval admin bonuses** (`index.vue` `navalAdminBonus`). Its range check calls `administration.Systems.has(SystemID)` with a number, but the set holds system objects, so the check always fails and orbital terraformers get no admin bonus. Its range is also wrong once the check is fixed: `adminsWithSystems` walks `NavalAdminCommandLevel` jumps (4,096 on the sample's homeworld) instead of the radius, and the unused `Radius` it computes is one jump short (`floor(log2(level))`, no `+ 1`). It also ignores flag-bridge commands and commander rank. The Outlook page uses its own helpers in `utilities/minerals.js` (`navalAdminRadius`, `navalAdminRequiredRanks`, `navalAdminChainBonus`); G1 should move the Production page onto them.

## Open questions for you

1. ~~**Charts:** add Chart.js or draw SVG by hand?~~ Chart.js, decided.
2. **Navigation:** there are already 9 tabs. Group the new pages (for example Economy: Finances, Runway, Fuel, Maintenance; Colonies: Outlook, Targets; Exploration: Survey, Routes) or keep one tab per page? Should Colonization Targets and Mineral Runway be tabs inside Habitability and Minerals?
3. **Empire History storage:** is the app allowed to keep its own per-game snapshot history, and where: electron-store, or a file per game?
4. **Estimates:** for the formulas that are only in the workbook (population growth rate, harvester output, add-slipway cost), is an "estimate" label enough, or should those columns wait until they're confirmed in game?
