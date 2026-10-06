# Economy pages: SQL and maths for four planned pages

Scope: Colony Outlook, Maintenance Budget, Fuel Balance, Shipyard Planner. Sections 1–3 are built (Colonies and Logistics tabs); [`build-2.md`](build-2.md) records where the pages depart from this design. Most importantly, maintenance upkeep is charged by location, not by assignment, and the refinery and MSP formulas, species modifier included, are confirmed by the mineral ledger. Section 4 (Shipyard Planner) is design only.

## 0. Read this first

**How it was validated.** Python `sqlite3`, read-only (`mode=ro`) on the sample save (`fixtures/AuroraDB.zip`), with `${this.GameID}` = 140 and `${this.RaceID}` = 784. Every query below executed cleanly against the sample and the row counts are quoted. Tables that are empty in the sample (`FCT_ShipyardTask`, shipyard upgrade tasks) and the player's own harvesters (none exist) were exercised on a scratch **copy** of the save with synthetic rows (not the real save); harvesters were also run against NPR race 786, which owns the only harvester ships in the sample. Where I could not exercise a branch I say so.

**Query style.** Each query goes in an `asyncComputed` getter exactly like the existing pages, guarded on `this.database`, `this.GameID`, `this.RaceID`:

```js
colonies: { async get () { if (!this.database || !this.GameID || !this.RaceID) { return [] } return await this.database.query(`...`).then(([items]) => items) }, default: [] },
```

SQLite is 3.41.1 (sqlite3 5.1.5), so CTEs and window functions are available; the queries below only use plain subqueries, so no view and no write is needed. The queries reference no `vw_*` view: `vw_const` became `FCT_Race`/`RaceID`, `vw_popname` is replaced by the usual `populationName()` column set (`SystemName, Component, SystemBodyID, PlanetNumber, OrbitNumber, BodyClass, SystemBodyName, PopName`), `vw_GovernorSectorBonus` became inline subqueries following index.vue's pattern.

**Units seen in the save** (checked on sample rows): `FCT_Population.Population` is millions of people; `FCT_ShipCargo.Amount` for colonists is persons (2,750 = 0.00275 M); `FuelStockpile`, `FCT_Ship.Fuel`, `FuelCapacity` are litres; `MaintenanceStockpile`, `CurrentMaintSupplies` are MSP; `p.Sorium` is tons; `FCT_Race.FuelProduction` is litres per refinery per year (2,500,000); `FCT_Race.MSPProduction` is BP per facility per year (800); `FCT_Race.MaintenanceCapacity` is tons per facility (100,000); `FCT_ShipClass.Size` is HS (x50 = tons); `FCT_Ship.DistanceTravelled` is km; year = 31,536,000 s (`utilities/aurora.js` convention).

**Shared helpers I recommend extracting** (all four pages need them; do not re-derive):
1. `populationProductionModifiers` plus `populationConstructionCapacity` / `populationShipyardCapacity` / `populationShipyardUpgradeCapacity` / `shipyardContinualRemainingDays` from `src/renderer/pages/index.vue:535-581`, `629-658`, `675-694` into a mixin. I ran that query verbatim against the sample (75 rows, one per population) and used its `OverallProductionModifier`, `ShipyardBuildRate`, `ShipyardOperations`, `ConstructionPower`.
2. `navalAdminBonus()` (`index.vue:660-672`) hard-codes commander bonus 9 (terraforming) in the `navalAdministrations` query (`index.vue:808`). Harvesting needs bonus 6 (mining); both use the same `DIM_NavalAdminCommandType.Industrial` share (docs `naval-organization`). Query 3D below returns both bonuses. The same query also omits `ParentAdminCommandID`, so `adminsWithSystems` entries have no `ParentCommandID` and the chain recursion at `index.vue:671` never climbs past the first command (the sample has admin trees, e.g. command 1350 under 1345); 3D returns the parent column.
3. `bodyMaxPopulation(body, species)` from `habitability.vue:626-628, 2051-2062` (constants `earthSurfaceArea = 511187128`, `baseMaxPop = 12000`).

