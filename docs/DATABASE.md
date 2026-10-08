# The Aurora save database

Aurora (C#) stores everything in one SQLite file, `AuroraDB.db`. That includes static reference data, every game in the install, and each race's view of the galaxy. Aurora owns this file and rewrites it whenever the player saves. External edits made while a game is loaded in Aurora can be overwritten by its next save.

## Sample save (`fixtures/AuroraDB.zip`)

| | |
|---|---|
| Size | 39 MB unzipped, 13.7 MB zipped, 214 tables |
| Game | GameID **140**, "Aurelian Empire", `StartYear` 1, `GameTime` ≈ 300.8 years |
| Player race | RaceID **784**, "Aurelian Empire", with 75 populations |
| NPRs | 14 races (785–800): Eldar, "Precusors" (sic, as it appears in the save), Ancients, Invaders, and Rakhas groups |
| Volume | 170 systems, 247 stars, 10,698 system bodies, 83 populations, 1,550 ships, 8,482 log events, 2,716 tech systems |

It's a mid/late-game save, which makes it good for exercising most pages. Some tables are empty in it, though: `FCT_ResearchProject`, `FCT_ResearchQueue`, `FCT_ShipyardTask`, `FCT_GroundUnitTraining`, `FCT_Contacts`, `FCT_AetherRift`, `FCT_Lifepods`, `FCT_ShippingLines`, and `FCT_PopInstallationDemand`. The features that read them (parts of Production, plus some warnings) will show nothing against the sample.

## Naming and scoping

- **`DIM_*`** tables are game-independent reference data: installation types, gases, stellar types, event types, tech types, research fields, and so on. They have no `GameID`, except `DIM_KnownSystems` (the real star catalogue the map uses for X/Y/Z).
- **`FCT_*`** tables are per-game facts. Almost all of them carry `GameID`. Race-owned ones also carry `RaceID`: 62 tables across the schema do.
- A handful of undecorated legacy tables mix both kinds. `GovType`, `FGNicknames`, and `PhoneticNames` are reference data. `ForeignAid`, `Wormholes`, `MissileSeries`, and `RaceCompare` are per game or per race, and the last two have no `GameID`. Check their columns before relying on them.
- **Always filter by `GameID`,** because one file can hold several games. Filter race-owned data (populations, fleets, ships, classes, tech, log) by `RaceID` as well.

### Per-race knowledge (fog of war)

Aurora keeps the shared truth in global tables and each race's knowledge in separate tables. To show the player only what their race knows, join through the knowledge tables:

| Knowledge | Table | Notes |
|---|---|---|
| Known systems | `FCT_RaceSysSurvey` (RaceID, SystemID) | The race's name for the system, map `Xcor`/`Ycor`, `ControlRaceID`, `SectorID`, `SurveyDone`, `DiscoveredTime` |
| Body names | `FCT_SystemBodyName` (RaceID, SystemBodyID) | Custom names only. Unnamed bodies get a name derived by `systemBodyName()` |
| Geological surveys | `FCT_SystemBodySurveys` (RaceID, SystemBodyID) | Rows exist only for surveyed bodies. Mineral data should be hidden otherwise |
| Gravitational surveys | `FCT_RaceSurveyLocation` | Against `FCT_SurveyLocation` |
| Jump points | `FCT_RaceJumpPointSurvey` | `Charted`, `Explored`, `Hide` |
| Other races | `FCT_AlienRace` (AlienRaceID, ViewRaceID) | What `ViewRaceID` knows about `AlienRaceID`: name, `ContactStatus`, treaties. Use `ViewRaceID = <selected race>`, and fall back to "Unknown" when there's no row |
| Researched tech | `FCT_RaceTech` | Against `FCT_TechSystem` |

The settings toggle `spyNPR` exposes NPRs in the race picker. That's the only intended way to look at another race's data.

### Races

`FCT_Race.NPR` marks non-player races. A non-zero `SpecialNPRID` marks the special factions: 1 Precursors, 2 Swarm, 3 Invaders, 4 Rakhas, 5 Eldar, 6 Ancients (the sample has all but the Swarm). All 14 of the sample's NPRs are special factions, so it has no ordinary NPR empire; test NPR features on a copy with `SpecialNPRID` set to 0 for one of them. Empire History records player races and NPRs with `SpecialNPRID = 0`.

What a race knows about other races is in the `FCT_Alien*` tables, keyed by the viewing race (`ViewRaceID`, `ViewingRaceID` or `DetectRaceID`, depending on the table). Their `Actual*` columns point at the real designs, so never join them for display. Each `FCT_AlienRace` row is one race's view of another; the reverse view is a separate row. `sql-fleet.md` § 7 has the details, and `references/mechanics/intelligence.md` (the maintainer's reference for Aurora 2.7.1) the full mechanics. The codes:

