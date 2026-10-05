# Fleet, Commander, Finance, Route and Logistics queries: design and validation

Scope: SQL and JS design for six planned Aurora Electrons pages. Design only: nothing here is implemented yet. Every query below was run read-only (`sqlite3` URI `mode=ro`) against the sample save with `GameID` 140 and `RaceID` 784 substituted for `${this.GameID}` and `${this.RaceID}`. Queries that returned 0 rows on the sample were additionally run against a throwaway copy of the save with injected test rows, to prove the logic fires. No views are used; every helper view in the references became an inline subquery or CTE. Query style is the page style: raw SQL in a template literal, run via `this.database.query(sql).then(([items]) => items)`.

How to read the validation lines: "sample" means the unmodified sample save. "synthetic" means the scratch copy with injected rows.

## Cross-cutting findings (read first)

- **Sample quirks that affect testing.** The sample has no orbital miners, no research projects, no prototype components marked for research, and its player stores every fleet at its home colony. Fleet speeds are huge (75,000 to 144,000 km/s). Do not tune thresholds to this save.
- **Convention-free means:** no fleet-name patterns. The substitutes used throughout are structural: `Fleet.Speed > 1` (speed 1 is an immobile station or trailer), `ShippingLine = 0 and CivilianFunction = 0` (non-civilian), `MaintenanceState = 2` (overhaul), `MothershipID > 0` (docked in a hangar), `CycleMoves = 1` (repeat orders), and `Capital = 1`.
- **Commander assignment codes** (`FCT_Commander.CommandType`, checked against the sample by joining `CommandID` to each candidate table): 1 ship commander (1407 rows, all match `FCT_Ship`), 3 population governor (67), 4 sector (6), 5 ground formation (3287), 12 naval admin command (67), 17 academy commandant (1; `CommandID` is a population). Codes 8, 9, 10, 11 and 15 are secondary ship posts: all 374, 574, 27, 356 and 34 rows have `CommandID` equal to a `ShipID` of the race. Mapping to Executive Officer (8), Chief Engineer (9), Science Officer (10), Tactical Officer (11) and Commander Air Group (15) is inferred from each group's dominant bonus (Crew Training 1.24 avg, Engineering, Survey, Tactical, Carrier Operations) and from the docs' post list; it is not stored anywhere in the save. `CommandType = 0` with `CommandID = 0` means unassigned. `CommandType = 7` (research project, `CommandID = ProjectID`) is used by `index.vue` and the references but has 0 rows on the sample.
- **Commander type codes** (`CommanderType`): 0 naval, 1 ground, 2 civilian administrator, 3 scientist (matches the reference CASE). Counts for race 784: 8022 naval, 7930 ground, 1702 administrators, 2199 scientists. 19,853 rows are alive (`Deceased = 0`; all 20,108 rows in the game have `Deceased = 0` and `RetireStatus = 0`).
- **Fleet pathing in Aurora minimises jumps first, then distance.** The docs say so (fleet-movement.md: "shorter route in terms of kilometres but longer in terms of transits"), and I verified it: re-running a (jumps, km) Dijkstra over the fog-of-war graph reproduced the exact jump-point sequence of 109 of the 110 stored Standard Transit chains (start system != end system). Pure-km Dijkstra only reproduced 92. See feature 4.
- **No indexes** exist on `FCT_Commander`, `FCT_CommanderBonuses`, or `FCT_WealthData`. Correlated subqueries per commander are therefore full scans. The roster query below aggregates bonuses once in a CTE instead (0.20 s for 19,853 rows).
- **Time:** `FCT_Game.GameTime` seconds; 31,536,000 s per year; wealth rows use the same clock.

---

## 1. Finances

**Purpose.** Show the race's income against spending by category for the last year (and any shorter window), as per-category totals plus a per-step time series for a stacked chart, next to the current treasury.

**Data facts (verified).**
- `FCT_WealthData` holds one row per (use, time step). `Amount` is always positive; the sign comes from `DIM_WealthUse.Income` (1 income, 0 expense). 51 use types exist in `DIM_WealthUse`; the sample race uses 5 (Worker Taxes 11, Financial Centres 39, Installation Construction 4, Ordnance Production 2, Maintenance Supplies 28).
- The step is 5 days (73 gaps of exactly 5.0 days between 74 distinct `TimeUsed` values) and the save holds exactly 365 days of history (oldest row is `GameTime - 31,536,000`). So "last N days" is capped at 365 and the series has at most 73 points per category. The references' `DaysAgo = cast((GameTime - TimeUsed)/86400 as int)` therefore only produces multiples of 5.
- A strict `TimeUsed > GameTime - 365 d` window yields exactly 73 steps (one full year). The reference `annual wealth.sql` uses `GameTime <= TimeUsed + 31536000` (inclusive) which would count 74 steps; avoid that.
- Treasury: `FCT_Race.WealthPoints` = 52,641,546.56 on the sample. `FCT_Race.AnnualWealth` = 26,325,265 looks like a projected annual figure (about latest step income x 73); `PreviousWealth` is NULL; `StartingWealth` = 0.

**SQL: totals per category over the window** (replace `365` by `${days}` as a number you coerce with `toNumber()`; it is never user-typed text, but keep it numeric).

```sql
select w.UseID, coalesce(wu.Description, 'Unknown (' || w.UseID || ')') as Description, coalesce(wu.Income, 0) as Income, wu.DisplayOrder, sum(w.Amount) as Total, count(distinct w.TimeUsed) as Steps, min(w.TimeUsed) as FirstTime, max(w.TimeUsed) as LastTime
from FCT_WealthData as w
left join DIM_WealthUse as wu on wu.WealthUseID = w.UseID
inner join FCT_Game as g on g.GameID = w.GameID
where w.GameID = ${this.GameID} and w.RaceID = ${this.RaceID}
  and w.TimeUsed > g.GameTime - 365 * 86400.0
group by w.UseID
order by Income desc, wu.DisplayOrder
```
Validated: 5 rows, 0.00 s. Sample rows:
`(11, 'Worker Taxes', 1, 2.0, 8,250,839.90, 73 steps)`, `(39, 'Financial Centres', 1, 2.5, 17,862,004.37, 73)`, `(28, 'Maintenance Supplies', 0, 28.0, 415,076.65, 73)`. Income 26.11 M against expenses 0.63 M gives net +25.48 M per year.

**SQL: per-step series for the chart.**

```sql
select w.UseID, coalesce(wu.Description, 'Unknown (' || w.UseID || ')') as Description, coalesce(wu.Income, 0) as Income, wu.DisplayOrder, w.TimeUsed, sum(w.Amount) as Amount
from FCT_WealthData as w
left join DIM_WealthUse as wu on wu.WealthUseID = w.UseID
inner join FCT_Game as g on g.GameID = w.GameID
where w.GameID = ${this.GameID} and w.RaceID = ${this.RaceID}
  and w.TimeUsed > g.GameTime - 365 * 86400.0
group by w.UseID, w.TimeUsed
order by w.TimeUsed, wu.Income desc, wu.DisplayOrder
```
Validated: 365 rows (5 categories x 73 steps), 0.01 s. Sample: `(11, 'Worker Taxes', 1, 2.0, 9454409425, 112841.43)`, `(39, 'Financial Centres', 1, 2.5, 9454409425, 244524.91)`.

**SQL: treasury and game clock.**

```sql
select r.WealthPoints, r.PreviousWealth, r.StartingWealth, r.AnnualWealth, r.WealthCreationRate, g.GameTime, g.StartYear
from FCT_Race as r
inner join FCT_Game as g on g.GameID = r.GameID
where r.GameID = ${this.GameID} and r.RaceID = ${this.RaceID}
```
Validated: 1 row: `(52641546.56, NULL, 0.0, 26325265, 2200.0, 9485513425, 1)`.