**Page wiring** (CLAUDE.md): each new page needs a `<v-tab>` and a `title()` case in `src/renderer/layouts/default.vue:58-66`. Suggested tabs: Colonies (section 1), Logistics (sections 2 and 3, as the game's own summary pairs M-* and F-* columns), Shipyards (section 4).

**Two findings that change the design** (both verified on the sample):
- `FCT_Population.LastColonyCost` is stale and must not be used to size infrastructure. I ported the colony-cost algorithm of `habitability.vue:1277-1410` to Python and ran it for all 39 populated colonies: it gives CC 0 for 38 of them, while `LastColonyCost > 0` for 34 (33 of those compute to 0, consistent with terraforming: Auriga, stored 2.0, now has 0.23 atm oxygen for an oxygen breather). Only Phobos has a current CC (0.2). `FCT_Population.ReqInf` is the live value: it is non-zero for exactly the one colony with a current CC, and equals `Population x CC x 100 / PopulationDensityModifier` (877 = 37.2766 x 0.2 x 100 / 0.85). So **infrastructure required per million = ReqInf / Population** (0 means none needed). This matches wiki "Population and Production" (max pop = infrastructure x 10,000 / CC).
- MSP production has a hidden x4: the racial "Maintenance Production Rate N MSP" value is BP per facility per year, and 1 MSP = 0.25 BP, so MSP/yr = N x 4 (wiki "Maintenance Facility"; v2.2.0 patch notes: "technology naming for MSP production ... reflect it is BP"). That is the workbook's `*4`.

**Verified versus inferred**

| Item | Status |
|---|---|
| Worker model (service/agri/manufacturing split, required workers incl. shipyards) | Verified: reproduces stored `FCT_Population.Efficiency` for all 39 colonies, max error 0.0006 |
| Body population capacity formula | Docs `colonies` (Population Capacity) + `habitability.vue`; sanity check: no sample colony exceeds the computed cap (max fill 0.915) |
| Growth curve fall-off above 1/3 capacity | Docs `colonies` |
| Base growth rate `min(0.1, 0.2 / pop^(1/3)) x modifier` | **Inferred** from the workbook only (not in docs/wiki; wiki says ~2% for large pops, which it matches at modifier 1). Radiation term `-RadiationLevel/40000` also workbook-only; all sample radiation is 0 |
| Refinery output = racial rate x governor/sector production bonus; 1 ton sorium = 2,000 L | Wiki "Fuel Refinery" (verified against `FCT_Race.FuelProduction` = tech value) |
| Harvester output per module = racial refinery rate | **Inferred** (workbook). Wiki text says 20,000 L/module base; component "Sorium Harvester" has ComponentValue 10 ("Base Mining Rate") that nothing explains. Open |
| MSP upkeep = class cost / 4 per year; overhaul = class cost per year | Docs `maintenance` |
| Shipyard capacity-add cost 0.24 BP/ton/slipway x ShipyardOperations (naval), x0.1 commercial | Wiki "Shipyard" example (2000 t = 480 BP naval, 48 BP commercial) + `index.vue:643` (120 x slipways per 500 t). Slipway scaling not in docs; two independent implementations agree |
| Add-slipway cost | **Not documented anywhere I could reach.** Calibrate from `FCT_Shipyard.RequiredBP` when a `TaskType = 1` task exists (see section 4) |


---

## 1. Colony Outlook

**Purpose.** Per populated colony: growth per year, projected population over N years, how full the body is, infrastructure headroom (only where colony cost is above zero) and months until infrastructure caps growth, and the worker economy (service/agriculture/manufacturing split, free or missing workers now and in N years), plus colonists and installations already en route. Answers: where will growth stall, where do I lack or waste workers, and how much construction does the growth need.

**Already in the app (do not repeat).** `warnings.vue:1202` lists colonies with `Efficiency < 1` and `warnings.vue:1218` self-sustaining colonist destinations, `warnings.vue:1122` free construction capacity, `index.vue:535` per-population construction BP/yr. Nothing shows growth, capacity, worker numbers or infrastructure.

### SQL 1A: one row per populated colony
```sql
select
  p.PopulationID, p.PopName, p.Population, p.Efficiency, p.ReqInf, p.LastColonyCost, p.UnrestPoints,
  sp.SpeciesID, sp.PopulationGrowthModifier, sp.PopulationDensityModifier, sp.Gravity - sp.GravDev as MinimumGravity,
  rss.Name as SystemName, st.Component, b.SystemBodyID, b.PlanetNumber, b.OrbitNumber, b.BodyClass, bn.Name as SystemBodyName,
  b.Radius, b.Gravity, b.HydroExt, b.TidalLock, b.RadiationLevel,
  coalesce(inst.Infrastructure, 0) as Infrastructure, coalesce(inst.LGInfrastructure, 0) as LGInfrastructure,
  coalesce(inst.InstallationWorkers, 0) as InstallationWorkers, coalesce(yard.YardWorkers, 0) as YardWorkers,
  coalesce(inst.ConstructionFactories, 0) as ConstructionFactories,
  coalesce(gov.Bonus, 1) * coalesce(sec.Bonus, 1) as PopulationGrowthBonus,
  bp.BodyPopulation
from FCT_Population p
inner join FCT_Species sp on sp.SpeciesID = p.SpeciesID
inner join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID
left join FCT_SystemBodyName bn on bn.SystemBodyID = b.SystemBodyID and bn.RaceID = p.RaceID
left join FCT_RaceSysSurvey rss on rss.SystemID = p.SystemID and rss.RaceID = p.RaceID
left join FCT_Star st on st.StarID = b.StarID
left join (
  select pi.PopID, sum(d.InfrastructureValue * pi.Amount) as Infrastructure, sum(d.LGInfrastructureValue * pi.Amount) as LGInfrastructure, sum(d.Workers * pi.Amount) as InstallationWorkers, sum(case when pi.PlanetaryInstallationID in (5, 47) then pi.Amount else 0 end) as ConstructionFactories
  from FCT_PopulationInstallations pi
  inner join DIM_PlanetaryInstallation d on d.PlanetaryInstallationID = pi.PlanetaryInstallationID
  where pi.GameID = ${this.GameID}
  group by pi.PopID
) inst on inst.PopID = p.PopulationID
left join (
  select y.PopulationID, sum(y.Capacity * y.Slipways * case y.SYType when 1 then 1.0 else 0.1 end) / 4000.0 as YardWorkers
  from FCT_Shipyard y
  where y.GameID = ${this.GameID} and y.RaceID = ${this.RaceID}
  group by y.PopulationID
) yard on yard.PopulationID = p.PopulationID
left join (
  select c.CommandID, cb.BonusValue as Bonus
  from FCT_Commander c
  inner join FCT_CommanderBonuses cb on cb.CommanderID = c.CommanderID and cb.BonusID = 8
  where c.GameID = ${this.GameID} and c.RaceID = ${this.RaceID} and c.CommanderType in (2, 4) and c.CommandType = 3 and c.CommandID <> 0
) gov on gov.CommandID = p.PopulationID
left join (
  select rs.SystemID, 1 + (cb.BonusValue - 1) * 0.25 as Bonus
  from FCT_RaceSysSurvey rs
  inner join FCT_Commander c on c.CommandID = rs.SectorID and c.CommanderType in (2, 4) and c.CommandType = 4 and c.RaceID = rs.RaceID
  inner join FCT_CommanderBonuses cb on cb.CommanderID = c.CommanderID and cb.BonusID = 8
  where rs.GameID = ${this.GameID} and rs.RaceID = ${this.RaceID} and rs.SectorID <> 0
) sec on sec.SystemID = p.SystemID
left join (
  select SystemBodyID, sum(Population) as BodyPopulation
  from FCT_Population
  where GameID = ${this.GameID} and RaceID = ${this.RaceID}
  group by SystemBodyID
) bp on bp.SystemBodyID = p.SystemBodyID
where p.GameID = ${this.GameID} and p.RaceID = ${this.RaceID} and p.Population > 0
order by p.Population desc
```

### SQL 1B: colonists and installations en route (move orders 6 Unload Colonists, 96/177 Unload Installation)
```sql
select
  mo.PopulationID,
  sum(case when mo.MoveActionID = 6 and sc.CargoTypeID = 1 then sc.Amount else 0 end) as InboundColonists,
  sum(case when mo.MoveActionID in (96, 177) and sc.CargoTypeID = 2 and d.InfrastructureValue + d.LGInfrastructureValue > 0 then sc.Amount * (d.InfrastructureValue + d.LGInfrastructureValue) else 0 end) as InboundInfrastructure,
  sum(case when mo.MoveActionID in (96, 177) and sc.CargoTypeID = 2 and sc.CargoID in (5, 47) then sc.Amount else 0 end) as InboundConstructionFactories,
  sum(case when mo.MoveActionID in (96, 177) and sc.CargoTypeID = 2 then sc.Amount else 0 end) as InboundInstallations,
  count(distinct f.FleetID) as Fleets
from FCT_MoveOrders mo
inner join FCT_Fleet f on f.FleetID = mo.FleetID
inner join FCT_Ship s on s.FleetID = f.FleetID
inner join FCT_ShipCargo sc on sc.ShipID = s.ShipID
left join DIM_PlanetaryInstallation d on d.PlanetaryInstallationID = sc.CargoID and sc.CargoTypeID = 2
where mo.GameID = ${this.GameID} and mo.RaceID = ${this.RaceID} and mo.MoveActionID in (6, 96, 177) and mo.PopulationID <> 0
group by mo.PopulationID
```

**Validated.** 1A: 39 rows (75 populations, 39 with `Population > 0`). 1B: 4 rows. Samples:
- Aurelia: Population 5056.18, Efficiency 1.0, ReqInf 0, growth modifier 0.36, governor/sector growth bonus 1.125, installation workers 397.5 + yard workers 782.1 M, body population 5056.18.
- Elysium: Population 100.99, Efficiency 0.501 (workers 39.0 available vs 77.9 required).
- Phobos: Population 37.28, ReqInf 877, Infrastructure 25,000, growth bonus 1.414 (the only colony with a current CC).
- 1B: Volturn, Deimos, Canceron each have 2,750 colonists (persons) inbound; pop 49120 has 200 infrastructure inbound.
- Worker model check (JS below applied to 1A): max |predicted - stored Efficiency| = 0.0006. Result: 12 colonies are short of workers now (Belka -57.5 M, Volturn -47.2, Elysium -38.8, Phobos -24.8) and 8 still short in 5 years.
- Construction capacity from the shared modifiers (`index.vue:542` formula): Aurelia 885,075 BP/yr, Elysium 12,177, Phobos 9,948, Belka 8,746.
- Growth model sanity: Aurelia +0.47%/yr (+23.8 M), 10-year 5,298; Tertium +4.2%/yr; Chronos fill 0.915, growth 0.18%/yr (body cap 285.6 M).

**JS-side formulas.**
```js
const bodyCapacity = (c) => { // M people; docs colonies "Population Capacity", habitability.vue:2051
  const area = 4 * Math.PI * c.Radius ** 2
  const hydro = c.HydroExt > 75 ? Math.max((100 - c.HydroExt) / 25, 0.01) : 1
  const tidal = c.TidalLock && c.BodyClass !== 2 ? 5 : 1 // moons exempt, as in habitability.vue
  return Math.max(area / 511187128 * 12000 * c.PopulationDensityModifier * hydro / tidal, 0.05)
}
const growthRate = (c, pop, bodyPop, cap) => { // per year; base curve is workbook-only (see section 0)
  const raw = Math.min(0.1 * c.PopulationGrowthModifier, 0.2 * c.PopulationGrowthModifier / Math.cbrt(pop))
  const crowd = Math.max(0, Math.min(1, 1.5 * (1 - bodyPop / cap))) // full to cap/3, linear to 0 at cap
  return raw * c.PopulationGrowthBonus * crowd - c.RadiationLevel / 40000
}
const infraPerM = (c) => c.ReqInf > 0 ? c.ReqInf / c.Population : 0
// Aurora 2.6 removed low-gravity infrastructure (docs planetary-installations, v2.6): ordinary infrastructure
// counts on every body, and a low-gravity body needs twice as much, which the game's live ReqInf already holds.
// Only a pre-2.6 save (one with an LG installation type, DIM_PlanetaryInstallation.LGInfrastructureValue > 0)
// counts LG infrastructure alone on low-gravity bodies: pass legacyLowGravity for those.
const lowGravity = (c) => c.Gravity < c.MinimumGravity
const infraCap = (c, legacyLowGravity = false) => {
  if (!infraPerM(c)) {
    return Infinity
  }

  return (legacyLowGravity && lowGravity(c) ? c.LGInfrastructure : c.Infrastructure + c.LGInfrastructure) / infraPerM(c)
}
// project monthly: pop += pop * growthRate(...) / 12, bodyPop += same delta; months until pop >= infraCap(c)
const workers = (c, pop) => { // all in M
  const cc = c.ReqInf > 0 ? c.ReqInf * c.PopulationDensityModifier / (c.Population * 100 * (lowGravity(c) && !c.LegacyLowGravity ? 2 : 1)) : 0 // ReqInf is doubled on low-gravity bodies
  const service = Math.min(0.7, (pop / 1000) ** 0.25), agri = cc * 0.05 + 0.05 // x surface share if orbital pop is ever modelled
  const available = Math.max(0, 1 - service - agri) * pop
  const required = c.InstallationWorkers + c.YardWorkers
  return { available, required, free: available - required, efficiency: required > 0 ? Math.min(1, available / required) : 1 }
}
// inbound: pop += InboundColonists / 1e6; BP to build infra for the projection = max(0, projectedPop * infraPerM - infra - InboundInfrastructure) * DIM_PlanetaryInstallation.Cost (2 BP)
// Free workers / 0.05 = installations they could staff (DIM Workers 0.05 M for factory, mine, refinery, maintenance, FinCen).
```
Sample JS results: Phobos infra cap 1,062.6 M vs pop 37.3, growth 2.71%/yr, so it reaches the infra cap after about 2,733 months (228 years); body cap 14,483 M is not binding.

**Reuse.** Construction BP/yr and the "BP needed" comparison come from the extracted `populationConstructionCapacity()` (`index.vue:535`). Name rendering: `populationName()` (`utilities/aurora.js:47`). Overlap to avoid: do not add a second low-efficiency list; link to the Warnings entry.

**Caveats / open questions.**
- Orbital population (Ark modules on ships, docs `colonies`) is not modelled: `Population` is surface population only. Orbital pop would change service/agri shares (workbook `AU6` comment). I did not check the sample for them.
- Growth curve and radiation term are workbook-derived (section 0); show growth as an estimate. Easy verification: compare `Population` between two saves of the same game.
- Inbound colonists use move orders with `MoveActionID` 6/96/177 only; a fleet with several unload orders is counted at each destination (same as the reference view). `FCT_ShipCargo` has no destination of its own.
- Gravity check uses species `Gravity - GravDev`. The sample DIM table has no Low Gravity Infrastructure row (id 41 in the workbook) because Aurora 2.6 removed it, so I sum `InfrastructureValue`/`LGInfrastructureValue` instead of hard-coding ids 9/41. On a 2.6+ save `LGInfrastructure` is always 0, and a low-gravity colony with 1 M people, `ReqInf` 200 and 200 infrastructure is at its cap of 1 M, not at 0.
- The LG "x2 on colony cost" in workbook column AH is avoided for infrastructure by using `ReqInf`, the game's live requirement. The colony cost recovered from `ReqInf` for the worker split is halved on a low-gravity body (2.6+ saves), because `ReqInf` already holds the doubling. I could not test an LG colony (none in the sample has CC > 0).


---

## 2. Maintenance Budget

**Purpose.** Per colony (and for the whole empire): MSP stockpile, MSP production per year from maintenance facilities, upkeep per year of the ships assigned to it, net per year and runway in years, plus MSP held by supply ships. This is the data behind the game's own v2.8 "Empire Logistics Summary" (docs `logistics`: M-CAP, M-CIO, M-TONS, M-YEAR, M-MSP, M-PROD), which the app does not offer yet.

**Already in the app.** `warnings.vue:945` (ships with low own MSP), `:994` (supply classes with no minimum). Nothing covers colony stockpiles, production, upkeep or runway; `WarningMSP` is never read.

### SQL 2A: one row per colony that holds MSP, has facilities, or has ships assigned
```sql
select
  p.PopulationID, p.PopName, p.Population, p.Efficiency, p.MaintenanceStockpile, p.MaintProdStatus, p.WarningMSP,
  r.MSPProduction, r.MaintenanceCapacity, r.EconomicProdModifier, (1 - coalesce(b.RadiationLevel, 0) / 10000.0) as RadiationModifier, (1 - p.UnrestPoints / 100.0) as PoliticalStability, coalesce(ps.ProductionMod, 1) as PoliticalStatusModifier,
  rss.Name as SystemName, st.Component, b.SystemBodyID, b.PlanetNumber, b.OrbitNumber, b.BodyClass, bn.Name as SystemBodyName,
  coalesce(mf.MaintenanceFacilities, 0) as MaintenanceFacilities,
  coalesce(u.Ships, 0) as Ships, coalesce(u.MilitaryCost, 0) as MilitaryCost, coalesce(u.MaintainedCost, 0) as MaintainedCost,
  coalesce(u.MaintainedTons, 0) as MaintainedTons, coalesce(u.OverhaulCostOneYear, 0) as OverhaulCostOneYear,
  coalesce(u.SupplyShipMSP, 0) as SupplyShipMSP, coalesce(u.MaintModules, 0) as MaintModules,
  coalesce(orb.OrbitTons, 0) as OrbitTons, coalesce(orb.OrbitCost, 0) as OrbitCost
from FCT_Population p
inner join FCT_Race r on r.RaceID = p.RaceID
left join DIM_PopPoliticalStatus ps on ps.StatusID = p.PoliticalStatus
left join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID
left join FCT_SystemBodyName bn on bn.SystemBodyID = b.SystemBodyID and bn.RaceID = p.RaceID
left join FCT_RaceSysSurvey rss on rss.SystemID = p.SystemID and rss.RaceID = p.RaceID
left join FCT_Star st on st.StarID = b.StarID
left join (
  select pi.PopID, sum(d.MaintenanceValue * pi.Amount) as MaintenanceFacilities
  from FCT_PopulationInstallations pi
  inner join DIM_PlanetaryInstallation d on d.PlanetaryInstallationID = pi.PlanetaryInstallationID and d.MaintenanceValue > 0
  where pi.GameID = ${this.GameID}
  group by pi.PopID
) mf on mf.PopID = p.PopulationID
left join (
  select
    f.AssignedPopulationID as PopulationID, count(*) as Ships,
    sum(case when sc.Commercial = 0 and sc.ClassShippingLineID = 0 then sc.Cost else 0 end) as MilitaryCost,
    sum(case when sc.Commercial = 0 and sc.ClassShippingLineID = 0 and coalesce(sc_mother.CommercialHangar, 1) = 1 and scrap.ShipID is null then sc.Cost else 0 end) as MaintainedCost,
    sum(case when sc.Commercial = 0 and sc.ClassShippingLineID = 0 and coalesce(sc_mother.CommercialHangar, 1) = 1 and scrap.ShipID is null then sc.Size * 50 else 0 end) as MaintainedTons,
    sum(case when sc.MoraleCheckRequired = 1 and s.MaintenanceState = 2 then min(1.0, (g.GameTime - s.LastOverhaul) / 31536000.0 / 4.0) * sc.Cost else 0 end) as OverhaulCostOneYear,
    sum(case when sc.SupplyShip = 1 then s.CurrentMaintSupplies - sc.MinimumSupplies else 0 end) as SupplyShipMSP,
    sum(case when s.MothershipID = 0 then sc.MaintModules else 0 end) as MaintModules
  from FCT_Fleet f
  inner join FCT_Ship s on s.FleetID = f.FleetID
  inner join FCT_ShipClass sc on sc.ShipClassID = s.ShipClassID
  inner join FCT_Game g on g.GameID = f.GameID
  left join FCT_Ship s_mother on s_mother.ShipID = s.MothershipID
  left join FCT_ShipClass sc_mother on sc_mother.ShipClassID = s_mother.ShipClassID
  left join (select distinct ShipID from FCT_ShipyardTask where TaskTypeID = 3) scrap on scrap.ShipID = s.ShipID
  where f.GameID = ${this.GameID} and f.RaceID = ${this.RaceID} and f.AssignedPopulationID <> 0
  group by f.AssignedPopulationID
) u on u.PopulationID = p.PopulationID
left join (
  select f.OrbitBodyID, sum(sc.Size * 50) as OrbitTons, sum(sc.Cost) as OrbitCost
  from FCT_Fleet f
  inner join FCT_Ship s on s.FleetID = f.FleetID and s.MothershipID = 0
  inner join FCT_ShipClass sc on sc.ShipClassID = s.ShipClassID and sc.Commercial = 0 and sc.ClassShippingLineID = 0
  where f.GameID = ${this.GameID} and f.RaceID = ${this.RaceID}
  group by f.OrbitBodyID
) orb on orb.OrbitBodyID = p.SystemBodyID
where p.GameID = ${this.GameID} and p.RaceID = ${this.RaceID}
  and (p.MaintenanceStockpile > 0 or mf.MaintenanceFacilities > 0 or u.Ships > 0)
order by p.MaintenanceStockpile desc
```

### SQL 2B: supply ships with spare MSP
```sql
select
  f.FleetID, f.FleetName, f.AssignedPopulationID, f.OrbitBodyID, f.SystemID, s.ShipID, s.ShipName, sc.ClassName,
  s.CurrentMaintSupplies, sc.MaintSupplies as MaintSuppliesCapacity, sc.MinimumSupplies,
  s.CurrentMaintSupplies - sc.MinimumSupplies as AvailableMSP
from FCT_Ship s
inner join FCT_ShipClass sc on sc.ShipClassID = s.ShipClassID
inner join FCT_Fleet f on f.FleetID = s.FleetID
where s.GameID = ${this.GameID} and s.RaceID = ${this.RaceID} and sc.SupplyShip = 1 and sc.ClassShippingLineID = 0 and s.CurrentMaintSupplies - sc.MinimumSupplies > 0
order by AvailableMSP desc
```

**Validated.** 2A: 51 rows (47 with assigned ships, 42 with facilities). 2B: 9 rows, 38.8 M MSP available in total (six Yggdrasil supply ships hold 6.27 M each). Samples:
- Aurelia: stock 217,491,605; production on; 250 facilities; 836 ships assigned; `MaintainedCost` 16,682,099.6 (upkeep 4,170,525/yr); `MaintainedTons` 3,615,992; `SupplyShipMSP` 1,171,055.
- Korhal: 25 facilities, 37 ships, `MaintainedCost` 1,619,704.8. Fortuna: stock 3,302,098, Efficiency 0.972.
- Derived with the JS below: Aurelia production 1,170,000 MSP/yr (250 x 800 x 4 x 1.4625), net -3,000,525/yr, runway 72.9 years. Empire: stock 262,957,945; potential production 2,488,409/yr (current 1,663,997 because most small colonies have production switched off); upkeep 9,920,285/yr; 45 colonies with a deficit; capacity is never exceeded.
- Scrap-task exclusion and the overhaul term cannot fire in the sample (`FCT_ShipyardTask` empty; every ship `MaintenanceState` 0). On the scratch copy a synthetic scrap task for one Korhal ship reduced `MaintainedCost` from 1,619,704.8 to 1,606,117.6, as intended.
- Assigned versus physically in orbit (`OrbitCost`): equal for 45 of 47 colonies; two deep-space depots (Epsilon Ceti, Eta Cassiopei) have ships assigned (1,581,569 cost each) but none in orbit.

**JS-side formulas** (`mod` = `OverallProductionModifier` from the shared index.vue modifiers, matched on `PopulationID`).
```js
const potential = c.MaintenanceFacilities * c.MSPProduction * 4 * mod               // MSP/yr, 1 MSP = 0.25 BP
const current = c.MaintProdStatus ? potential : 0
const capacity = (c.MaintenanceFacilities * c.MaintenanceCapacity * c.Efficiency * c.RadiationModifier * c.PoliticalStability * c.PoliticalStatusModifier + c.MaintModules * c.MaintenanceCapacity) * c.EconomicProdModifier // tons, docs maintenance rule 6
const emr = c.OrbitTons > 0 ? Math.min(1, capacity / c.OrbitTons) : 1                // docs maintenance rule 5
const upkeep = (c.MaintainedCost / 4 + c.OverhaulCostOneYear) * emr                  // MSP/yr
const net = current - upkeep
const runwayYears = net >= 0 ? Infinity : (c.MaintenanceStockpile + c.SupplyShipMSP) / -net
// flags: stock < WarningMSP; production off and runway < N years (turn on); production on and stock > N x upkeep (turn off)
```

**Reuse.** The extracted production modifiers (shared helper 1). Upkeep rules are those of `references/queries/ShipSizeAndCostByPopulation.sql` (military non-shipping-line classes, excluding ships docked in a military hangar via `CommercialHangar`, and ships being scrapped); I dropped the commercial totals and replaced its hard-coded RaceID. Layout idea: one "Logistics" page with this table and the fuel table in section 3, as the game's own summary does.

**Caveats / open questions.**
- MSP is consumed where a ship is, not where it is assigned (docs `maintenance`: ships draw from populations at the same location, then supply ships, then themselves). Assigned-based upkeep is the planning figure from the reference query; the in-orbit column shows the physical reality. Ships assigned to population 0 (58 ships, 34 fleets in the sample) are not in any row.
- `OverallProductionModifier` includes the species `ProductionRateModifier` (Zenox 1.25). Whether it applies to MSP and fuel output is not stated in docs or wiki (the wiki lists governor skill, workers, unrest, radiation only); the workbook omits it. Effect: +25% on Zenox colonies. Verify by comparing stockpiles of a facility-only colony across two saves.
- The workbook applies the efficiency penalty twice in its "current production" cell (`JA = IZ x FW`, with `IZ` already containing `FW`); I apply it once.
- Overhaul term follows the reference query but adds to, rather than replaces, normal upkeep for ships in overhaul.


---

## 3. Fuel Balance

**Purpose.** Empire fuel position: stock in colonies and in tankers/stations, production per year from refineries and from sorium harvesters (location, deposit accessibility and remaining deposit), the sorium stock that feeds refineries, and a consumption estimate derived from the save instead of the workbook's hand-entered "tank days".

**Already in the app.** `warnings.vue:1026` (tanker classes with no minimum fuel), `information.vue:257` (range and refuel time per class). Nothing aggregates fuel stock, production or burn; `FuelStockpile`, `WarningFuel` are never read.

### SQL 3A: colonies with fuel, refineries or sorium
```sql
select
  p.PopulationID, p.PopName, p.Population, p.FuelStockpile, p.FuelProdStatus, p.WarningFuel, p.Sorium, p.ReserveSorium, fr.FuelProduction,
  rss.Name as SystemName, st.Component, b.SystemBodyID, b.PlanetNumber, b.OrbitNumber, b.BodyClass, bn.Name as SystemBodyName,
  coalesce(r.Refineries, 0) as Refineries, coalesce(r.RefuellingPoint, 0) as RefuellingPoint
from FCT_Population p
inner join FCT_Race fr on fr.RaceID = p.RaceID
left join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID
left join FCT_SystemBodyName bn on bn.SystemBodyID = b.SystemBodyID and bn.RaceID = p.RaceID
left join FCT_RaceSysSurvey rss on rss.SystemID = p.SystemID and rss.RaceID = p.RaceID
left join FCT_Star st on st.StarID = b.StarID
left join (
  select pi.PopID, sum(d.RefineryProductionValue * pi.Amount) as Refineries, max(d.MassRefuelling) as RefuellingPoint
  from FCT_PopulationInstallations pi
  inner join DIM_PlanetaryInstallation d on d.PlanetaryInstallationID = pi.PlanetaryInstallationID and (d.RefineryProductionValue > 0 or d.MassRefuelling > 0)
  where pi.GameID = ${this.GameID}
  group by pi.PopID
) r on r.PopID = p.PopulationID
where p.GameID = ${this.GameID} and p.RaceID = ${this.RaceID} and (p.FuelStockpile > 0 or r.Refineries > 0 or p.Sorium > 0)
order by p.FuelStockpile desc
```

### SQL 3B: your harvester ships (deposit data only for surveyed bodies)
```sql
select
  f.FleetID, f.FleetName, f.ParentCommandID, f.SystemID, f.Speed, s.ShipID, s.ShipName, sc.ShipClassID, sc.ClassName, sc.Harvesters,
  s.Fuel, sc.FuelCapacity, sc.MinimumFuel,
  rss.Name as SystemName, st.Component, b.SystemBodyID, b.PlanetNumber, b.OrbitNumber, b.BodyClass, bn.Name as SystemBodyName,
  case when sbs.SystemBodyID is null then null else md.Amount end as SoriumAmount, case when sbs.SystemBodyID is null then null else md.Accessibility end as SoriumAccessibility,
  coalesce(cb.BonusValue, 1.0) as MiningBonus, cmd.Name as CommanderName,
  pop.PopName as ColonyAtBody
from FCT_Ship s
inner join FCT_ShipClass sc on sc.ShipClassID = s.ShipClassID
inner join FCT_Fleet f on f.FleetID = s.FleetID
left join FCT_SystemBody b on b.SystemBodyID = f.OrbitBodyID
left join FCT_SystemBodyName bn on bn.SystemBodyID = b.SystemBodyID and bn.RaceID = s.RaceID
left join FCT_RaceSysSurvey rss on rss.SystemID = f.SystemID and rss.RaceID = s.RaceID
left join FCT_Star st on st.StarID = b.StarID
left join FCT_MineralDeposit md on md.SystemBodyID = f.OrbitBodyID and md.MaterialID = 8 and md.GameID = s.GameID
left join FCT_SystemBodySurveys sbs on sbs.SystemBodyID = f.OrbitBodyID and sbs.RaceID = s.RaceID and sbs.GameID = s.GameID
left join FCT_Commander cmd on cmd.CommandID = s.ShipID and cmd.CommandType = 1 and cmd.RaceID = s.RaceID and cmd.CommanderType = 0
left join FCT_CommanderBonuses cb on cb.CommanderID = cmd.CommanderID and cb.BonusID = 6
left join FCT_Population pop on pop.SystemBodyID = f.OrbitBodyID and pop.RaceID = s.RaceID and pop.GameID = s.GameID
where s.GameID = ${this.GameID} and s.RaceID = ${this.RaceID} and sc.Harvesters > 0 and sc.ClassShippingLineID = 0
order by sc.Harvesters desc, md.Accessibility desc
```

### SQL 3C: fuel levels and burn proxy per ship class (ships with engines, not docked, no shipping lines)
```sql
select
  sc.ShipClassID, sc.ClassName, sc.FuelTanker, sc.Commercial, sc.MaxSpeed, sc.EnginePower, sc.FuelEfficiency, sc.FuelCapacity, sc.MinimumFuel,
  count(*) as Ships,
  sum(s.Fuel) as FuelNow,
  sum(sc.FuelCapacity) as FuelCapacityTotal,
  sum(case when s.Fuel < sc.FuelCapacity * 0.5 then 1 else 0 end) as ShipsBelowHalf,
  sum(case when f.Xcor <> f.LastXcor or f.Ycor <> f.LastYcor then 1 else 0 end) as ShipsMoving,
  sum(case when exists (select 1 from FCT_MoveOrders mo where mo.FleetID = f.FleetID and mo.Arrived = 0) then 1 else 0 end) as ShipsWithOrders,
  avg(min(1.0, s.DistanceTravelled / (max(g.GameTime - s.Constructed, 31536000.0 / 4) * sc.MaxSpeed))) as AverageDutyCycle,
  sum(min(1.0, s.DistanceTravelled / (max(g.GameTime - s.Constructed, 31536000.0 / 4) * sc.MaxSpeed))) * sc.EnginePower * sc.FuelEfficiency * 8760 as LifetimeBurnLitresPerYear
from FCT_Ship s
inner join FCT_ShipClass sc on sc.ShipClassID = s.ShipClassID
inner join FCT_Fleet f on f.FleetID = s.FleetID
inner join FCT_Game g on g.GameID = s.GameID
where s.GameID = ${this.GameID} and s.RaceID = ${this.RaceID} and s.ShippingLineID = 0 and sc.EnginePower > 0 and sc.MaxSpeed > 0 and sc.FuelCapacity > 0 and s.MothershipID = 0
group by sc.ShipClassID
order by LifetimeBurnLitresPerYear desc
```

### SQL 3D: naval admin commands with mining and terraforming bonuses (replaces the bonus-9-only query at `index.vue:808`)
```sql
select
  a.NavalAdminCommandID, a.ParentAdminCommandID as ParentCommandID, a.PopulationID, p.SystemID,
  pi.Amount * d.NavalHeadquartersValue as NavalAdminCommandLevel,
  t.Radius, t.Industrial, t.Logistics,
  cbm.BonusValue as MiningBonus, cbt.BonusValue as TerraformingBonus
from FCT_NavalAdminCommand a
inner join FCT_PopulationInstallations pi on pi.PopID = a.PopulationID
inner join DIM_PlanetaryInstallation d on d.PlanetaryInstallationID = pi.PlanetaryInstallationID and d.NavalHeadquartersValue > 0
inner join FCT_Population p on p.PopulationID = a.PopulationID
left join DIM_NavalAdminCommandType t on t.CommandTypeID = a.AdminCommandTypeID
left join FCT_Commander c on c.CommandID = a.NavalAdminCommandID and c.CommandType = 12
left join FCT_CommanderBonuses cbm on cbm.CommanderID = c.CommanderID and cbm.BonusID = 6
left join FCT_CommanderBonuses cbt on cbt.CommanderID = c.CommanderID and cbt.BonusID = 9
where a.GameID = ${this.GameID} and a.RaceID = ${this.RaceID}
```

`NavalAdminCommandLevel` is the HQ level, not the radius. Use the radius, required-rank and flag-bridge handling in `mineral-outlook.vue`'s `navalAdmins` and `utilities/minerals.js` (`navalAdminRadius`, `navalAdminRequiredRanks`, `navalAdminChainBonus`); docs/DATABASE.md § Commander bonus rules has the rules.

### SQL 3E: fuel held in tankers, stations and other ships
```sql
select
  sc.FuelTanker, case when sc.EnginePower > 0 then 1 else 0 end as HasEngines, sc.Commercial,
  count(*) as Ships, sum(s.Fuel) as Fuel, sum(sc.FuelCapacity) as FuelCapacity, sum(case when s.Fuel > sc.MinimumFuel then s.Fuel - sc.MinimumFuel else 0 end) as FuelAboveMinimum
from FCT_Ship s
inner join FCT_ShipClass sc on sc.ShipClassID = s.ShipClassID
where s.GameID = ${this.GameID} and s.RaceID = ${this.RaceID} and s.ShippingLineID = 0 and sc.FuelCapacity > 0
group by sc.FuelTanker, HasEngines, sc.Commercial
order by Fuel desc
```

**Validated.** 3A: 53 rows (43 with refineries, 10 producing). 3B: **0 rows for race 784 (the player owns no harvesters in the sample)**; against NPR race 786 it returns 9 rows (fleet "Precursor Harvester Group 001", class Haven, 57 harvesters each, sorium 32,989,497 t at accessibility 0.9, tanks full). On the scratch copy a player ship moved to that body returned `SoriumAmount = NULL` because race 784 has not surveyed it (fog-of-war guard works) and a synthetic 1.15 mining bonus was picked up. 3C: 33 rows, 667 ships. 3D: 60 rows. 3E: 7 rows. Samples:
- Colonies: Aurelia stock 25,969,890,307 L (25,970 ML), 50 refineries, sorium 50,750,169 t. Empire colony stock 35,119 ML; tankers/stations 6 stations hold 939.4 ML (+50 ML tanker, +13 ML), other ships about 84 ML.
- Production with the JS below: 264 ML/yr now (Aurelia 182.8, Caprica 23.7, Korhal 19.3, Fortuna 15.7, Fomalhaut I 7.1), potential 434 ML/yr. Sorium cover: Aurelia 555 years, but the small refinery colonies 0 to 12 years.
- 3C: lifetime-average burn proxy 23.2 ML/yr (Pilgrim 7.19, Mule 5.74, Traveler 4.42, C400 Hauler 3.08); current burn if the 50 ships that moved in the last increment run at full power: 31.6 ML/yr. The two agree to within 40%, so net is about +230 ML/yr, and the colony stock alone would cover about 1,100 years of that burn.

**JS-side formulas.**
```js
// refinery colony (3A), mod = OverallProductionModifier from shared helper 1
const output = c.Refineries * c.FuelProduction * mod * (c.FuelProdStatus ? 1 : 0)   // L/yr
const sorYears = (c.Sorium / (c.Refineries * c.FuelProduction * mod / 2000))        // years of sorium; 1 t sorium = 2000 L (wiki Fuel Refinery)
// harvester ship (3B). Admin multiplier: walk fleet.ParentCommandID -> admin.ParentCommandID as index.vue:660 intends, with MiningBonus and the Industrial share
const perShip = h.Harvesters * raceFuelProduction * h.MiningBonus * h.SoriumAccessibility * adminMult   // L/yr (workbook SorHarv; inferred)
const sorTonsPerYear = perShip / 2000; const depositYears = h.SoriumAmount / (sorTonsPerYear * shipsAtBody)
// harvesting stops when tanks are full: room = h.FuelCapacity - h.Fuel
// consumption proxies (3C, per class row k)
const burnPerHour = k.EnginePower * k.FuelEfficiency                                  // L/h at full power (information.vue:257 uses the same product)
const lifetimeBurn = k.LifetimeBurnLitresPerYear                                       // sum over ships of dutyCycle * EP * eff * 8760
const currentBurn = burnPerHour * ship.moving * 8760                                   // upper bound: full power while moving
const topUpDemand = k.FuelCapacityTotal - k.FuelNow                                    // L needed to fill every tank today
// dutyCycle per ship = min(1, DistanceTravelled / (max(GameTime - Constructed, 0.25 y) * MaxSpeed))
// net = production(refineries + harvesters) - (lifetimeBurn or currentBurn); stock years = stock / -net when net < 0
```

**Reuse.** `information.vue:257` fuel-range formula (`EnginePower x FuelEfficiency` L/hour; confirmed by `engines.vue:622`, where per-engine use is L per engine-power-hour), `FuelTanker` flag semantics from `warnings.vue:1026`, shared production modifiers, admin-bonus helper (shared helper 2). The reference `Yearly/09 Stations Needing Refuel or Resupply.sql` depends on fleet-name suffixes (`___GAS`) so I did not port it; 3E captures the same stock without naming conventions.

**Consumption proxy, and how uncertain it is.**
1. *Lifetime duty cycle* (3C): `DistanceTravelled` is cumulative km per ship, so `DistanceTravelled / (age x MaxSpeed)` is the average fraction of time at full speed. Cycling freighters in the sample score 0.9 (average 71,740 km/s on a 72,008 km/s hull), idle military ships near 0. It is a historical average (300-year-old ships average over their whole career, refits change speed, ships with `Constructed = 0` are treated as game-age), so it is a floor-ish estimate for a steady-state economy.
2. *Current motion* (3C `ShipsMoving`): a fleet moved in the last increment when `Xcor <> LastXcor or Ycor <> LastYcor` (33 of 227 fleets, 50 ships). Burn at partial speed is assumed to scale linearly with power, so full-power burn is an upper bound. `FCT_Fleet.Speed` is not a movement flag: it is non-zero for every fleet that has engines (all 667 counted ships).
3. *Pending orders*: `ShipsWithOrders` (66 ships) shows what will burn next; converting orders to km needs route distances (jump point graph), which I did not attempt.
4. *Top-up demand* (`FuelCapacityTotal - FuelNow`): immediate, certain, but small (0.9 ML in the sample).
Not covered: new ships starting with full tanks (needs `FCT_ShipyardTask`, empty in the sample), refuelling of civilian lines (excluded; I could not confirm whether they draw on colony fuel), NPR/ally refuelling.

**Caveats / open questions.**
- Harvester rate (section 0 table) is the biggest unknown; the formula is the workbook's. Treat harvester output as "estimated" in the UI until checked against an in-game fleet.
- Refineries stop when the colony runs out of sorium: `output` should be `min(output, p.Sorium * 2000 / yearsHorizon)` for projections; `ReserveSorium` semantics (is it a floor for refineries?) are unknown.
- Conventional Industry counts 0.05 refinery (docs `planetary-installations`); the SQL does this via `RefineryProductionValue`.
- Same species-modifier question as section 2.


---

## 4. Shipyard Planner

**Purpose.** One row per shipyard: type, capacity, slipways, tooled class, busy slipways, BP/yr per slipway with all bonuses, build time of its class, and what it costs in BP and time to add capacity, add a slipway or retool; plus a what-if for any class at a chosen yard and a component-production share (workbook sheets Yards, ShipyardGrowth, QCalc).

**Already in the app.** `index.vue:272-289` shows only shipyards with an upgrade in progress and `index.vue:256-271` ships already being built (remaining days from stored BP). `warnings.vue:1298` lists yards tooled for obsolete classes. Nothing shows idle yards, bonuses per slipway, or what-if costs.

### SQL 4A: shipyards
```sql
select
  y.ShipyardID, y.ShipyardName, y.PopulationID, y.SYType, y.Capacity, y.Slipways, y.CapacityTarget,
  y.TaskType as UpgradeTaskType, y.RequiredBP, y.CompletedBP, y.PauseActivity,
  y.BuildClassID, bc.ClassName as BuildClassName, bc.Size as BuildClassSize, bc.Cost as BuildClassCost, bc.Commercial as BuildClassCommercial,
  y.RetoolClassID, rc.ClassName as RetoolClassName, rc.Cost as RetoolClassCost,
  coalesce(t.BusySlips, 0) as BusySlips, coalesce(t.ConstructionTasks, 0) as ConstructionTasks,
  y.Capacity * y.Slipways * case y.SYType when 1 then 1.0 else 0.1 end / 4000.0 as WorkersRequired,
  p.PopName, rss.Name as SystemName, st.Component, b.SystemBodyID, b.PlanetNumber, b.OrbitNumber, b.BodyClass, bn.Name as SystemBodyName
from FCT_Shipyard y
left join FCT_Population p on p.PopulationID = y.PopulationID
left join FCT_SystemBody b on b.SystemBodyID = p.SystemBodyID
left join FCT_SystemBodyName bn on bn.SystemBodyID = b.SystemBodyID and bn.RaceID = y.RaceID
left join FCT_RaceSysSurvey rss on rss.SystemID = p.SystemID and rss.RaceID = y.RaceID
left join FCT_Star st on st.StarID = b.StarID
left join FCT_ShipClass bc on bc.ShipClassID = y.BuildClassID
left join FCT_ShipClass rc on rc.ShipClassID = y.RetoolClassID
left join (
  select ShipyardID, count(*) as BusySlips, sum(case when TaskTypeID = 0 then 1 else 0 end) as ConstructionTasks
  from FCT_ShipyardTask
  where GameID = ${this.GameID} and RaceID = ${this.RaceID}
  group by ShipyardID
) t on t.ShipyardID = y.ShipyardID
where y.GameID = ${this.GameID} and y.RaceID = ${this.RaceID} and y.TractorParentShipID = 0
order by y.PopulationID, y.SYType, y.Capacity * y.Slipways desc
```

### SQL 4B: shipyard tasks (all task types occupy a slipway)
```sql
select
  t.TaskID, t.ShipyardID, t.TaskTypeID, t.ClassID, t.UnitName, t.TotalBP, t.CompletedBP, t.TotalBP - t.CompletedBP as RemainingBP, t.Paused, t.UseComponents,
  c.ClassName, c.Size, c.Cost
from FCT_ShipyardTask t
left join FCT_ShipClass c on c.ShipClassID = t.ClassID
where t.GameID = ${this.GameID} and t.RaceID = ${this.RaceID}
```

### SQL 4C: buildable classes (what-if list)
```sql
select
  c.ShipClassID, c.ClassName, c.Size, c.Size * 50 as Tons, c.Cost, c.Commercial, c.MaintSupplies, c.FuelCapacity,
  (select count(*) from FCT_ClassComponent cc inner join FCT_ShipDesignComponents sdc on sdc.SDComponentID = cc.ComponentID where cc.ClassID = c.ShipClassID and sdc.Prototype = 1) as PrototypeComponents
from FCT_ShipClass c
where c.GameID = ${this.GameID} and c.RaceID = ${this.RaceID} and c.ClassShippingLineID = 0 and c.Obsolete = 0
order by c.Commercial, c.Size
```

### SQL 4D: components of every class (group by `ClassID` in JS)
```sql
select
  cc.ClassID, c.ClassName, sdc.SDComponentID, sdc.Name, sdc.Prototype, cc.NumComponent, sdc.Cost, cc.NumComponent * sdc.Cost as TotalCost,
  cc.NumComponent * sdc.Cost / c.Cost as ShareOfClass
from FCT_ClassComponent cc
inner join FCT_ShipClass c on c.ShipClassID = cc.ClassID
inner join FCT_ShipDesignComponents sdc on sdc.SDComponentID = cc.ComponentID
where cc.GameID = ${this.GameID} and c.RaceID = ${this.RaceID}
order by cc.ClassID, TotalCost desc
```

### SQL 4E: components in stock per colony
```sql
select
  pc.PopulationID, pc.ComponentID, sdc.Name, sdc.Cost, pc.Amount
from FCT_PopComponent pc
inner join FCT_Population p on p.PopulationID = pc.PopulationID
inner join FCT_ShipDesignComponents sdc on sdc.SDComponentID = pc.ComponentID
where p.GameID = ${this.GameID} and p.RaceID = ${this.RaceID} and pc.Amount > 0
order by pc.PopulationID, sdc.Cost * pc.Amount desc
```

**Validated.** 4A: 38 rows (the whole table for game 140; 21 at Aurelia). 4B: 0 rows in the sample (4 on the scratch copy). 4C: 47 classes. 4D: 1,476 component rows. 4E: 39 rows. Class cost equals the sum of component costs (Owl II: 44,662.36 = 44,662.36). Samples:
- Battlecruiser Drydocks: type 1, capacity 75,000 t, 3 slipways, class Aurelia II (size 1500 HS, cost 903,237.5), workers 56.25 M. Jonferson Shipbuilding: type 2, 120,000 t, 12 slipways, class Liberty (cost 43,033.6). Yamagata Forge: type 3, 4,000,000 t, 4 slipways, no class (a repair yard by the docs; inferred).
- Rates from the shared modifiers (Aurelia: `ShipyardBuildRate` R = 90,000, `ShipyardOperations` 0.1): Aurelia II 720,000 BP/yr per slipway, 458 days; Liberty at a commercial yard 308,951 BP/yr, 50.8 days; capacity modification rate at Battlecruiser Drydocks 720,000 BP/yr; adding 5,000 t to Frigate Shipyards (15 slipways) costs 1,800 BP and 5.8 days.
- Synthetic copy: 4 tasks on yard 16 (2 construction, 1 refit, 1 scrap) gave `BusySlips = 4`, `ConstructionTasks = 2`; an upgrade on yard 7 (`TaskType` 1, `RequiredBP` 5000, `CompletedBP` 1000) came through unchanged.

**JS-side formulas** (`R` = `ShipyardBuildRate` of the yard's population, `ops` = `ShipyardOperations`; `naval = SYType === 1`).
```js
const slipwayRate = (R, sizeHS, naval) => R * (1 + (sizeHS * (naval ? 1 : 0.25) / 100 - 1) / 2) // BP/yr per slipway, index.vue:569; wiki: commercial uses base size 400
const buildDays = (cost, rate) => cost / rate * 365
const modRate = (R, capTons, naval) => R * (1 + (capTons * (naval ? 1 : 0.1) / 5000 - 1) / 2)   // index.vue:580; same maths for add capacity, add slipway, retool
const capacityCost = (addTons, slipways, naval, ops) => addTons * 0.24 * slipways * ops * (naval ? 1 : 0.1) // 120 BP per 500 t per slipway (index.vue:643); wiki: 2000 t = 480 BP at one slipway
const stepDays = (cost, M) => cost / M * 365                                       // a discrete task runs at the rate fixed when it starts
const continualYears = (R, C0, C1, slipways, ops, naval) => { // "Continual Capacity Upgrade": rate grows with the yard
  const k = (naval ? 1 : 0.1) / 10000, c = 0.24 * slipways * ops * (naval ? 1 : 0.1)
  return c / (R * k) * Math.log((C1 + 0.5 / k) / (C0 + 0.5 / k))
}
const retoolCost = (classCost, slipways) => classCost * (0.5 + 0.25 * slipways)     // wiki "Shipyard"; a new yard with no class retools free
const slipwayCost = null // unknown: see caveats; calibrate k = RequiredBP / (Capacity/1000 x ops) from any FCT_Shipyard row with TaskType = 1
// QCalc: components for n ships not in stock (4D x n minus 4E at that colony): compBP = sum((NumComponent * Cost) * n) - stocked
//   days at share q% = compBP / (constructionBPperYear * q / 100) * 365;   q% to hit a deadline = compBP / (BPperYear * days / 365) * 100
//   constructionBPperYear = populationConstructionCapacity() of the build colony (index.vue:535); component projects are ProductionType 3 in FCT_IndustrialProjects
```
Check: `continualYears` agrees with an iteration of `index.vue:629-658` (steps of `MinConstructionPeriod`, 86,399 s in the sample) to within one construction period (for example 7,500 to 15,000 t at 15 slipways: 0.0188 y closed form versus 0.0219 y iterated, a 1.1-day difference). Remaining days for a task already stored use the stored `RequiredBP - CompletedBP`, exactly as `index.vue:276`.

**Reuse.** All rate maths and the task-type labels (`index.vue:107-125`) from the extracted helpers; `FCT_Shipyard.TaskType` map: 0 none, 1 add slipway, 2-6 add 500/1000/2000/5000/10,000 t, 7 retool, 8 continual, 9 SM modification. Worker use per yard is in 4A (`WorkersRequired`, same maths as `population infrastructure and capacity.sql`: capacity x slipways x 250 workers per ton, x0.1 commercial, divided by 1e6). Naval admin shipbuilding bonuses are already in `ShipyardBuildRate` (governor x 0.25 sector).

**Caveats / open questions.**
- **Add-slipway cost is unknown** (not in docs, wiki or workbook). The wiki "Shipyard" page only says extra slipways are built by the yard itself at the same modification rate. Proposed provisional rule: same as adding the yard's current capacity (`capacityCost(Capacity, 1, ...)`), marked "estimate"; replace with a calibrated constant once a `TaskType = 1` row is seen in a real save.
- `SYType`: 1 naval, 2 commercial, 3 repair are inferred from the sample (capacity 4,000,000 t, no class). Light Naval yards (docs `shipyards`) do not appear in the sample; their `SYType` value, 1,000-ton fixed capacity and naval-style worker use are unverified, and the `SYType === 1 ? naval : commercial` rule used by `index.vue` would misprice them.
- `ShipyardOperations` is a cost/time multiplier (1.0 normal, 0.1 for the "90% Time/Cost Saving" tech, which the sample race has); the workbook's equivalent is `1/(1 - reduction)` on the rate. Both give the same time; cost only scales with the first.
- Retool rate in `index.vue:276` divides days by slipways; I could not verify that against the game (no retool task in the sample).
- Towed yards (`TractorParentShipID <> 0`, a ship is carrying the yard) are excluded from 4A; the reference query includes them via the ship join.
- Prototype components: a class with a prototype cannot be tooled (docs `ship-components`); 4C returns `PrototypeComponents` for that flag (all 0 in the sample).


---

## 5. Blockers and what would unblock them

1. Add-slipway cost formula: need one real save with a `FCT_Shipyard.TaskType = 1` row, or Steve's post. Planner still works with an "estimate" label.
2. Harvester output per module (and whether the species production modifier applies to MSP/fuel): need two saves of the same game or an in-game readout; both are labelled estimates in the plan.
3. Base population growth curve: only the workbook documents it; labelled estimate.
4. Not exercisable in the sample: player harvesters, shipyard tasks, low-gravity colonies with CC > 0, orbital (Ark) population, Light Naval yards, ships in overhaul. SQL for all of these ran (synthetic rows or NPR race) but their results are unverified against real play.