| Field | Codes |
|---|---|
| `FCT_AlienRace.ContactStatus` | 0 Hostile, 1 Neutral, 2 Friendly, 3 Allied, 4 Civilian, 5 None, 6 Combat |
| `FCT_AlienRace.CommStatus` | 0 None, 1 Attempting Communication, 2 Communication Established, 3 Communication Impossible |
| `FCT_KnownSpecies.Status` | 0 Discovered, 1 Autopsied, 2 fully known (uncertain) |
| `FCT_AlienRaceSystemStatus.ProtectionStatusID` | 0 No Protection, 1 Suggest Leave, 2 Request Leave, 3 Request Leave Urgently, 4 Demand Leave, 5 Demand Leave With Threat |
| `FCT_AlienClass.EngineType` | 0 None, 1 Military, 2 Commercial, 3 FAC, 4 Survey, 5 Fighter |

Diplomatic points are separate from those codes, with their own lines: −100 hostility, 200 trade treaty, 800 geological treaty and Friendly, 2,400 gravitational treaty, 4,000 Allied, 6,000 technology treaty. The Warnings page's hostile check (`ContactStatus === 0`) and its friendly or allied skip (2, 3) match these codes.

## Data quirks

- **Booleans** are mostly `0`/`1` integers, but some rows store text such as `'FALSE'` (for example, `DIM_ResearchField.DoNotDisplay`). Coerce with `toBoolean()`/`toNumber()` from `utilities/aurora.js` rather than comparing directly.
- **Time:** `FCT_Game.GameTime` is seconds elapsed since 1 January of `FCT_Game.StartYear`. Event times such as `FCT_GameLog.Time` and `DiscoveredTime` use the same clock. Convert with `gameTime(StartYear, seconds)`, which returns a UTC dayjs. Code uses 31,536,000 seconds per year and 86,400 per day.
- **Body classes** (`FCT_SystemBody.BodyClass`): 1 is a planet, 2 a moon, 3 an asteroid, and 5 a comet. Names are derived as follows: planets are `<star letter> <roman planet number>`, moons are `… -<orbit>`, and asteroids and comets are `Asteroid #n`/`Comet #n`. Star components become letters through `convertDisplayBase(component, 26)`.
- **Names:** the system name lives on `FCT_RaceSysSurvey.Name`, because it's per race. The body name lives on `FCT_SystemBodyName.Name` when present. `populationName()` combines both with `PopName`.
- **Odd column names:** `FCT_System.Stars` (the model calls it `StarCount`), `FCT_AncientConstruct.ResearchField` (the model calls it `ResearchFieldID`), and `FCT_PopulationInstallations.PopID` (not `PopulationID`).
- Commander bonuses come from `FCT_CommanderBonuses`, joined on `BonusID`, and the bonus names are in `DIM_CommanderBonusType`. The ones used in code are 2 Survey, 3 Research, 4 Shipbuilding, 5 Production, 6 Mining, 8 Population Growth, 9 Terraforming, and 11 Ground Construction. `FCT_Commander.CommandType` identifies what a commander leads: 0 nothing, 1 ship (captain), 3 population (governor), 4 sector, 5 ground formation, 7 research project, 8 executive officer, 9 chief engineer, 10 science officer, 11 tactical officer, 12 naval admin, 15 commander air group, 17 academy commandant. `CommandID` holds the matching ID (a `ShipID` for 1 and 8–15, a `PopulationID` for 3 and 17), and `CommanderType` the officer type (0 naval, 1 ground, 2 administrator, 3 scientist). The ship posts are confirmed on the sample: every holder of 8, 9, 10, 11 and 15 has that post's bonus (1 Crew Training, 28 Engineering, 2 Survey, 21 Tactical, 7 Carrier Operations) and serves with its module (Auxiliary Control, Main Engineering, Science Department, Combat Information Centre, Primary Flight Control).
- **Rank levels:** `FCT_Ranks.Priority` 1 is the highest rank, per `RankType` (0 naval, 1 ground). A rank's level is the lowest rank's `Priority` − its own + 1, and a class's `RankRequired` is the captain's level (all 1,407 captains on the sample match). Secondary officers serve one level below the captain. Administrators and scientists have `RankID = 0`.
- **Move orders:** `FCT_MoveOrders` rows run in `MoveOrder` sequence; `FCT_Fleet.CycleMoves = 1` repeats them. `DestinationType` 1 is a jump point (`DestinationID` is the entry `WarpPointID`; the exit is `NewWarpPointID`, or the entry's `WPLink`), 2 and 15 a body (`SystemBodyID`), 12 an intra-system jump between Lagrange points (`FCT_LagrangePoint` from `DestinationID` to `DestinationItemID`; it has `Xcor`/`Ycor`). "Load Mineral Type" (action 178) carries `MaxItems` tonnes; the sample's every such order sets it.
- **Cargo shuttles:** a class's `CargoShuttleStrength` is already its bays × the bay component's strength (one `Cargo Shuttle Bay - Autonomous` is 50). `FCT_Race.CargoShuttleLoadModifier` is the race's shuttle technology (50 on the sample).

- **Mineral ledger** (Aurora 2.6+): `FCT_RaceMineralData` logs every mineral movement per population, mineral (`MineralID` 1–11), type and time, in tonnes, always positive. `DIM_MineralDataType.Income` says which direction a type is. Types 7, 8, 12 and 13 (freighter and mass-driver transfers) and 20 (starting stockpile) move minerals between your own colonies, so leave them out of empire totals. Mining events come once per production cycle (5 days in the sample), and the sample holds about 40 days. All production-phase types (mining, construction, ordnance, fuel refining, maintenance…) share those ticks, so count cycles by distinct `Time` across them, never by rows: one tick logs several types. Freighter and mass-driver receipts (7, 8, 13) land between ticks. The save doesn't store the cycle length (`FCT_Game.MinConstructionPeriod` is about a day). Mineral Outlook annualises it and groups the types in `utilities/minerals.js` (`FLOW_GROUPS`).
- **Production checked against the ledger:** fuel refining (type 14, Sorium) and maintenance production (type 16) match, colony by colony, refineries × `FCT_Race.FuelProduction` / 2,000 and facilities × `FCT_Race.MSPProduction` BP a year, both times the colony's overall production modifier, species `ProductionRateModifier` included (the 1.25 colonies only match with it). MSP production uses 1 t of minerals per BP (0.1 Duranium, 0.05 Uridium, 0.1 Gallicite per MSP), and 1 MSP is 0.25 BP. Logistics caps a colony's yearly MSP by each of the three it doesn't mine on its own body: no more than its stockpile can make (stock / per-MSP cost), so a colony with none shows as blocked and one with a few tonnes as short. The docs say production halts without the minerals; mining elsewhere, orbital mining and incoming hauls are not visible.
- **Wealth history:** `FCT_WealthData` holds a year of rows, one per use and production cycle; `Amount` is always positive and `DIM_WealthUse.Income` gives the direction. `FCT_Race.AnnualWealth` is the latest cycle's income times the cycles in a year. Cycles can differ in length (construction phases), so Finances annualises by the time the cycle ends span, from the cycle end before the window (it fetches one cycle past the year for that) to the last one; with no earlier end, the first cycle is taken to last as long as the next gap.
- **Unused or misleading columns:** `FCT_ShipClass.CrewQuartersHS` is 0 for every class; `FCT_Ship.ShipFuelEfficiency` is NULL (use the class's `FuelEfficiency`); `FCT_Population.LastColonyCost` is stale (use `ReqInf`). `FCT_SystemBody.GroundMineralSurvey` is the ground-survey potential: 0 when done or none, 1–5 Minimal to Excellent.
- **Deposit accessibility** stays at `OriginalAcc` until `Amount` falls to `HalfOriginalAmount`, then falls linearly with the amount: `0.1 + (OriginalAcc - 0.1) × Amount / HalfOriginalAmount`. It reaches 0.1 as the deposit empties. Deposits that start at or below 0.1 don't decline. A ground survey can raise `Accessibility` without updating `OriginalAcc`.

## Commander bonus rules

These are the rules the production maths relies on, checked against the references below. A bonus value is a multiplier such as 1.2. A command that passes on a share `s` of it contributes `1 + (bonus - 1) * s`.

- **Sector governors** apply a quarter of each of their bonuses, by bonus type, to every colony in the sector. Use the same bonus type the planetary governor uses: Production 5, Shipbuilding 4, Terraforming 9, Ground Construction 11. Ground-unit construction is documented only as "plus any governor bonus"; ID 11 is inferred from the save's dedicated `Ground Construction` bonus type.
- **Naval Admin Commands** pass their commander's bonuses to ships using the shares in `DIM_NavalAdminCommandType`. The `Industrial` column is the share of **Mining and Terraforming**: Industrial 25%, Logistics 10%, General 5%. Orbital terraformers therefore use the admin commander's Terraforming bonus (9), not Production. Commands chain multiplicatively up the tree, but only while each command is within its parent's command radius and has a commander of sufficient rank.
  - **Radius:** a Naval Headquarters gives 1 jump plus 1 per doubling of its level (levels 1, 2, 4 and 8 give 1, 2, 3 and 4), times `DIM_NavalAdminCommandType.Radius` (2 for Patrol and Survey). The level is `FCT_PopulationInstallations.Amount × NavalHeadquartersValue`, summed per population. A command on a flag bridge (`FCT_NavalAdminCommand.ShipID > 0`) reaches only the ship's current system.
  - **Required rank:** ranks compare by `FCT_Ranks.Priority`, where 1 is the highest. A command needs a commander one rank above the best captain (`FCT_Commander.CommandType = 1`) in its directly attached fleets (`FCT_Fleet.ParentCommandID`), one above each direct subordinate's required rank and commander, and at least `MinimumRankPriority`. The game doesn't store the result. In the sample, every staffed command meets it.
- **Ship officers:** a ship's captain applies half of their Survey (and Crew Training, Engineering, Tactical, Fighter Operations) bonus; a science officer applies the full Survey bonus (docs `crew-and-commanders`). How the two combine isn't documented; Survey Progress uses the better of them. Mining and Production apply in full.
- **Under-crewed ships** (Aurora 2.6) run survey sensors, Sorium harvesters, orbital mining, maintenance, salvage, terraforming and jump-gate modules at Current Crew / Class Crew.
- **Maintenance** (docs `maintenance`): ships use MSP where they are, not where they're assigned, at class cost / 4 a year (the full cost while overhauling). A location's capacity is its colonies' facilities × racial capacity × efficiency, radiation, stability and political modifiers (each radiation and stability factor floored at 0, so a bombarded colony adds none rather than going negative), plus maintenance modules, all × the economic modifier. Above capacity every ship there is maintained, and uses MSP, at capacity / tonnage.
- **Cargo handling** (docs `logistics`): loading or unloading takes cargo points × 20 s (colonists × 10 s) / handling modifier, where the modifier is the ship's cargo shuttle bays, plus one if the colony has a spaceport or cargo shuttle station, times the race's shuttle technology. Ships up to 500 t can land and need no shuttles. An under-crewed ship takes Class Crew / Current Crew times as long (v2.6; the Hauling Planner caps the fraction at 1, as Mineral Outlook does for mining, and treats a ship with no crew as unable to load). Commander, governor and admin Logistics bonuses shorten it further. The Hauling Planner uses this; the Information page multiplies `CargoShuttleStrength` by the race modifier, counting the technology twice.
- **Governor assignment** (docs `crew-and-commanders`): candidates must have the colony's first required bonus (`FCT_Population.BonusOne`) and rank by it, then by `BonusTwo`, then `BonusThree`. A science officer's Survey bonus applies in full when the class has a Science Department; a captain applies half.
- **Ground construction elements** have capacity = construction rating × units × race construction rating × the formation commander's **Production** bonus (5) × 100 tons.

### Game-rule references

- Docs: https://aurora4x-docs.vercel.app/ (single-page app). The raw markdown is at `https://aurora4x-docs.vercel.app/current/<topic>.md`, e.g. `naval-organization`, `colonies`, `ground-forces`, `terraforming`.
- Wiki: https://aurora4x.net/wiki/ (use the bare domain; `www.` is blocked in cloud sessions). It's community-written, and some pages hedge or are out of date, so prefer the docs.
- Forum: https://aurora4x.com/ (Discourse). Steve Walmsley's patch-notes threads are authoritative. Search with `/search.json?q=<terms>`, and read a thread's raw text at `/raw/<topic id>`.

## Colony cost, capacity and terraforming rules

Checked against the save; the Colonization Planner (`utilities/habitability.js`, `terraforming.js`) implements them.

- **Colony cost** (docs `colonies`). Gas giants, super-jovians, fixed bodies and bodies heavier than the species' maximum gravity have none (-1, "N/A"). Otherwise the cost is the **largest** of these factors, not their sum: the worst dangerous gas (`DIM_Gases.Dangerous` of 2 or 3, present above `DangerousLevel / 10000` percent of the atmosphere, not frozen out, not the species' own breathing gas); temperature (degrees outside `Temperature ± TempDev`, over `TempDev`, a fifth on a tide-locked non-moon); pressure (`AtmosPress / PressMax`, at least 2, above `PressMax`); the breathable gas, only when the cost so far is under 2 (its partial pressure `GasAtm` must lie in `Oxygen ± OxyDev`, and its share `AtmosGasAmount` must be at most 30 %, else 2); water (`(20 - HydroExt) / 10` under 20 %); and low gravity (1 under `Gravity - GravDev`). Rounded to four decimals, then times `FCT_Race.ColonizationSkill` (the colonisation cost tech, 0.1 in the sample, so every cost there is a tenth). A body with eccentricity, and every moon (its parent's orbit), is also priced at periapsis and apoapsis; the worst of the three counts. Verified: a Python re-implementation predicts `FCT_Population.ReqInf` (the game stores `int(population * 100 * cost * gravityMultiplier / PopulationDensityModifier)`) for 35 of 35 own colonies of 5 M or more on the sample, and the exported Planner rows match it on 8,000 body-species pairs.
- **BaseTemp is not the column.** The game works the base temperature out again from the body's present distance (`DistanceToParent`) and star luminosity, and a moon takes its planet's. The saved `FCT_SystemBody.BaseTemp` is only written when a body changes and is stale for most eccentric orbits. The saved `SurfaceTemp` follows the recomputed value on 368 of 368 planets, 6,640 of 6,640 asteroids, 236 of 236 comets and 3,269 of 3,269 moons of the sample, against 65, 5,284, 15 and 867 for the column; three other saves agree. The Planner uses the recomputed value. The old Habitability page recomputed it for planets, asteroids and comets but used the column for moons, which skewed the periapsis, apoapsis and terraforming figures on about 350 moon-species pairs.
- **Frozen gases.** A gas is frozen out below its boiling point and the saved `FrozenOut` flag follows it. The dangerous-gas check skips frozen gases; the breathable-gas check does not look at the flag.
- **Population capacity** (docs `colonies`): `4 · 3.1416 · Radius² / 511,187,128 · 12,000 · PopulationDensityModifier` millions, times `(100 - HydroExt) / 25` (at least 0.01) above 75 % water, divided by 5 on a tide-locked non-moon, at least 0.05; 0 where the cost is N/A.
- **Infrastructure**: `ceil(cost · 100 · gravityMultiplier / PopulationDensityModifier)` per million people, with a gravity multiplier of 2 on a low-gravity body. One `Infrastructure` installation gives 1 (`DIM_PlanetaryInstallation.InfrastructureValue`).
- **Terraforming** (docs `terraforming`). A colony works on one gas at a time. Its yearly capacity, in atm of an Earth-sized body, is `(FCT_Race.TerraformingRate · output modifier · terraforming installations + orbital module output) · FCT_Game.TerraformingSpeed / 100`, scaled by `511,187,128 / (4 · 3.1416 · Radius²)` for the body, so small bodies terraform faster. The output modifier is the governor's Terraforming bonus (and a quarter of the sector governor's), the colony's efficiency, radiation, stability and political status. Nothing under 0.1 g can be terraformed. Water vapour condenses at 0.1 atm a year, evaporates at 4, a hydro extent of 1 % is 1/40 atm, and a liquid hydrosphere holds `AtmosPress · HydroExt / 100 · 0.01` atm of vapour. **`TerraformingSpeed` is 10 on the sample**, so terraforming there is a tenth of the racial rate; the old page left it out. The Planner takes a number of terraformers at the racial rate and the game speed, without commander or colony modifiers (a colony that doesn't exist yet has none).
- **Not modelled:** the output modifier, orbital terraforming modules (fleet modules and the naval admin share), the game's own distance for the map (the Planner uses the route a ship flies), and the civilian mining check's Lagrange-point condition for non-primary stars.

