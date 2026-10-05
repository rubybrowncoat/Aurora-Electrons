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

`FCT_Race.NPR` marks non-player races. A non-zero `SpecialNPRID` marks the special factions. In the sample: 1 is Precursors, 3 is Invaders, 4 is Rakhas, 5 is Eldar, and 6 is Ancients.

## Data quirks

- **Booleans** are mostly `0`/`1` integers, but some rows store text such as `'FALSE'` (for example, `DIM_ResearchField.DoNotDisplay`). Coerce with `toBoolean()`/`toNumber()` from `utilities/aurora.js` rather than comparing directly.
- **Time:** `FCT_Game.GameTime` is seconds elapsed since 1 January of `FCT_Game.StartYear`. Event times such as `FCT_GameLog.Time` and `DiscoveredTime` use the same clock. Convert with `gameTime(StartYear, seconds)`, which returns a UTC dayjs. Code uses 31,536,000 seconds per year and 86,400 per day.
- **Body classes** (`FCT_SystemBody.BodyClass`): 1 is a planet, 2 a moon, 3 an asteroid, and 5 a comet. Names are derived as follows: planets are `<star letter> <roman planet number>`, moons are `… -<orbit>`, and asteroids and comets are `Asteroid #n`/`Comet #n`. Star components become letters through `convertDisplayBase(component, 26)`.
- **Names:** the system name lives on `FCT_RaceSysSurvey.Name`, because it's per race. The body name lives on `FCT_SystemBodyName.Name` when present. `populationName()` combines both with `PopName`.
- **Odd column names:** `FCT_System.Stars` (the model calls it `StarCount`), `FCT_AncientConstruct.ResearchField` (the model calls it `ResearchFieldID`), and `FCT_PopulationInstallations.PopID` (not `PopulationID`).
- Commander bonuses come from `FCT_CommanderBonuses`, joined on `BonusID`, and the bonus names are in `DIM_CommanderBonusType`. The ones used in code are 3 Research, 4 Shipbuilding, 5 Production, 9 Terraforming, and 11 Ground Construction. `FCT_Commander.CommandType` identifies what a commander leads: 1 ship, 3 population, 4 sector, 5 ground formation, 7 research project, 12 naval admin. `CommandID` holds the matching ID, and `CommanderType` the officer type.

- **Mineral ledger** (Aurora 2.6+): `FCT_RaceMineralData` logs every mineral movement per population, mineral (`MineralID` 1–11), type and time, in tonnes, always positive. `DIM_MineralDataType.Income` says which direction a type is. Types 7, 8, 12 and 13 (freighter and mass-driver transfers) and 20 (starting stockpile) move minerals between your own colonies, so leave them out of empire totals. Mining events come once per production cycle (5 days in the sample), and the sample holds about 40 days. Mineral Outlook annualises it and groups the types in `utilities/minerals.js` (`FLOW_GROUPS`).
- **Deposit accessibility** stays at `OriginalAcc` until `Amount` falls to `HalfOriginalAmount`, then falls linearly with the amount: `0.1 + (OriginalAcc - 0.1) × Amount / HalfOriginalAmount`. It reaches 0.1 as the deposit empties. Deposits that start at or below 0.1 don't decline. A ground survey can raise `Accessibility` without updating `OriginalAcc`.

## Commander bonus rules

These are the rules the production maths relies on, checked against the references below. A bonus value is a multiplier such as 1.2. A command that passes on a share `s` of it contributes `1 + (bonus - 1) * s`.

- **Sector governors** apply a quarter of each of their bonuses, by bonus type, to every colony in the sector. Use the same bonus type the planetary governor uses: Production 5, Shipbuilding 4, Terraforming 9, Ground Construction 11. Ground-unit construction is documented only as "plus any governor bonus"; ID 11 is inferred from the save's dedicated `Ground Construction` bonus type.
- **Naval Admin Commands** pass their commander's bonuses to ships using the shares in `DIM_NavalAdminCommandType`. The `Industrial` column is the share of **Mining and Terraforming**: Industrial 25%, Logistics 10%, General 5%. Orbital terraformers therefore use the admin commander's Terraforming bonus (9), not Production. Commands chain multiplicatively up the tree, but only while each command is within its parent's command radius and has a commander of sufficient rank.
  - **Radius:** a Naval Headquarters gives 1 jump plus 1 per doubling of its level (levels 1, 2, 4 and 8 give 1, 2, 3 and 4), times `DIM_NavalAdminCommandType.Radius` (2 for Patrol and Survey). The level is `FCT_PopulationInstallations.Amount × NavalHeadquartersValue`, summed per population. A command on a flag bridge (`FCT_NavalAdminCommand.ShipID > 0`) reaches only the ship's current system.
  - **Required rank:** ranks compare by `FCT_Ranks.Priority`, where 1 is the highest. A command needs a commander one rank above the best captain (`FCT_Commander.CommandType = 1`) in its directly attached fleets (`FCT_Fleet.ParentCommandID`), one above each direct subordinate's required rank and commander, and at least `MinimumRankPriority`. The game doesn't store the result. In the sample, every staffed command meets it.
