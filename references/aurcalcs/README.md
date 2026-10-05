# Aur_Calcs reference workbook

`Aur_Calcs260.xlsx` is a community calculator workbook for Aurora C# 2.6.0. It's kept here as a reference for features and game maths to port into Aurora Electrons. The app doesn't read it.

## How it gets its data

The workbook reads a save through an ODBC DSN (`AuroraDB32`) and runs `SELECT * FROM "main"."vw_*"` against 25 SQL views that the author created inside their `AuroraDB.db`. Each result lands in a `*_src` sheet (or a table on a calculation sheet), and the other sheets compute from those tables, their named ranges (368 of them), and some manually entered plans and overrides.

Aurora Electrons must not install views in users' saves. When a feature is ported, the view's SQL becomes an inline query in the page, scoped by `GameID` and `RaceID` like every other query in the app.

| View | Sheet | Contents |
|---|---|---|
| `vw_cycling` | `Cycling_src` | Cycling cargo/colonist fleets: route, cargo, capacity, rate, fuel |
| `vw_empireMining` | `Mins_src` | Empire mineral stock and change |
| `vw_Fleets_FuelFairies` | `FuelFairies_src` | Tanker (fuel fairy) fleets and routes |
| `vw_Fleets_MSPFairies` | `MSPFairies_src` | Supply (MSP) fleets and routes |
| `vw_gamedate` | `BigPlan` | Game date, seconds since the construction cycle |
| `vw_groundforces` | `GroundForces_src` | Ground forces per population, present and inbound |
| `vw_groundsurvey` | `GrndSurvey` | Ground geosurvey progress per body |
| `vw_haulingCapacity` | `HaulCap_src` | Freighter/colony-ship capacity per class |
| `vw_jumppoints` | `JP_src` | Jump points with coordinates, destinations, gates |
| `vw_LagrangePoints` | `LP_src` | Lagrange point coordinates |
| `vw_mineralStocks` | `Mins_src` | Mineral stock and reserve levels per population |
| `vw_mining_surface` | `SurfMin_src` | Surface mines per deposit with bonuses and accessibility |
| `vw_orbitalMining` | `OrbMin_src` | Orbital mining ships per deposit, with depletion columns |
| `vw_orbitalTerraforming` | `OrbTF_src` | Terraforming ships and their bonuses |
| `vw_pop` | `Pop_src` | Wide per-population summary: installations, bonuses, inbound cargo, maintenance |
| `vw_RaceTech` | `RaceTech_src` | Racial tech values (refinery, mining, terraforming rates…) |
| `vw_ScoopCycling` | `ScoopCycling_src` | Sorium harvester cycling fleets |
| `vw_shipClasses` | `ShipClasses_src` | Ship classes with cost, minerals, fuel, cargo |
| `vw_sorharv` | `SorHarv_src` | Sorium harvesters and their output |
| `vw_Species` | `Species_src` | Species tolerances and modifiers |
| `vw_supplies` | `Supplies_src` | Fuel and MSP stock per population |
| `vw_survey` | `Srv_src` | Gravitational survey progress per system |
| `vw_surveylocations` | `SrvLoc_src` | Survey location coordinates |
| `vw_tfbodies` | `TFBodies_src` | Bodies' atmosphere and orbit data for terraforming |
| `vw_tfplan` | `TF_src` | Per-body minerals, accessibility, atmosphere, colony cost |
