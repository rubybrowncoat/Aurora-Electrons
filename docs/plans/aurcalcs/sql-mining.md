# Mining / colonisation planning pages: SQL design and validation

All SQL was run read-only against the sample save (`fixtures/AuroraDB.zip`, GameID 140, RaceID 784) with the IDs substituted, and again after the whitespace was reflowed for this document (identical results). In page code each query is a single-line template literal like the rest of the app. Branches the sample can't exercise were tested on a throwaway copy of the save with synthetic rows ("the scratch copy" below).

## Headline findings (read this first)

1. **The save already contains the game's own mineral ledger: `FCT_RaceMineralData`** (+ `DIM_MineralDataType`). Aurora v2.6 "Mineral Tracking" logs every mining, usage and transfer event per population, mineral and type (docs: wealth-and-mining, "Mineral Tracking"). That is observed production *and* consumption, and it makes feature 2 far more accurate than estimating from the queue. The workbook predates it. The sample holds about 40 days of data (8 five-day increments).
2. **The surface-mining formula is validated exactly against that ledger**: for 385 colony x mineral series the formula matches the logged mining to a median relative error of 1e-15 (max 0.2%). Empire Duranium: 692,564 t/yr logged vs 692,631 t/yr by formula. This also showed that **population `Efficiency` scales manned mines** (Belka: logged/base = 0.3705 vs `Efficiency` 0.3709; Coldbrook-A II Moon 11: logged 0, `Efficiency` 0), which the workbook ignores.
3. **The accessibility-decline model checks out.** Data: `Accessibility = 0.1 + (OriginalAcc - 0.1) * Amount / HalfOriginalAmount` once `Amount < HalfOriginalAmount`; 37 declining deposits (3 in the sample plus 34 in the workbook) fit within 0.005 (the 2-decimal rounding). The wiki (Mining page, "Minerals Quantity & Accessibility") says the same in words: accessibility falls once half is mined and reaches 0.1 just before exhaustion. The docs site has no formula.
4. **The workbook's `YearsFromHereToDepletion` double-counts** the above-half tonnage for deposits that have not yet reached half (it adds `(Amount - Half)/rate` and then again inside `YrsRemainingInCurrentHun`; reproduced exactly in Python). Its below-half maths is fine, so use the closed form in section 1.
5. **Sample quirk**: 36 populated bodies carry 11 "bottomless" deposits each (about 1e12 t at accessibility 0.01 to 0.06; 396 deposits >= 1e10 t), and all but one of our mining colonies sit on them. With the validated rates, 374 of the 380 mined deposits forecast >= 12.9 million years and the other 6 (Coldbrook-A II Moon 11, 3 manned mines, pop 0, `Efficiency` 0) produce nothing, so **the sample has no finite depletion case**. Cap the display ("> 10,000 y") and test the forecast with the workbook numbers below instead.
6. **Existing-code issue (not changed)**: `src/renderer/pages/minerals.vue:794` restricts deposits to `SystemBodyID in (select ... from FCT_SystemBodySurveys ... left join FCT_Race ...)`. The `left join` does not filter, so the subquery matches bodies surveyed by *any* race. In the sample that is 5,368 rows instead of 5,327 (41 deposits the player never surveyed). All queries below use `FCT_SystemBodySurveys.RaceID = ${this.RaceID}`.
7. `index.vue` has **no mining output** (grep for mining/MineProduction finds only terraformer code), so the surface/orbital rate code is new. The reusable parts are the naval-admin machinery (`navalAdministrations`, `adminsWithSystems`, `navalAdminBonus`, lines ~169 and 660) and `modifiedProductions`/capacity helpers. Note `navalAdminBonus` returns 1 as soon as an admin in the chain has no commander bonus, dropping ancestors' bonuses.

Mineral IDs everywhere: 1 Duranium, 2 Neutronium, 3 Corbomite, 4 Tritanium, 5 Boronide, 6 Mercassium, 7 Vendarite, 8 Sorium, 9 Uridium, 10 Corundium, 11 Gallicite (same as `MaterialMap` in minerals.vue).

---

## 1. Mining Outlook (depletion forecast)

**Purpose.** For every deposit the race is mining (surface mines, automated mines, forced-labour camps, CMCs, orbital mining ships), show the current accessibility, the mining rate in t/yr with all bonuses, years to the halfway point and to depletion, and a chart of accessibility and output over time.

**Reuse.** Deposit columns and fog-of-war pattern from `minerals.vue`/`habitability.vue` (but with the corrected survey scoping). Naval admin tree: extend `index.vue` `navalAdministrations` with a second bonus join (BonusID 6 = Mining) rather than copying it. Governor/sector commander lookups are the ones `index.vue` already uses (`CommandType` 3 and 4); sector share is 0.25 (docs/DATABASE.md).

### 1a. Surface mining, one row per colony x deposit (391 rows, 36 colonies, 380 distinct deposits)

```sql
select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_RaceSysSurvey.Name as SystemName,
  FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber,
  FCT_SystemBody.Radius * 2 as Diameter, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, FCT_MineralDeposit.MaterialID,
  FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount, FCT_MineralDeposit.OriginalAcc,
  VIR_Mines.MineCount, VIR_Mines.OwnedMineCount, VIR_Mines.ManualMineCount, FCT_Race.MineProduction, coalesce(VIR_Governor.BonusValue,
  1) as GovernorBonus, 1 + (coalesce(VIR_Sector.BonusValue, 1) - 1) * 0.25 as SectorBonus, FCT_Population.Efficiency,
  (1 - FCT_SystemBody.RadiationLevel / 10000) as RadiationModifier, (1 - FCT_Population.UnrestPoints / 100) as StabilityModifier,
  DIM_PopPoliticalStatus.ProductionMod as PoliticalModifier, FCT_Race.EconomicProdModifier
from FCT_Population
inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID
inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_Population.SystemBodyID and FCT_SystemBodySurveys.RaceID = FCT_Population.RaceID and FCT_SystemBodySurveys.GameID = FCT_Population.GameID
inner join FCT_MineralDeposit on FCT_MineralDeposit.SystemBodyID = FCT_Population.SystemBodyID and FCT_MineralDeposit.GameID = FCT_Population.GameID
inner join (select FCT_PopulationInstallations.PopID, sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue) as MineCount, sum(case when FCT_PopulationInstallations.PlanetaryInstallationID = 39 and VIR_Owner.PurchaseCivilianMinerals = 0 then 0 else FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue end) as OwnedMineCount, sum(case when FCT_PopulationInstallations.PlanetaryInstallationID in (7, 38, 48) then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.MiningProductionValue else 0 end) as ManualMineCount
from FCT_PopulationInstallations
inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID
inner join FCT_Population as VIR_Owner on VIR_Owner.PopulationID = FCT_PopulationInstallations.PopID
where FCT_PopulationInstallations.GameID = ${this.GameID} and DIM_PlanetaryInstallation.MiningProductionValue > 0 and FCT_PopulationInstallations.Amount > 0
group by FCT_PopulationInstallations.PopID) as VIR_Mines on VIR_Mines.PopID = FCT_Population.PopulationID
left join DIM_PopPoliticalStatus on DIM_PopPoliticalStatus.StatusID = FCT_Population.PoliticalStatus
left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID
left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID
left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID
left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue
from FCT_Commander
inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 6
where FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 3 and FCT_Commander.CommandID <> 0) as VIR_Governor on VIR_Governor.CommandID = FCT_Population.PopulationID
left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue
from FCT_Commander
inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 6
where FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 4 and FCT_Commander.CommandID <> 0) as VIR_Sector on VIR_Sector.CommandID = FCT_RaceSysSurvey.SectorID and FCT_RaceSysSurvey.SectorID <> 0
where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}
```