- **Ground construction elements** have capacity = construction rating × units × race construction rating × the formation commander's **Production** bonus (5) × 100 tons.

### Game-rule references

- Docs: https://aurora4x-docs.vercel.app/ (single-page app). The raw markdown is at `https://aurora4x-docs.vercel.app/current/<topic>.md`, e.g. `naval-organization`, `colonies`, `ground-forces`, `terraforming`.
- Wiki: https://aurora4x.net/wiki/ (use the bare domain; `www.` is blocked in cloud sessions). It's community-written, and some pages hedge or are out of date, so prefer the docs.
- Forum: https://aurora4x.com/ (Discourse). Steve Walmsley's patch-notes threads are authoritative. Search with `/search.json?q=<terms>`, and read a thread's raw text at `/raw/<topic id>`.

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
| Production (`index.vue`) | FCT_ResearchProject/Queue, FCT_IndustrialProjects, FCT_ShipyardTask, FCT_Shipyard, FCT_GroundUnitTraining, FCT_Population(+Installations), FCT_Commander(+Bonuses), FCT_NavalAdminCommand, FCT_AncientConstruct, FCT_AtmosphericGas, FCT_JumpPoint, FCT_RaceJumpPointSurvey |
| Warnings | Models above + FCT_Ship, FCT_ShipClass, FCT_ClassComponent, FCT_ShipDesignComponents, FCT_DamagedComponent, FCT_ArmourDamage, FCT_FireControlAssignment, FCT_Lifepods, FCT_Wrecks, FCT_MineralDeposit, FCT_SectorCommand |
| Minerals | FCT_MineralDeposit, FCT_SystemBody, FCT_SystemBodySurveys, FCT_RaceSysSurvey, DIM_KnownSystems |
| Mineral Outlook | FCT_RaceMineralData, DIM_MineralDataType, FCT_MineralDeposit, FCT_Population, FCT_PopulationInstallations, DIM_PlanetaryInstallation, FCT_ShipCargo, FCT_MassDriverPackets, FCT_IndustrialProjects, FCT_Ship, FCT_ShipClass, FCT_Fleet, FCT_NavalAdminCommand, FCT_Commander, FCT_CommanderBonuses, FCT_SystemBodySurveys |
| Habitability | FCT_SystemBody, FCT_AtmosphericGas, DIM_Gases, FCT_Species, FCT_MineralDeposit, FCT_SystemBodySurveys |
| Information | FCT_Ship, FCT_ShipClass, FCT_ShipCargo, FCT_Fleet, FCT_MoveOrders, FCT_PopInstallationDemand, FCT_ShippingLines, DIM_PlanetaryInstallation |
| Map | FCT_RaceSysSurvey, FCT_System, FCT_JumpPoint, FCT_RaceJumpPointSurvey, FCT_SurveyLocation, FCT_RaceSurveyLocation, FCT_SystemBodySurveys, FCT_SectorCommand, FCT_AlienRace, DIM_KnownSystems; SystemView: Star, StarType, SystemBody, SystemBodyName |
| Log | FCT_GameLog, DIM_EventType, FCT_EventColour |
| Designed Tech | FCT_TechSystem, FCT_RaceTech, FCT_ShipDesignComponents, DIM_ComponentType, DIM_ResearchCategories, FCT_Species, DIM_Gases |
| Tech Tree | FCT_TechSystem, FCT_RaceTech, DIM_TechType, DIM_ResearchField |
| Settings | FCT_ShipClass, FCT_HullDescription |

## Writes

The app writes to the save in exactly one place: map → **Save Positions**. It runs `UPDATE FCT_RaceSysSurvey SET Xcor, Ycor WHERE GameID, RaceID, SystemID` for every node, behind a confirmation dialog. Keep any future write equally explicit, confirmed, and scoped. Test it against the sample or a copy, never a live save.

## Exploring the schema

```bash
python3 - <<'EOF'
import sqlite3
db = sqlite3.connect('file:AuroraDB.db?mode=ro', uri=True)  # read-only
print([r[1] for r in db.execute('pragma table_info(FCT_Population)')])
print(db.execute("select name from sqlite_master where type='table' and name like 'FCT_Ship%'").fetchall())
EOF
```
