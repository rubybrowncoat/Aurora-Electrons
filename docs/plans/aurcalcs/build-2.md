# Second build: Colony Outlook, Logistics, Finances, Survey Progress and fleet hygiene

This build covers features 3, 4, 5, 6, 8 and 10 of the [ranked plan](README.md). Fuel Balance (6) and Maintenance Budget (8) share one page, **Logistics**, as the game's own Empire Logistics Summary does.

| Plan item | Page | Tab | File |
|---|---|---|---|
| 3. Colony Outlook | Colony Outlook | Colonies | `pages/colony-outlook.vue`, `utilities/colonies.js` |
| 4. Finances | Finances | Finances | `pages/finances.vue` |
| 5. Survey Progress | Survey Progress | Survey | `pages/survey-progress.vue` |
| 6 + 8. Fuel Balance, Maintenance Budget | Logistics | Logistics | `pages/logistics.vue`, `utilities/logistics.js` |
| 10. Fleet hygiene warnings | Warnings | Warnings | `pages/warnings.vue` |

Shared pieces built for them:

- `utilities/naval-admins.js`: the naval-admin loader that was inline in Mineral Outlook, now taking the bonus and share (Mining with the Industrial share, Survey with the Survey share).
- `utilities/load-tracking.js`: the read-failure tracking that was inline in Mineral Outlook. Every new page shows a named error with Retry instead of partial numbers while a read fails.
- The production-modifier mixin's read is tracked too, so pages that need it wait for it.

All SQL was run read-only on the sample save (GameID 140, RaceID 784). Branches the sample can't reach were run on a scratch copy with injected rows. The pure helpers were checked with synthetic cases.

## What the analysis changed

These findings overturn or settle parts of the plan's SQL appendices.

1. **Refinery and maintenance production are confirmed by the game's own mineral ledger.** For every refining colony, the ledger's Sorium for fuel refining (type 14) equals refineries × `FuelProduction` × the colony's overall production modifier / 2,000 L per tonne. Ratios are 1.0000, or 0.994–0.999 where efficiency moved during the 40 days. Maintenance production (type 16) matches facilities × `MSPProduction` × the same modifier in BP a year, at 1 t of minerals per BP. The species `ProductionRateModifier` applies to both: Korhal and Caprica (Zenox, 1.25) only match with it. This settles the appendices' open question.
2. **Maintenance supplies are used where ships are, not where they're assigned.** The docs (`maintenance`: ships draw from populations at the same location) and the game's Empire Logistics Summary (M-TONS is "maintained tonnage in orbit") agree. The appendix's per-assignment table is replaced by maintenance locations. On the sample the totals barely differ (9.92 M MSP a year either way), but deep-space depots and fleets away from home now land where they draw.
3. **Crew matters to more modules.** Aurora 2.6 runs survey sensors, Sorium harvesters, orbital mining, maintenance, salvage, terraforming and jump-gate modules at Current Crew / Class Crew (docs `crew-and-commanders`). Survey rates, harvester output and maintenance-module capacity all apply it.
4. **The growth formula has outside support.** It is min(10%, 20% / ∛population in millions), times the species and governor/sector modifiers. The sources:
   - A community write-up gives the same formula (forum topic 958).
   - The docs give the fall-off: full growth to a third of capacity, linear to none at capacity. With it, absolute growth peaks at 40% of capacity, which a second forum post (topic 862) reports from play.
   - The radiation term (−1% per 400 points) is consistent with the v2.7 patch notes: about −30% at 13,000 radiation.

   Growth stays labelled an estimate until two saves of one game confirm it.
5. **Survey speed applies to survey ships only** (docs `fleet-movement`: "applied to the survey points produced by survey ships. Everything else remains the same"). The appendix's JS also applied it to ground teams.
6. **`CommandType` 10 is the science officer.** Every survey ship in the sample has one, and all carry a Survey bonus. Captains apply half their Survey bonus; science officers apply it in full.
7. **`FCT_ShipClass.CrewQuartersHS` is always 0**, so the crew-quarters warning filters on class crew instead.
8. **Harvesters stop when their tanks are full.** All nine NPR harvesters in the sample sit at 100%, so their output is zero until they unload.