**JS-side logic.**
- Convert `TimeUsed` with `gameTime(StartYear, seconds)` (utilities/aurora.js). Derive the step length from the two smallest distinct times, never hard-code 5 days (a game's construction increment can differ).
- Signed amount = `Income ? Amount : -Amount`. Net per step = sum of signed amounts. Per-day average = category total / (steps x stepDays). Yearly total = the totals query (window 365 d). Shorter windows (30, 90 days) reuse the same series query with a different cutoff or are filtered client-side from the one 365-day load (cheaper: one query, filter in a computed property).
- Treasury history without extra data: `balance(t) = WealthPoints - sum(net of all steps after t)`. On the sample the start-of-year balance reconstructs to about 27.2 M (52.64 M - 25.48 M); treat it as an estimate because trade and tax events outside `FCT_WealthData` (and `WealthPoints` rounding) are not in the rows.
- Chart: stacked bars for income above the axis and expenses below, one series per `Description`; sort series by `Income desc, DisplayOrder`. Unknown `UseID`s (not in the DIM table) fall back to `Unknown (id)` (handled in SQL).

**Reuse.** Models `Race` already maps `WealthPoints` and `AnnualWealth` (utilities/database.js:58-61). Time helpers in utilities/aurora.js. No charting library is in package.json (only cytoscape and d3-color/d3-interpolate), so draw the stacked bars as plain SVG or with Vuetify's `v-sparkline`, or add a small library deliberately.

**Caveats / open questions.**
- Scope is the selected race only, as required. On the sample `FCT_WealthData` holds rows only for race 784 (1,776 rows), so NPR finances are not even stored; always keep the `RaceID` filter.
- `AnnualWealth` semantics are inferred. Label it "Aurora's annual estimate" or omit it.
- Expense rows for a use can be 0 on some steps (Maintenance Supplies min 0.0) and categories can be absent for whole years; the chart must tolerate missing (use, time) pairs.
- If a new Aurora version stores history longer than a year, the 365-day cap in the SQL is a deliberate choice to keep "yearly" meaning one year.

---

## 2. Commanders

**Purpose.** A filterable roster of the race's commanders (type, rank, what they command, age, health, bonuses, traits) plus candidate views: idle administrators for colonies, better idle scientists for research projects, and best idle officers for mining, terraforming and survey ships.

**Data facts (verified).**
- 19,853 alive commanders for race 784 (naval 8022, ground 7930, administrators 1702, scientists 2199). Load as one query (0.20 s) and filter client-side, or push filters into SQL with Sequelize `replacements` (below). Do not render all rows at once: use `v-data-table` pagination or a type tab.
- Ranks: `FCT_Ranks` (RankID, RankName, RankAbbrev, Priority, RankType). Priority 1 is the highest rank; RankType 0 naval, 1 ground. Administrators and scientists have `RankID = 0`: show `FCT_Race.RankAdministrator` / `RankScientist` ("Administrator", "Scientist" on the sample) or the commander type name instead.
- **Rank level.** `ShipClass.RankRequired` equals the commander's level counted from the lowest rank, `level = max(Priority of that RankType) - Priority + 1`. Verified: all 1407 ship commanders satisfy `level = RankRequired` exactly (700 at 1, 131 at 2, 318 at 3, 258 at 4).
- **Age** is not stored. Docs (crew-and-commanders.md, "Officer Graduation Age") say age = starting age + (GameTime - CareerStart) / one year, with the starting age being the species `GraduationAge` (21 default). The sample has two species (753 grad age 21, 786 grad age 30), so join `FCT_Species` instead of hard-coding 21 (the reference queries hard-code 20 or 21).
- **Health.** `HealthRisk` is an integer 1 to 10 (counts on the sample: 14,869 at 1, 3,110 at 2, 1,081 at 3, ... 2 at 10). It rises with age only loosely (scientists: mean age 41.3 at 1, 48.0 at 6). The reference treats 6 as "poor health"; the scale is not documented, so show the raw number, 1 = best (inferred).
- **Bonuses** (`FCT_CommanderBonuses`, `DIM_CommanderBonusType`, 34 types). Values are multipliers (1.15 means +15%) except BonusID 25 (Colony Administration, an integer rating 1 to 10) and 27 (Research Admin, integer max labs 2 to 10), which have `Percentage = 0`. Display rule from the references: `BonusID in (25, 27) ? Math.round(value) : '+' + Math.round((value - 1) * 100) + '%'`. Values carry float noise (1.1500000000000001), so round in JS. `DIM_CommanderBonusType` has the applicability flags `Naval`, `Ground`, `Civilian`, `Scientist` and `MaximumBonus`.
  - Administrators carry bonuses 4 Shipbuilding, 5 Production, 6 Mining, 8 Population Growth, 9 Terraforming, 11 Ground Construction, 14 Political Reliability, 20 Wealth Creation, 24 Logistics and 25 Colony Administration (the `Civilian` flag). Scientists carry 3 Research and 27 Research Admin. Naval officers: 1 Crew Training, 2 Survey, 5, 6, 7 Carrier Ops, 9, 13 Reaction, 17, 21 Tactical, 22, 23, 24, 26, 28 Engineering, 37.
- **Traits** (`FCT_CommanderTraits.CmdrID`, `DIM_TraitsList` 148 rows with a `GroupID`). Load the lookup once and keep `TraitID`s per commander.

**SQL A: roster.** One row per alive commander; bonuses as `BonusID:value` list and traits as `TraitID` list, both parsed in JS. Assignment is resolved per `CommandType` with LEFT JOINs.

```sql
with bonus as (
  select b.CommanderID, group_concat(b.BonusID || ':' || b.BonusValue, ',') as Bonuses
  from FCT_CommanderBonuses as b
  inner join FCT_Commander as c on c.CommanderID = b.CommanderID
  where c.GameID = ${this.GameID} and c.RaceID = ${this.RaceID} and c.Deceased = 0
  group by b.CommanderID
), trait as (
  select t.CmdrID as CommanderID, group_concat(t.TraitID, ',') as Traits
  from FCT_CommanderTraits as t
  inner join FCT_Commander as c on c.CommanderID = t.CmdrID
  where c.GameID = ${this.GameID} and c.RaceID = ${this.RaceID} and c.Deceased = 0
  group by t.CmdrID
)
select c.CommanderID, c.Name, c.CommanderType, c.RankID, r.RankName, r.RankAbbrev, c.CommandType, c.CommandID, c.ResSpecID, rf.FieldName, c.HealthRisk, c.PromotionScore, c.Seniority, c.Female, c.StoryCharacter, c.GameTimePromoted, c.GameTimeAssigned, round(coalesce(sp.GraduationAge, 21) + (g.GameTime - c.CareerStart) / 31536000.0, 1) as Age, case when c.CommandType in (1, 8, 9, 10, 11, 15) then sh.ShipName when c.CommandType in (3, 17) then pop.PopName when c.CommandType = 4 then sec.SectorName when c.CommandType = 5 then gf.Name when c.CommandType = 12 then nac.AdminCommandName when c.CommandType = 7 then ts.Name end as AssignmentName, fl.FleetName, bonus.Bonuses, trait.Traits
from FCT_Commander as c
inner join FCT_Game as g on g.GameID = c.GameID
left join FCT_Species as sp on sp.SpeciesID = c.SpeciesID and sp.GameID = c.GameID
left join FCT_Ranks as r on r.RankID = c.RankID
left join DIM_ResearchField as rf on rf.ResearchFieldID = c.ResSpecID and c.CommanderType = 3
left join bonus on bonus.CommanderID = c.CommanderID
left join trait on trait.CommanderID = c.CommanderID
left join FCT_Ship as sh on sh.ShipID = c.CommandID and c.CommandType in (1, 8, 9, 10, 11, 15)
left join FCT_Fleet as fl on fl.FleetID = sh.FleetID
left join FCT_Population as pop on pop.PopulationID = c.CommandID and c.CommandType in (3, 17)
left join FCT_SectorCommand as sec on sec.SectorCommandID = c.CommandID and c.CommandType = 4
left join FCT_GroundUnitFormation as gf on gf.FormationID = c.CommandID and c.CommandType = 5
left join FCT_NavalAdminCommand as nac on nac.NavalAdminCommandID = c.CommandID and c.CommandType = 12
left join FCT_ResearchProject as rp on rp.ProjectID = c.CommandID and c.CommandType = 7
left join FCT_TechSystem as ts on ts.TechSystemID = rp.TechID
where c.GameID = ${this.GameID} and c.RaceID = ${this.RaceID} and c.Deceased = 0
order by c.CommanderType, c.Seniority
```
Validated: 19,853 rows, 0.20 s. Sample rows (truncated):
`(678431, 'Aurelia Ashikaga', type 0, 'Imperator', cmd 12 -> 'Aurelian Interstellar Command', age 366.8, bonuses '21:1.5,28:1.5,1:1.5,...', traits '17,22,27,88,91')` and `(774207, 'Samantha Wahlund', 0, 'Grand Admiral', 12, 'Aurelian Naval High Command', 83.7, '1:1.5,2:1.1,21:1.45,13:1.45,28:1.4', '7,76,78')`. The first row's age of 366.8 is arithmetic, not a bug: she is a `StoryCharacter` (never retires) whose `CareerStart` is -1,135,296,000 s (36 years before game start) and the species graduation age is 30.

**Filtered variant (typed text must use replacements).** Append to the final WHERE: `and c.CommanderType = :type and (c.CommandID = 0) = :idle and c.Name like '%' || :search || '%'` and end with `limit :limit offset :offset`; pass `{ replacements: { type: 2, idle: 1, search: 'Ash', limit: 50, offset: 0 } }`. Validated: 18 rows in 0.11 s; the matching `select count(*)` for `v-data-table` `server-items-length` takes 0.004 s.

**Lookups (load once into data):**

```sql
select BonusID, Description, BonusAbbrev, Percentage, Naval, Ground, Civilian, Scientist, MaximumBonus from DIM_CommanderBonusType order by DisplayOrder
```
```sql
select TraitID, GroupID, Name from DIM_TraitsList
```
Validated: 34 and 148 rows.

**SQL B: colony vacancies and governor upgrades.** Every populated colony with its governor and the governor's values for the colony's own `BonusOne/Two/Three` (the "Required/Secondary/Tertiary bonus" fields of the Governor tab; docs: candidates rank by descending BonusOne, then Two, then Three).

```sql
select p.PopulationID, p.PopName, p.Population, p.Importance, p.AutoAssign, p.BonusOne, p.BonusTwo, p.BonusThree, p.AcademyOfficers, rss.Name as SystemName, gov.CommanderID, gov.Name as GovernorName, (select b.BonusValue from FCT_CommanderBonuses as b where b.CommanderID = gov.CommanderID and b.BonusID = p.BonusOne) as GovBonusOne, (select b.BonusValue from FCT_CommanderBonuses as b where b.CommanderID = gov.CommanderID and b.BonusID = p.BonusTwo) as GovBonusTwo, (select b.BonusValue from FCT_CommanderBonuses as b where b.CommanderID = gov.CommanderID and b.BonusID = p.BonusThree) as GovBonusThree, (select b.BonusValue from FCT_CommanderBonuses as b where b.CommanderID = gov.CommanderID and b.BonusID = 25) as GovAdminRating
from FCT_Population as p
left join FCT_Commander as gov on gov.CommandType = 3 and gov.CommandID = p.PopulationID and gov.GameID = p.GameID and gov.Deceased = 0
left join FCT_RaceSysSurvey as rss on rss.SystemID = p.SystemID and rss.RaceID = p.RaceID and rss.GameID = p.GameID
where p.GameID = ${this.GameID} and p.RaceID = ${this.RaceID} and p.Population > 0
order by p.Importance desc, p.Population desc
```
Validated: 39 rows (all populated colonies), 0.15 s, 0 vacancies. Sample: `(48984, 'Garuda', pop 1035.6, importance 4, auto 1, bonuses 6/9/8, 'Aurelus', governor 'Horiuchi Chikayo' 1.30/1.05/NULL, admin rating 6)`. Without the `Population > 0` filter there are 8 more colonies (population 0) with no governor; the Warnings page's `governorlessPopulations` (warnings.vue:1234) lists populated ones only, so a vacancy list would duplicate that and should be framed as "best candidate for each vacancy" and "colonies where an idle administrator beats the governor".

**SQL C: pool of idle administrators** (`CommanderType = 2`, `CommandID = 0`), bonuses pivoted for ranking.

```sql
select c.CommanderID, c.Name, c.HealthRisk, c.Seniority, round(coalesce(sp.GraduationAge, 21) + (g.GameTime - c.CareerStart) / 31536000.0, 1) as Age, max(case when b.BonusID = 25 then b.BonusValue end) as AdminRating, max(case when b.BonusID = 4 then b.BonusValue end) as Shipbuilding, max(case when b.BonusID = 5 then b.BonusValue end) as Production, max(case when b.BonusID = 6 then b.BonusValue end) as Mining, max(case when b.BonusID = 8 then b.BonusValue end) as PopGrowth, max(case when b.BonusID = 9 then b.BonusValue end) as Terraforming, max(case when b.BonusID = 11 then b.BonusValue end) as GroundConstruction, max(case when b.BonusID = 14 then b.BonusValue end) as PoliticalReliability, max(case when b.BonusID = 20 then b.BonusValue end) as Wealth, max(case when b.BonusID = 24 then b.BonusValue end) as Logistics
from FCT_Commander as c
inner join FCT_Game as g on g.GameID = c.GameID
inner join FCT_CommanderBonuses as b on b.CommanderID = c.CommanderID
left join FCT_Species as sp on sp.SpeciesID = c.SpeciesID and sp.GameID = c.GameID
where c.GameID = ${this.GameID} and c.RaceID = ${this.RaceID} and c.CommanderType = 2 and c.CommandID = 0 and c.Deceased = 0
group by c.CommanderID
order by AdminRating desc
```
Validated: 1,629 rows (362 with admin rating >= 5), 0.02 s. Sample: `(807505, 'Grace Waters', health 1, age 52.1, rating 8, Ground Construction 1.05, Wealth 1.05)`.

JS ranking for a colony: candidates = pool rows where `row[bonusName(BonusOne)] != null`; sort by the three bonus values descending (nulls as 1.0). The BonusID to pool-column map is `{ 25: AdminRating, 4: Shipbuilding, 5: Production, 6: Mining, 8: PopGrowth, 9: Terraforming, 11: GroundConstruction, 14: PoliticalReliability, 20: Wealth, 24: Logistics }`. Sample result: 1 colony ('Chronos', BonusOne 9) where an idle administrator (Damon Valance, Terraforming 1.35) beats the current governor (1.30). Remove each assigned candidate from the pool as you go down the importance-sorted vacancy list (greedy, as Aurora does).

**SQL D: research projects and their scientist; SQL E: pool of idle scientists.**

```sql
select rp.ProjectID, rp.PopulationID, p.PopName, ts.Name as ProjectName, rp.ResSpecID as ProjectField, rf.FieldName as ProjectFieldName, rp.Facilities, rp.ResearchPointsRequired, c.CommanderID, c.Name as CommanderName, c.ResSpecID as CommanderField, c.HealthRisk, max(case when b.BonusID = 27 then b.BonusValue end) as Labs, max(case when b.BonusID = 3 then b.BonusValue end) as ResearchBonus
from FCT_ResearchProject as rp
inner join FCT_Population as p on p.PopulationID = rp.PopulationID
left join FCT_TechSystem as ts on ts.TechSystemID = rp.TechID
left join DIM_ResearchField as rf on rf.ResearchFieldID = rp.ResSpecID
left join FCT_Commander as c on c.CommandType = 7 and c.CommandID = rp.ProjectID and c.GameID = rp.GameID and c.CommanderType = 3
left join FCT_CommanderBonuses as b on b.CommanderID = c.CommanderID and b.BonusID in (3, 27)
where rp.GameID = ${this.GameID} and rp.RaceID = ${this.RaceID}
group by rp.ProjectID
order by rp.ResearchPointsRequired desc
```
```sql
select c.CommanderID, c.Name, c.ResSpecID, rf.FieldName, c.HealthRisk, c.GameTimePromoted, round(coalesce(sp.GraduationAge, 21) + (g.GameTime - c.CareerStart) / 31536000.0, 1) as Age, max(case when b.BonusID = 27 then b.BonusValue end) as Labs, max(case when b.BonusID = 3 then b.BonusValue end) as ResearchBonus
from FCT_Commander as c
inner join FCT_Game as g on g.GameID = c.GameID
inner join FCT_CommanderBonuses as b on b.CommanderID = c.CommanderID and b.BonusID in (3, 27)
left join FCT_Species as sp on sp.SpeciesID = c.SpeciesID and sp.GameID = c.GameID
left join DIM_ResearchField as rf on rf.ResearchFieldID = c.ResSpecID
where c.GameID = ${this.GameID} and c.RaceID = ${this.RaceID} and c.CommanderType = 3 and c.Deceased = 0 and c.CommandID = 0
group by c.CommanderID
having Labs is not null
order by c.ResSpecID, ResearchBonus desc
```
Validated: D returned 0 rows on the sample (`FCT_ResearchProject` is empty; the table is documented as empty in docs/DATABASE.md) and 1 row on the synthetic copy with an injected project and an assigned scientist: `(900001, 'Aurelia', 'Advanced TN Technology', field 1 'Power and Propulsion', facilities 5, 'Jennifer Woodby', bonus 1.15, labs 5)`. E returned 2,199 rows, 0.03 s (2,198 after the synthetic assignment). E sample: `(813349, 'Bryan Seanez', field 1, age 57.8, labs 4, research 1.45)`.

JS: effective research bonus uses the formula already in `index.vue:707`: in-field `4 * b - 3`, out-of-field `b` (the docs: changing field cuts the bonus by 75%). A candidate is better when `scientist.ResSpecID == project.ProjectField`, `Labs >= project.Facilities` (the docs define Research Admin as the maximum labs the scientist can run) and its effective bonus is higher; prefer `HealthRisk` not worse. On the synthetic project the current scientist's effective bonus is 1.60 and there are 87 idle same-field scientists with enough labs; the best has 1.40 (effective 2.60). The existing "mismatched research field" warning (warnings.vue:1250) already flags out-of-field commanders; this view adds "better idle scientist exists".

**SQL F: specialist ships and their commanders; SQL G: pool of idle naval officers.** Specialist means `MiningModules > 0` (orbital miner), `Harvesters > 0`, `Terraformers > 0`, or `GeoSurvey > 0` / `GravSurvey > 0`. Primary bonus per class comes from the docs' assignment table: terraformer 9, harvester or orbital miner 6, geo/grav survey 2 (the ship commander only gets half of Survey; the Science Officer posts 10 get the full value).

```sql
select s.ShipID, s.ShipName, f.FleetID, f.FleetName, sc.ShipClassID, sc.ClassName, sc.RankRequired, sc.NoOfficers, sc.MiningModules, sc.Terraformers, sc.Harvesters, sc.GeoSurvey, sc.GravSurvey, c.CommanderID, c.Name as CommanderName, rk.Level as CommanderLevel, max(case when b.BonusID = 6 then b.BonusValue end) as Mining, max(case when b.BonusID = 9 then b.BonusValue end) as Terraforming, max(case when b.BonusID = 2 then b.BonusValue end) as Survey
from FCT_Ship as s
inner join FCT_Fleet as f on f.FleetID = s.FleetID
inner join FCT_ShipClass as sc on sc.ShipClassID = s.ShipClassID
left join FCT_Commander as c on c.CommandType = 1 and c.CommandID = s.ShipID and c.GameID = s.GameID
left join (
  select r.RankID, (select max(r2.Priority) from FCT_Ranks as r2 where r2.RaceID = r.RaceID and r2.RankType = r.RankType) - r.Priority + 1 as Level
  from FCT_Ranks as r where r.GameID = ${this.GameID} and r.RaceID = ${this.RaceID}
) as rk on rk.RankID = c.RankID
left join FCT_CommanderBonuses as b on b.CommanderID = c.CommanderID and b.BonusID in (2, 6, 9)
where s.GameID = ${this.GameID} and s.RaceID = ${this.RaceID} and s.ShippingLineID = 0
  and (sc.MiningModules > 0 or sc.Terraformers > 0 or sc.Harvesters > 0 or sc.GeoSurvey > 0 or sc.GravSurvey > 0)
group by s.ShipID
order by sc.ClassName, s.ShipName
```
```sql
select c.CommanderID, c.Name, c.CommandType, c.RankID, rk.RankAbbrev, rk.Level, c.HealthRisk, round(coalesce(sp.GraduationAge, 21) + (g.GameTime - c.CareerStart) / 31536000.0, 1) as Age, max(case when b.BonusID = 2 then b.BonusValue end) as Survey, max(case when b.BonusID = 5 then b.BonusValue end) as Production, max(case when b.BonusID = 6 then b.BonusValue end) as Mining, max(case when b.BonusID = 9 then b.BonusValue end) as Terraforming
from FCT_Commander as c
inner join FCT_Game as g on g.GameID = c.GameID
inner join FCT_CommanderBonuses as b on b.CommanderID = c.CommanderID and b.BonusID in (2, 5, 6, 9)
left join FCT_Species as sp on sp.SpeciesID = c.SpeciesID and sp.GameID = c.GameID
left join (
  select r.RankID, r.RankAbbrev, (select max(r2.Priority) from FCT_Ranks as r2 where r2.RaceID = r.RaceID and r2.RankType = r.RankType) - r.Priority + 1 as Level
  from FCT_Ranks as r where r.GameID = ${this.GameID} and r.RaceID = ${this.RaceID}
) as rk on rk.RankID = c.RankID
where c.GameID = ${this.GameID} and c.RaceID = ${this.RaceID} and c.CommanderType = 0 and c.Deceased = 0
  and c.CommandType in (0, 8, 9, 10, 11, 15)
group by c.CommanderID
order by rk.Level, c.CommanderID
```
Validated: F 36 rows, 0.02 s (Gaia 16, Eden 13, Discoverer 2, Hermes [GEO] 3, Hermes [GRV] 2; no orbital miners exist on the sample). It exposes real mismatches: `(AIN Discoverer, survey class, commander 'Dong Ning Ning', Survey NULL, Terraforming 1.1)` and `(Eden 001 terraformer, commander 'Donn Caceres', Terraforming NULL, Survey 1.1)`. G returned 4,683 rows (idle or secondary-post naval officers having any of bonuses 2, 5, 6, 9), 0.05 s; by level: 4,019 at 1, 438 at 2, 226 at 3.

JS: for each specialist ship, candidates = pool rows with `Level >= ship.RankRequired` (auto-assignment picks exactly the required level; allow >= for manual use), `CommandType = 0` or a secondary post (8, 9, 10, 11, 15; Aurora treats those officers as available), and the relevant bonus above the current commander's (null = 1.0). On the sample no idle officer at level >= required beats an assigned specialist (the only idle Terraforming officers, 1,073 of them, are level 1), so show "candidates below required rank" as a separate greyed group that needs a promotion.

**Reuse.** `index.vue:808-826` already joins `FCT_Commander` to `FCT_CommanderBonuses` for naval admin and terraformer maths; copy its join style. Existing lookups: DATABASE.md "Commander bonus rules" (sector governors give a quarter of their bonuses; naval admin commands pass 25% of Mining/Terraforming). The page needs a `<v-tab>` and a `title()` case in layouts/default.vue.

**Caveats / open questions.**
- Codes 8, 9, 10, 11, 15 labels are inferred (see cross-cutting section). Label them "Secondary post (inferred)" until confirmed from the game UI.
- `HealthRisk` scale and `PromotionScore` semantics are undocumented; show them as raw numbers.
- Do not show other races' commanders; scope every query by `RaceID`. `FCT_Commander` rows for POWs/prisoners exist (`Prisoner`, `POWRaceID`); both are 0 on the sample, but filter `Prisoner = 0` if a save has them.
- A commander in a `CommandType = 12` command (naval admin) is "assigned" for the idle test even if the admin command is otherwise empty (assumption; Aurora's own rules for admin posts were not checked).
- Candidate lists can reach thousands of rows: cap each to the top 5 per colony/ship in JS.

---

## 3. Fleet hygiene warnings

**Purpose.** Convention-free hygiene checks for fleets, ships, classes and colonies, added as new sections on warnings.vue (or a sub-page). One SQL per warning. Each is scoped by `GameID` and `RaceID` and read-only.

**Already covered by warnings.vue (do not duplicate):** colonies with mines but no deposits (`wastedMiningCapacity`, warnings.vue:716; zero hits on the sample and equivalent to W5 below), populated colonies with no governor (`governorlessPopulations`, :1234), researchers in the wrong field (`mismatchedResearchFields`, :1250), obsolete ships and shipyards (:929, :1298), classes without cargo shuttles, low maintenance, low morale. Note `wastedMiningCapacity` counts any installation with `MiningProductionValue > 0`, which includes Conventional Industry (0.15) and Civilian Mining Complex (10); narrow it to IDs 7, 12 and 48 (Mine, Automated Mine, Forced Labour Mining Camp) if false positives show up. Aurora deletes depleted deposit rows (min `Amount` on the sample is 1.0), so no separate "depleted" check is needed.

| # | Warning | Sample rows | Synthetic rows | New? |
|---|---|---|---|---|
| W1 | Idle mobile non-civilian fleets | 136 (2 away from any colony) | 137 | new |
| W2 | Ships carrying cargo with no orders | 0 | 2 | new |
| W3 | Survey order without matching sensor | 0 | 1 | new |
| W4 | Orbital miners at unminable bodies | 0 | 3 | new |
| W5 | Mines without deposits | 0 | n/a | covered |
| W6 | Mining colonies without mass-driver destination | 0 (6 without the hub exclusion) | 4 | new |
| W7 | Ships missing crew | 1 | n/a | new |
| W8 | Classes with outdated crew design efficiency | 0 (9 if captured and locked classes are included) | n/a | new |
| W9 | Prototypes marked for research without a project | 0 | 1 | new |
| W10 | Fleets assigned to a non-existent population | 0 | 1 | new |

Synthetic injections: orders deleted from a cargo-carrying fleet (W2, W1), a grav-survey order added to a fleet without a survey sensor (W3), `MiningModules = 3` set on a class whose fleets sit at a colony without deposits and at a body above the diameter limit (W4), `MassDriverDest` cleared on three Regulus colonies (W6), `Prototype = 3` set on a race component (W9), a fleet's `AssignedPopulationID` set to 999999 (W10).

**W1: idle fleets.** Non-civilian, mobile fleets with at least one non-overhauling, non-docked ship and no `FCT_MoveOrders` rows. Speed 1 fleets are immobile stations or trailers and are excluded. 171 fleets have no orders on the sample, 136 are mobile, and 134 of those sit at an own colony (parked home fleets); the UI should default to "not at an own colony" (the 2 TDF Patrol Flotillas in Epsilon Ceti and Eta Cassiopei, both in deep space) with a toggle for the parked ones, and persist per-fleet ignores in `this.config` under `game.<GameID>.race.<RaceID>.idleFleetExclusions` (the same pattern as `maintenanceExclusions`). Replaces the reference's name-prefix filters.

```sql
select f.FleetID, f.FleetName, f.SystemID, rss.Name as SystemName, f.OrbitBodyID, f.Speed, fs.Ships, fs.Fuel, (select p.PopName from FCT_Population as p where p.SystemBodyID = f.OrbitBodyID and p.RaceID = f.RaceID and p.GameID = f.GameID limit 1) as ColonyName, (select jp.WarpPointID from FCT_JumpPoint as jp where jp.SystemID = f.SystemID and jp.GameID = f.GameID and jp.Xcor = f.Xcor and jp.Ycor = f.Ycor limit 1) as AtJumpPointID, f.ConditionalOrderOne, f.AnchorFleetID
from FCT_Fleet as f
inner join (
  select s.FleetID, count(*) as Ships, sum(s.Fuel) as Fuel,
    sum(case when s.MaintenanceState = 2 then 1 else 0 end) as Overhauling,
    sum(case when s.MothershipID > 0 then 1 else 0 end) as Docked
  from FCT_Ship as s
  where s.GameID = ${this.GameID} and s.RaceID = ${this.RaceID}
  group by s.FleetID
) as fs on fs.FleetID = f.FleetID and fs.Overhauling < fs.Ships and fs.Docked < fs.Ships
left join FCT_RaceSysSurvey as rss on rss.SystemID = f.SystemID and rss.RaceID = f.RaceID and rss.GameID = f.GameID
where f.GameID = ${this.GameID} and f.RaceID = ${this.RaceID}
  and f.ShippingLine = 0 and f.CivilianFunction = 0 and f.Speed > 1
  and not exists (select 1 from FCT_MoveOrders as mo where mo.FleetID = f.FleetID)
order by f.FleetName
```
Location class in JS: `ColonyName` set means parked at own colony; else `OrbitBodyID > 0` means at a body; else `AtJumpPointID` set means at a jump point; else deep space. `ConditionalOrderOne` and `AnchorFleetID` are returned so the UI can grey out fleets that have conditional orders or follow another fleet. Fleets with no ships (8 on the sample) never appear because of the inner join; they are a separate (cosmetic) check.

**W2: ships with cargo and no orders.** Cargo types in `FCT_ShipCargo`: 1 colonists, 2 installations, 3 minerals (the references also use 6 for ship components and 7 for ground-related cargo; only 1, 2 and 3 occur on the sample). Excludes civilian fleets (they wait for orders by design) and speed 1 fleets (the sample has 11 immobile one-ship fleets holding millions of colonists or minerals, which is a station function, not a bug). 31 mobile fleets carry cargo on the sample and all have orders.

```sql
select f.FleetID, f.FleetName, s.ShipID, s.ShipName, sc.ClassName, rss.Name as SystemName, sum(case when c.CargoTypeID = 1 then c.Amount else 0 end) as Colonists, sum(case when c.CargoTypeID = 2 then c.Amount else 0 end) as Installations, sum(case when c.CargoTypeID = 3 then c.Amount else 0 end) as Minerals, sum(case when c.CargoTypeID not in (1, 2, 3) then c.Amount else 0 end) as Other
from FCT_Fleet as f
inner join FCT_Ship as s on s.FleetID = f.FleetID and s.GameID = f.GameID
inner join FCT_ShipClass as sc on sc.ShipClassID = s.ShipClassID
inner join FCT_ShipCargo as c on c.ShipID = s.ShipID and c.GameID = s.GameID and c.Amount > 0
left join FCT_RaceSysSurvey as rss on rss.SystemID = f.SystemID and rss.RaceID = f.RaceID and rss.GameID = f.GameID
where f.GameID = ${this.GameID} and f.RaceID = ${this.RaceID}
  and f.ShippingLine = 0 and f.CivilianFunction = 0 and f.Speed > 1
  and not exists (select 1 from FCT_MoveOrders as mo where mo.FleetID = f.FleetID)
group by s.ShipID
order by f.FleetName, s.ShipName
```
Synthetic sample: `(460033, 'Minerals: Aurelia -> Chronos', 'C400 Hauler 001', minerals 200)`.

**W3: survey order without the matching sensor.** Uses the class columns `GeoSurvey` (Double) and `GravSurvey` (INTEGER), which agree with the sensor components (ComponentTypeID 7 geo, 6 grav; verified on Owl, Discoverer, Hermes [GEO]). Order IDs: 9 Geological Survey, 12 Gravitational Survey (DIM_MoveAction). The sample has 1 survey order (fleet `DSS-02 AIN Intrepid`) and it is fine.

```sql
select f.FleetID, f.FleetName, mo.MoveOrder, mo.MoveActionID, ma.Description as OrderName, mo.Description as OrderDescription, sum(case when sc.GeoSurvey > 0 then 1 else 0 end) as GeoShips, sum(case when sc.GravSurvey > 0 then 1 else 0 end) as GravShips
from FCT_MoveOrders as mo
inner join FCT_Fleet as f on f.FleetID = mo.FleetID
inner join DIM_MoveAction as ma on ma.MoveActionID = mo.MoveActionID
inner join FCT_Ship as s on s.FleetID = f.FleetID
inner join FCT_ShipClass as sc on sc.ShipClassID = s.ShipClassID
where f.GameID = ${this.GameID} and f.RaceID = ${this.RaceID} and mo.MoveActionID in (9, 12)
group by mo.MoveOrderID
having (mo.MoveActionID = 9 and GeoShips = 0) or (mo.MoveActionID = 12 and GravShips = 0)
order by f.FleetName, mo.MoveOrder
```
**W4: orbital miners at bodies they cannot mine.** `MaximumOrbitalMiningDiameter` is 4000 on the sample race (the docs say the tech line starts at 100 km and ends at 500 km, so trust the saved value, not the docs); a body qualifies when `Radius * 2 <= MaximumOrbitalMiningDiameter`. A body with no `FCT_MineralDeposit` rows has nothing to mine. To respect fog of war the check reports 'not geo-surveyed' when the race has no `FCT_SystemBodySurveys` row for the body, instead of revealing deposit data. Fleets with orders are skipped (in transit or releasing tractored ships). Synthetic: `('BG-01 Core Group', 'Brimstone', diameter 4500 > 4000, deposits 11, 'body too large')` and two fleets at Aurelia (no deposits). Also see the Warnings page's `wastedMiningCapacity` for surface mines.

```sql
select f.FleetID, f.FleetName, f.SystemID, rss.Name as SystemName, f.OrbitBodyID, sb.BodyClass, sb.PlanetNumber, sb.OrbitNumber, star.Component, sbn.Name as BodyName, sb.Radius * 2 as DiameterKm, r.MaximumOrbitalMiningDiameter as MaxDiameterKm, dep.Deposits, sum(sc.MiningModules) as MiningModules, case when sbs.SystemBodyID is null then 'not geo-surveyed' when dep.Deposits is null then 'no deposits' else 'body too large' end as Reason
from FCT_Fleet as f
inner join FCT_Race as r on r.RaceID = f.RaceID and r.GameID = f.GameID
inner join FCT_Ship as s on s.FleetID = f.FleetID
inner join FCT_ShipClass as sc on sc.ShipClassID = s.ShipClassID and sc.MiningModules > 0
inner join FCT_SystemBody as sb on sb.SystemBodyID = f.OrbitBodyID
left join FCT_Star as star on star.StarID = sb.StarID
left join FCT_SystemBodyName as sbn on sbn.SystemBodyID = sb.SystemBodyID and sbn.RaceID = f.RaceID
left join FCT_SystemBodySurveys as sbs on sbs.SystemBodyID = sb.SystemBodyID and sbs.RaceID = f.RaceID and sbs.GameID = f.GameID
left join FCT_RaceSysSurvey as rss on rss.SystemID = f.SystemID and rss.RaceID = f.RaceID and rss.GameID = f.GameID
left join (select SystemBodyID, count(*) as Deposits from FCT_MineralDeposit where GameID = ${this.GameID} group by SystemBodyID) as dep on dep.SystemBodyID = sb.SystemBodyID
where f.GameID = ${this.GameID} and f.RaceID = ${this.RaceID} and f.OrbitBodyID > 0
  and (sbs.SystemBodyID is null or dep.Deposits is null or sb.Radius * 2 > r.MaximumOrbitalMiningDiameter)
  and not exists (select 1 from FCT_MoveOrders as mo where mo.FleetID = f.FleetID)
group by f.FleetID
order by f.FleetName
```
**W5: mines without deposits.** Already covered by `wastedMiningCapacity` (warnings.vue:716), 0 rows on the sample. No new SQL.

**W6: mining colonies without a mass-driver destination.** Colony has mines (IDs 7, 12, 48), at least one mass driver (`DIM_PlanetaryInstallation.MassDriverValue > 0`), deposits on its body, `MassDriverDest = 0`, and another own colony in the same system. A colony that is already the destination of another colony (a hub) is excluded; without that exclusion the sample returns 6 rows, all hubs (Belka, Elysium, Geburah and three more) that legitimately keep `MassDriverDest = 0`. This replaces the reference's `'%HUB%'` name convention. Synthetic (hub links cleared): `(49072, 'Belka', 'Regulus', mines 1790, drivers 20, 3 other colonies)`.

```sql
select p.PopulationID, p.PopName, p.SystemID, rss.Name as SystemName, mine.Mines, md.Drivers, dep.Deposits, (select count(*) from FCT_Population as o where o.SystemID = p.SystemID and o.RaceID = p.RaceID and o.GameID = p.GameID and o.PopulationID <> p.PopulationID) as OtherColonies, (select group_concat(o.PopulationID || ':' || o.PopName, '|') from FCT_Population as o where o.SystemID = p.SystemID and o.RaceID = p.RaceID and o.GameID = p.GameID and o.PopulationID <> p.PopulationID) as OtherColonyList
from FCT_Population as p
inner join (
  select pi.PopID, sum(pi.Amount) as Mines from FCT_PopulationInstallations as pi
  where pi.PlanetaryInstallationID in (7, 12, 48) group by pi.PopID
) as mine on mine.PopID = p.PopulationID
inner join (
  select pi.PopID, sum(pi.Amount) as Drivers from FCT_PopulationInstallations as pi
  inner join DIM_PlanetaryInstallation as di on di.PlanetaryInstallationID = pi.PlanetaryInstallationID and di.MassDriverValue > 0
  group by pi.PopID
) as md on md.PopID = p.PopulationID
inner join (select SystemBodyID, count(*) as Deposits from FCT_MineralDeposit where GameID = ${this.GameID} and Amount > 0 group by SystemBodyID) as dep on dep.SystemBodyID = p.SystemBodyID
left join FCT_RaceSysSurvey as rss on rss.SystemID = p.SystemID and rss.RaceID = p.RaceID and rss.GameID = p.GameID
where p.GameID = ${this.GameID} and p.RaceID = ${this.RaceID} and p.MassDriverDest = 0
  and OtherColonies > 0
  and not exists (select 1 from FCT_Population as h where h.MassDriverDest = p.PopulationID and h.GameID = p.GameID)
order by p.PopName
```
**W7: ships missing crew.** Sample: `(460648, 'DDG-02 Sri Tiga 002', ship 'Sri Tiga 002', class 'Sri Tiga', crew 1 of 357, 0.3%, morale 0.25)` (a captured class).

```sql
select f.FleetID, f.FleetName, s.ShipID, s.ShipName, sc.ClassName, s.CurrentCrew, sc.Crew, sc.Crew - s.CurrentCrew as MissingCrew, round(100.0 * s.CurrentCrew / sc.Crew, 1) as CrewPercent, s.CrewMorale, (select p.PopName from FCT_Population as p where p.SystemBodyID = f.OrbitBodyID and p.RaceID = f.RaceID and p.GameID = f.GameID limit 1) as ColonyName
from FCT_Ship as s
inner join FCT_Fleet as f on f.FleetID = s.FleetID
inner join FCT_ShipClass as sc on sc.ShipClassID = s.ShipClassID
where s.GameID = ${this.GameID} and s.RaceID = ${this.RaceID} and s.ShippingLineID = 0
  and sc.Crew > 0 and s.CurrentCrew < sc.Crew
order by MissingCrew desc, f.FleetName
```
**W8: classes with outdated crew design efficiency.** CDE is a multiplier of crew quarters space: 1.0 means standard, 0.9 to 0.25 are the Crew Quarters Design techs (verified from `FCT_TechSystem`: 'Crew Quarters Design - 10% HS Reduction' = 0.9 ... '75% HS Reduction' = 0.25). Lower is better, so a class needs updating when its value is *greater* than the race's (`FCT_Race.CrewDesignEfficiency`, 0.1 on the sample). The sample's 9 classes at 1.0 are all captured (`OtherRaceClassID <> 0`) and locked, hence 0 rows; the Update CDE button only works on unlocked classes, so return `Locked` and let the UI say "unlock first".

```sql
select sc.ShipClassID, sc.ClassName, sc.CrewDesignEfficiency as ClassEfficiency, r.CrewDesignEfficiency as RaceEfficiency, sc.Locked, sc.TotalNumber, (select count(*) from FCT_Ship as s where s.ShipClassID = sc.ShipClassID and s.GameID = sc.GameID) as Ships
from FCT_ShipClass as sc
inner join FCT_Race as r on r.RaceID = sc.RaceID and r.GameID = sc.GameID
where sc.GameID = ${this.GameID} and sc.RaceID = ${this.RaceID}
  and sc.Obsolete = 0 and sc.ClassShippingLineID = 0 and sc.OtherRaceClassID = 0
  and sc.CrewDesignEfficiency > r.CrewDesignEfficiency
order by sc.ClassName
```
**W9: prototype components marked for research but not being researched.** `FCT_ShipDesignComponents.Prototype`: 0 not a prototype, 1 prototype not marked, 3 marked for research (the docs call these Research Prototypes). `FCT_ShipDesignComponents.GameID` is 0 for stock components, so do not join it on `GameID`. `FCT_ResearchQueue` has no `RaceID`, only `GameID`/`PopulationID`/`TechSystemID`. Synthetic: `(3, 'Cargo Hold - Small', Prototype 3, 'Transport - Cargo')`.

```sql
select sdc.SDComponentID, sdc.Name, sdc.Prototype, sdc.ComponentTypeID, dct.TypeDescription, sdc.Cost, rt.Obsolete
from FCT_RaceTech as rt
inner join FCT_ShipDesignComponents as sdc on sdc.SDComponentID = rt.TechID
left join DIM_ComponentType as dct on dct.ComponentTypeID = sdc.ComponentTypeID
where rt.GameID = ${this.GameID} and rt.RaceID = ${this.RaceID}
  and sdc.Prototype = 3
  and not exists (select 1 from FCT_ResearchProject as rp where rp.TechID = rt.TechID and rp.RaceID = rt.RaceID and rp.GameID = rt.GameID)
  and not exists (select 1 from FCT_ResearchQueue as rq where rq.TechSystemID = rt.TechID and rq.GameID = rt.GameID)
order by sdc.Name
```
**W10: fleets assigned to a population that no longer exists.** Synthetic: `(459996, 'Colony Group - 001', AssignedPopulationID 999999, 'Aurelus')`. 193 of 227 sample fleets have an assigned population and all resolve.

```sql
select f.FleetID, f.FleetName, f.AssignedPopulationID, rss.Name as SystemName
from FCT_Fleet as f
left join FCT_Population as p on p.PopulationID = f.AssignedPopulationID
left join FCT_RaceSysSurvey as rss on rss.SystemID = f.SystemID and rss.RaceID = f.RaceID and rss.GameID = f.GameID
where f.GameID = ${this.GameID} and f.RaceID = ${this.RaceID}
  and f.AssignedPopulationID <> 0 and p.PopulationID is null
order by f.FleetName
```
**JS-side logic.** Each warning is an `asyncComputed` guarded on `this.database`, `this.GameID` and `this.RaceID` (the warnings.vue pattern), shown as a collapsible `v-list` with the fleet or ship name as title. W1 and W4 need `systemBodyName()` / `populationName()` style helpers already used in warnings.vue for the body name (the SQL returns `PlanetNumber`, `OrbitNumber`, `Component`, `BodyClass`, `BodyName`).

**Reuse.** warnings.vue's section/list markup; `maintenanceExclusions` config pattern for W1 ignores.

**Caveats / open questions.**
- W1 will be noisy in saves like the sample where home fleets are parked on purpose. Parked-at-colony is therefore a toggle, and per-fleet ignore is persisted. A stronger signal (fleet idle for a long time) needs `FCT_FleetHistory` and is not designed here.
- W4 skips fleets with any orders; a miner that is mid-route stays silent until it arrives. The reference also skipped fleets with a "release tractored ships" order; MoveActionID 161 would extend that.
- W2 uses `Speed > 1` to exclude stations. A mobile freighter that is immobile because it has no engines would be excluded too.
- W6's hub rule can miss a colony that is itself a destination for a colony in another system; refine if users complain.
- The sample has no case for W5, W8 (non-captured) or W4 in real data; all were exercised only synthetically.

---

## 4. Route Finder & Distances

**Purpose.** Shortest jump route between two known systems over the race's explored jump points, with the in-system distance between each entry and exit jump point, total distance and travel time at a chosen speed. Also computes "jumps and km from the capital" for every known system, usable by other pages.

**Fog of war.** Edges come only from jump points the race has **explored** (`FCT_RaceJumpPointSurvey.Explored = 1`) whose partner (`FCT_JumpPoint.WPLink`) is also explored. The sample: 358 explored, 97 charted but not explored (partner system unknown, therefore not usable), 1 neither. Every explored point has its partner explored, so the graph is symmetric: 358 directed edges = 179 links over 169 known systems (`FCT_RaceSysSurvey`), all reachable from the capital (max 11 jumps).

**SQL A: nodes (known systems).**

```sql
select rss.SystemID, rss.Name, rss.Xcor as MapX, rss.Ycor as MapY, rss.ControlRaceID, rss.DangerRating, rss.MilitaryRestrictedSystem, rss.NoAutoRoute, rss.SurveyDone
from FCT_RaceSysSurvey as rss
where rss.GameID = ${this.GameID} and rss.RaceID = ${this.RaceID}
```
Validated: 169 rows, 0.00 s: `(21644, 'Aurelus', MapX 0, MapY 0, control 0, danger 0, restricted 0, noAutoRoute 0, surveyDone 1)`, `(21645, 'Procyon', 140, 0, ...)`. `MapX/MapY` are the galactic-map pixel positions (not used for distance).

**SQL B: edges (directed, one row per explored jump point).** `Xcor/Ycor` are in km within the system; the partner row gives the arrival point.

```sql
select jp.WarpPointID, jp.SystemID, jp.Xcor, jp.Ycor, jp.WPLink as DestWarpPointID, dest.SystemID as DestSystemID, jp.JumpGateStrength, jp.JumpGateRaceID, rjp.MilitaryRestricted, rjp.IgnoreForDistance, rjp.Hide
from FCT_RaceJumpPointSurvey as rjp
inner join FCT_JumpPoint as jp on jp.WarpPointID = rjp.WarpPointID and jp.GameID = rjp.GameID
inner join FCT_JumpPoint as dest on dest.WarpPointID = jp.WPLink and dest.GameID = jp.GameID
inner join FCT_RaceJumpPointSurvey as rjd on rjd.WarpPointID = dest.WarpPointID and rjd.RaceID = rjp.RaceID and rjd.GameID = rjp.GameID and rjd.Explored = 1
where rjp.GameID = ${this.GameID} and rjp.RaceID = ${this.RaceID} and rjp.Explored = 1
```
Validated: 358 rows, 0.00 s: `(59723, system 21701, x -12257077.37, y -4220450.20, dest JP 59854, dest system 21745, gate 0, ...)`. `JumpGateStrength > 0` marks gates (82 of 458 points); `MilitaryRestricted`, `IgnoreForDistance`, `Hide` are race-level flags to offer as "avoid" options. `IgnoreForDistance` is not used by the SQL; its meaning is undocumented.

**SQL C: capital position** (start point for "distance from capital"; the capital's body coordinates are the current orbital position, so results shift slightly over game time).

```sql
select p.PopulationID, p.PopName, p.SystemID, sb.SystemBodyID, sb.Xcor, sb.Ycor
from FCT_Population as p
inner join FCT_SystemBody as sb on sb.SystemBodyID = p.SystemBodyID
where p.GameID = ${this.GameID} and p.RaceID = ${this.RaceID} and p.Capital = 1
```
Validated: 1 row: `(48980, 'Aurelia', system 21644, body 1991021, x 555441673.67, y -1311013286.82)`. Fall back to the most populous colony if no `Capital = 1` row exists.

**SQL D (optional): Lagrange point nodes** for the "use LPs" toggle: 74 rows in known systems. Docs (fleet-movement.md "Create New Lagrange Points"): ships can jump between stable Lagrange points of a system. Model that as LP-to-LP edges with zero distance, plus ordinary in-system legs between a jump point and an LP.

```sql
select lp.LagrangePointID, lp.SystemID, lp.PlanetID, lp.Xcor, lp.Ycor
from FCT_LagrangePoint as lp
inner join FCT_RaceSysSurvey as rss on rss.SystemID = lp.SystemID and rss.GameID = lp.GameID and rss.RaceID = ${this.RaceID}
where lp.GameID = ${this.GameID}
```
**JS Dijkstra (no recursive SQL).**
- State is `(systemID, entryJumpPointID | null)`, not just the system, because the leg inside a system depends on which jump point you arrived at. Build `adj[systemID] = [edge rows]` and `jp[warpPointID] = edge row` from SQL B.
- Cost is a pair `[jumps, km]` compared lexicographically (Aurora's auto-route behaviour: fewest transits, ties by distance). Offer a toggle to switch to `[km, jumps]` for "shortest by distance".
- Relaxing edge `r` from state `(s, entry)`: `leg = entry == null ? (origin ? hypot(origin.x - r.Xcor, origin.y - r.Ycor) : 0) : hypot(jp[entry].Xcor - r.Xcor, jp[entry].Ycor - r.Ycor)`; push `[jumps + 1, km + leg]` to state `(r.DestSystemID, r.DestWarpPointID)`. The first system's entry leg is 0 unless an origin point (a body or fleet position) is given. A final leg from the last entry point to a destination body is added the same way.
- Use a binary heap (`utilities/math.js` has none; ~25 lines). 169 systems and 358 edges are trivial; run once per request, or once per capital for the "distance from capital" table.
- Travel time seconds = `km / speedKmPerSec`; days = `/ 86400`. A fleet's speed is `FCT_Fleet.Speed` (km/s), a class's is `FCT_ShipClass.MaxSpeed`. Jumps themselves add no distance. Ignores transit delay for squadron jumps and fuel.
- Avoid options: skip edges whose destination system has `NoAutoRoute = 1`, `MilitaryRestrictedSystem = 1` or `ControlRaceID` not 0 and not the race's own, or `DangerRating > 0`, mirroring the fleet "Avoid Danger" and "Avoid Alien Systems" flags (docs).

**Validation of the algorithm (verified).** Using SQL A and B, a Dijkstra with cost (jumps, km) and a free start reproduced the exact jump-point sequence of 109 of 110 contiguous Standard Transit order chains (start != end) stored for the race in `FCT_MoveOrders` (orders store `DestinationID` = exit JP and `NewWarpPointID` = arrival JP). Cost (km, jumps) matched only 92. The one miss has the same number of jumps and a longer distance (fleet 460495, Kochab to Aurelus), probably a manual or avoid-flag route.

**Sample outputs** (free start at the first exit jump point, speed 75,000 km/s):
- `Zhang > Iota Pegasi > Aurelus`: 2 jumps, 5.95 Gkm, 0.9 days. Shortest by km is `Zhang > Merope > Capella > Aurelus`: 3 jumps, 5.00 Gkm, 0.8 days. Aurora's own stored orders use the first.
- `Aurelus > Capella > Vega > Alhena > Alpha Mensae > Lyssaros > Curia > Gamma Virginis > Orion > Lorynn > Meryth > Grolvith`: 11 jumps, 50.85 Gkm, 7.8 days.
- Distance from capital (start at Aurelia's coordinates, so it includes the first in-system leg): Procyon 1 jump / 1.198 Gkm, Capella 1 / 3.712, Epsilon Ceti 1 / 4.492, Selene 10 / 51.473, Grolvith 11 / 54.566; all 169 systems reachable.

**Reuse.** map.vue:1813 loads jump points with a `Charted = 1` filter and no `Explored` filter (right for drawing, wrong for routing: it includes unexplored points whose destination is not known). Keep the route graph separate, or reuse the node list by sharing a Vuex module (`store/`) with the "distance from capital" table so the Map, Minerals and Habitability pages can show it. `utilities/map.js` and `utilities/math.js` are the places for the Dijkstra and the heap.

**Caveats / open questions.**
- A destination body's position is its current orbital position; moons and planets move, so an in-system last leg is an approximation.
- Gates: `JumpGateStrength > 0` points allow free movement between gates with no squadron limit; they do not change distances, so they are ignored here.
- Intra-system Lagrange jumps are optional (SQL D) and Aurora only uses them if the fleet's LP option is on.
- The route graph for another race (spyNPR) would need that race's own survey rows; the same SQL works with its `RaceID`, but do not show other races' routes without the setting.

---

## 5. Lagrange Points

**Purpose.** For every planet and moon in known systems with mass of at least 0.25, show whether it has a stable Lagrange point and, if not, how many years a stabilisation ship needs.

**Formula (verified against the docs).** fleet-movement.md: time in months = 60 / sqrt(planet mass), the ship commander's production bonus reduces it, planets below 0.25 mass cannot be stabilised, planets of mass 150 or more already have a stable point. `5 / sqrt(mass)` years in `AllLagrangePoints_Basic.sql` is the same thing (60 months = 5 years). Docs examples agree: Saturn (95) = 6.2 months, Earth (1) = 5 years, Uranus (14) = 1.3 years. Moons can be stabilised too (mass >= 0.25); the reference query only looked at gas giants (`BodyTypeID in (4, 5)`).

**Data facts.** `FCT_LagrangePoint` (LagrangePointID, SystemID, StarID, PlanetID, Xcor, Ycor, Distance, Bearing): 75 rows in the game, one per planet that has a stable point. Body types: 4 gas giant and 5 super jovian (the labels in SystemView.vue:44). `FCT_SystemBody.Mass` is in Earth masses (gas giants 2.9 to 4000).

**SQL.** Known systems come from `FCT_RaceSysSurvey` (the reference used `FCT_SystemBodySurveys`, which only has geologically surveyed bodies: 373 of the 376 candidate bodies; using the system survey also shows bodies in grav-surveyed systems).

```sql
select sb.SystemBodyID, sb.SystemID, rss.Name as SystemName, rss.SurveyDone, sb.PlanetNumber, sb.OrbitNumber, sb.BodyClass, sb.BodyTypeID, sb.Mass, sb.Radius, sbn.Name as SystemBodyName, star.Component, sb.OrbitalDistance, lp.LagrangePointID, lp.Distance as LPDistance, case when lp.LagrangePointID is null then round(5.0 / sqrt(sb.Mass), 2) end as StabilisationYears, (select count(*) from FCT_Population as p where p.SystemID = sb.SystemID and p.RaceID = rss.RaceID and p.GameID = rss.GameID) as ColoniesInSystem
from FCT_SystemBody as sb
inner join FCT_RaceSysSurvey as rss on rss.SystemID = sb.SystemID and rss.GameID = sb.GameID and rss.RaceID = ${this.RaceID}
left join FCT_SystemBodyName as sbn on sbn.SystemBodyID = sb.SystemBodyID and sbn.RaceID = rss.RaceID
left join FCT_Star as star on star.StarID = sb.StarID
left join FCT_LagrangePoint as lp on lp.PlanetID = sb.SystemBodyID and lp.GameID = sb.GameID
where sb.GameID = ${this.GameID} and sb.BodyClass in (1, 2) and sb.Mass >= 0.25
order by lp.LagrangePointID is null desc, sb.Mass desc
```
Validated: 376 rows (planets and moons with mass >= 0.25 in the race's 169 known systems), 0.01 s. 74 have a stable LP, 302 do not (262 planets and 40 moons; by body type: 153 type 2, 109 gas giants type 4, 40 moons type 11). Years to stabilise range 0.36 to 9.94 on the sample. Sample rows: `('Solarii Pax', mass 188.13, gas giant, no LP, 0.36 years, 0 colonies in system)`, `('Corvis', 179.51, 0.37 years, 3 colonies in system)`, `('Gloriana', 176.65, 0.38 years)`. 100 of the 302 candidate bodies are in a system where the race has a colony.

**JS-side logic.**
- Display name: `SystemBodyName` if set, else `systemBodyName()` from `PlanetNumber`, `OrbitNumber`, `Component`, `BodyClass` (utilities/aurora.js; already used by warnings.vue).
- Time with a commander: `years / commanderProductionBonus` (bonus 5 of the stabilising ship's commander, multiplier form; assumption from the docs wording "will reduce this time"). Offer an input for the bonus (default 1.0).
- Group by system; filter chips: has LP, can be stabilised in <= N years, gas giants only, system has a colony (`ColoniesInSystem > 0`), unsurveyed system (`SurveyDone = 0`). Sort by years ascending to answer "cheapest LP to add".
- Mass >= 150 with no LP row should be shown as "expected stable (no row)" rather than "10 years": 5 gas giants (160 to 188) on the sample have no `FCT_LagrangePoint` row although their mass is above the docs' 150 threshold, while one body of mass 157.2 does have one. The cause is not visible in the save, so trust the presence of a row, not the mass rule; the `StabilisationYears` column is still computed for them (0.36 to 0.39) because the docs formula applies to any mass.

**Reuse.** Habitability and map pages already join `FCT_SystemBody` with `FCT_SystemBodyName` and `FCT_Star` (habitability.vue:2435, map SystemView.vue); the name helpers exist. A `Stabilise Lagrange Point` order has `MoveActionID = 217`; use `FCT_MoveOrders` with it to mark bodies already being worked on (0 rows on the sample).

**Caveats / open questions.**
- Anomaly above (5 bodies at mass 160 to 188 with no row). Could be game-specific generation; unresolved.
- Whether the production bonus divides or subtracts is not stated; treat the bonus-adjusted number as an estimate.
- Stable LPs jump to any other stable LP in the system; the value of a new LP depends on the other LPs there (`FCT_LagrangePoint` rows per system; max 4 per system on the sample, in Procyon), which the page can show from SQL D of feature 4.

---

## 6. Hauling Planner (lower priority)

**Purpose.** Freighter capacity per class (cargo, colonists, speed, throughput potential) and, for fleets running repeat orders, their round-trip distance and throughput per year.

**What the workbook did.** The Scoop and CyclingFleets sheets estimate demand in Bkm x kt per year and match it against supply from `vw_haulingCapacity` (`excel/hauling capacity.sql`): `BkmPerYear = MaxSpeed * 31,536,000 / 1e9`, `CargoHoldBKMPerYear = CargoCapacity / 25000 * BkmPerYear * count`, `MPopBKMPerYear = ColonistCapacity * BkmPerYear / 1e6 * count`, `MLPerYear = FuelEfficiency * EnginePower * 8760 / 1e6`. The cycling sheet (`excel/cycling.sql`) identifies cycling fleets by the author's fleet names ("CS/FT/TK ... kt/yr") and tractor-trailer pairs by class-name concatenation. Both name conventions are dropped. Cycling fleets are identified here by the real flag `FCT_Fleet.CycleMoves = 1` (46 fleets on the sample).

**Feasibility.** Class capacity: fully feasible and cheap. Round-trip distance and throughput per cycling fleet: feasible for fleets whose orders consist only of jump-point transits (`DestinationType = 1`) and body orders (`DestinationType = 2`): 33 of 46 cycling fleets on the sample compute fully; the other 13 contain order destination types 12 (Intra-system Jump to a Lagrange point, 14 orders) or 15 (6 orders). Tractor-trailer combinations: not feasible without more design (there are 0 tractored ships on the sample; `TractorTargetShipID`, `TractorParentShipID` exist). Demand modelling (which minerals must move where, as in Scoop) is out of scope: it needs surface-mining projections that the app does not compute.

**SQL A: freighter classes in service.** Excludes immobile hulls (`MaxSpeed > 1`: orbital habitats and trailers).

```sql
select sc.ShipClassID, sc.ClassName, hd.HullAbbr, sc.ClassShippingLineID, sc.Obsolete, sc.CargoCapacity, sc.ColonistCapacity, sc.MaxSpeed, sc.FuelCapacity, sc.EnginePower * sc.FuelEfficiency as FuelPerHour, sc.CargoShuttleStrength, count(s.ShipID) as Ships
from FCT_ShipClass as sc
inner join FCT_HullDescription as hd on hd.HullDescriptionID = sc.HullDescriptionID
inner join FCT_Ship as s on s.ShipClassID = sc.ShipClassID and s.GameID = sc.GameID
where sc.GameID = ${this.GameID} and sc.RaceID = ${this.RaceID}
  and (sc.CargoCapacity > 0 or sc.ColonistCapacity > 0) and sc.MaxSpeed > 1
group by sc.ShipClassID
order by sc.ClassShippingLineID, Ships desc
```
Validated: 9 rows, 0.00 s. Sample: `(Conveyor FT, cargo 26,000, speed 75,000, 23 ships)`, `(Pilgrim SL, colonists 2,750, speed 71,451, 22 ships)`, `(C400 Hauler CST, cargo 400, 20 ships)`, `(Mule FT, cargo 100,000, 15 ships)`. Derived in JS for Conveyor: 2,365 Bkm/yr per ship, 0.49 ML fuel/yr per ship at continuous full power, 1.41e9 ton-Bkm/yr for 23 ships.

**SQL B: cycling fleets with their capacity.** `Fleet.Speed` is the speed actually set (it can be below the class maximum, e.g. 20,000 against 72,008 for fleet 460576); use it for throughput.

```sql
select f.FleetID, f.FleetName, f.SystemID, f.Speed, f.UseMaximumSpeed, f.Xcor, f.Ycor, count(s.ShipID) as Ships, min(sc.MaxSpeed) as SlowestSpeed, sum(sc.CargoCapacity) as CargoCapacity, sum(sc.ColonistCapacity) as ColonistCapacity, sum(sc.EnginePower * sc.FuelEfficiency) as FuelPerHour, sum(sc.FuelCapacity) as FuelCapacity
from FCT_Fleet as f
inner join FCT_Ship as s on s.FleetID = f.FleetID
inner join FCT_ShipClass as sc on sc.ShipClassID = s.ShipClassID
where f.GameID = ${this.GameID} and f.RaceID = ${this.RaceID} and f.CycleMoves = 1 and f.ShippingLine = 0
group by f.FleetID
having sum(sc.CargoCapacity) > 0 or sum(sc.ColonistCapacity) > 0
order by f.FleetName
```
Validated: 46 rows, 0.00 s. Sample: `(459995, 'Cargo Group - 001', speed 54173, 5 ships, cargo 500,000)`, `(460576, 'Minerals: Aurelia -> Acrab', speed 20000, 1 ship, cargo 400)`.

**SQL C: orders of those fleets with destination coordinates.** `DestinationType 1` = jump point (`DestinationID` is the exit `WarpPointID`; `NewWarpPointID` is the arrival point), `2` = system body (`PopulationID` set for colonies). Actions: 4 load colonists, 6 unload colonists, 63 unload all minerals, 165 load/unload to reserve level, 176 load installation, 178 load mineral type (`DestinationItemID` = mineral), 206 refuel and resupply, 223 load all minerals until full.

```sql
select mo.FleetID, mo.MoveOrder, mo.MoveActionID, ma.Description as ActionName, mo.Description, mo.DestinationType, mo.DestinationID, mo.PopulationID, mo.DestinationItemType, mo.DestinationItemID, mo.MaxItems, mo.OrderDelay, mo.NewSystemID, mo.NewWarpPointID, coalesce(jp.SystemID, sb.SystemID) as DestSystemID, coalesce(jp.Xcor, sb.Xcor) as DestX, coalesce(jp.Ycor, sb.Ycor) as DestY
from FCT_MoveOrders as mo
inner join FCT_Fleet as f on f.FleetID = mo.FleetID and f.CycleMoves = 1
inner join DIM_MoveAction as ma on ma.MoveActionID = mo.MoveActionID
left join FCT_JumpPoint as jp on mo.DestinationType = 1 and jp.WarpPointID = mo.DestinationID
left join FCT_SystemBody as sb on mo.DestinationType = 2 and sb.SystemBodyID = mo.DestinationID
where mo.GameID = ${this.GameID} and mo.RaceID = ${this.RaceID} and f.ShippingLine = 0
order by mo.FleetID, mo.MoveOrder
```
Validated: 561 rows, 0.00 s: `(459995, order 1798, 'Standard Transit', type 1, JP 59602, new system 21659, JP 59614, dest xy -2081872241.55, -1250915043.79)`.

**JS-side logic (verified in Python, same arithmetic).**
- Walk each fleet's orders in `MoveOrder` sequence, tracking a position. For a type 1 order: add `hypot(pos - exitJP)` if a position is set, then set the position to the arrival point `NewWarpPointID` (look up its `Xcor/Ycor`; SQL B of feature 4 or a `FCT_JumpPoint` lookup). For a type 2 order: add `hypot(pos - body)` and set the position to the body. Types other than 1 or 2 mark the fleet "not computable". Close the cycle by adding the leg from the last position back to the first order's position. The result is round-trip km.
- `tripsPerYear = 31,536,000 * Speed / roundTripKm`; `cargoPerYear = tripsPerYear * CargoCapacity` (minerals and installations, tons; colonists use `ColonistCapacity`). Cargo kind comes from the first load order (4 colonists, 176 installations, 178/223 minerals, 165 either).
- Fuel per year of the cycle: `FuelPerHour * (roundTripKm / Speed / 3600)` per trip multiplied by trips (workbook formula; `FuelEfficiency * EnginePower` is litres per hour).
- Sample results (all 33 computable fleets; top by distance): `Cargo Group - 001` round trip 99.01 Gkm at 54,173 km/s = 21.2 days, 17.3 trips/yr, about 8.6 M tons/yr; `Cargo Group - 003` 81.13 Gkm at 25,000 km/s = 37.6 days, 9.7 trips, 4.9 M tons/yr; `Minerals: Aurelia -> Tertium` 48.52 Gkm, 7.8 days, 46.8 trips, 37,439 tons/yr (a 400-ton hauler).
- Totals page: sum `cargoPerYear` by destination body and cargo kind (what the workbook's CyclingTotals did) once the cargo kind and destination of each fleet are known from its load/unload orders.

**Reuse.** The route Dijkstra from feature 4 can replace the straight JP-to-JP summation when orders skip intermediate systems (they do not here; Aurora stores every transit as its own order). Class and speed formulas are in `excel/hauling capacity.sql`.

**Caveats / open questions.**
- Ignores loading time (`OrderDelay` is 0 here), refuelling stops, overhaul, orbital motion of bodies (positions are the current ones) and Aurora's per-increment rounding. Treat results as upper bounds.
- `CargoCapacity` units are as stored on the class (tons for minerals/installations as far as the references imply; cargo shuttle strength changes load time and is not modelled).
- Spaceliner and colony-ship hulls (`SL`, `OH`) share `ColonistCapacity`; sort or filter by hull abbreviation only for display, never for logic.
- Fleet-name conventions are gone, so a cycling fleet is whatever Aurora has flagged `CycleMoves = 1`, including warship patrol loops; the page should list only fleets with cargo or colonist capacity (done in SQL B).

---

## Summary of validation

| Feature | Queries | Result |
|---|---|---|
| 1 Finances | totals, series, treasury | 5 / 365 / 1 rows, all on real data |
| 2 Commanders | roster, lookups, colonies, admin pool, project, scientist pool, specialist ships, naval pool | 19,853 / 34 + 148 / 39 / 1,629 / 0 sample + 1 synthetic / 2,199 / 36 / 4,683 rows |
| 3 Fleet hygiene | W1 to W10 | W1 136, W7 1 on sample; W2, W3, W4, W6, W9, W10 empty on sample and fire on synthetic data; W5 covered by existing page; W8 empty by design |
| 4 Route finder | nodes, edges, capital, LP nodes | 169 / 358 / 1 / 74 rows; Dijkstra matches Aurora on 109 of 110 stored routes |
| 5 Lagrange points | one query | 376 rows (74 with LP, 302 without) |
| 6 Hauling | capacity, cycling fleets, orders | 9 / 46 / 561 rows; 33 of 46 fleets computable |

Not verified: semantic labels for `CommandType` 8, 9, 10, 11, 15 and the scale of `HealthRisk`; the cause of 5 high-mass bodies lacking a Lagrange point row; the units behind `Fleet.Speed` beyond "km/s" (consistent with route times and the workbook).