Sample rows (trimmed): `{PopName:'Brimstone', MaterialID:1, Amount:9.99996e11, Accessibility:0.03, OriginalAcc:0.03, MineCount:450, OwnedMineCount:450, ManualMineCount:0, MineProduction:600, GovernorBonus:1.4, SectorBonus:1.125, Efficiency:1}`; `{PopName:'Coldbrook-A II - Moon 11', MaterialID:1, Amount:12340512, Accessibility:0.8, HalfOriginalAmount:1430416, OriginalAcc:0.8, MineCount:3, ManualMineCount:3, Efficiency:0}`.

`MiningProductionValue` replaces the workbook's hard-coded "installation 39 counts x10": Mine 7, Automated Mine 12, Conventional Industry 38 (0.15), CMC 39 (10), Forced Labour Camp 48, Ex-CMC 52 (10). Only 7 and 12 exist in the sample; the others are syntax-checked only. `OwnedMineCount` drops a CMC whose colony has `PurchaseCivilianMinerals = 0` (workbook `IsOwned`): it still *depletes* the deposit (use `MineCount` for the forecast) but delivers nothing.

### 1b. Orbital mining, one row per ship x deposit (0 rows in the sample)

```sql
select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.ParentCommandID as NavalAdminCommandID, FCT_Ship.ShipID, FCT_Ship.ShipName,
  FCT_ShipClass.MiningModules, FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID,
  FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.PlanetNumber,
  FCT_SystemBody.OrbitNumber, FCT_SystemBody.Radius * 2 as Diameter, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component,
  FCT_MineralDeposit.MaterialID, FCT_MineralDeposit.Amount, FCT_MineralDeposit.Accessibility, FCT_MineralDeposit.HalfOriginalAmount,
  FCT_MineralDeposit.OriginalAcc, FCT_Race.MineProduction, FCT_Race.MaximumOrbitalMiningDiameter, coalesce(VIR_Commander.BonusValue,
  1) as CommanderBonus
from FCT_Ship
inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and FCT_ShipClass.MiningModules > 0
inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID
inner join FCT_Race on FCT_Race.RaceID = FCT_Ship.RaceID
inner join FCT_Population on FCT_Population.PopulationID = FCT_Fleet.AssignedPopulationID and FCT_Population.SystemBodyID = FCT_Fleet.OrbitBodyID
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Fleet.OrbitBodyID
inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_SystemBodySurveys.RaceID = FCT_Ship.RaceID and FCT_SystemBodySurveys.GameID = FCT_Ship.GameID
inner join FCT_MineralDeposit on FCT_MineralDeposit.SystemBodyID = FCT_Fleet.OrbitBodyID and FCT_MineralDeposit.GameID = FCT_Ship.GameID
left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Ship.RaceID
left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Ship.RaceID
left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID
left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue
from FCT_Commander
inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 6
where FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 1) as VIR_Commander on VIR_Commander.CommandID = FCT_Ship.ShipID
where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_Fleet.FleetName <> '__Shipyard'
```

No race-784 ship has `MiningModules > 0` (the only such class, 'Starr King' 62914, is race 787's and unbuilt). To test the joins I gave one race-784 class `MiningModules = 5` in a scratch copy plus two synthetic `BonusID 6` rows: 242 rows = 22 ships x 11 materials, e.g. `{ShipName:'IAN Fang', MiningModules:5, PopName:'Lyrenia', MaterialID:1, Accessibility:0.01, CommanderBonus:1.2, Diameter:13200, MaximumOrbitalMiningDiameter:4000}`; that body is too big for orbital mining (compare `Diameter` with the race maximum, as minerals.vue does). The fleet-to-colony join uses `AssignedPopulationID` *and* `OrbitBodyID = FCT_Population.SystemBodyID`: Lyrenia and "Lyrenia - Human" are two own colonies on one body and the assignment picks the stockpile (the workbook's `OrbitBodyID`-only join double counts). `'__Shipyard'` is inherited from the workbook; no such fleets exist here.

### 1c. Naval admin chain for the ship bonus (60 rows)

```sql
select FCT_NavalAdminCommand.NavalAdminCommandID, FCT_NavalAdminCommand.ParentAdminCommandID as ParentCommandID,
  FCT_NavalAdminCommand.AdminCommandName, FCT_NavalAdminCommand.PopulationID, FCT_Population.SystemID,
  FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.NavalHeadquartersValue as NavalAdminCommandLevel,
  FCT_CommanderBonuses.BonusValue as MiningBonusValue, DIM_NavalAdminCommandType.Radius, DIM_NavalAdminCommandType.Industrial
from FCT_NavalAdminCommand
inner join FCT_PopulationInstallations on FCT_PopulationInstallations.PopID = FCT_NavalAdminCommand.PopulationID
left join FCT_Population on FCT_NavalAdminCommand.PopulationID = FCT_Population.PopulationID
left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID
left join DIM_NavalAdminCommandType on FCT_NavalAdminCommand.AdminCommandTypeID = DIM_NavalAdminCommandType.CommandTypeID
left join FCT_Commander on FCT_NavalAdminCommand.NavalAdminCommandID = FCT_Commander.CommandID and FCT_Commander.CommandType = 12 and FCT_Commander.RaceID = FCT_NavalAdminCommand.RaceID
left join FCT_CommanderBonuses on FCT_CommanderBonuses.BonusID = 6 and FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID
where FCT_NavalAdminCommand.GameID = ${this.GameID} and FCT_NavalAdminCommand.RaceID = ${this.RaceID} and DIM_PlanetaryInstallation.NavalHeadquartersValue > 0
```

No admin command has a Mining bonus in the sample (`MiningBonusValue` null); the scratch copy with a synthetic 1.1 on command 1386 returned it. Sorium **harvesters** deplete a gas giant but produce fuel, not stockpile minerals, and none exist here, so they are out of scope.

### 1d. JS side