## Colonization Planner ranking

What the Planner calls a valuable body, and what each plan state means. The code is `utilities/colonization.js` (the ranking) and `utilities/colonization-states.js` (the states); a state is defined only in that table, and the page's "Plan states" legend prints it.

**Where the numbers come from.** What the game itself values:

- The Minerals window colours a body by colony cost: blue under 2, cyan under 3 and brown under 6, each times the race's colonisation skill. The Planner's cost bands are the same 2, 3 and 6, read on the cost before the skill (`raw`), so a race with the cost tech lands in the same band as one without. What a colony really pays is the infrastructure per million people (above), shown beside the band.
- An NPR values a deposit like this: nothing under 2,000 t, halved under 10,000 t, times 1.25, 1.5 or 2 for a deposit above 100,000, 250,000 or 1,000,000 t with accessibility above 0.4, times a factor for how little of the mineral its capital holds (3, 2 or 1.5 under 1,000, 3,000 or 5,000 t, down to 0.1 above 400,000 t). It seeds a mining colony on a body whose deposits add up to 6 and adds mines to a colony from 4. It dismisses an empty colony of cost 2 or more with nothing to mine and seeds terraforming colonies where the worst-case cost is under 1.5, falling back to under 2.5.
- The Planner uses that deposit value, with the race's shortage in place of the capital's stock: the Mineral Outlook's runway (stock plus cargo and packets, over the net loss a year from `FCT_RaceMineralData`, for the last 365 days) gives x3 under 5 years, x2 under 25 and x1.5 under 100, and 1 for a mineral that holds. A save with no ledger (before Aurora 2.6) counts every mineral once. Every mineral has the same base weight (1; the knob stays).
- Capacity and cost are the rules above; distance is the charted route from the nearest colony of 1 M or more, which is how far a freighter flies to supply it.

