# Fourth build: Intelligence

This build covers feature 16 of the [ranked plan](README.md), on its own tab.

| Plan item | Page | Tab | File |
|---|---|---|---|
| 16. Intelligence History | Intelligence | Intelligence (after History) | `pages/intelligence.vue`, `utilities/intelligence.js`; recording in `utilities/history.js` |

The codes and thresholds come from the maintainer's reference for Aurora 2.7.1, [`references/mechanics/intelligence.md`](../../../references/mechanics/intelligence.md). The queries, and the sample decoded with them, are in [`sql-fleet.md`](sql-fleet.md) § 7.

## What it answers

What does the selected race know about each alien race, and how has that changed? It shows only the race's own observations: every read goes through the viewing race's intelligence tables. So it needs no spy mode for a player race; an NPR's knowledge shows only in spy mode, the only way to select an NPR. Aurora's special factions aren't recorded, so for them the tab is disabled, as History's is.

## Data

Eight tracked reads, each scoped by `GameID` and the viewing race:

| Read | Tables | Sample (race 784) |
|---|---|---|
| Known races (SQL A, with the alien's treaty grants to the viewer from its reciprocal record) | `FCT_AlienRace`, `FCT_Game`, counts from `FCT_AlienClass`, `FCT_AlienShip`, `FCT_AlienPopulation`, `FCT_AlienSystem`, `FCT_AlienGroundUnitClass`, `FCT_AlienRaceSensor` | 11 rows |
| Tracked ships (SQL B) | `FCT_AlienShip`, `FCT_AlienClass` | 195 |
| Observed classes, with weapons seen firing | `FCT_AlienClass`, `FCT_AlienClassWeapon`, `FCT_ShipDesignComponents` (weapon names) | 15 |
| Observed colonies (SQL C) | `FCT_AlienPopulation` | 6 |
| Observed sensors | `FCT_AlienRaceSensor` | 10 |
| Observed ground unit classes | `FCT_AlienGroundUnitClass` | 65 |
| Systems seen in | `FCT_AlienSystem`, `FCT_RaceSysSurvey` (the viewer's names) | 19 |
| Species | `FCT_AlienRaceSpecies`, `FCT_Species` (name), `FCT_KnownSpecies` (status) | 1 |

Every read takes 8 ms or less on the sample. No `Actual*` column, alien `ShipID` or alien `PopulationID` is joined. The one read of another race's record is the alien's own treaty flags toward the viewer (`TradeTreaty`, `TechTreaty`, `GeoTreaty`, `GravTreaty`), which is how the game's Intelligence window shows what an alien race grants you.

## Rules

| Rule | Source |
|---|---|
| Stance (`ContactStatus` 0–6) and communication (`CommStatus` 0–3) labels; species knowledge, engine type and class role codes | Reference |
| Class roles are labelled by the rule that sets them (launchers of size 4 or more, smaller launchers, beams needing more than twice their recharge rate in power, other beams), because the role names themselves are uncertain | Reference |
| Diplomatic points against the lines where treaties and statuses change: −100, 200, 800, 2,400, 4,000, 6,000; standing worded with the game's report bands (at war, negative, neutral, positive, friendly, allied) | Reference |
| A colony field shows once `MaxIntelligence` is **above** its threshold (100, 200, 300, 500), and is marked last-known while current points are no longer above it | Reference |
| Sensor range and resolution show above 100 points; each ground unit counter reveals something at 20 | Reference |
| Race intelligence is spent 100 at a time on a random discovery, so each fall in it is marked as a discovery | Reference |
| Tracked fleet over time, rebuilt: a ship counts from its first detection; a destroyed one is lost at its last damage time, or its last contact without one | Save timestamps |

## Recording

The Empire History recorder (`recordHistory`) also takes SQL A for every recorded race, in the same pass, and `mergeGame` keeps it in the same per-game file and single write: `intel.<ViewRaceID>.<AlienRaceID>` → `{ name, snapshots }`. A snapshot holds stance, communication, translation progress, diplomatic and intelligence points, treaties both ways (as bitmasks), and the counts of tracked ships, tonnage, losses, classes, colonies, known population, systems, ground unit classes and sensors.

Intelligence changes slowly, so a snapshot is kept only when something besides the time changed. The same rewind and new-game rules as Empire History apply: an older save drops what came after it, and a game under the same ID with another name starts over. The page draws the recorded points and ends each line with the save as it is now.

## Layout

- A note that this is only what the race has observed, and where the file is saved.
- Tiles: known races by stance, ships tracked (with tonnage, of how many ever tracked), ships destroyed, colonies observed.
- Known races: stance chip (icon and label), communication, diplomatic points and standing, first contact, last ship contact, ships tracked, destroyed, colonies and systems. Clicking a row selects it; the choice is kept per race (`game.<GameID>.race.<RaceID>.intelligenceAlien`).
- The selected race:
  - its stance and communication, a fixed-relationship chip, first and last contact, diplomatic points and standing, communication (with its date once established), translation progress while attempting, treaties granted each way, race intelligence and the damage it has done to you;
  - three charts: diplomatic points with the dashed threshold lines (the axis reaches the nearest line on each side); ships tracked, destroyed and tonnage, rebuilt back to first contact; and race intelligence with discovery marks, plus translation progress when communication was being attempted;
  - observed classes (engine, armament role, size, top speed, armour, shields, in service out of tracked, first seen, weapons seen), colonies (each field once unlocked, stale ones in italics with a tooltip), sensors, ground unit classes, and systems and species.

`ChartCanvas` gained labelled dashed horizontal lines (`options.plugins.guides.levels`) for the diplomacy chart.

## Checks

- **Sample** (race 784):
  - 11 known races, all Hostile; 112 ships tracked in service (2.55 Mt) of 195 ever tracked; 83 destroyed; 6 colonies observed, none with population known.
  - The Precursors are selected by default (most ships): first contact 0005-07-30, last ship contact 0293-07-02, −123 points (at war), fixed relationship, 22 damage. Their 15 classes, 2 colonies, 10 sensors (5 with range known), 11 ground unit classes, 9 systems and 1 species (Discovered) all show. The rebuilt fleet chart reaches back to year 4.
  - A Rakhas group shows its single system and no ships, with an empty fleet chart noted as such.
- **A scripted NPR contact**, on a copy where the Eldar are an ordinary NPR known to race 784 (Neutral, Attempting, 150 points, a colony at 250 intelligence points, one class with three tracked hulls, one destroyed):
  - Three simulated saves raised points to 250 and 260, intelligence to 120 then spent it to 30, and established communication; a fourth changed nothing.
  - Recorded snapshots: 3 (the unchanged save added none), with one file write per save.
  - The diplomacy chart crossed the trade-treaty line; the intelligence chart marked one discovery; communication showed its establishment date; "They grant: Trade" came from the Eldar's own record.
  - With the colony's intelligence down to 150, its factories, mines and spaceport showed as last known (italic), its population and installations as current.
- **Read failures:** a simulated `SQLITE_BUSY` on the races read and on the colonies read each showed the named error and hid the panels, kept it on Retry while still failing, and recovered on Retry.
- **Node**, 16 cases: change-only recording, holding, rewinds, same-time replacement, new games, treaty masks, strict colony thresholds and stale fields, colony levels, the fleet rebuild (including a destroyed ship without a damage time), discovery marks, standing bands and status labels. Empire History's 11 merge cases still pass.
- Both themes; lint clean; `yarn web:smoke` ok on all 19 pages.

## Caveats

- The codes are from the reference for 2.7.1; another version could differ.
- Tracked ships are the hulls the race has seen, not the alien fleet, and a destroyed ship's time of loss is its last damage time.
- Diplomacy, intelligence and translation history starts when recording does; only the tracked fleet is rebuilt from before.
- The sample's own contacts are all special factions with colonies at 0 intelligence points, so most colony fields and diplomacy above −100 were checked on the scripted copy only.
- Web mode stores the history in localStorage; Electron's files aren't exercised (as for Empire History).