## Colony Outlook

**What it answers.** Where will growth stall, where am I short of workers or wasting them, and how much infrastructure does the growth need?

**Data.** One row per populated colony:

- species growth and density modifiers;
- body radius, water, tidal lock and radiation;
- infrastructure, installation and shipyard workers;
- governor and sector Population Growth bonus (8; the sector applies a quarter);
- the race's total population on the body.

A second query gives colonists and installations on board ships whose unload order targets the colony (move actions 6, 96 and 177). Both queries were reworked from `sql-economy.md` § 1.

**Rules** (`utilities/colonies.js`):

| Rule | Status |
|---|---|
| Body capacity: area / Earth's × 12 bn × density, less above 75% water (to 1% at 100%), a fifth if tide-locked (moons exempt, as Habitability does), at least 50,000 | Docs `colonies` |
| Growth min(10%, 20%/∛pop) × modifiers × crowding − radiation / 40,000 | Estimate, with support (above) |
| Crowding: 1 up to a third of capacity, linear to 0 at capacity, on the body's total population | Docs `colonies` |
| Infrastructure per million = `ReqInf` / population; growth stops at the cap (above it the population shrinks) | Game's live value; wiki for the decline |
| Workers: services min(70%, (pop/1000)^0.25), agriculture 5% + 5% per point of colony cost, the rest can work; needed = installation `Workers` + shipyards | Reproduces stored `Efficiency` for all 39 colonies (max error 0.0006) |
| Pre-2.6 saves: a low-gravity body counts only low-gravity infrastructure | Plan rule, untested (no such save) |
| Low gravity (body gravity below the species' ideal less deviation): from 2.6 `ReqInf` is doubled at the same colony cost, so the colony cost behind the worker split is `ReqInf` / 2 there; a pre-2.6 save has no doubling | Docs `planetary-installations` (v2.6); untested (no low-gravity colony in the sample) |

**Layout.**

- Tiles: population now and at the horizon, colonies short of workers now and later, growth capped within the horizon, and infrastructure to build.
- A table per colony: population now and later, growth a year, body fill with the one-third mark, infrastructure status, a stacked worker bar, workers free or short at the horizon, and cargo on its way.
- Expanding a row shows a projection chart with the nearby limits (growth slows, infrastructure cap, body capacity) and a worker table for now and later.
- Horizon 5, 10, 25 or 50 years; an "only colonies that need attention" filter; a search box.

**Sample checks.**

- 39 colonies; 12 short of workers now, 8 in 10 years (Belka −57.5 M, Volturn −47.2 M, Elysium −38.8 M).
- Aurelia grows 0.47% a year and fills 32% of 15.72 bn.
- Phobos, the only colony with a colony cost, has infrastructure for 1.06 bn.
- Population 15.26 bn now, 16.54 bn in 10 years.
- Synthetic cases (helpers): a 10 M colony with a 20 M infrastructure cap stops at 20 M in month 105, and keeps growing to 40.8 M without it.

**Caveats.** Population in orbit (Ark modules) isn't modelled. A fleet with unload orders at several colonies counts its cargo at each.

## Finances

**What it answers.** Where does the wealth come from, and where does it go?

**Data.** The year of `FCT_WealthData` (one row per use and cycle) with `DIM_WealthUse`, and the treasury.

**Rules.**

- The sign comes from `DIM_WealthUse.Income`.
- The cycle length is measured from the data, not assumed.
- Each logged time stands for the cycle before it, so the history covers cycles × cycle length; totals are annualised over that.
- `AnnualWealth` is the latest cycle's income times the cycles in a year (26,325,103 against 26,325,265 stored), so it's shown as "Aurora's annual figure at today's rate".

**Layout.**

- A window of 30, 90, 180 or 365 days.
- Tiles: treasury and its change, net, income, and spending a year (with the treasury's runway when net is negative).
- A stacked bar per cycle, income up and spending down, with a net line; a table view.
- A ranked category list, each category's share of its own side.
- The treasury worked back from today, labelled an estimate.

**Sample checks.** 73 cycles of 5 days; income 26,112,844 a year (Financial Centres 68.4%, Worker Taxes 31.6%); spending 628,739 (Maintenance Supplies 66%); net +25,484,105; treasury 52,641,547. These match `sql-fleet.md` § 1.

## Survey Progress

**What it answers.** How much exploring is left, and who's doing it?

**Data.**

- Known systems, with survey locations (counted from `FCT_SurveyLocation`, not assumed 30) and the ones surveyed.
- Bodies (planets, moons, asteroids, comets) surveyed or not, skipping banned bodies.
- The unsurveyed bodies, and the charted jump links for the map.
- Survey ships with their captain's and science officer's Survey bonus.
- The survey fleets' orders and standing orders.
- Ground-survey sites and formations.
- Naval admins with the Survey share.

**Rules.**

- Gravitational points left = locations left × the system's points per location (set by the primary's mass).
- Geological points = radius / 100, × 10 for anything but a gas giant (`sql-mining.md` § 4b).
- A ship's points a day = sensor rating × 24 × survey speed × the better of the science officer's bonus and half the captain's × the admin Survey chain × crew share. Docked craft don't survey.
- Survey time counts only ships already in the system; travel isn't included.
- Ground surveys: radius / 10 points; each unit adds its equipment's points a day × its formation commander's Survey bonus (survey speed not applied).

**Layout.**

- Tiles: systems done, gravitational and geological work left, and survey capacity with idle fleets.
- An SVG map of known systems at their galactic-map positions. Systems are coloured by what's left (both, gravitational, geological, done) and sized by points left; fleets are ringed. Clicking a system opens its row.
- A systems table with progress bars, points left, fleets there and survey time. Expanding a row lists the bodies left and their points.
- A survey-fleet table with rates and what each fleet is doing (surveying, under way, standing orders, idle), and a ground-survey table.

**Sample checks.**

- 166 of 169 systems done.
- 57 locations (24,822 points) left in Polaris and Al Kalb al Rai; 116 bodies (2,824 points) left in three systems. These match `sql-mining.md` § 4.
- Three survey fleets: Discoverer 1,290 and Intrepid 1,409 points a day; Pathfinder's Hermes craft are docked.
- 12 bodies with ground-survey potential, one colonised (Tiaki III, 780 points, no teams).

**Caveats.**

- How the captain's and science officer's bonuses combine is undocumented.
- The sensor unit (points per hour) is assumed.
- Morale's effect on surveying isn't modelled.

## Logistics (Fuel Balance and Maintenance Budget)

**What it answers.** Is the fuel economy sustainable, and will the fleets stay maintained?

**Fuel.**

- Colonies with fuel or refineries: stock, refineries, output, Sorium and how long it lasts, the warning level, and whether ships can refuel or resupply there.
- Harvesters: deposit data only on surveyed bodies, output with commander, admin (Industrial share) and crew, tanks.
- Burn by class: the lifetime duty cycle (distance / (age × top speed)), and ships that moved in the last increment at full power. They give a range, not one number.
- Fuel held by tankers and other ships.
- An idle refinery is labelled turned off, out of Sorium, or without workers.

**Maintenance.**

- Locations are colony bodies and spots in space with ships.
- Capacity comes from the colonies' facilities × racial capacity × efficiency, radiation, stability and political modifiers, plus crew-scaled maintenance modules, all × the economic modifier.
- Ships needing upkeep are military classes, not in a military hangar, at class cost / 4 a year (full cost in overhaul), scaled by capacity / tonnage when over.
- Stock is the colonies' MSP plus supply ships' MSP above their minimums. Production is shown as made, and as possible with every facility on.
- Sorted by how soon the stock runs out, with unmaintained ships first.

**Sample checks.**

- Fuel: 36.21 bn L in stock; refineries make 264.1 ML a year (Aurelia 182.8, Caprica 23.7, Korhal 19.3); estimated burn 23.2–31.6 ML a year. Fomalhaut I has 1.4 years of Sorium left. Korvath I's refineries are idle for lack of workers.
- Maintenance:
  - 301.8 M MSP, including 38.8 M on supply ships.
  - 1.66 M MSP made a year (2.49 M with every facility on), 9.92 M used.
  - Aurelia's stock lasts 72.9 years; Jangala's 11 months.
  - Two ships (53.9 kt) sit where nothing maintains them.
- With the NPR race that owns harvesters (786): nine Haven harvesters, all with full tanks.
- Helper checks: the docs' example (100 kt in orbit, 80 kt capacity) gives 80% maintenance and 80% of the MSP.

**Caveats.**

- Harvester output per module is the workbook's rule (the wiki gives a different base rate): an estimate.
- Burn is a range.
- New ships' first fill and civilian refuelling aren't counted.

## Fleet hygiene warnings: review

The plan proposed ten checks (`sql-fleet.md` § 3). Each was run on the sample and on a scratch copy with injected faults. Verdicts:

| # | Check | Verdict | Where | Sample | Injected |
|---|---|---|---|---|---|
| W1 | Idle fleets | Added. Fleets parked at your own colonies are hidden unless toggled on; fleets following another fleet are skipped; each fleet can be ignored (stored per race) | Fleets | 2 (TDF patrol flotillas in deep space), 134 parked | 3 |
| W2 | Ships carrying cargo with no orders | Added | Fleets | 0 | 2 (a trade route with its orders removed) |
| W3 | Survey orders without the matching sensor | Added. It catches a fleet whose survey ship left after the order was given | Fleets | 0 | 1 |
| W4 | Orbital miners at bodies they can't mine (not surveyed, no deposits, too large) | Added; deposit data gated on the race's survey | Fleets | 0 | 3 |
| W5 | Mines without deposits | Already covered by "wasted mining capacity" | — | — | — |
| W6 | Mining colonies with mass drivers but no destination | Added; hubs (destinations of other colonies) and unsurveyed bodies are left out | Economy | 0 | 34 (all destinations cleared) |
| W7 | Ships short of crew | Added. It matters more since 2.6 (crew scales module output) and differs from "low morale" | Ships | 1 (Sri Tiga 002, 1 of 357) | — |
| W8 | Classes with outdated crew quarters | Added. The docs confirm classes keep their design-time CDE until Update CDE (unlocked classes only); filtered on class crew because `CrewQuartersHS` is always 0 | Ships | 0 | 1 |
| W9 | Research prototypes with no project | Added; the research queue is matched through the queuing colony's race | Populations | 0 | 1 |
| W10 | Fleets assigned to a colony that no longer exists | Added. It's rare, but costs nothing when absent | Fleets | 0 | 1 |

On the sample the page gains two entries: two idle fleets in deep space and one ship short of crew. All ten queries run in about 0.01 s each.

**Considered, not added.** These come from the new pages, which show them in context:

- colonies below their own fuel or MSP warning level (Logistics marks them);
- refineries out of Sorium (Logistics);
- ships away from any maintenance (Logistics' supplies tile).

Survey and patrol fleets are often away on purpose, so a warning for the last of these would be noisy.

## Open items

- Population growth, survey rates and harvester output stay labelled estimates until two saves of one game, or an in-game readout, confirm them.
- Survey time excludes travel; the jump graph (G2) would add it.
- The Production page still has its own naval-admin code (README, found along the way, item 5). `utilities/naval-admins.js` is the shared replacement.