**Worth.** For the goal, worth = prize x cost x time x distance. The prize is the people share (`capacity / (capacity + 1,000 M)`), the mining share (`value / (value + 6)`, a civilian mining complex site that meets the game's other conditions adds the bonus to the value) or both added. Each discount is `1 / (1 + x / scale)` with x the raw colony cost (scale 3), the years of terraforming (25) and the AU from the nearest colony (60); a body with no charted route keeps 30 %. The ranking compares settling the body as it is with waiting for its terraforming plan and keeps the better. Only a place to settle (a state with `target`) that holds 50 M or more, or has a deposit value of 4 or more, or is a ready civilian mining complex site, is ranked, and only from 10 % of the best one's worth. The table's default view lists the best targets, from 25 %.

**Plan states**, first match wins. The ranking's best route for the best species decides the terraforming states.

| State | When |
|---|---|
| Colony | an own colony with people on the body |
| Outpost | an own colony with no people |
| Alien colony | intelligence shows an alien population (`FCT_AlienPopulation`) |
| Not habitable | no species can live there: too heavy, or a fixed body (gas giants are not loaded) |
| Mining colony | deposit value of 6 or more on a body that holds under the smallest colony (50 M by default) |
| Terraform to free | the best route is terraforming and its outcome is Yes: cost 0 at every point of the orbit |
| Terraform, part free | the best route is terraforming and its outcome is Partial |
| Terraform to cheaper | the best route is terraforming and the cost falls but stays above 0 |
| Free colony | raw cost 0: no infrastructure |
| Cheap, Moderate, Costly, Severe | raw cost under 2, 2 to 3, 3 to 6, 6 or more |

The two example saves have no unsettled body in Free or Cheap: a low-gravity body costs at least 1, and without a breathing gas, enough water or the right temperature a body costs 2 or more.

## Sequelize models (`src/renderer/utilities/database.js`)

`resetDatabase()` defines 23 models with `timestamps: false`. Several are marked `// INCOMPLETE`, meaning they only map the columns the app needs. Add columns as required.

| Model | Table | Model | Table |
|---|---|---|---|
| Game | FCT_Game | Star | FCT_Star |
| Race | FCT_Race | StarType | DIM_StellarType |
| LogEventType | DIM_EventType | SystemBody | FCT_SystemBody |
| LogEventColour | FCT_EventColour | SystemBodyName | FCT_SystemBodyName |
| LogEvent | FCT_GameLog | SystemBodySurvey | FCT_SystemBodySurveys |
| AlienRace | FCT_AlienRace | Fleet | FCT_Fleet |
| TechSystem | FCT_TechSystem | GroundUnitFormation | FCT_GroundUnitFormation |
| Population | FCT_Population | ResearchField | DIM_ResearchField |
| PopulationInstallation | FCT_PopulationInstallations | AncientConstruct | FCT_AncientConstruct |
| PlanetaryInstallation | DIM_PlanetaryInstallation (scope `civilianEconomy`) | AetherRift | FCT_AetherRift |
| System | FCT_System | Contact | FCT_Contacts |
| RaceSystemSurvey | FCT_RaceSysSurvey | | |

Some details:

- `LogEvent` and `AetherRift` have no primary key, so they call `removeAttribute('id')`.
- Composite keys are declared by marking several fields `primaryKey`.
- `Contact` has an `afterFind` hook that moves an included `Population` onto `Contact` for population contacts (`ContactType` 4).
- Most pages use raw SQL (`this.database.query(sql)`, which resolves to `[rows, metadata]`), because the joins are wide and aggregate-heavy. Warnings, log, and parts of the map use the models.

## Which page reads what

| Page | Main tables |
|---|---|
| Production (`production.vue`) | FCT_ResearchProject/Queue, FCT_IndustrialProjects, FCT_ShipyardTask, FCT_Shipyard, FCT_GroundUnitTraining, FCT_Population(+Installations), FCT_Commander(+Bonuses), FCT_NavalAdminCommand, FCT_AncientConstruct, FCT_AtmosphericGas, FCT_JumpPoint, FCT_RaceJumpPointSurvey |
| Warnings | Models above + FCT_Ship, FCT_ShipClass, FCT_ClassComponent, FCT_ShipDesignComponents, FCT_DamagedComponent, FCT_ArmourDamage, FCT_FireControlAssignment, FCT_Lifepods, FCT_Wrecks, FCT_MineralDeposit, FCT_SectorCommand, FCT_MoveOrders, FCT_ShipCargo, FCT_FleetStandingOrder, FCT_RaceTech, FCT_ResearchQueue |
| Minerals | FCT_MineralDeposit, FCT_SystemBody, FCT_SystemBodySurveys, FCT_RaceSysSurvey, DIM_KnownSystems |
| Mineral Outlook | FCT_RaceMineralData, DIM_MineralDataType, FCT_MineralDeposit, FCT_Population, FCT_PopulationInstallations, DIM_PlanetaryInstallation, FCT_ShipCargo, FCT_MassDriverPackets, FCT_IndustrialProjects, FCT_Ship, FCT_ShipClass, FCT_Fleet, FCT_NavalAdminCommand, FCT_Commander, FCT_CommanderBonuses, FCT_SystemBodySurveys |
| Colony Outlook | FCT_Population, FCT_Species, FCT_SystemBody, FCT_PopulationInstallations, DIM_PlanetaryInstallation, FCT_Shipyard, FCT_Commander(+Bonuses), FCT_MoveOrders, FCT_Ship, FCT_ShipCargo |
| Logistics | FCT_Population, FCT_Race, FCT_PopulationInstallations, DIM_PlanetaryInstallation, DIM_PopPoliticalStatus, FCT_Fleet, FCT_Ship, FCT_ShipClass, FCT_MineralDeposit, FCT_SystemBodySurveys, FCT_Commander(+Bonuses), FCT_NavalAdminCommand |
| Finances | FCT_WealthData, DIM_WealthUse, FCT_Race, FCT_Game |
| Survey Progress | FCT_RaceSysSurvey, FCT_System, FCT_SurveyLocation, FCT_RaceSurveyLocation, FCT_SystemBody, FCT_SystemBodySurveys, FCT_BannedBodies, FCT_JumpPoint, FCT_RaceJumpPointSurvey, FCT_Ship, FCT_ShipClass, FCT_Fleet, FCT_MoveOrders, FCT_FleetStandingOrder, DIM_StandingOrders, FCT_GroundUnitFormation(+Element), FCT_GroundUnitClass, DIM_GroundComponentType, FCT_Commander(+Bonuses), FCT_NavalAdminCommand |
| Hauling Planner | FCT_Fleet, FCT_MoveOrders, DIM_MoveAction, FCT_Ship, FCT_ShipClass, FCT_HullDescription, FCT_ClassComponent, FCT_ShipDesignComponents, FCT_Race, FCT_JumpPoint, FCT_LagrangePoint, FCT_SystemBody, FCT_RaceSysSurvey, FCT_Population, FCT_PopulationInstallations, DIM_PlanetaryInstallation |
| Empire History (recorder) | FCT_Race, FCT_Game, FCT_Population, FCT_PopulationInstallations, FCT_Ship, FCT_ShipClass, FCT_RaceTech, FCT_TechSystem, FCT_RaceSysSurvey, FCT_Commander, and the Intelligence known-races query; the page itself reads DIM_PlanetaryInstallation and the history file |
| Intelligence | FCT_AlienRace (the viewer's records, plus the alien's treaty flags toward the viewer), FCT_Game, FCT_AlienClass, FCT_AlienClassWeapon, FCT_ShipDesignComponents (weapon names), FCT_AlienShip, FCT_AlienPopulation, FCT_AlienSystem, FCT_RaceSysSurvey, FCT_AlienGroundUnitClass, FCT_AlienRaceSensor, FCT_AlienRaceSpecies, FCT_Species, FCT_KnownSpecies; and the history file |
| Colonization Planner (`/habitability`) | FCT_SystemBody, FCT_Star, FCT_SystemBodyName, FCT_RaceSysSurvey, FCT_AtmosphericGas, DIM_Gases, FCT_Species, FCT_Population, FCT_AlienPopulation (other races' colonies, only as the race's intelligence has them), FCT_MineralDeposit and FCT_SystemBodySurveys (deposits only on bodies the race surveyed), FCT_BannedBodies, FCT_Race, FCT_Game, FCT_JumpPoint, FCT_RaceJumpPointSurvey |
| Commanders | FCT_Commander, FCT_CommanderBonuses, FCT_CommanderTraits, DIM_CommanderBonusType, DIM_TraitsList, FCT_Ranks, FCT_Species, FCT_Game, DIM_ResearchField, FCT_Ship, FCT_ShipClass, FCT_ClassComponent, FCT_ShipDesignComponents, FCT_Fleet, FCT_Population, FCT_SectorCommand, FCT_GroundUnitFormation, FCT_NavalAdminCommand, FCT_ResearchProject, FCT_TechSystem |
| Information | FCT_Ship, FCT_ShipClass, FCT_ShipCargo, FCT_Fleet, FCT_MoveOrders, FCT_PopInstallationDemand, FCT_ShippingLines, DIM_PlanetaryInstallation |
| Map | FCT_RaceSysSurvey, FCT_System, FCT_JumpPoint, FCT_RaceJumpPointSurvey, FCT_SurveyLocation, FCT_RaceSurveyLocation, FCT_SystemBodySurveys, FCT_SectorCommand, FCT_AlienRace, DIM_KnownSystems; SystemView: Star, StarType, SystemBody, SystemBodyName |
| Log | FCT_GameLog, DIM_EventType, FCT_EventColour |
| Designed Tech | FCT_TechSystem, FCT_RaceTech, FCT_ShipDesignComponents, DIM_ComponentType, DIM_ResearchCategories, FCT_Species, DIM_Gases |
| Tech Tree | FCT_TechSystem, DIM_TechType, DIM_ResearchField, FCT_RaceTech, FCT_ResearchProject, FCT_ResearchQueue, FCT_PausedResearch, FCT_EligibleProjects (absent from older saves), FCT_Commander(+Bonuses), FCT_Population(+Installations), DIM_PlanetaryInstallation, FCT_Species, FCT_SystemBody, DIM_PopPoliticalStatus, FCT_AncientConstruct, FCT_Race, FCT_Game |
| Settings | FCT_ShipClass, FCT_HullDescription |

## Research

How the game decides what a race can research, and where the save keeps it. The Tech Tree page implements this in `utilities/research.js`.

- **Catalogue:** `FCT_TechSystem` with `GameID = 0` is the static catalogue (1,407 techs in the sample). Rows with the game's `GameID` are race-designed components (`RaceID` set); they belong to Designed Tech and are not research projects. A tech's field comes from its type: `DIM_TechType.FieldID` to `DIM_ResearchField`. Field 10, Component Creation, has `DoNotDisplay = 1` (an integer; the other fields hold the text `'FALSE'`, so use `toBoolean`).
- **Researchable by a race** when: not `RuinOnly`; `RaceID` is 0, the race's, or listed in `FCT_EligibleProjects`; `Prerequisite1` and `Prerequisite2` are each 0 or researched; and it is not researched, running or queued. A prerequisite id with no tech row (seven static techs point at id 1) makes the tech unresearchable. `NoTechScan`, `StartingSystem`, `ConventionalSystem` and `AutomaticResearch` do not filter the list.
- **Researched:** `FCT_RaceTech(GameID, RaceID, TechID, Obsolete)`. Completing a tech also grants every `AutomaticResearch` tech whose `Prerequisite1` it is, and tech treaties and `DIM_TechType.DistributeLowerTech` can hand techs to other races, so a race can hold techs it never paid for. Conventional starts must research Trans-Newtonian Technology (id 27434) first.
- **Projects:** `FCT_ResearchProject` (`ResearchPointsRequired` is the RP left, `Facilities` the labs, `ResSpecID` the project's field, `Pause`, `AssignNew`); the scientist is the `FCT_Commander` with `CommandType = 7` and `CommandID = ProjectID`. **Queue:** `FCT_ResearchQueue(PopulationID, TechSystemID, CurrentProjectID, ResearchOrder)`; an entry hangs off a running project, not a colony, and the race comes only through `PopulationID`. **Banked points:** `FCT_PausedResearch(RaceID, TechSystemID, PointsAccumulated)`, which also holds points from salvaged components.
- **RP a year** of a project: labs x colony output per lab x scientist multiplier x construct bonuses. Output per lab is species `ResearchRateModifier` x `FCT_Race.Research` x `EconomicProdModifier` x colony `Efficiency` x (1 - radiation / 10000) x (1 - unrest / 100) x political status `ProductionMod` x `FCT_Game.ResearchSpeed` / 100. The scientist multiplier is the Research bonus (commander bonus 3), or 4 x bonus - 3 when the scientist's `ResSpecID` is the project's field. An active `FCT_AncientConstruct` of the project's field on the colony's body multiplies by its `ResearchBonus`, and each active construct on a populated body of the race adds a tenth of its bonus above 1 to its field. Research Admin (bonus 27) caps the labs on a project. Labs are `FCT_PopulationInstallations` of the installation with `DIM_PlanetaryInstallation.ResearchValue > 0`.
- **Landing time:** RP left / RP a year; a queued tech starts when the one before it lands, at the same labs and scientist, paying its cost less banked points at the queued tech's own field rate.
- **Not modelled:** NPR research (`DIM_DesignPhilosophyTechProgression`: NPRs pool RP and complete the next tech of a type, they run no projects) and research prototypes (`FCT_ShipDesignComponents.Prototype`).

## Writes

The app writes to the save in exactly one place: map → **Save Positions**. (Empire History writes its own files, `history/game-<GameID>.json`, never the save.) It runs `UPDATE FCT_RaceSysSurvey SET Xcor, Ycor WHERE GameID, RaceID, SystemID` for every node, behind a confirmation dialog. Keep any future write equally explicit, confirmed, and scoped. Test it against the sample or a copy, never a live save.

## Exploring the schema

```bash
python3 - <<'EOF'
import sqlite3
db = sqlite3.connect('file:AuroraDB.db?mode=ro', uri=True)  # read-only
print([r[1] for r in db.execute('pragma table_info(FCT_Population)')])
print(db.execute("select name from sqlite_master where type='table' and name like 'FCT_Ship%'").fetchall())
EOF
```