```js
// t/yr per row. Surface: validated against the ledger. owned=false also counts unpurchased CMCs (for depletion)
const surfaceRate = (r, owned = true) => {
  const mines = owned ? r.OwnedMineCount : r.MineCount
  const modifier = r.RadiationModifier * r.StabilityModifier * r.PoliticalModifier * r.EconomicProdModifier // all 1 in the sample
  return (r.ManualMineCount * r.Efficiency + (mines - r.ManualMineCount)) * r.MineProduction * r.Accessibility * r.GovernorBonus * r.SectorBonus * modifier
}
// Orbital: workbook formula, UNVERIFIED (no miners in the sample). adminBonus = product up the chain of 1 + (MiningBonusValue - 1) * Industrial
const orbitalRate = (r, adminBonus) => r.MiningModules * r.MineProduction * r.CommanderBonus * adminBonus * r.Accessibility
// group rows by `${SystemBodyID}-${MaterialID}`, sum the rates, then:
const FLOOR = 0.1 // accessibility never falls below this
const ENDLESS_YEARS = 10000

// deposit: { Amount, Accessibility, HalfOriginalAmount, OriginalAcc }; rate: t/yr at the CURRENT accessibility, all colonies + ships summed
function depositForecast (deposit, rate) {
  const { Amount: amount, Accessibility: accessibility, HalfOriginalAmount: half, OriginalAcc: original } = deposit

  if (!(rate > 0) || !(amount > 0)) {
    return { yearsToHalf: null, yearsToDepletion: null, endless: false }
  }

  const declines = original > FLOOR && half > 0
  const slope = declines ? (original - FLOOR) / half : 0                     // accessibility lost per tonne mined, below half
  const yearsToHalf = declines ? Math.max(0, amount - half) / rate : 0
  const startAccessibility = amount > half ? original : FLOOR + slope * amount // use the unrounded value, not the stored one
  const k = rate / accessibility                                              // t/yr per 1.0 of accessibility
  // below half: dA/dt = -k * (FLOOR + slope * A)  =>  accessibility decays exponentially to FLOOR, where the deposit is empty
  const yearsToDepletion = declines ? yearsToHalf + Math.log(startAccessibility / FLOOR) / (k * slope) : amount / rate

  return { yearsToHalf, yearsToDepletion, endless: yearsToDepletion > ENDLESS_YEARS, upgraded: amount > 2 * half + 1 || accessibility > original + 0.005 }
}

// chart series: [{ year, accessibility, amount, rate }]
function depositSeries (deposit, rate, points = 60, maxYears = 500) {
  const { Amount: amount, Accessibility: accessibility, HalfOriginalAmount: half, OriginalAcc: original } = deposit
  const { yearsToHalf, yearsToDepletion } = depositForecast(deposit, rate)
  const declines = original > FLOOR && half > 0
  const slope = declines ? (original - FLOOR) / half : 0
  const startAccessibility = amount > half ? original : FLOOR + slope * amount
  const k = rate / accessibility
  const horizon = Math.min(yearsToDepletion, maxYears)

  return Array.from({ length: points + 1 }, (_, i) => {
    const year = horizon * i / points
    const above = !declines || year <= yearsToHalf
    const a = above ? accessibility : Math.max(FLOOR, startAccessibility * Math.exp(-k * slope * (year - yearsToHalf)))

    return { year, accessibility: a, amount: above ? Math.max(0, amount - rate * year) : (a - FLOOR) / slope, rate: k * a }
  })
}
```

Check against the workbook (34 deposits already below half, closed form vs its stepped sum): mean error 0.23%, max 2.25%. Example, workbook row FAB-ACom1 Corundium (acc 0.33, 12.12 kt, half 47.4 kt, OriginalAcc 1, 8.1675 t/yr): `yearsToDepletion` 2,541.8 (workbook 2,543.4); series at 0/508/1017/1525/2033/2542 y gives accessibility 0.330/0.260/0.205/0.161/0.127/0.100 and output 8.17/6.43/5.07/3.99/3.14/2.48 t/yr. Above half, workbook row BUA-ACom13 (acc 0.6, 29.2 kt, half 14.7 kt, 14.85 t/yr): halfway 980.8 y (matches the workbook) but total 3,104.8 y vs the workbook's 4,086.5 (the double count). Use `a_start = 0.1 + slope*Amount` (the unrounded accessibility), not the rounded stored value (that variant was 2.3% mean error). Series for the chart: `depositSeries(deposit, rate, 60, 500)` returns `{year, accessibility, amount, rate}`; plot accessibility and rate on the same time axis, with a vertical marker at `yearsToHalf`.

**Caveats / open questions.**
- Closed form: below half, `dA/dt = -k(0.1 + s*A)`, so accessibility decays exponentially, `a(t) = a_start * exp(-k s t)`, and the deposit is exhausted when `a` reaches 0.1. Wiki says the decline applies to "planets and moons"; the sample data fits asteroids and a gas giant too (the 3 declining sample deposits are 2 asteroids and 1 gas giant; the workbook set is mostly asteroids).
- Ground-survey upgrades leave `OriginalAcc`/`HalfOriginalAmount` stale (12 sample deposits have `Accessibility != OriginalAcc` at `Amount >= Half`; 17 have `Amount > 2*Half`). `depositForecast` flags these (`upgraded`) and uses the stored values as-is (what the game's own decline rule sees). Treat their years as indicative.
- Efficiency applies to manned installations (validated for Mines); that it spares Automated Mines is inferred (no sample colony has automines and `Efficiency < 1`). Radiation, unrest, political and economic modifiers are documented to affect mines (planetary-installations doc) but are all 1.0 here, so unverified.
- Rates change as mines/ships are added, and several colonies can share a deposit; the forecast is "at today's rates".

---

## 2. Mineral Runway (empire mineral balance)

**Purpose.** Per mineral: stockpile, annual production, annual consumption, minerals in transit, net per year and years of stock left. Production and consumption come from the game's own ledger when it exists, with formula-based fallbacks for saves older than v2.6.

**Reuse.** Production by formula = feature 1 (surface + orbital, summed per `MaterialID`; harvesters excluded because they fill fuel tanks). Queue demand reuses the `productions` query and `modifiedProductions`/`populationConstructionCapacity`/`...Ordnance...`/`...Fighter...` in `index.vue`; those depend on `populationProductionModifiers`, so extract it (and the capacity helpers) into a mixin shared by both pages.

### 2a. Stockpile, in transit, observed ledger

```sql
-- stockpile: 1 row, e.g. Duranium 54,112,060, Neutronium 92,742,264, Gallicite 47,311,085 (t)
select sum(FCT_Population.Duranium) as Duranium, sum(FCT_Population.Neutronium) as Neutronium, sum(FCT_Population.Corbomite) as Corbomite,
  sum(FCT_Population.Tritanium) as Tritanium, sum(FCT_Population.Boronide) as Boronide, sum(FCT_Population.Mercassium) as Mercassium,
  sum(FCT_Population.Vendarite) as Vendarite, sum(FCT_Population.Sorium) as Sorium, sum(FCT_Population.Uridium) as Uridium,
  sum(FCT_Population.Corundium) as Corundium, sum(FCT_Population.Gallicite) as Gallicite
from FCT_Population
where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}
-- on ships (CargoTypeID 3 = minerals, CargoID = MaterialID): 11 rows, e.g. (1, 8,615 t), (2, 9,634 t)
select FCT_ShipCargo.CargoID as MaterialID, sum(FCT_ShipCargo.Amount) as Amount
from FCT_ShipCargo
inner join FCT_Ship on FCT_Ship.ShipID = FCT_ShipCargo.ShipID
where FCT_ShipCargo.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID} and FCT_ShipCargo.CargoTypeID = 3
group by FCT_ShipCargo.CargoID
-- in mass-driver packets: 1 row, 62 packets, ~16,130 t of each mineral
select count(*) as Packets, sum(FCT_MassDriverPackets.Duranium) as Duranium, sum(FCT_MassDriverPackets.Neutronium) as Neutronium,
  sum(FCT_MassDriverPackets.Corbomite) as Corbomite, sum(FCT_MassDriverPackets.Tritanium) as Tritanium,
  sum(FCT_MassDriverPackets.Boronide) as Boronide, sum(FCT_MassDriverPackets.Mercassium) as Mercassium,
  sum(FCT_MassDriverPackets.Vendarite) as Vendarite, sum(FCT_MassDriverPackets.Sorium) as Sorium,
  sum(FCT_MassDriverPackets.Uridium) as Uridium, sum(FCT_MassDriverPackets.Corundium) as Corundium,
  sum(FCT_MassDriverPackets.Gallicite) as Gallicite
from FCT_MassDriverPackets
where FCT_MassDriverPackets.GameID = ${this.GameID} and FCT_MassDriverPackets.RaceID = ${this.RaceID}
-- the game's own flows over the last ${this.periodDays} days (30/90/180/365 from a select, never free text): 65 rows at 90 d
select FCT_RaceMineralData.MineralID as MaterialID, FCT_RaceMineralData.MineralDataType, DIM_MineralDataType.Description as FlowName,
  DIM_MineralDataType.Income, sum(FCT_RaceMineralData.Amount) as Amount, min(FCT_RaceMineralData.Time) as FirstTime,
  max(FCT_RaceMineralData.Time) as LastTime, count(distinct FCT_RaceMineralData.Time) as Events
from FCT_RaceMineralData
left join DIM_MineralDataType on DIM_MineralDataType.MineralDataType = FCT_RaceMineralData.MineralDataType
where FCT_RaceMineralData.GameID = ${this.GameID} and FCT_RaceMineralData.RaceID = ${this.RaceID} and FCT_RaceMineralData.Time > (select FCT_Game.GameTime
from FCT_Game
where FCT_Game.GameID = ${this.GameID}) - ${this.periodDays} * 86400
group by FCT_RaceMineralData.MineralID, FCT_RaceMineralData.MineralDataType
```

`FCT_RaceMineralData` (13,475 rows, 54 colonies, 309 distinct times). `DIM_MineralDataType.Income` = 1 for inflow types. Sample (Sorium, 90 d window = all 40 d held): `{1 Mining 1 75,897 t}`, `{14 Fuel Refining 0 14,468 t}`, `{7 Unloaded from Freighter 1 90,728}`, `{8 Loaded into Freighter 0 92,565}`, `{12 Sent by Mass Driver 0 83,541}`, `{13 Received by Mass Driver 1 75,638}`. Types 7/8/12/13 (and 20 Starting Stockpile) are internal transfers ("double-entry book-keeping" per the docs): **exclude them from the empire net**. Inflow types: 1, 11, 10, 15, 17, 18, 19. Outflow: 2, 3, 4, 5, 6, 9, 14, 16, 40, 45.

Annualising: each event covers one increment, so the covered span is `(GameTime - firstMiningEventTime) + step` where `step = (LastTime - FirstTime)/(Events - 1)` of type 1. For the sample that is 35 + 5 = 40 days (using 36.5 days instead gives the 9.6% error I first hit). `perYear = Amount * 365 / coverageDays`.

```js
const TRANSFERS = new Set([7, 8, 12, 13, 20])
const flows = rows.filter((r) => !TRANSFERS.has(r.MineralDataType))
const production = (m) => sum(flows.filter((r) => r.MaterialID === m && r.Income)) * 365 / coverageDays
const consumption = (m) => sum(flows.filter((r) => r.MaterialID === m && !r.Income)) * 365 / coverageDays
const net = production - consumption
const yearsOfStock = net >= 0 ? Infinity : stock / -net   // optionally stock + inTransit
```

Sample result (annualised, t/yr): every mineral produced 692,564 (mining only). Consumption: Duranium 166,364 (all Maintenance Production), Sorium 132,017 (all Fuel Refining), Gallicite 179,704 (166,364 maintenance + 13,339 ordnance), Boronide 93,374 and Tritanium 66,696 (ordnance), Corundium 27,573 (mine construction), Neutronium, Mercassium and Vendarite 0. All nets are positive (> 500,000 t/yr), so `yearsOfStock` is infinite for all 11 (stocks are 47 to 93 Mt). The ledger also gives usage by purpose, which a queue estimate cannot: fuel refining and maintenance production are the whole of the Duranium and Sorium use here and are not in `FCT_IndustrialProjects` at all.

### 2b. Forward-looking demand from the industrial queue (4 active rows, 4 more paused)

```sql
select FCT_IndustrialProjects.ProjectID, FCT_IndustrialProjects.PopulationID, FCT_Population.PopName, FCT_IndustrialProjects.ProductionType,
  FCT_IndustrialProjects.Description, FCT_IndustrialProjects.Percentage, FCT_IndustrialProjects.Queue,
  FCT_IndustrialProjects.Pause as Paused, FCT_IndustrialProjects.Amount, FCT_IndustrialProjects.ProdPerUnit, FCT_IndustrialProjects.Duranium,
  FCT_IndustrialProjects.Neutronium, FCT_IndustrialProjects.Corbomite, FCT_IndustrialProjects.Tritanium, FCT_IndustrialProjects.Boronide,
  FCT_IndustrialProjects.Mercassium, FCT_IndustrialProjects.Vendarite, FCT_IndustrialProjects.Sorium, FCT_IndustrialProjects.Uridium,
  FCT_IndustrialProjects.Corundium, FCT_IndustrialProjects.Gallicite
from FCT_IndustrialProjects
left join FCT_Population on FCT_Population.PopulationID = FCT_IndustrialProjects.PopulationID
where FCT_IndustrialProjects.GameID = ${this.GameID} and FCT_IndustrialProjects.RaceID = ${this.RaceID} and FCT_IndustrialProjects.Pause = 0
-- shipyard tasks: 0 rows in the sample (FCT_ShipyardTask is empty); mineral columns are the task totals, scale by (1 - CompletedBP/TotalBP) -- UNVERIFIED
select FCT_ShipyardTask.TaskID, FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.ShipyardID, FCT_ShipyardTask.TaskTypeID,
  FCT_ShipyardTask.UnitName, FCT_ShipyardTask.TotalBP, FCT_ShipyardTask.CompletedBP, FCT_ShipyardTask.Duranium, FCT_ShipyardTask.Neutronium,
  FCT_ShipyardTask.Corbomite, FCT_ShipyardTask.Tritanium, FCT_ShipyardTask.Boronide, FCT_ShipyardTask.Mercassium, FCT_ShipyardTask.Vendarite,
  FCT_ShipyardTask.Sorium, FCT_ShipyardTask.Uridium, FCT_ShipyardTask.Corundium, FCT_ShipyardTask.Gallicite
from FCT_ShipyardTask
where FCT_ShipyardTask.GameID = ${this.GameID} and FCT_ShipyardTask.RaceID = ${this.RaceID} and FCT_ShipyardTask.Paused = 0
```

Sample row: `{PopName:'Fortuna', ProductionType:1, Description:'...Mjolnir', Percentage:100, Amount:8179.29, ProdPerUnit:211.85, Corbomite:1.75, Tritanium:75, Boronide:105, Uridium:15.1, Gallicite:15}`. The mineral columns are **per unit**. `industrialProjects.sql` re-derives production capacity from installations with governor/sector bonuses only (no efficiency, radiation, unrest...), so the page's existing capacity helpers replace it. `annualQueueDemand` follows "mineral use.sql" (cost x `min(1, 365/CompletionDays)`, queue entries only while capacity is left) but takes capacity from `capacityOf`:

```js
const MINERALS = ['Duranium', 'Neutronium', 'Corbomite', 'Tritanium', 'Boronide', 'Mercassium', 'Vendarite', 'Sorium', 'Uridium', 'Corundium', 'Gallicite']

const facility = (type) => (type === 1 ? 'ordnance' : type === 2 ? 'fighter' : 'construction')

// projects: QUEUE rows; capacityOf(PopulationID, ProductionType) -> BP/yr at 100% (the page already has this as populationConstruction/Ordnance/FighterCapacity)
function annualQueueDemand (projects, capacityOf) {
  const demand = Object.fromEntries(MINERALS.map((mineral) => [mineral, 0]))
  const groups = {}

  projects.forEach((project) => {
    const key = `${project.PopulationID}-${facility(project.ProductionType)}`

    ;(groups[key] = groups[key] || []).push(project)
  })

  Object.values(groups).forEach((group) => {
    let usedPercent = 0

    ;[...new Set(group.map((project) => project.Queue))].sort((a, b) => a - b).forEach((queue) => {
      if (usedPercent >= 100) {
        return // capacity is spoken for, later queue entries do not start within the year
      }

      group.filter((project) => project.Queue === queue).forEach((project) => {
        const yearlyBP = capacityOf(project.PopulationID, project.ProductionType) * project.Percentage / 100
        const remainingBP = project.Amount * project.ProdPerUnit

        if (!yearlyBP || !remainingBP) {
          return
        }

        const days = 365 * remainingBP / yearlyBP
        const oneYearFactor = days > 365 ? 365 / days : 1 // only one year's worth of the cost

        MINERALS.forEach((mineral) => {
          demand[mineral] += project.Amount * (project[mineral] || 0) * oneYearFactor
        })

        usedPercent += project.Percentage * Math.min(1, days / 365)
      })
    })
  })

  return demand
}
```

Validation: with Fortuna's ordnance capacity `250 factories * 600 * 1.15 (governor Production) * 1.125 (sector) * 0.9722 (Efficiency)` the estimate is Corbomite 1,558, Tritanium 66,792, Boronide 93,509, Uridium 13,448, Gallicite 13,358 t/yr against 1,556, 66,696, 93,374, 13,428, 13,339 logged (all within 0.15%). Queued (`Queue > 0`) entries have no sample data, so that branch is unverified.

**Caveats / open questions.**
- The ledger only exists from v2.6, and `FCT_RaceMineralData` most likely keeps a rolling window (the game UI offers 1, 3, 6 and 12 months; this save holds only ~40 days, possibly because it was recently upgraded to v2.6, which I could not confirm). Older saves: fall back to formula production (feature 1) minus `annualQueueDemand`, and say the figure excludes fuel refining/maintenance/shipyard use.
- Civilian mining that is not purchased in place is not tracked in the ledger (docs), consistent with `OwnedMineCount`.
- `FCT_Population.Last<Mineral>` snapshots (the workbook's "Change") are polluted by mass-driver and freighter flows (sample deltas are 0 for most colonies), so don't use them.
- Whether to add `FCT_Population.Reserve<Mineral>` to the display is a UX question; I did not use it.

---

## 3. Colonization Targets

**Purpose.** Rank surveyed, uncolonised bodies by how good a mining colony they would make, on top of what the Habitability page already computes.

**What Habitability already has** (`habitability.vue`): per surveyed body the deposit list (`bodies` query, fog-scoped via `FCT_SystemBodySurveys.RaceID`), current and planned colony cost, `MaximumPopulation`, terraform time, `MiningPotential` (an arctan blend of amount and accessibility, 0 to 10) and `TotalMiningAmount`, ground-survey potential and extant populations. **Missing:** the workbook's weighted mineral score, CMC qualification, distance from the capital, and a combined rank.

**Reuse.** Merge by `SystemBodyID` into `calculatedBodies`. The mineral score can be computed from `body.Minerals`, so only the CMC extras, coordinates and the jump graph strictly need SQL. The standalone query below returns everything so the page can also stand alone.

```sql
-- surveyed bodies of known systems: 10,009 rows / 10,005 bodies (4 bodies hold two own colonies, dedupe by SystemBodyID);
-- 1,322 have deposits, 372 CMC-qualified (Duranium or Gallicite), 76 already colonised, 0 banned (FCT_BannedBodies is empty here)
select FCT_SystemBody.SystemBodyID, FCT_SystemBody.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.BodyClass,
  FCT_SystemBody.BodyTypeID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName,
  FCT_Star.Component, FCT_SystemBody.Radius * 2 as Diameter, FCT_SystemBody.GroundMineralSurvey, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor,
  case when FCT_SystemBody.BodyClass = 2 then VIR_Parent.OrbitalDistance else FCT_SystemBody.OrbitalDistance end as StarDistance,
  VIR_Minerals.MineralScore, VIR_Minerals.DepositCount, VIR_Minerals.CMCQualified, VIR_Minerals.CMCScore,
  VIR_OwnSystem.OwnPopulation as SystemPopulation, FCT_Population.PopulationID, FCT_Population.Population,
  case when FCT_BannedBodies.SystemBodyID is null then 0 else 1 end as Banned
from FCT_SystemBody
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID}
inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID}
left join (select FCT_MineralDeposit.SystemBodyID, count(*) as DepositCount, sum(case when FCT_MineralDeposit.Amount >= 1000 then FCT_MineralDeposit.Accessibility * (case FCT_MineralDeposit.MaterialID when 1 then 1 when 2 then 1 when 3 then 0.25 when 4 then 0.01 when 5 then 1 when 6 then 1 when 7 then 1.25 when 8 then 0.01 when 9 then 0.01 when 10 then 1 when 11 then 1.25 else 0 end) else 0 end) as MineralScore, max(case when FCT_MineralDeposit.MaterialID in (1, 11) and FCT_MineralDeposit.Amount >= 10000 and FCT_MineralDeposit.Accessibility >= 0.7 then 1 else 0 end) as CMCQualified, sum(case when FCT_MineralDeposit.Accessibility >= 0.5 then FCT_MineralDeposit.Amount * (case when FCT_MineralDeposit.MaterialID = 1 then 2 else 1 end) else 0 end) as CMCScore
from FCT_MineralDeposit
where FCT_MineralDeposit.GameID = ${this.GameID}
group by FCT_MineralDeposit.SystemBodyID) as VIR_Minerals on VIR_Minerals.SystemBodyID = FCT_SystemBody.SystemBodyID
left join (select FCT_Population.SystemID, max(FCT_Population.Population) as OwnPopulation
from FCT_Population
where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID}
group by FCT_Population.SystemID) as VIR_OwnSystem on VIR_OwnSystem.SystemID = FCT_SystemBody.SystemID
left join FCT_Population on FCT_Population.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.GameID = ${this.GameID}
left join FCT_BannedBodies on FCT_BannedBodies.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_BannedBodies.RaceID = ${this.RaceID}
left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${this.RaceID}
left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID
left join FCT_SystemBody as VIR_Parent on VIR_Parent.SystemBodyID = FCT_SystemBody.ParentBodyID and FCT_SystemBody.BodyClass = 2
where FCT_SystemBody.GameID = ${this.GameID} and FCT_SystemBody.BodyClass in (1, 2, 3, 5) and FCT_SystemBody.BodyTypeID not in (0, 4, 5)

-- capital: 1 row (Aurelia, system 21644)
select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor
from FCT_Population
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID
where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.Capital = 1

-- jump points the race has charted: 455 rows (358 explored)
select FCT_JumpPoint.WarpPointID, FCT_JumpPoint.SystemID, FCT_JumpPoint.WPLink, FCT_JumpPoint.Xcor, FCT_JumpPoint.Ycor,
  FCT_RaceJumpPointSurvey.Explored, FCT_RaceJumpPointSurvey.IgnoreForDistance
from FCT_JumpPoint
inner join FCT_RaceJumpPointSurvey on FCT_RaceJumpPointSurvey.WarpPointID = FCT_JumpPoint.WarpPointID and FCT_RaceJumpPointSurvey.RaceID = ${this.RaceID} and FCT_RaceJumpPointSurvey.Charted = 1
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_JumpPoint.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID}
where FCT_JumpPoint.GameID = ${this.GameID}
```

Sample (top by `MineralScore`): Vespucci body 1995741 (asteroid, 180 km): `MineralScore 7.51, CMCQualified 1, CMCScore 73,027, StarDistance 3.45 AU, SystemPopulation 150.9`. Checked by hand: its nine deposits give 1+1+0.01+1+1+1.25+1+1.25 = 7.51 (Uridium, 169 t, is under the 1,000 t floor).

**Definitions.**
- Mineral score = sum over deposits with `Amount >= 1000` t of `Accessibility * weight`; weights Dur 1, Neu 1, Crb 0.25, Tri 0.01, Bor 1, Mer 1, Ven 1.25, Sor 0.01, Uri 0.01, Crn 1, Gal 1.25 (workbook `SurfMin!J1:T1`, minimum 1 kt per `CCOver!P2`; the workbook's first column uses `>=`, the rest `>`, which is clearly an oversight). Keep the weights and the 1 kt floor in `this.config`.
- CMC qualification per the docs (civilians "C# Civilian Mining Check"): >= 10,000 t Duranium at accessibility >= 0.7, in a system that has a population of >= 10 M (`SystemPopulation`), body < 80 AU from its star (`StarDistance`, parent planet's orbit for moons), not banned, not already colonised; the game then picks the location with the highest `CMCScore` (sum of amounts at accessibility >= 0.5, Duranium counted twice). **Decision**: the docs say Duranium only, while the workbook (`SystemBodyDetails.sql`) also accepts Gallicite; we follow the workbook, so the query uses `MaterialID in (1, 11)`. Keep it a one-line constant. The check is only live when `FCT_Game.AllowCMC = 1` (it is 0 in the sample), and for non-primary stars the docs add a Lagrange-point condition that I did not model.

**Distance from the capital.** Jumps cost no distance, only in-system legs do, so: Dijkstra over jump points, node = jump point, edge = straight line to every other jump point in the same system plus a zero-length edge to its `WPLink` partner when `Explored = 1` and neither end has `IgnoreForDistance`; start from the capital body's `Xcor/Ycor` (km). Distance to a body = min over its system's jump points of `km + straight line`. Cross-system distance therefore needs a path search (the workbook's `SysInfo!Path`); straight-line distance is only valid inside the capital's system.

```js
// jumpPoints: rows of JUMP_POINTS, capital: row of CAPITAL
function buildDistanceMap (jumpPoints, capital) {
  const bySystem = {}
  const byId = {}

  jumpPoints.forEach((jp) => {
    byId[jp.WarpPointID] = jp
    ;(bySystem[jp.SystemID] = bySystem[jp.SystemID] || []).push(jp)
  })

  const hypot = (a, b) => Math.hypot(a.Xcor - b.Xcor, a.Ycor - b.Ycor)
  const best = {} // WarpPointID -> { km, jumps }
  const queue = (bySystem[capital.SystemID] || []).map((jp) => ({ jp, km: hypot(capital, jp), jumps: 0 }))

  // plain Dijkstra, a few hundred nodes at most
  while (queue.length) {
    queue.sort((a, b) => a.km - b.km)

    const { jp, km, jumps } = queue.shift()

    if (best[jp.WarpPointID]) {
      continue
    }

    best[jp.WarpPointID] = { km, jumps }

    // walk through the jump point to its partner, which costs no distance
    const partner = byId[jp.WPLink]

    if (jp.Explored && !jp.IgnoreForDistance && partner && !partner.IgnoreForDistance && !best[partner.WarpPointID]) {
      queue.push({ jp: partner, km, jumps: jumps + 1 })
    }

    // then cross the system to its other jump points
    (bySystem[jp.SystemID] || []).forEach((other) => {
      if (other !== jp && !best[other.WarpPointID] && !other.IgnoreForDistance) {
        queue.push({ jp: other, km: km + hypot(jp, other), jumps })
      }
    })
  }

  return function distanceTo (body) { // body: { SystemID, Xcor, Ycor }
    let result = body.SystemID === capital.SystemID ? { km: hypot(capital, body), jumps: 0 } : null

    ;(bySystem[body.SystemID] || []).forEach((jp) => {
      const entry = best[jp.WarpPointID]

      if (entry) {
        const km = entry.km + hypot(jp, body)

        if (!result || km < result.km) {
          result = { km, jumps: entry.jumps }
        }
      }
    })

    return result // null when no charted route exists
  }
}
```

Run on the sample: all 145 systems with surveyed bodies are reachable, 19 ms for the 10,009 rows. Examples (km / 149,597,870.7 = AU): Procyon 1 jump 23.3 AU, Vespucci body 1995741 6 jumps 127.9 AU, Deneb body 1991877 3 jumps 85.4 AU, Cepheus 13 jumps 231.3 AU (distances are along the shortest-distance route, so the jump count is the count on that route, not a minimum).

**Combined rank (a proposal, not in the workbook).** Filter first: `!Banned`, no own `PopulationID`, a finite colony cost (`PlannedColonyCostMetric` from habitability, or `CurrentColonyCostOverall`). Then
`rank = (MineralScore + (CMCQualified ? cmcBonus : 0)) * popFactor * distFactor`, with `popFactor = 1 / (1 + max(0, colonyCost - 2) / 4)` (cheap colonies keep full value), `distFactor = 1 / (1 + distanceAU / 60)`, defaults `cmcBonus = 2`. Expose the three knobs next to the table and persist them as `game.<GameID>.race.<RaceID>.targetWeights`. Always show the raw columns beside the rank.

**Caveats.** Unsurveyed bodies have no deposit data and are excluded (the workbook's "-0.000001" marker); `GroundMineralSurvey` (1 to 5) says a ground survey could still add minerals. Bodies in known systems are visible to the player even before survey, but their minerals are not. Distance ignores ship speed and unexplored routes (only charted jump points are used; the `Hide` and `MilitaryRestricted` flags on `FCT_RaceJumpPointSurvey` are not filtered).

---

## 4. Survey Progress

**Purpose.** Per known system: gravitational survey locations done vs remaining, geological survey bodies done vs remaining, points still needed, the ships and ground teams working on it, and a points-based ETA.

**Reuse.** `map.vue` already reads `FCT_RaceSurveyLocation`/`FCT_SystemBodySurveys`; `habitability.vue` has `BodySurveyed`. The fleet/ship rows resemble `information.vue`'s ship queries. The naval-admin survey share (`DIM_NavalAdminCommandType.Survey`) works like the mining share in feature 1c (BonusID 2 = Survey).

### 4a. Gravitational survey (169 rows)

```sql
select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_RaceSysSurvey.SurveyDone,
  FCT_System.JumpPointSurveyPoints as PointsPerLocation, 30 - coalesce(VIR_Done.Surveyed, 0) as RemainingLocations
from FCT_RaceSysSurvey
inner join FCT_System on FCT_System.SystemID = FCT_RaceSysSurvey.SystemID
left join (select FCT_RaceSurveyLocation.SystemID, count(*) as Surveyed
from FCT_RaceSurveyLocation
where FCT_RaceSurveyLocation.GameID = ${this.GameID} and FCT_RaceSurveyLocation.RaceID = ${this.RaceID}
group by FCT_RaceSurveyLocation.SystemID) as VIR_Done on VIR_Done.SystemID = FCT_RaceSysSurvey.SystemID
where FCT_RaceSysSurvey.GameID = ${this.GameID} and FCT_RaceSysSurvey.RaceID = ${this.RaceID}
```

`30` locations per system is the documented value (wiki Survey page; all 170 systems in the sample have exactly 30 `FCT_SurveyLocation` rows). Result: 57 locations remain in two systems, Polaris (27 x 406 points) and Al Kalb al Rai (30 x 462), 24,822 points; the other 167 have `SurveyDone = 1`, which matches `RemainingLocations = 0` exactly.

### 4b. Geological survey (10,304 bodies in known systems; 10,188 surveyed, 116 not)

```sql
select FCT_SystemBody.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass, FCT_SystemBody.BodyTypeID,
  FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component,
  FCT_SystemBody.Radius, FCT_SystemBody.Radius / 100.0 * (case when FCT_SystemBody.BodyTypeID in (4, 5) then 1 else 10 end) as SurveyPoints,
  case when FCT_SystemBodySurveys.SystemBodyID is null then 0 else 1 end as Surveyed,
  case when FCT_BannedBodies.SystemBodyID is null then 0 else 1 end as Banned
from FCT_SystemBody
inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = ${this.RaceID} and FCT_RaceSysSurvey.GameID = ${this.GameID}
left join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = ${this.RaceID}
left join FCT_BannedBodies on FCT_BannedBodies.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_BannedBodies.RaceID = ${this.RaceID}
left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = ${this.RaceID}
left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID
where FCT_SystemBody.GameID = ${this.GameID} and FCT_SystemBody.BodyClass in (1, 2, 3, 5)
```

Points: `Radius / 100 * (gas giant ? 1 : 10)`. Verified in the sample for an asteroid: the only live geological-survey order (fleet 460381, 'Asteroid #16') needs 7.4 points and its body has `Radius` 74. Terrestrial planets and moons at x10 is supported by the docs' statement that the ground survey needs "the same points as the orbital survey" and the workbook's ground survey (`Radius / 10`). Gas giants (`BodyTypeID` 4 and 5) at x1 comes from the workbook only. (The task brief guessed x1 for planets and x10 for asteroids/comets; the workbook and the ground-survey equivalence say x10 for everything except gas giants.) Unsurveyed, non-banned remainder: Polaris 30 bodies 1,503 pts, Al Kalb al Rai 49 bodies 983 pts, Cepheus 37 bodies 339 pts (2,824 total); `FCT_RaceSysSurvey.GeoSurveyDefaultDone = 0` for exactly these three systems.

### 4c. Ships, orders, standing orders

```sql
-- 7 ships with GeoSurvey/GravSurvey > 0 (e.g. AIN Intrepid 250/250 with a 1.19 Survey commander)
select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_Fleet.OrbitBodyID, FCT_Fleet.ParentCommandID as NavalAdminCommandID,
  FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_ShipClass.GeoSurvey, FCT_ShipClass.GravSurvey, FCT_ShipClass.Size,
  coalesce(VIR_Commander.BonusValue, 1) as CommanderBonus
from FCT_Ship
inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and (FCT_ShipClass.GeoSurvey > 0 or FCT_ShipClass.GravSurvey > 0)
inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID
left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue
from FCT_Commander
inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 2
where FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 1) as VIR_Commander on VIR_Commander.CommandID = FCT_Ship.ShipID
where FCT_Ship.GameID = ${this.GameID} and FCT_Ship.RaceID = ${this.RaceID}
-- 1 row: the live geo order above (also where grav-location orders would show, DestinationType 4 in the workbook; none in the sample)
select FCT_MoveOrders.FleetID, FCT_MoveOrders.MoveOrder, FCT_MoveOrders.MoveActionID, FCT_MoveOrders.DestinationType,
  FCT_MoveOrders.DestinationID, FCT_MoveOrders.StartSystemID as SystemID, FCT_MoveOrders.Description, FCT_MoveOrders.SurveyPointsRequired
from FCT_MoveOrders
where FCT_MoveOrders.GameID = ${this.GameID} and FCT_MoveOrders.RaceID = ${this.RaceID} and FCT_MoveOrders.SurveyPointsRequired > 0
-- 15 rows: SV:/MV: standing survey orders per fleet (survey-capable ships on auto-survey)
select FCT_FleetStandingOrder.FleetID, FCT_FleetStandingOrder.Priority, DIM_StandingOrders.OrderID, DIM_StandingOrders.Description
from FCT_FleetStandingOrder
inner join DIM_StandingOrders on DIM_StandingOrders.OrderID = FCT_FleetStandingOrder.StandingOrderID
inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_FleetStandingOrder.FleetID
where FCT_FleetStandingOrder.GameID = ${this.GameID} and FCT_Fleet.RaceID = ${this.RaceID} and (DIM_StandingOrders.Description like 'SV:%' or DIM_StandingOrders.Description like '%survey%')
```

### 4d. Ground survey (1 row in the sample)

```sql
select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_SystemBody.SystemBodyID, FCT_SystemBody.BodyClass,
  FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component,
  FCT_SystemBody.GroundMineralSurvey as Potential, FCT_SystemBody.Radius / 10.0 as PointsRequired,
  FCT_Population.GroundGeoSurvey as PointsDone, coalesce(VIR_Teams.Units, 0) as Units, coalesce(VIR_Teams.PointsPerDay, 0) as PointsPerDay,
  FCT_Game.SurveySpeed
from FCT_Population
inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID
inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_Population.SystemBodyID and FCT_SystemBodySurveys.RaceID = FCT_Population.RaceID
inner join FCT_Game on FCT_Game.GameID = FCT_Population.GameID
left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID
left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID
left join (select FCT_GroundUnitFormation.PopulationID, sum(FCT_GroundUnitFormationElement.Units) as Units, sum(FCT_GroundUnitFormationElement.Units * VIR_Class.GeoSurvey * coalesce(VIR_Commander.BonusValue, 1)) as PointsPerDay
from FCT_GroundUnitFormation
inner join FCT_GroundUnitFormationElement on FCT_GroundUnitFormationElement.FormationID = FCT_GroundUnitFormation.FormationID
inner join (select FCT_GroundUnitClass.GroundUnitClassID, coalesce(ComponentA.Geosurvey, 0) + coalesce(ComponentB.Geosurvey, 0) + coalesce(ComponentC.Geosurvey, 0) + coalesce(ComponentD.Geosurvey, 0) as GeoSurvey
from FCT_GroundUnitClass
left join DIM_GroundComponentType as ComponentA on ComponentA.ComponentTypeID = FCT_GroundUnitClass.ComponentA
left join DIM_GroundComponentType as ComponentB on ComponentB.ComponentTypeID = FCT_GroundUnitClass.ComponentB
left join DIM_GroundComponentType as ComponentC on ComponentC.ComponentTypeID = FCT_GroundUnitClass.ComponentC
left join DIM_GroundComponentType as ComponentD on ComponentD.ComponentTypeID = FCT_GroundUnitClass.ComponentD
where FCT_GroundUnitClass.GameID = ${this.GameID}) as VIR_Class on VIR_Class.GroundUnitClassID = FCT_GroundUnitFormationElement.ClassID and VIR_Class.GeoSurvey > 0
left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue
from FCT_Commander
inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 2
where FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 5) as VIR_Commander on VIR_Commander.CommandID = FCT_GroundUnitFormation.FormationID
where FCT_GroundUnitFormation.GameID = ${this.GameID} and FCT_GroundUnitFormation.RaceID = ${this.RaceID}
group by FCT_GroundUnitFormation.PopulationID) as VIR_Teams on VIR_Teams.PopulationID = FCT_Population.PopulationID
where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and (FCT_SystemBody.GroundMineralSurvey > 0 or coalesce(VIR_Teams.PointsPerDay, 0) > 0)
```

Sample: Tiaki III, potential 4 (High), 780 points required, 0 done, no teams, so no rate. I moved two Research Battalions (45 'Intrepid' units each, `Geosurvey` 0.1/day per unit from `DIM_GroundComponentType.Geosurvey`, commanders 1.4 and 1.3) to it in the scratch copy: `PointsPerDay` 12.15 = 45*0.1*1.4 + 45*0.1*1.3, as expected. `PointsRequired = Radius / 10` matches `groundsurvey.sql`; progress is `FCT_Population.GroundGeoSurvey`.

### 4e. JS

```js
const hoursPerDay = 24
const speed = game.SurveySpeed / 100                     // 15 in the sample: surveys run at 15% of the base rate
const shipRate = (ships, key) => ships.reduce((sum, s) => sum + s[key] * s.CommanderBonus, 0) * hoursPerDay * speed   // points/day
const gravRemaining = (sys) => sys.RemainingLocations * sys.PointsPerLocation                      // minus partial points on in-flight orders
const geoRemaining = (bodies) => bodies.filter((b) => !b.Surveyed && !b.Banned).reduce((sum, b) => sum + b.SurveyPoints, 0)
const etaDays = (points, perDay) => (perDay > 0 ? points / perDay : Infinity)                      // lower bound: travel time not included
// ground: etaDays(PointsRequired - PointsDone, PointsPerDay * speed)
```

Sample: the 7 ships make 5,301 geo and 4,311 grav points/day, so the point-only ETAs are 0.53 and 5.8 days; real ETA is dominated by travel, which the save cannot give you.

**Feasible from the save:** locations and bodies done/remaining per system; points remaining; survey-capable ships and which are on auto-survey; ground teams, points done/required; per-body ground potential. **Not feasible:** partial progress of a location or body being surveyed right now (no table stores it; only the order's `SurveyPointsRequired`), travel/ETA between targets, and which target a ship will pick next.

**Caveats / open questions.**
- Unit of `FCT_ShipClass.GeoSurvey/GravSurvey`: assumed points per hour (wiki: basic sensor = 1 point/hour; the class totals here, 100 to 250, look like sum of sensor strengths). Unverified, since no partial-progress data exists in the sample.
- `SurveySpeed` is applied to ships (docs). The workbook also applies it to ground teams, while the (v1.0) docs say the modifier is "applied to the survey points produced by survey ships. Everything else remains the same". Settle by comparing `GroundGeoSurvey` in two saves.
- "Survey Point Type Ratio.sql" has no `RaceID` filter (all systems, `GameID > 115`); not used.
- Admin Survey share and the commander bonus on large ships (> 1000 t only get half the Survey bonus per the ship-components doc) are not modelled in `shipRate`.
