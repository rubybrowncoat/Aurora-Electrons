/*
  Checks the terraforming planner's inputs against observed campaigns (backlog AE-059-01), read only.

  node scripts/check-terraform-campaigns.js [--no-mutations]

  Each group opens saves of a recorded campaign read only (SELECTs only) and compares a before/after pair with the rate and climate rules of docs/DATABASE.md:
  - rate: the change of a gas on a colony with a terraforming order that stood across a pair of saves equals the capacity of the colony at the earlier save (terraformers, racial rate, commanders, installations, modifiers, the game's speed) times the elapsed years of the growth clock times the pressure of one earth-equivalent atmosphere over the body's surface. The elapsed time is read from the growth clock, not the game time: the same pair with the game time is off by percent;
  - climate: the surface temperature of every body with an atmosphere equals the app's recomputed base temperature times the greenhouse factors of the gases that are listed;
  - hidden: some bodies carry more pressure than their listed gases add up to (gases at zero are not saved);
  - plans: the app's plan against what the player did on the same bodies;
  - shared rule: the terraforming capacity of every colony of the fixture and of the played save equals an independent working under the fleet-at-colony rule the game applies (a fleet counts at the colony when it is of the colony's race, within one unit of the colony's body on both axes, and assigned to the colony or to none), and the planted fleets — one assigned to the colony but away from it, one assigned to none at it, one assigned to none that the game may give to two colonies — are read as the rule says.
  A save that is not there skips its group and says so; a skipped group is never counted as passed. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { Database } = require('bun:sqlite')
const { assert, runChecks, judged, caughtAll } = require('./lib/fault-credit')
const { FIXTURE, PLAYED } = require('./lib/fixtures')
const { loadUtilities } = require('./lib/utilities')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating, refusePlanting } = require('./lib/no-mutations')

const root = path.resolve(__dirname, '..')
const SECONDS_PER_YEAR = 31536000
const EARTH_ATMOSPHERE_UNITS = 511187128
const PI = 3.1416
const GROUP_BY = 'export default (list, key) => list.reduce((groups, item) => { (groups[item[key]] = groups[item[key]] || []).push(item); return groups }, {})'

const FALRYX = 'artifacts/falryx-sequential-and-rollback'
const falryx = (time) => `${FALRYX}/AuroraDB-${time}.db`

const handles = new Map()

const handleOf = (file) => {
  if (!handles.has(file)) {
    handles.set(file, new Promise((resolve, reject) => {
      const database = new sqlite3.Database(path.join(root, file), sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(database)))
    }))
  }

  return handles.get(file)
}

const rowsOf = async (file, sql, ...parameters) => {
  const database = await handleOf(file)

  return new Promise((resolve, reject) => database.all(sql, parameters, (error, rows) => (error ? reject(error) : resolve(rows))))
}

const firstOf = async (file, sql, ...parameters) => (await rowsOf(file, sql, ...parameters))[0]
const databaseOf = (file) => ({ query: async (sql) => [await rowsOf(file, sql)] })
const present = (...files) => files.every((file) => fs.existsSync(path.join(root, file)))

// The saves hold their gas figures under the names the loaders of the planner read (the share of a gas as AtmosGasPercentage), as the saves of the line do and the campaign saves recorded before it do not.
const lineGases = async (...files) => {
  for (const file of files) {
    if (!present(file) || (await firstOf(file, "select count(*) n from pragma_table_info('FCT_AtmosphericGas') where name = 'AtmosGasPercentage'")).n !== 1) {
      return false
    }
  }

  return true
}

const BEFORE_LINE = 'the saves hold their gas figures under the names used before the line, which the loaders of the planner do not read'

const clockOf = (file, game) => firstOf(file, 'select GameTime, LastGrowthTime, TerraformingSpeed from FCT_Game where GameID = ?', game)

// The capacity of one colony in atmospheres of earth equivalent a year, as the game spends it: undamaged modules on the ships assigned to the colony (racial rate, captain bonus, crew share), the installations, and the colony's modifiers.
const capacityOf = async (file, game, population) => {
  const clock = await clockOf(file, game)
  const rate = (await firstOf(file, 'select TerraformingRate from FCT_Race where GameID = ? and RaceID = ?', game, population.RaceID)).TerraformingRate
  const body = await firstOf(file, 'select RadiationLevel, SystemID from FCT_SystemBody where GameID = ? and SystemBodyID = ?', game, population.SystemBodyID)
  const installations = (await firstOf(file, 'select coalesce(sum(i.Amount * d.TerraformValue), 0) n from FCT_PopulationInstallations i join DIM_PlanetaryInstallation d on d.PlanetaryInstallationID = i.PlanetaryInstallationID where i.GameID = ? and i.PopID = ?', game, population.PopulationID)).n
  const governor = await firstOf(file, 'select b.BonusValue v from FCT_Commander c join FCT_CommanderBonuses b on b.CommanderID = c.CommanderID and b.BonusID = 9 where c.GameID = ? and c.CommandType = 3 and c.CommandID = ?', game, population.PopulationID)
  const sector = await firstOf(file, 'select b.BonusValue v from FCT_Commander c join FCT_CommanderBonuses b on b.CommanderID = c.CommanderID and b.BonusID = 9 join FCT_RaceSysSurvey s on s.SectorID = c.CommandID and s.GameID = c.GameID where c.GameID = ? and c.CommandType = 4 and s.SystemID = ? and s.RaceID = ?', game, body.SystemID, population.RaceID)
  const status = await firstOf(file, 'select ProductionMod m from DIM_PopPoliticalStatus where StatusID = ?', population.PoliticalStatus)
  const modifier = (governor ? governor.v : 1) * (sector ? 1 + (sector.v - 1) / 4 : 1) * population.Efficiency * Math.max(0, 1 - (body.RadiationLevel || 0) / 10000) * (1 - Math.min(99, Math.max(0, population.UnrestPoints)) / 100) * (status ? status.m : 1)
  const ships = await rowsOf(file, 'select s.ShipID, s.CurrentCrew, sc.Crew, cc.NumComponent from FCT_Ship s join FCT_ShipClass sc on sc.ShipClassID = s.ShipClassID join FCT_ClassComponent cc on cc.ClassID = sc.ShipClassID and cc.GameID = s.GameID join FCT_ShipDesignComponents d on d.SDComponentID = cc.ComponentID join FCT_Fleet fl on fl.FleetID = s.FleetID where s.GameID = ? and d.ComponentTypeID = 33 and fl.AssignedPopulationID = ?', game, population.PopulationID)
  let orbital = 0
  let modules = 0
  let effective = 0

  for (const ship of ships) {
    const damaged = (await firstOf(file, 'select sum(dc.Number) n from FCT_DamagedComponent dc join FCT_ShipDesignComponents d on d.SDComponentID = dc.ComponentID where dc.ShipID = ? and dc.GameID = ? and d.ComponentTypeID = 33', ship.ShipID, game)).n || 0
    const captain = await firstOf(file, 'select b.BonusValue v from FCT_Commander c join FCT_CommanderBonuses b on b.CommanderID = c.CommanderID where c.GameID = ? and c.CommandType = 1 and c.CommandID = ? and b.BonusID = 9', game, ship.ShipID)
    const crew = ship.Crew > 0 ? Math.min(1, ship.CurrentCrew / ship.Crew) : 1
    const count = ship.NumComponent - damaged

    modules += count
    orbital += count * rate * (captain ? captain.v : 1) * crew
    effective += count * (captain ? captain.v : 1) * crew
  }

  return { total: (rate * Math.trunc(installations) * modifier + orbital) * clock.TerraformingSpeed / 100, modules, installations, modifier, rate, speed: clock.TerraformingSpeed, effective }
}

// The terraforming capacity of every colony of a race under the fleet-at-colony rule the game applies, worked from the save's own rows: the installations and their modifier, and the terraformer modules of the ships in the fleets of the race within one unit of the colony's body on both axes that are assigned to the colony or to none (a fleet assigned to a colony that no longer exists counts as assigned to none), each ship at the share of its class crew aboard and at its captain's Terraforming bonus. The naval admin chain's multiplier is the one factor not re-derived here: it is the app's own chain over the commands `loadNavalAdmins` gives, so a fault confined to the chain is out of this working's reach. Returns `{ colonies, placeless }`: per colony its ships (ShipIDs), installations' output, orbital output and capacity, `ambiguous` (an unassigned fleet the game may give to either of more than one colony, whose term is unavailable) and `unknown` (a figure the save does not hold); `placeless` names the fleets with terraformer modules that have neither a position nor an orbit body, which this working does not settle.
const sharedCapacityOf = async (database, { game, race, chainOf }) => {
  const query = async (sql) => (await database.query(sql))[0]
  const [rateRow] = await query(`select TerraformingRate from FCT_Race where GameID = ${game} and RaceID = ${race}`)
  const [speedRow] = await query(`select TerraformingSpeed from FCT_Game where GameID = ${game}`)
  const rate = rateRow ? rateRow.TerraformingRate : null
  const speed = speedRow ? speedRow.TerraformingSpeed : null
  const colonies = await query(`select FCT_Population.PopulationID, FCT_Population.SystemBodyID, FCT_Population.PoliticalStatus, FCT_Population.Efficiency, FCT_Population.UnrestPoints, FCT_SystemBody.SystemID, FCT_SystemBody.Xcor as BodyX, FCT_SystemBody.Ycor as BodyY, FCT_SystemBody.RadiationLevel from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${game} and FCT_Population.RaceID = ${race}`)
  const fleetRows = await query(`select FCT_Fleet.FleetID, coalesce(FCT_Fleet.AssignedPopulationID, 0) as Assigned, exists (select 1 from FCT_Population VIR_Assigned where VIR_Assigned.PopulationID = FCT_Fleet.AssignedPopulationID) as AssignedExists, FCT_Fleet.OrbitBodyID, FCT_Fleet.Xcor as FleetX, FCT_Fleet.Ycor as FleetY, (select count(*) from FCT_Population VIR_Place inner join FCT_SystemBody VIR_Body on VIR_Body.SystemBodyID = VIR_Place.SystemBodyID where VIR_Place.GameID = ${game} and VIR_Place.RaceID = ${race} and ((FCT_Fleet.Xcor is not null and FCT_Fleet.Ycor is not null and VIR_Body.Xcor is not null and VIR_Body.Ycor is not null and abs(FCT_Fleet.Xcor - VIR_Body.Xcor) < 1 and abs(FCT_Fleet.Ycor - VIR_Body.Ycor) < 1) or ((FCT_Fleet.Xcor is null or FCT_Fleet.Ycor is null or VIR_Body.Xcor is null or VIR_Body.Ycor is null) and FCT_Fleet.OrbitBodyID = VIR_Place.SystemBodyID))) as Places from FCT_Fleet where FCT_Fleet.GameID = ${game} and FCT_Fleet.RaceID = ${race} and exists (select 1 from FCT_Ship VIR_Ship inner join FCT_ClassComponent VIR_Class on VIR_Class.ClassID = VIR_Ship.ShipClassID and VIR_Class.GameID = VIR_Ship.GameID inner join FCT_ShipDesignComponents VIR_Design on VIR_Design.SDComponentID = VIR_Class.ComponentID and VIR_Design.ComponentTypeID = 33 where VIR_Ship.FleetID = FCT_Fleet.FleetID and VIR_Ship.GameID = ${game} and VIR_Ship.RaceID = ${race})`)
  const fleets = new Map(fleetRows.map((row) => [row.FleetID, row]))
  const bonusOf = async (type, command) => (await query(`select max(FCT_CommanderBonuses.BonusValue) as value, count(*) as rows, count(FCT_CommanderBonuses.BonusValue) as known from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.GameID = ${game} and FCT_Commander.CommandType = ${type} and FCT_Commander.CommandID = ${command} and FCT_CommanderBonuses.BonusID = 9`))[0]
  const bonusValue = (row) => (!row || !(row.rows > 0) ? 1 : row.known === row.rows && Number.isFinite(row.value) ? row.value : null)
  const capacity = {}

  for (const colony of colonies) {
    const governor = bonusValue(await bonusOf(3, colony.PopulationID))
    const [association] = await query(`select SectorID from FCT_RaceSysSurvey where GameID = ${game} and RaceID = ${race} and SystemID = ${colony.SystemID}`)
    const sector = !association || association.SectorID === null ? null : association.SectorID === 0 ? 1 : bonusValue(await bonusOf(4, association.SectorID))
    const [status] = await query(`select ProductionMod from DIM_PopPoliticalStatus where StatusID = ${colony.PoliticalStatus}`)
    const [installation] = await query(`select coalesce(sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.TerraformValue), 0) as amount from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${game} and FCT_PopulationInstallations.PopID = ${colony.PopulationID} and DIM_PlanetaryInstallation.TerraformValue > 0`)
    const bodyX = colony.BodyX === null ? 'null' : colony.BodyX
    const bodyY = colony.BodyY === null ? 'null' : colony.BodyY
    const at = `((FCT_Fleet.Xcor is not null and FCT_Fleet.Ycor is not null and ${bodyX} is not null and ${bodyY} is not null and abs(FCT_Fleet.Xcor - ${bodyX}) < 1 and abs(FCT_Fleet.Ycor - ${bodyY}) < 1) or ((FCT_Fleet.Xcor is null or FCT_Fleet.Ycor is null or ${bodyX} is null or ${bodyY} is null) and FCT_Fleet.OrbitBodyID = ${colony.SystemBodyID}))`
    const claim = `(coalesce(FCT_Fleet.AssignedPopulationID, 0) = 0 or not exists (select 1 from FCT_Population VIR_Assigned where VIR_Assigned.PopulationID = FCT_Fleet.AssignedPopulationID) or FCT_Fleet.AssignedPopulationID = ${colony.PopulationID})`
    const lines = await query(`select FCT_Ship.ShipID, FCT_Fleet.FleetID, FCT_Fleet.ParentCommandID, FCT_Fleet.SystemID as FleetSystemID, FCT_ShipClass.Crew as ClassCrew, FCT_Ship.CurrentCrew, FCT_ClassComponent.NumComponent as Designed, (case when FCT_ShipClass.Crew is null then null when FCT_ShipClass.Crew > 0 then min(1.0, max(0, FCT_Ship.CurrentCrew) * 1.0 / FCT_ShipClass.Crew) else 1.0 end) as CrewShare, (select FCT_DamagedComponent.Number from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID order by FCT_DamagedComponent.rowid limit 1) as Damaged, (select count(*) from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID) as DamageRows, max(FCT_CommanderBonuses.BonusValue) as CaptainBonus, count(FCT_CommanderBonuses.BonusValue) as CaptainKnown, count(FCT_CommanderBonuses.CommanderID) as CaptainRows from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and FCT_ClassComponent.GameID = FCT_Ship.GameID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID = 33 inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID left join FCT_Commander on FCT_Commander.GameID = ${game} and FCT_Commander.CommandType = 1 and FCT_Commander.CommandID = FCT_Ship.ShipID left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 9 where FCT_Ship.GameID = ${game} and FCT_Ship.RaceID = ${race} and FCT_Fleet.RaceID = ${race} and ${at} and ${claim} group by FCT_Ship.ShipID, FCT_ClassComponent.ComponentID`)
    const ships = new Map()

    lines.forEach((row) => {
      const ship = ships.get(row.ShipID) || { ShipID: row.ShipID, FleetID: row.FleetID, FleetSystemID: row.FleetSystemID, ParentCommandID: row.ParentCommandID, crew: row.CrewShare, captain: row.CaptainRows > 0 ? (row.CaptainKnown === row.CaptainRows && Number.isFinite(row.CaptainBonus) ? row.CaptainBonus : null) : 1, modules: 0 }

      ship.modules = ship.modules === null || !Number.isFinite(row.Designed) || (row.DamageRows > 0 && !Number.isFinite(row.Damaged)) ? null : ship.modules + Math.max(0, row.Designed - (row.DamageRows > 0 ? row.Damaged : 0))
      ships.set(row.ShipID, ship)
    })

    const modifier = Number.isFinite(governor) && sector !== null && Number.isFinite(colony.Efficiency) && Number.isFinite(colony.UnrestPoints) && Number.isFinite(colony.RadiationLevel) && status && Number.isFinite(status.ProductionMod) ? governor * (1 + (sector - 1) / 4) * colony.Efficiency * Math.max(0, 1 - colony.RadiationLevel / 10000) * (1 - Math.min(99, Math.max(0, colony.UnrestPoints)) / 100) * status.ProductionMod : null
    const counted = [...ships.values()]
    let ambiguous = false
    let unknown = !Number.isFinite(rate) || !Number.isFinite(speed) || (installation.amount > 0 && modifier === null)

    counted.forEach((ship) => {
      const fleet = fleets.get(ship.FleetID)
      const chain = chainOf(ship.FleetSystemID, ship.ParentCommandID)

      ship.chain = chain

      if (!Number.isFinite(ship.modules) || !Number.isFinite(ship.crew) || !Number.isFinite(ship.captain) || !Number.isFinite(chain)) {
        unknown = true
      }

      if ((fleet.Assigned === 0 || !fleet.AssignedExists) && fleet.Places > 1) {
        ambiguous = true
      }
    })

    const installations = installation.amount === 0 ? 0 : rate * Math.trunc(installation.amount) * modifier
    const orbital = rate * counted.reduce((total, ship) => total + (Number.isFinite(ship.modules) && Number.isFinite(ship.crew) && Number.isFinite(ship.captain) && Number.isFinite(ship.chain) ? ship.modules * ship.crew * ship.captain * ship.chain : 0), 0)

    capacity[colony.PopulationID] = { ships: counted.map((ship) => ship.ShipID), installations, orbital, capacity: (installations + orbital) * speed / 100, ambiguous, unknown }
  }

  return { colonies: capacity, placeless: fleetRows.filter((fleet) => !(Number.isFinite(fleet.FleetX) && Number.isFinite(fleet.FleetY)) && !(fleet.OrbitBodyID > 0)).map((fleet) => fleet.FleetID) }
}

const gasOf = async (file, game, body, gas) => {
  const row = await firstOf(file, 'select GasAtm from FCT_AtmosphericGas where GameID = ? and SystemBodyID = ? and AtmosGasID = ?', game, body, gas)

  return row ? row.GasAtm : 0
}

// The change of one gas the capacity at the earlier save predicts for the elapsed growth clock, and the change observed.
const pairOf = async (before, after, game, populationId, clockOfTime = 'LastGrowthTime') => {
  const population = await firstOf(before, 'select * from FCT_Population where GameID = ? and PopulationID = ?', game, populationId)
  const later = await firstOf(after, 'select TerraformStatus, TerraformingGasID from FCT_Population where GameID = ? and PopulationID = ?', game, populationId)
  const body = await firstOf(before, 'select Radius from FCT_SystemBody where GameID = ? and SystemBodyID = ?', game, population.SystemBodyID)
  const years = ((await clockOf(after, game))[clockOfTime] - (await clockOf(before, game))[clockOfTime]) / SECONDS_PER_YEAR
  const capacity = await capacityOf(before, game, population)
  const sign = population.TerraformStatus ? 1 : -1
  const predicted = sign * capacity.total * years * EARTH_ATMOSPHERE_UNITS / (4 * PI * body.Radius ** 2)
  const observed = await gasOf(after, game, population.SystemBodyID, population.TerraformingGasID) - await gasOf(before, game, population.SystemBodyID, population.TerraformingGasID)

  return { same: later.TerraformStatus === population.TerraformStatus && later.TerraformingGasID === population.TerraformingGasID, predicted, observed, ratio: observed / predicted, years, radius: body.Radius, capacity }
}

// Pairs whose order stood and whose target was not reached inside the interval: the observed change is the predicted one to four places. [label, earlier save, later save, game, colony]
const AURELIAN = 'saves/AuroraDB_270_unknown.db'
const EXACT = [
  ['Falryx 2713949950 to 2740177930 Verun III carbon dioxide', falryx(2713949950), falryx(2740177930), 141, 49103],
  ['Falryx 2713949950 to 2740177930 Orso oxygen', falryx(2713949950), falryx(2740177930), 141, 49128],
  ['Falryx 2713949950 to 2740177930 Grassi aestusium', falryx(2713949950), falryx(2740177930), 141, 49284],
  ['Falryx 2713949950 to 2740177930 Bremerhaven aestusium', falryx(2713949950), falryx(2740177930), 141, 49304],
  ['Falryx 2794985390 to 2810693885 Espadon gas 15', falryx(2794985390), falryx(2810693885), 141, 49053],
  ['Falryx 2794985390 to 2810693885 Verun III carbon dioxide', falryx(2794985390), falryx(2810693885), 141, 49103],
  ['Falryx 2794985390 to 2810693885 Orso oxygen', falryx(2794985390), falryx(2810693885), 141, 49128],
  ['Falryx 2794985390 to 2810693885 Guardiola aestusium', falryx(2794985390), falryx(2810693885), 141, 49262],
  ['Falryx 2904201340 to 2930673230 Verun III aestusium', falryx(2904201340), falryx(2930673230), 141, 49103],
  ['Falryx 2904201340 to 2930673230 Orso oxygen', falryx(2904201340), falryx(2930673230), 141, 49128],
  ['Falryx 2904201340 to 2930673230 Guardiola aestusium', falryx(2904201340), falryx(2930673230), 141, 49262],
  ['Falryx 2904201340 to 2930673230 Odesa aestusium', falryx(2904201340), falryx(2930673230), 141, 49326],
]

// Fixtures that need no save, worked by hand from the rule (capacity = (rate x whole installations x modifier + rate x modules at crew and captain share) x speed / 100): so each planted fault in the app's arithmetic is detectable whichever saves are present. 0.001 x 5 x 10 x 1.25 + 0.001 x 5 x 3 = 0.0775; 0.001 x 4 x 0.5 = 0.002.
const ARITHMETIC = [
  { label: 'arithmetic: 10.5 installations at modifier 1.25 and 3 staffed modules, speed 500%', rate: 0.001, speed: 500, installations: 10.5, modifier: 1.25, effective: 3, total: 0.0775, observed: 0.2, radius: 6000 },
  { label: 'arithmetic: 4 installations at modifier 0.5, speed 100%', rate: 0.001, speed: 100, installations: 4, modifier: 0.5, effective: 0, total: 0.002, observed: -0.05, radius: 3000 },
].map((fixture) => ({ ...fixture, years: Math.abs(fixture.observed) * 4 * PI * fixture.radius ** 2 / EARTH_ATMOSPHERE_UNITS / fixture.total }))

// The faults planted in the app's own capacity, years and area arithmetic: each must break the app-output assertions. [label, utility, text, replacement, needs the plans' saves]
const APP_FAULTS = [
  ['halved capacity', 'terraforming', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier * 0.5', false, ['capacity']],
  ['doubled Earth surface area', 'terraforming', 'export const EARTH_SURFACE_AREA = 511187128', 'export const EARTH_SURFACE_AREA = 1022374256', true, ['work']],
  ['years multiplied by the capacity', 'terraforming', 'work / capacity : Infinity', 'work * capacity : Infinity', false, ['years']],
  ['modifier ignored', 'terraforming', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers', false, ['capacity']],
  ['speed ignored', 'terraforming', 'TerraformingRate * (TerraformingSpeed / 100) * terraformers * modifier', 'TerraformingRate * terraformers * modifier', false, ['capacity']],
]
// The app's capacity of each exact pair's colony (installations at the colony's modifier, orbital modules at the crew and captain share), its years for the observed change, and the work of three plans against the rule's independent expectation (the atm to move times the body's area over the Earth's, with the game's 3.1416).
const appOutputs = async (modules, fixtures, plans, only = null) => {
  const { terraforming } = modules

  for (const fixture of fixtures) {
    const race = { TerraformingRate: fixture.rate, TerraformingSpeed: fixture.speed }
    const capacity = terraforming.terraformCapacity(race, Math.trunc(fixture.installations), fixture.modifier) + terraforming.terraformCapacity(race, fixture.effective, 1)

    if (!only || only === 'capacity') {
      assert.ok(Math.abs(capacity / fixture.total - 1) < 1e-9, `${fixture.label}: capacity ${capacity}, rule ${fixture.total}`)
    }

    const years = terraforming.planYears(Math.abs(fixture.observed) * 4 * PI * fixture.radius ** 2 / EARTH_ATMOSPHERE_UNITS, capacity)

    if (!only || only === 'years') {
      assert.ok(Math.abs(years / fixture.years - 1) < 5e-4, `${fixture.label}: years ${years}, observed ${fixture.years}`)
    }
  }

  for (const [file, game, race, populationId] of !only || only === 'work' ? plans : []) {
    const { assessment, body } = await planOf(modules, file, game, race, populationId)
    const area = 4 * PI * body.Radius ** 2 / EARTH_ATMOSPHERE_UNITS
    const expected = assessment.plan.steps.reduce((sum, step) => sum + step.atm * area, 0)

    for (const step of assessment.plan.steps) {
      assert.ok(Math.abs(step.work / (step.atm * area) - 1) < 1e-5, `plan ${populationId} ${step.label}: work ${step.work}, rule ${step.atm * area}`)
    }

    assert.ok(Math.abs(assessment.plan.work / expected - 1) < 1e-5, `plan ${populationId}: work ${assessment.plan.work}, rule ${expected}`)
    assert.ok(Math.abs(assessment.work / expected - 1) < 1e-5, `plan ${populationId}: assessed work ${assessment.work}, rule ${expected}`)

    const capacity = ARITHMETIC[0].total
    const years = modules.terraforming.planYears(assessment.plan.work, capacity)

    assert.ok(Math.abs(years / (expected / capacity) - 1) < 1e-5, `plan ${populationId}: years ${years}, rule ${expected / capacity}`)
  }
}

// Every pair of saves of one campaign whose colonies kept their order across the pair and moved the ordered gas, for every race of the game: [campaign, earlier save, later save, game]. The three short Falryx pairs and Egg's one interval.
const LEDGER_INTERVALS = [
  ['Falryx A', falryx(2713949950), falryx(2740177930), 141],
  ['Falryx B', falryx(2794985390), falryx(2810693885), 141],
  ['Falryx C', falryx(2904201340), falryx(2930673230), 141],
  ['Egg', 'saves/AuroraDBSaveBackup.db', 'saves/AuroraDB.db', 138],
]

const LEDGER_COUNTS = { exact: 12, 'climate: water vapour condenses': 6, 'rate: capacity changed, observed between the two predictions': 10, 'rate: capacity changed, observed outside the two predictions': 3, 'gap: no cause visible at the two saves': 3 }

// The ledger of the replay: one row per colony whose order (direction and gas) stood across the pair and whose gas changed, with the capacity the rule gives at the earlier and at the later save, the change it predicts at the earlier capacity, the change observed and a class.
const ledgerOf = async () => {
  const rows = []

  for (const [campaign, before, after, game] of LEDGER_INTERVALS) {
    const populations = await rowsOf(before, 'select p.PopulationID, p.PopName, p.TerraformStatus, p.TerraformingGasID, g.Name GasName from FCT_Population p join DIM_Gases g on g.GasID = p.TerraformingGasID where p.GameID = ? and p.TerraformingGasID != 0 order by p.PopulationID', game)

    for (const row of populations) {
      const pair = await pairOf(before, after, game, row.PopulationID)

      if (!pair.same || pair.observed === 0) {
        continue
      }

      const laterPopulation = await firstOf(after, 'select * from FCT_Population where GameID = ? and PopulationID = ?', game, row.PopulationID)
      const later = await capacityOf(after, game, laterPopulation)
      const predictedLater = (row.TerraformStatus === 1 ? 1 : -1) * later.total * pair.years * EARTH_ATMOSPHERE_UNITS / (4 * PI * pair.radius ** 2)

      assert.ok(Number.isFinite(pair.predicted) && Number.isFinite(predictedLater), `${row.PopName}: predictions ${pair.predicted} and ${predictedLater} are not finite`)

      const changed = Math.abs(later.total - pair.capacity.total) > 1e-9 * Math.max(1, pair.capacity.total)
      const bracketed = Math.min(pair.predicted, predictedLater) <= pair.observed && pair.observed <= Math.max(pair.predicted, predictedLater)
      const entry = { campaign, population: row.PopulationID, name: row.PopName.replace(/\s+/g, ' ').replace(/\|/g, '/'), gas: row.GasName, gasId: row.TerraformingGasID, adding: row.TerraformStatus === 1, installations: pair.capacity.installations, modules: pair.capacity.modules, modifier: pair.capacity.modifier, rate: pair.capacity.rate, speed: pair.capacity.speed, capacity: pair.capacity.total, laterCapacity: later.total, radius: pair.radius, years: pair.years, predicted: pair.predicted, predictedLater, observed: pair.observed, ratio: pair.ratio, residual: pair.observed - pair.predicted }

      entry.class = Math.abs(pair.ratio - 1) < 0.0005 ? 'exact' : row.TerraformingGasID === 5 ? 'climate: water vapour condenses' : changed ? (bracketed ? 'rate: capacity changed, observed between the two predictions' : 'rate: capacity changed, observed outside the two predictions') : 'gap: no cause visible at the two saves'
      rows.push(entry)
    }
  }

  return rows
}

const printLedger = (ledger) => {
  console.log('| Interval | Colony | Gas | Direction | Installations | Modules | I | Capacity | Capacity later | R km | Years | Predicted | Predicted later | Observed | Ratio | Residual | Class |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')

  for (const row of ledger) {
    console.log(`| ${row.campaign} | ${row.name} ${row.population} | ${row.gas} | ${row.adding ? 'add' : 'remove'} | ${row.installations} | ${row.modules} | ${row.modifier.toPrecision(4)} | ${row.capacity.toPrecision(5)} | ${row.laterCapacity.toPrecision(5)} | ${row.radius} | ${row.years.toPrecision(5)} | ${row.predicted.toPrecision(6)} | ${row.predictedLater.toPrecision(6)} | ${row.observed.toPrecision(6)} | ${row.ratio.toPrecision(5)} | ${row.residual.toExponential(2)} | ${row.class} |`)
  }
}

// The shared breakdown (utilities/terraform-capacity.js) against the rule oracle above. Each entry is a check of its own, `needs` the saves it reads (missing: SKIP), and `run(modules)` throws when the breakdown disagrees; the planted faults below are loaded from a patched source and must fail the checks they name.
const adminOf = (overrides) => ({ NavalAdminCommandID: 1, SystemID: 5, ParentCommandID: 0, BonusValue: 1.2, Share: 0.05, Eligible: true, Unknown: null, Systems: new Set([5]), ...overrides })

const sourcesOf = (modules, file, game, race, blocked) => modules['terraform-capacity'].loadTerraformSources(databaseOf(file), { GameID: game, RaceID: race, blocked })
const adminsOf = (modules, file, game, race) => modules['naval-admins'].loadNavalAdmins(databaseOf(file), { GameID: game, RaceID: race, bonusId: 9, share: 'Industrial' })
const missingOf = (result) => (result.inputs ? result.inputs.missing.join('; ') : '')

// A colony and its race worked by hand: 10.5 installations (10 count) at I = 1.2 x 1.1 x 0.9 x 0.99 x 0.9 x 1 (the sector bonus 1.4 counts a quarter of its excess), 8 modules at half the crew, a captain's 1.1 and the admin chain 1 + (1.2 - 1) x 0.05, rate 0.001, speed 500 %, radius 6000 km.
const handSource = () => ({ installations: 10.5, radius: 6000, modifier: { governor: 1.2, sector: 1.4, efficiency: 0.9, radiation: 100, unrest: 10, status: 1 }, ships: [{ ShipID: 1, PopulationID: 1, ParentCommandID: 1, FleetSystemID: 5, crew: 0.5, captain: 1.1, captained: true, modules: 8 }] })

const handExpected = () => {
  const installations = 0.001 * 10 * (1.2 * 1.1 * 0.9 * 0.99 * 0.9 * 1)
  const orbital = 0.001 * (8 * 0.5 * 1.1) * 1.01
  const capacity = (installations + orbital) * 500 / 100

  return { installations, orbital, capacity, rate: capacity * EARTH_ATMOSPHERE_UNITS / (4 * PI * 6000 ** 2) }
}

const near = (value, expected, tolerance, what) => assert.ok(Number.isFinite(value) && Math.abs(value / expected - 1) < tolerance, `${what}: ${value}, rule ${expected}`)

const FIXTURE_CASE = Object.freeze({ game: FIXTURE.gameId, race: FIXTURE.raceId })
const PLAYED_CASE = Object.freeze({ game: PLAYED.gameId, race: PLAYED.raceId })

// The breakdown's rate on every colony of one save that terraforms, against the oracle's capacity spread over the body.
const rateOnSave = async (modules, file, game, race) => {
  const { terraformBreakdown, hasTerraformers } = modules['terraform-capacity']
  const sources = await sourcesOf(modules, file, game, race)
  const admins = await adminsOf(modules, file, game, race)
  let compared = 0

  for (const source of Object.values(sources.colonies).filter(hasTerraformers)) {
    const population = await firstOf(file, 'select * from FCT_Population where GameID = ? and PopulationID = ?', game, source.PopulationID)
    const oracle = (await capacityOf(file, game, population)).total * EARTH_ATMOSPHERE_UNITS / (4 * PI * source.radius ** 2)
    const { rate } = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source, admins })

    assert.equal(rate.status, 'estimated', `${source.PopName}: ${missingOf(rate)}`)

    if (oracle === 0) {
      assert.equal(rate.value, 0, source.PopName)
    } else {
      near(rate.value, oracle, 1e-9, source.PopName)
    }

    compared += 1
  }

  assert.ok(compared > 0, 'no colony with terraformers')
}

// The app's capacity of every colony of one save against `sharedCapacityOf`: the ships each colony counts, the installations' output, the orbital output and the capacity. A colony whose fleet the save cannot settle must be unavailable there, naming the unsettled place or claim. `database` is the save or an in-memory copy read through its `query`.
const assertSharedRule = async (modules, database, { game, race }, label) => {
  const { loadTerraformSources, terraformBreakdown } = modules['terraform-capacity']
  const sources = await loadTerraformSources(database, { GameID: game, RaceID: race })
  const admins = await modules['naval-admins'].loadNavalAdmins(database, { GameID: game, RaceID: race, bonusId: 9, share: 'Industrial' })
  const expected = await sharedCapacityOf(database, { game, race, chainOf: (system, command) => modules.minerals.navalAdminChain(admins, system, command).bonus })
  const breakdowns = {}
  let compared = 0
  let shipped = 0

  assert.deepEqual(expected.placeless, [], `${label}: a terraformer fleet with neither a position nor an orbit body`)

  for (const source of Object.values(sources.colonies)) {
    const oracle = expected.colonies[source.PopulationID]
    const breakdown = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source, admins })
    const listed = source.ships.map((ship) => ship.ShipID).sort((left, right) => left - right)
    const counted = [...oracle.ships].sort((left, right) => left - right)

    breakdowns[source.PopulationID] = breakdown
    assert.deepEqual(listed, counted, `${label} ${source.PopName}: the ships the colony counts`)
    compared += 1
    shipped += listed.length

    if (oracle.ambiguous) {
      assert.equal(breakdown.orbital.status, 'unavailable', `${label} ${source.PopName}: ${missingOf(breakdown.orbital)}`)
      assert.ok(/which colony of the race/.test(missingOf(breakdown.orbital)), `${label} ${source.PopName}: ${missingOf(breakdown.orbital)}`)
      assert.equal(breakdown.capacity.status, 'unavailable', `${label} ${source.PopName}`)
      continue
    }

    if (oracle.unknown) {
      assert.equal(breakdown.capacity.status, 'unavailable', `${label} ${source.PopName}: ${missingOf(breakdown.capacity)}`)
      continue
    }

    assert.equal(breakdown.capacity.status, 'estimated', `${label} ${source.PopName}: ${missingOf(breakdown.capacity)}`)

    if (oracle.installations === 0) {
      assert.equal(breakdown.installations.value, 0, `${label} ${source.PopName}: installations`)
    } else {
      near(breakdown.installations.value, oracle.installations, 1e-12, `${label} ${source.PopName}: installations`)
    }

    if (oracle.orbital === 0) {
      assert.equal(breakdown.orbital.value, 0, `${label} ${source.PopName}: orbital`)
    } else {
      near(breakdown.orbital.value, oracle.orbital, 1e-12, `${label} ${source.PopName}: orbital`)
    }

    if (oracle.capacity === 0) {
      assert.equal(breakdown.capacity.value, 0, `${label} ${source.PopName}: capacity`)
    } else {
      near(breakdown.capacity.value, oracle.capacity, 1e-12, `${label} ${source.PopName}: capacity`)
    }
  }

  assert.ok(compared > 0, `${label}: no colony compared`)

  return { sources, admins, expected: expected.colonies, breakdowns, compared, shipped }
}

// The change of the ordered gas of each exact pair that starts at `before`, the breakdown's rate at the earlier save times the elapsed years against the observed change.
const pairsFrom = async (modules, before) => {
  const { terraformBreakdown } = modules['terraform-capacity']

  for (const [label, from, after, game, populationId] of EXACT.filter(([, file]) => file === before)) {
    const pair = await pairOf(from, after, game, populationId)
    const population = await firstOf(from, 'select RaceID, TerraformStatus from FCT_Population where GameID = ? and PopulationID = ?', game, populationId)
    const sources = await sourcesOf(modules, from, game, population.RaceID)
    const { rate } = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: sources.colonies[populationId], admins: await adminsOf(modules, from, game, population.RaceID) })

    assert.equal(rate.status, 'estimated', `${label}: ${missingOf(rate)}`)
    assert.ok(Math.abs((population.TerraformStatus ? 1 : -1) * rate.value * pair.years / pair.observed - 1) < 0.0005, `${label}: breakdown ${rate.value * pair.years}, observed ${pair.observed}`)
  }
}

// A copy of a save in memory with `statements` run on it: the loaders read it as they read a save, and the file is never opened for writing.
const mutatedOf = (file, statements) => {
  const database = Database.deserialize(fs.readFileSync(path.join(root, file)))

  statements.forEach((statement) => database.exec(statement))

  return { query: async (sql) => [database.query(sql).all()], close: () => database.close() }
}

// ---- The Environment tab's one-year lines (AE-304-05) ------------------------------------------------------------------
// What the game's Environment tab writes for a colony that terraforms (SystemBody.PopulateAtmosphereListView, SystemBody.cs:4316-4320): "Add Aestusium for one year" as a plus before the change that `method_37` (2079-2100) gives with the colony's yearly pressure on the body added to the greenhouse gas, "Add Frigusium for one year" as the change with a tenth of it added to the greenhouse gas and the whole of it to the anti-greenhouse gas, each against the temperature `method_2` (303-344, with the dampening of `method_1`, 262-301) has just written. Worked here from the saved rows and those methods, never by the app's helper. The base temperature is the game's: 255 / sqrt(distance / sqrt(luminosity)) at the distance now, never under 4 K, and a moon takes its planet's (SystemBody.cs:895, 909-912, 2594-2598).
const TAB_LABELS = { aestusium: 'Add Aestusium for one year', frigusium: 'Add Frigusium for one year' }

// A .NET double written with `#,0.#` (Helpers.smethod_60): the value read at 15 significant digits, rounded half away from zero at one decimal, the thousands set apart, and a negative that rounds to nothing without its sign. Worked on the digits, not on a number.
const tabFigureOf = (value) => {
  const text = Math.abs(value) < 1e-6 ? '0.00000000000000' : Math.abs(value).toPrecision(15)
  const [whole, fraction = ''] = text.split('.')
  const tenths = BigInt(whole + (fraction[0] || '0')) + (fraction[1] >= '5' ? 1n : 0n)
  const digits = tenths.toString().padStart(2, '0')
  const integer = digits.slice(0, -1).replace(/\B(?=(\d{3})+$)/g, ',')
  const unsigned = digits.slice(-1) === '0' ? integer : `${integer}.${digits.slice(-1)}`

  return value < 0 && tenths > 0n ? `-${unsigned}` : unsigned
}

// The rows the tab reads for every body of a game, by body: the climate figures, the planet's orbit for a moon, the star's luminosity, and the pressure of the greenhouse and of the anti-greenhouse gases that are not frozen out (the tab's own sums, taken in the order it lists the gases, the greatest first).
const oneYearRows = async (database, game) => {
  const query = async (sql) => (await database.query(sql))[0]
  const bodies = await query(`select b.SystemBodyID, b.BodyClass, b.Albedo, b.AtmosPress, b.DustLevel, b.HydroExt, b.SurfaceTemp, b.OrbitalDistance, b.DistanceToParent, b.Eccentricity, b.Year, p.OrbitalDistance as ParentOrbitalDistance, p.DistanceToParent as ParentDistanceToParent, p.Eccentricity as ParentEccentricity, p.Year as ParentYear, s.Luminosity from FCT_SystemBody b inner join FCT_Star s on s.StarID = b.StarID left join FCT_SystemBody p on p.SystemBodyID = b.ParentBodyID and b.ParentBodyType = 1 where b.GameID = ${game} and b.BodyClass in (1, 2, 3, 5) and b.BodyTypeID not in (0, 4, 5)`)
  const gases = await query(`select a.SystemBodyID, a.GasAtm, a.FrozenOut, g.GHGas, g.AntiGHGas from FCT_AtmosphericGas a left join DIM_Gases g on g.GasID = a.AtmosGasID where a.GameID = ${game}`)
  const sums = new Map()

  for (const gas of gases.sort((left, right) => right.GasAtm - left.GasAtm)) {
    const sum = sums.get(gas.SystemBodyID) || { greenhouse: 0, anti: 0, frozen: 0 }

    if (gas.FrozenOut) {
      sum.frozen += 1
    } else if (gas.GHGas) {
      sum.greenhouse += gas.GasAtm
    } else if (gas.AntiGHGas) {
      sum.anti += gas.GasAtm
    }

    sums.set(gas.SystemBodyID, sum)
  }

  return new Map(bodies.map((row) => [row.SystemBodyID, { row, ...(sums.get(row.SystemBodyID) || { greenhouse: 0, anti: 0, frozen: 0 }) }]))
}

// The tab's figures for one body at a yearly pressure `yearly` on it (atm): the temperature now, the two estimates and the texts of the two lines, with whether a factor stood at the cap of 3. Null where a figure the tab reads is not in the rows.
const tabOf = ({ row, greenhouse, anti }, yearly) => {
  const moon = row.BodyClass === 2
  const figures = [row.Albedo, row.AtmosPress, row.DustLevel, row.HydroExt, row.OrbitalDistance, row.DistanceToParent, row.Eccentricity, row.Year, row.Luminosity, ...(moon ? [row.ParentOrbitalDistance, row.ParentDistanceToParent, row.ParentEccentricity, row.ParentYear] : [])]

  if (!figures.every(Number.isFinite)) {
    return null
  }

  const distance = moon ? row.ParentOrbitalDistance : row.OrbitalDistance
  const eccentricity = moon ? row.ParentEccentricity : row.Eccentricity
  const year = moon ? row.ParentYear : row.Year
  const dampening = eccentricity === 0 || distance === 0 ? 0 : (Math.min(0.5, row.AtmosPress / 10) + Math.min(0.3, row.HydroExt / 100 * 0.3)) * Math.min(1, 1 / Math.sqrt(year / 8760))
  const factors = (gh, agh) => [Math.min(3, 1 + row.AtmosPress / 10 + gh), Math.min(3, 1 + row.DustLevel / 20000 + agh)]
  const base = Math.max(4, 255 / Math.pow((moon && row.ParentDistanceToParent > 0 ? row.ParentDistanceToParent : row.DistanceToParent) / Math.pow(row.Luminosity, 0.5), 0.5))
  const [now, nowAnti] = factors(greenhouse, anti)
  const circular = 255 / Math.pow(distance / Math.pow(row.Luminosity, 0.5), 0.5) * now * row.Albedo / nowAnti
  const climate = base * now * row.Albedo / nowAnti
  const surface = Math.max(4, dampening <= 0 ? climate : climate * (1 - dampening) + circular * dampening)
  const estimate = (gh, agh) => {
    const [factor, antiFactor] = factors(gh, agh)

    return base * factor * row.Albedo / antiFactor
  }
  const aestusium = estimate(greenhouse + yearly, anti)
  const frigusium = estimate(greenhouse + yearly / 10, anti + yearly)

  return { base, surface, aestusium, frigusium, aestusiumText: `+${tabFigureOf(aestusium - surface)}`, frigusiumText: tabFigureOf(frigusium - surface), capped: now === 3 || nowAnti === 3 }
}

// The app's one-year lines against the tab's. The tab puts a plus before the Aestusium figure whatever its sign ("+-0.4" for a fall); the app writes a plus only before a figure that is not a fall, and nothing else of the line differs.
const assertTab = (found, tab, label) => {
  const close = (value, expected, what) => assert.ok(Math.abs(value - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${label}: ${what} ${value}, tab ${expected}`)

  close(found.current, tab.surface, 'the temperature now')
  assert.equal(found.aestusium.label, TAB_LABELS.aestusium, `${label}: the Aestusium label`)
  assert.equal(found.frigusium.label, TAB_LABELS.frigusium, `${label}: the Frigusium label`)
  close(found.aestusium.temperature, tab.aestusium, 'the Aestusium estimate')
  close(found.frigusium.temperature, tab.frigusium, 'the Frigusium estimate')
  close(found.aestusium.change, tab.aestusium - tab.surface, 'the Aestusium change')
  close(found.frigusium.change, tab.frigusium - tab.surface, 'the Frigusium change')
  assert.equal(found.aestusium.text, tab.aestusiumText.replace('+-', '-'), `${label}: the Aestusium figure`)
  assert.equal(found.frigusium.text, tab.frigusiumText, `${label}: the Frigusium figure`)
}

// A colony's rate on a body (a result of 'production.terraformRate') of a chosen size: one installation worth `yearly` atm on a body with the Earth's surface at the game's speed 100 and no modifier, so that the rate is `yearly` to the last digit but one; null `yearly` is a race with no terraforming rate, so the result is unavailable.
const NEUTRAL_MODIFIER = Object.freeze({ governor: 1, sector: 1, efficiency: 1, radiation: 0, unrest: 0, status: 1 })
const rateOf = (modules, yearly) => modules['terraform-capacity'].terraformBreakdown({ raceRate: yearly, speed: 100, source: { installations: 1, radius: Math.sqrt(EARTH_ATMOSPHERE_UNITS / (4 * PI)), modifier: NEUTRAL_MODIFIER, ships: [], shipsKnown: true }, admins: {} }).rate

const insertGas = (game, body, gas, atm, frozen) => `insert into FCT_AtmosphericGas (GameID, SystemBodyID, AtmosGasID, AtmosGasPercentage, GasAtm, FrozenOut) values (${game}, ${body}, ${gas}, 0, ${atm}, ${frozen})`

const BREAKDOWN_CHECKS = {
  arith: {
    needs: [],
    run: async (modules) => {
      const { terraformBreakdown } = modules['terraform-capacity']
      const expected = handExpected()
      const breakdown = terraformBreakdown({ raceRate: 0.001, speed: 500, source: handSource(), admins: { 1: adminOf() } })

      assert.equal(breakdown.rate.status, 'estimated')
      near(breakdown.installations.value, expected.installations, 1e-12, 'installations')
      near(breakdown.orbital.value, expected.orbital, 1e-12, 'orbital')
      near(breakdown.capacity.value, expected.capacity, 1e-12, 'capacity')
      near(breakdown.rate.value, expected.rate, 1e-12, 'rate')
      assert.deepEqual([breakdown.installations, breakdown.orbital, breakdown.capacity, breakdown.rate].map((result) => result.rule.id), ['terraform.installationOutput', 'terraform.orbitalOutput', 'terraform.capacity', 'production.terraformRate'])
      assert.ok(breakdown.lines.some((line) => line.key === 'admin0' && Math.abs(line.value - 1.01) < 1e-12))
    },
  },
  unknown: {
    needs: [],
    run: async (modules) => {
      const { terraformBreakdown } = modules['terraform-capacity']
      const at = (changes, { raceRate = 0.001, speed = 500, admins = { 1: adminOf() } } = {}) => terraformBreakdown({ raceRate, speed, source: { ...handSource(), ...changes }, admins })
      const ship = (changes) => ({ ...handSource().ships[0], ...changes })
      const unavailable = (breakdown, term, pattern, what) => {
        assert.equal(breakdown[term].status, 'unavailable', what)
        assert.ok(pattern.test(missingOf(breakdown[term])), `${what}: ${missingOf(breakdown[term])}`)
      }

      unavailable(at({ ships: [ship({ crew: null })] }), 'orbital', /crew/, 'unknown crew')
      unavailable(at({ ships: [ship({ modules: null })] }), 'orbital', /modules/, 'unknown modules')
      unavailable(at({ ships: [ship({ captain: null, captained: false })] }), 'orbital', /captain/, 'unknown captain bonus')
      unavailable(at({}, { admins: { 1: adminOf({ BonusValue: null, Unknown: 'FCT_Commander.RankID' }) } }), 'orbital', /RankID/, 'unknown admin chain')
      unavailable(at({ shipsKnown: false, ships: [] }), 'orbital', /assigned to the colony/, 'unknown fleet assignment')
      unavailable(at({ installations: null }), 'installations', /installations/, 'unknown installations')
      unavailable(at({ modifier: { ...handSource().modifier, governor: null } }), 'installations', /governor/, 'unknown governor')
      unavailable(at({ modifier: { ...handSource().modifier, efficiency: null } }), 'installations', /efficiency/, 'unknown efficiency')
      unavailable(at({ modifier: { ...handSource().modifier, unrest: null } }), 'installations', /stability/, 'unknown unrest')
      unavailable(at({ radius: null }), 'rate', /radius/, 'unknown radius')
      unavailable(at({}, { speed: null }), 'capacity', /speed/, 'unknown speed')
      unavailable(at({}, { raceRate: null }), 'installations', /rate/, 'unknown race rate')

      const none = at({ installations: 0, ships: [], modifier: { governor: null, sector: null, efficiency: null, radiation: null, unrest: null, status: null } })

      assert.equal(none.installations.status, 'estimated')
      assert.equal(none.installations.value, 0)
      assert.equal(none.orbital.value, 0)
    },
  },
  'rate Falryx': { needs: [falryx(2904201340)], run: (modules) => rateOnSave(modules, falryx(2904201340), 141, 791) },
  'speed Falryx': {
    needs: [falryx(2904201340)],
    run: async (modules) => {
      const { terraformBreakdown, hasTerraformers } = modules['terraform-capacity']
      const sources = await sourcesOf(modules, falryx(2904201340), 141, 791)
      const admins = await adminsOf(modules, falryx(2904201340), 141, 791)
      let compared = 0

      for (const source of Object.values(sources.colonies).filter(hasTerraformers)) {
        const base = terraformBreakdown({ raceRate: sources.raceRate, speed: 100, source, admins }).capacity.value

        assert.ok(base > 0, `${source.PopName}: capacity at the game speed 100 is ${base}`)

        for (const speed of [50, 300, 500]) {
          near(terraformBreakdown({ raceRate: sources.raceRate, speed, source, admins }).capacity.value, base * speed / 100, 1e-9, `${source.PopName} at the game speed ${speed}`)
        }

        compared += 1
      }

      assert.ok(compared > 0, 'no colony with terraformers')
    },
  },
  'pairs Falryx A': { needs: [falryx(2713949950), falryx(2740177930)], run: (modules) => pairsFrom(modules, falryx(2713949950)) },
  'pairs Falryx B': { needs: [falryx(2794985390), falryx(2810693885)], run: (modules) => pairsFrom(modules, falryx(2794985390)) },
  'pairs Falryx C': { needs: [falryx(2904201340), falryx(2930673230)], run: (modules) => pairsFrom(modules, falryx(2904201340)) },
  truncation: {
    needs: [falryx(2904201340)],
    run: async (modules) => {
      const { colonyModifier, terraformBreakdown } = modules['terraform-capacity']
      const sources = await sourcesOf(modules, falryx(2904201340), 141, 791)

      for (const [id, whole] of [[49045, 6], [49326, 12]]) {
        const source = sources.colonies[id]

        assert.ok(source.installations > whole && source.installations < whole + 1, `${source.PopName}: ${source.installations}`)
        near(terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source }).installations.value, sources.raceRate * whole * colonyModifier(source.modifier).value, 1e-12, source.PopName)
      }
    },
  },
  'bonus value missing: governor and sector': {
    needs: [falryx(2904201340)],
    run: async (modules) => {
      const { loadTerraformSources, terraformBreakdown } = modules['terraform-capacity']
      const copy = mutatedOf(falryx(2904201340), ['update FCT_CommanderBonuses set BonusValue = null where BonusID = 9'])
      const commands = (type) => `select FCT_Commander.CommandID from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 9 where FCT_Commander.GameID = 141 and FCT_Commander.RaceID = 791 and FCT_Commander.CommandType = ${type}`

      try {
        const governors = new Set((await copy.query(commands(3)))[0].map((row) => row.CommandID))
        const sectored = new Set((await copy.query(`select FCT_Population.PopulationID from FCT_Population inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID and FCT_RaceSysSurvey.GameID = FCT_Population.GameID where FCT_Population.GameID = 141 and FCT_Population.RaceID = 791 and FCT_RaceSysSurvey.SectorID in (${commands(4)})`))[0].map((row) => row.PopulationID))
        const sources = await loadTerraformSources(copy, { GameID: 141, RaceID: 791 })
        const colonies = Object.values(sources.colonies)

        assert.ok(governors.size > 0 && sectored.size > 0, 'the save needs governors and a sector commander with a Terraforming bonus')

        for (const colony of colonies) {
          assert.equal(colony.modifier.governor, governors.has(colony.PopulationID) ? null : 1, `${colony.PopName} governor`)
          assert.equal(colony.modifier.sector, sectored.has(colony.PopulationID) ? null : 1, `${colony.PopName} sector`)
        }

        for (const [what, found] of [['governor', colonies.find((colony) => colony.installations > 0 && governors.has(colony.PopulationID))], ['sector', colonies.find((colony) => colony.installations > 0 && sectored.has(colony.PopulationID))]]) {
          assert.ok(found, `a colony with installations and a ${what} row`)

          const breakdown = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: found })

          assert.equal(breakdown.installations.status, 'unavailable', what)
          assert.ok(new RegExp(what).test(missingOf(breakdown.installations)), `${what}: ${missingOf(breakdown.installations)}`)
        }
      } finally {
        copy.close()
      }
    },
  },
  'sector association missing': {
    needs: [falryx(2904201340)],
    run: async (modules) => {
      const { loadTerraformSources, terraformBreakdown } = modules['terraform-capacity']
      const base = await sourcesOf(modules, falryx(2904201340), 141, 791)
      const target = Object.values(base.colonies).find((colony) => colony.installations > 0 && colony.modifier.sector > 1)
      const other = Object.values(base.colonies).find((colony) => colony.SystemID !== target.SystemID && colony.modifier.sector !== null)
      const run = async (statements) => {
        const copy = mutatedOf(falryx(2904201340), statements)

        try {
          return await loadTerraformSources(copy, { GameID: 141, RaceID: 791 })
        } finally {
          copy.close()
        }
      }
      const rateOf = (sources, colony) => terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: sources.colonies[colony.PopulationID] }).installations

      assert.ok(target && other, 'the save needs a colony with a sector bonus above 1 and one elsewhere')

      const lost = await run([`update FCT_RaceSysSurvey set SectorID = null where RaceID = 791 and SystemID = ${target.SystemID}`])

      assert.equal(lost.colonies[target.PopulationID].modifier.sector, null)
      assert.equal(rateOf(lost, target).status, 'unavailable')
      assert.ok(/sector/.test(missingOf(rateOf(lost, target))), missingOf(rateOf(lost, target)))
      assert.equal(lost.colonies[other.PopulationID].modifier.sector, other.modifier.sector)

      const none = await run([`update FCT_RaceSysSurvey set SectorID = 0 where RaceID = 791 and SystemID = ${target.SystemID}`])

      assert.equal(none.colonies[target.PopulationID].modifier.sector, 1)
      assert.equal(rateOf(none, target).status, 'estimated', missingOf(rateOf(none, target)))

      const dropped = await run(['alter table FCT_RaceSysSurvey drop column SectorID'])

      assert.ok(Object.values(dropped.colonies).every((colony) => colony.modifier.sector === null), 'every colony has an unknown sector without the column')
      assert.equal(rateOf(dropped, target).status, 'unavailable')
    },
  },
  'admin bonus missing: terraforming': {
    needs: [AURELIAN],
    run: async (modules) => {
      const { terraformBreakdown } = modules['terraform-capacity']
      const sources = await sourcesOf(modules, AURELIAN, 140, 784)
      const base = await adminsOf(modules, AURELIAN, 140, 784)
      const copy = mutatedOf(AURELIAN, ['update FCT_CommanderBonuses set BonusValue = null where BonusID = 9 and CommanderID in (select CommanderID from FCT_Commander where CommandType = 12)'])

      try {
        const admins = await modules['naval-admins'].loadNavalAdmins(copy, { GameID: 140, RaceID: 784, bonusId: 9, share: 'Industrial' })
        const chained = Object.values(sources.colonies).filter((colony) => terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: colony, admins: base }).lines.some((line) => /^admin/.test(line.key) && line.value !== null && line.value !== 1))

        assert.ok(chained.length > 0, 'the save needs a colony whose orbital output rests on an admin bonus')
        assert.ok(Object.keys(admins).length > 0, 'a map of valueless bonuses is not empty')

        for (const colony of chained) {
          const orbital = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: colony, admins }).orbital

          assert.equal(orbital.status, 'unavailable', colony.PopName)
          assert.ok(/bonus, or the share of its command type/.test(missingOf(orbital)), `${colony.PopName}: ${missingOf(orbital)}`)
        }
      } finally {
        copy.close()
      }
    },
  },
  'admin bonus missing: another consumer': {
    needs: [AURELIAN],
    run: async (modules) => {
      const { loadNavalAdmins } = modules['naval-admins']
      const { navalAdminChain, orbitalChainGap, orbitalMinerRate } = modules.minerals
      const base = await loadNavalAdmins(databaseOf(AURELIAN), { GameID: 140, RaceID: 784, bonusId: 6, share: 'Industrial' })
      const copy = mutatedOf(AURELIAN, ['update FCT_CommanderBonuses set BonusValue = null where BonusID = 6 and CommanderID in (select CommanderID from FCT_Commander where CommandType = 12)'])

      try {
        const admins = await loadNavalAdmins(copy, { GameID: 140, RaceID: 784, bonusId: 6, share: 'Industrial' })
        const found = Object.values(base).flatMap((admin) => [...admin.Systems].map((system) => ({ system, command: admin.NavalAdminCommandID }))).find(({ system, command }) => {
          const chain = navalAdminChain(base, system, command)

          return chain.unknown === null && chain.bonus !== 1
        })

        assert.ok(found, 'the save needs a miner position whose chain rests on a Mining bonus')

        const row = { Diameter: 1, MaximumOrbitalMiningDiameter: 2, SystemID: found.system, NavalAdminCommandID: found.command }

        assert.equal(navalAdminChain(admins, found.system, found.command).bonus, null)
        assert.ok(/bonus, or the share of its command type/.test(orbitalChainGap(row, admins)), String(orbitalChainGap(row, admins)))
        assert.equal(orbitalMinerRate(row, admins), null)
      } finally {
        copy.close()
      }
    },
  },
  'shared rule: fixture': {
    needs: [FIXTURE.file],
    run: (modules) => assertSharedRule(modules, databaseOf(FIXTURE.file), FIXTURE_CASE, 'fixture'),
  },
  'shared rule: played': {
    needs: [PLAYED.file],
    run: (modules) => assertSharedRule(modules, databaseOf(PLAYED.file), PLAYED_CASE, 'played'),
  },
  'planted: an assigned fleet away from its colony counts nothing': {
    needs: [PLAYED.file],
    run: async (modules) => {
      const base = await assertSharedRule(modules, databaseOf(PLAYED.file), PLAYED_CASE, 'played')
      const held = Object.values(base.sources.colonies).find((source) => source.ships.length > 0)

      assert.ok(held && base.breakdowns[held.PopulationID].capacity.value > 0, 'the played save needs a terraformer fleet at its colony')

      const away = mutatedOf(PLAYED.file, [`update FCT_Fleet set Xcor = Xcor + 1000, Ycor = Ycor + 1000 where FleetID = ${held.ships[0].FleetID}`])

      try {
        const planted = await assertSharedRule(modules, away, PLAYED_CASE, 'away')

        assert.deepEqual(planted.sources.colonies[held.PopulationID].ships.map((ship) => ship.ShipID), [], 'the fleet away from its colony counted')
        assert.equal(planted.breakdowns[held.PopulationID].orbital.value, 0, 'the fleet away from its colony')
      } finally {
        away.close()
      }
    },
  },
  'planted: an unassigned fleet at the colony is counted': {
    needs: [PLAYED.file],
    run: async (modules) => {
      const base = await assertSharedRule(modules, databaseOf(PLAYED.file), PLAYED_CASE, 'played')
      const held = Object.values(base.sources.colonies).find((source) => source.ships.length > 0)

      assert.ok(held, 'the played save needs a terraformer fleet at its colony')

      const fleetId = held.ships[0].FleetID
      const ships = held.ships.filter((ship) => ship.FleetID === fleetId).map((ship) => ship.ShipID)
      const free = mutatedOf(PLAYED.file, [`update FCT_Fleet set AssignedPopulationID = 0 where FleetID = ${fleetId}`])

      try {
        const planted = await assertSharedRule(modules, free, PLAYED_CASE, 'unassigned')
        const listed = planted.sources.colonies[held.PopulationID].ships

        assert.deepEqual(listed.map((ship) => ship.ShipID), ships, 'the unassigned fleet at the colony')
        assert.ok(listed.every((ship) => !ship.contested), 'the unassigned fleet is at one colony')
        near(planted.breakdowns[held.PopulationID].capacity.value, base.breakdowns[held.PopulationID].capacity.value, 1e-12, 'the unassigned fleet at the colony')
      } finally {
        free.close()
      }
    },
  },
  'planted: a fleet the game may give to two colonies leaves the term unavailable': {
    needs: [PLAYED.file],
    run: async (modules) => {
      const base = await assertSharedRule(modules, databaseOf(PLAYED.file), PLAYED_CASE, 'played')
      const held = Object.values(base.sources.colonies).find((source) => source.ships.length > 0)
      const other = held ? Object.values(base.sources.colonies).find((source) => source.PopulationID !== held.PopulationID && Number.isFinite(source.Xcor) && Number.isFinite(source.Ycor)) : null

      assert.ok(held && other, 'the played save needs a colony with a terraformer fleet and another colony of the race')

      const fleetId = held.ships[0].FleetID
      const contested = mutatedOf(PLAYED.file, [`update FCT_Fleet set AssignedPopulationID = 0 where FleetID = ${fleetId}`, `update FCT_SystemBody set Xcor = ${held.Xcor}, Ycor = ${held.Ycor} where SystemBodyID = ${other.SystemBodyID}`])

      try {
        const planted = await assertSharedRule(modules, contested, PLAYED_CASE, 'ambiguous')

        for (const source of [held, other]) {
          const breakdown = planted.breakdowns[source.PopulationID]

          assert.equal(breakdown.orbital.status, 'unavailable', `${source.PopName}: ${missingOf(breakdown.orbital)}`)
          assert.ok(/which colony of the race/.test(missingOf(breakdown.orbital)), `${source.PopName}: ${missingOf(breakdown.orbital)}`)
          assert.ok(planted.sources.colonies[source.PopulationID].ships.some((ship) => ship.contested), `${source.PopName}: contested`)
        }
      } finally {
        contested.close()
      }
    },
  },
  'one-year: the played colony against the game\'s Environment tab': {
    needs: [PLAYED.file],
    run: async (modules) => {
      const { hasTerraformers, oneYearEstimate, terraformBreakdown } = modules['terraform-capacity']
      const database = databaseOf(PLAYED.file)
      const sources = await sourcesOf(modules, PLAYED.file, PLAYED_CASE.game, PLAYED_CASE.race)
      const admins = await adminsOf(modules, PLAYED.file, PLAYED_CASE.game, PLAYED_CASE.race)
      const bodies = await modules['colonization-data'].loadBodies(database, { GameID: PLAYED_CASE.game, RaceID: PLAYED_CASE.race })
      const rows = await oneYearRows(database, PLAYED_CASE.game)
      // The capacity is the working of the shared rule (the installations, the fleets at the colony, the modifiers and the game's speed from the save's rows); the naval admin chain's multiplier is the one factor taken from the app, as in that working.
      const expected = await sharedCapacityOf(database, { game: PLAYED_CASE.game, race: PLAYED_CASE.race, chainOf: (system, command) => modules.minerals.navalAdminChain(admins, system, command).bonus })
      let compared = 0

      for (const source of Object.values(sources.colonies).filter(hasTerraformers)) {
        const population = await firstOf(PLAYED.file, 'select * from FCT_Population where GameID = ? and PopulationID = ?', PLAYED_CASE.game, source.PopulationID)
        const { Radius: radius } = await firstOf(PLAYED.file, 'select Radius from FCT_SystemBody where GameID = ? and SystemBodyID = ?', PLAYED_CASE.game, population.SystemBodyID)
        const yearly = expected.colonies[population.PopulationID].capacity * EARTH_ATMOSPHERE_UNITS / (4 * PI * radius ** 2)
        const { rate } = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source, admins })
        const found = oneYearEstimate(bodies.find((row) => row.SystemBodyID === population.SystemBodyID), rate)
        const entry = rows.get(population.SystemBodyID)
        const tab = tabOf(entry, yearly)

        assert.ok(yearly > 0 && found && found.status === 'estimated', `${source.PopName}: ${found ? missingOf(found) : 'no line for a colony that moves pressure'}`)
        near(found.value.rate, yearly, 1e-9, `${source.PopName}: the yearly pressure on the body`)
        assert.ok(Math.abs(tab.surface - entry.row.SurfaceTemp) < 1e-6, `${source.PopName}: the working's temperature now ${tab.surface}, saved ${entry.row.SurfaceTemp}`)
        assertTab(found.value, tab, source.PopName)
        compared += 1
      }

      assert.ok(compared > 0, 'no colony with terraformers')
    },
  },
  'one-year: every body of the two saves': {
    needs: [PLAYED.file, FIXTURE.file],
    run: async (modules) => {
      const { oneYearEstimate } = modules['terraform-capacity']
      const rates = [0.0004, 0.05, 2].map((yearly) => rateOf(modules, yearly))
      const seen = { compared: 0, unavailable: 0, frozen: 0, moons: 0, eccentric: 0, capped: 0, falls: 0 }

      for (const [file, { game, race }] of [[PLAYED.file, PLAYED_CASE], [FIXTURE.file, FIXTURE_CASE]]) {
        const database = databaseOf(file)
        const bodies = await modules['colonization-data'].loadBodies(database, { GameID: game, RaceID: race })
        const rows = await oneYearRows(database, game)

        for (const body of bodies) {
          const entry = rows.get(body.SystemBodyID)

          for (const rate of rates) {
            const found = oneYearEstimate(body, rate)
            const tab = tabOf(entry, rate.value)

            if (!tab) {
              assert.equal(found.status, 'unavailable', `${file} ${body.SystemBodyID}: a figure the tab reads is not in the save`)
              seen.unavailable += 1
              continue
            }

            assert.equal(found.status, 'estimated', `${file} ${body.SystemBodyID}: ${missingOf(found)}`)
            assertTab(found.value, tab, `${file} ${body.SystemBodyID}`)
            seen.compared += 1
            seen.frozen += entry.frozen > 0 ? 1 : 0
            seen.moons += entry.row.BodyClass === 2 ? 1 : 0
            seen.eccentric += (entry.row.BodyClass === 2 ? entry.row.ParentEccentricity : entry.row.Eccentricity) > 0 ? 1 : 0
            seen.capped += tab.capped ? 1 : 0
            seen.falls += found.value.aestusium.text.startsWith('-') ? 1 : 0
          }
        }
      }

      assert.ok(seen.compared > 10000, `${seen.compared} lines compared`)
      assert.ok(seen.frozen > 0 && seen.moons > 0 && seen.eccentric > 0 && seen.capped > 0 && seen.falls > 0, `the saves cover frozen gases, moons, eccentric orbits, the cap of 3 and a fall under Aestusium: ${JSON.stringify(seen)}`)
    },
  },
  'one-year: planted cases': {
    needs: [PLAYED.file],
    run: async (modules) => {
      const { hasTerraformers, oneYearEstimate, terraformBreakdown } = modules['terraform-capacity']
      const sources = await sourcesOf(modules, PLAYED.file, PLAYED_CASE.game, PLAYED_CASE.race)
      const admins = await adminsOf(modules, PLAYED.file, PLAYED_CASE.game, PLAYED_CASE.race)
      const held = Object.values(sources.colonies).find(hasTerraformers)
      const { rate } = terraformBreakdown({ raceRate: sources.raceRate, speed: sources.speed, source: held, admins })
      const { p: parent } = await firstOf(PLAYED.file, 'select ParentBodyID p from FCT_SystemBody where GameID = ? and SystemBodyID = ?', PLAYED_CASE.game, held.SystemBodyID)
      const at = held.SystemBodyID
      const game = PLAYED_CASE.game
      const read = async (statements) => {
        const copy = mutatedOf(PLAYED.file, statements)

        try {
          const body = (await modules['colonization-data'].loadBodies(copy, { GameID: game, RaceID: PLAYED_CASE.race })).find((row) => row.SystemBodyID === at)
          const entry = (await oneYearRows(copy, game)).get(at)
          const tab = tabOf(entry, rate.value)
          const found = oneYearEstimate(body, rate)

          assert.equal(found.status, 'estimated', missingOf(found))
          assertTab(found.value, tab, 'planted')

          return { body, entry, tab, found: found.value }
        } finally {
          copy.close()
        }
      }
      const plain = await read([])

      // The tab sums the gases that are not frozen out: a frozen greenhouse gas moves neither the temperature now nor an estimate.
      const frozen = await read([insertGas(game, at, 20, 0.4, 1)])

      assert.equal(frozen.tab.surface, plain.tab.surface, 'a frozen gas leaves the temperature now')
      assert.equal(frozen.tab.aestusium, plain.tab.aestusium, 'and the Aestusium estimate')
      assert.equal(frozen.found.aestusium.temperature, plain.found.aestusium.temperature)

      // Greenhouse and anti-greenhouse gas past the cap of 3: more gas moves nothing, so the Aestusium estimate is the base temperature times the albedo, and the Frigusium estimate too.
      const capped = await read([insertGas(game, at, 20, 2.5, 0), insertGas(game, at, 22, 2.5, 0)])

      assert.ok(capped.tab.capped, 'both factors stand at the cap')
      assert.ok(Math.abs(capped.found.aestusium.temperature - capped.tab.base * capped.entry.row.Albedo) < 1e-9, 'the capped greenhouse factor against the capped anti-greenhouse factor')
      assert.ok(Math.abs(capped.found.frigusium.temperature - capped.tab.base * capped.entry.row.Albedo) < 1e-9)
      assert.notEqual(capped.found.current, plain.found.current, 'the temperature now follows the gases the save lists, not the temperature it kept')

      // Dust adds to the anti-greenhouse factor.
      const dusty = await read([`update FCT_SystemBody set DustLevel = 6000 where SystemBodyID = ${at}`])

      assert.notEqual(dusty.tab.surface, plain.tab.surface, 'dust cools the body')
      assert.ok(dusty.found.frigusium.temperature < plain.found.frigusium.temperature)

      // A moon takes its planet's orbit: the planet's distance now sets the base temperature, its orbital distance the circular temperature the dampening blends in, and only the temperature now has the blend (the tab's estimates have none).
      const closer = `update FCT_SystemBody set DistanceToParent = 0.5 where SystemBodyID = ${parent}`
      const blended = await read([closer])
      const circular = await read([closer, `update FCT_SystemBody set Eccentricity = 0 where SystemBodyID = ${parent}`])

      assert.notEqual(blended.tab.surface, plain.tab.surface, 'the planet\'s distance now sets the moon\'s base temperature')
      assert.notEqual(blended.tab.surface, circular.tab.surface, 'the planet\'s eccentricity switches the dampening on')
      assert.equal(blended.tab.aestusium, circular.tab.aestusium, 'the estimate has no dampening')
      assert.equal(blended.tab.frigusium, circular.tab.frigusium)

      // No pressure moved: no line. A figure the tab reads missing: unavailable and named, never a default. A rate that is unavailable: the same.
      assert.equal(oneYearEstimate(plain.body, rateOf(modules, 0)), null, 'a colony that moves no pressure has no line')

      for (const [label, body, named] of [['albedo', { ...plain.body, Albedo: null }, 'albedo'], ['base temperature', { ...plain.body, BaseTemp: undefined }, 'base temperature'], ['dust level', { ...plain.body, DustLevel: undefined }, 'dust level']]) {
        const missing = oneYearEstimate(body, rate)

        assert.equal(missing.status, 'unavailable', `a body without its ${label}`)
        assert.ok(missing.inputs.missing.some((text) => text.includes(named)), `names the ${label}: ${missingOf(missing)}`)
      }

      const unknown = oneYearEstimate(plain.body, rateOf(modules, null))

      assert.equal(unknown.status, 'unavailable', 'a colony whose rate is not known')
      assert.ok(/terraforming rate/.test(missingOf(unknown)), missingOf(unknown))
    },
  },
  'planted: an eccentric body with a tolerable mean and an intolerable extreme gets a priced dampening step': {
    needs: [FIXTURE.file],
    run: async (modules) => {
      const data = modules['colonization-data']
      const ask = { GameID: FIXTURE_CASE.game, RaceID: FIXTURE_CASE.race }
      const base = databaseOf(FIXTURE.file)
      const [species] = await data.loadSpecies(base, ask)
      const chosen = (await data.loadBodies(base, ask)).find((row) => row.BodyClass === 1 && !row.OwnPopulations.length && !row.AlienPopulations.length)
      // A planet of the fixture's with the air and the water taken off, on an orbit of eccentricity 0.3 whose present distance gives a base temperature of 250 K, and a species that lives between 258 and 318 K, breathes oxygen at 0.1 to 0.3 atm and bears 4 atm: its mean can be reached with gases, its extremes cannot.
      const distance = Math.sqrt(chosen.StarLuminosity) * (255 / 250) ** 2
      const copy = mutatedOf(FIXTURE.file, [
        `update FCT_SystemBody set Radius = 6371, Gravity = 1, AtmosPress = 0, HydroExt = 0, HydroID = 1, Albedo = 1, DustLevel = 0, TidalLock = 0, Eccentricity = 0.3, OrbitalDistance = ${distance}, DistanceToParent = ${distance}, Year = 8760 where SystemBodyID = ${chosen.SystemBodyID}`,
        `delete from FCT_AtmosphericGas where SystemBodyID = ${chosen.SystemBodyID}`,
        `update FCT_Species set Temperature = 288, TempDev = 30, Oxygen = 0.2, OxyDev = 0.1, PressMax = 4, Gravity = 1, GravDev = 0.5, BreatheID = 10 where SpeciesID = ${species.SpeciesID}`,
      ])

      try {
        const body = (await data.loadBodies(copy, ask)).find((row) => row.SystemBodyID === chosen.SystemBodyID)
        const limits = modules.habitability.speciesLimits((await data.loadSpecies(copy, ask)).find((row) => row.SpeciesID === species.SpeciesID))
        const { ColonizationSkill: skill } = await data.loadRaceRules(copy, ask)
        const gases = Object.fromEntries((await data.loadGases(copy)).map((row) => [row.GasID, { AtmosGasID: row.GasID, AtmosGasName: row.Name, ...row }]))
        const gasInfo = (id) => gases[id]
        const assessment = modules.terraforming.assessTerraforming(body, limits, skill, gasInfo)
        const { plan } = assessment
        const { stages } = modules['terraform-limits'].terraformStages({ assessment, body, species: limits, skill, gasInfo })
        const range = { low: limits.MinimumTemperature, high: limits.MaximumTemperature }

        // The mean is tolerable, and so is the whole orbit once the plan has pulled its lever; the gases alone leave an extreme outside the range.
        assert.equal(body.Eccentricity, 0.3)
        assert.equal(assessment.outcome, 'yes', 'the plan fits the whole orbit')
        assert.ok(plan && !plan.partial, 'no temperature limit is kept')
        assert.deepEqual(assessment.after.raws, { current: 0, periapsis: 0, apoapsis: 0 })
        assert.ok(plan.target.temperature >= range.low && plan.target.temperature <= range.high, 'the mean the plan reaches is in the range')
        assert.ok(stages[0].extremes.apoapsis < range.low, 'the body starts with its cold end under the range')

        const gasesOnly = stages[stages.length - 2]

        assert.ok(gasesOnly.extremes.periapsis > range.high, 'after every gas operation the hot end is still over the range')

        // The dampening step: proposed, named in its step and its stage, with its effect on both extremes, priced like the other steps and carrying the time basis.
        assert.ok(plan.dampening && plan.dampening.levers.length > 0, 'the plan names its levers')

        const lever = plan.steps.find((step) => step.lever)
        const area = 4 * PI * body.Radius ** 2 / EARTH_ATMOSPHERE_UNITS
        const end = stages[stages.length - 1]

        assert.ok(lever && lever.work > 0, 'a step pulls a lever and is work')

        for (const step of plan.steps) {
          assert.ok(Math.abs(step.work / (step.atm * area) - 1) < 1e-5, `${step.label}: work ${step.work}, rule ${step.atm * area}`)
        }

        assert.ok(Math.abs(plan.work / plan.steps.reduce((total, step) => total + step.atm * area, 0) - 1) < 1e-5, 'the plan\'s work is its steps\'')
        assert.equal(stages.find((stage) => stage.step && stage.step.key === lever.key).lever, lever.lever, 'the stage of the step names the lever')
        assert.equal(end.lever, 'water', 'the stage that settles the added vapour names the surface water')
        assert.ok(end.effect.dampening.to > end.effect.dampening.from && end.hydroExt === 100, 'and shows it raise the dampening with the whole surface under water')
        assert.ok(end.extremes.periapsis <= range.high && end.extremes.apoapsis >= range.low, 'both ends of the orbit end in the range')
        assert.ok(stages.every((stage) => stage.step ? stage.timeBasis === 'capacity' : stage.timeBasis === null), 'each operation carries the capacity basis, the end state none')
        assert.equal(end.cost.raw, assessment.after.raw, 'the last stage is the plan\'s cost after terraforming')
      } finally {
        copy.close()
      }
    },
  },
}

// Faults planted in the shared helper. `fails` names the BREAKDOWN_CHECKS each must break; a fault whose named checks all lack their saves is skipped.
const BREAKDOWN_FAULTS = [
  { label: 'the fleet position test dropped', from: 'if (placed ? fleetCountsForColony(fleet, colony) : fleet.RaceID === colony.RaceID && fleetClaimable(fleet, colony)) {', to: 'if (fleet.RaceID === colony.RaceID && fleetClaimable(fleet, colony)) {', fails: ['planted: an assigned fleet away from its colony counts nothing'] },
  { label: 'an unassigned fleet at the colony ignored', from: 'if (placed ? fleetCountsForColony(fleet, colony) : fleet.RaceID === colony.RaceID && fleetClaimable(fleet, colony)) {', to: 'if (fleet.AssignedPopulationID === colony.PopulationID && fleetPlaced(fleet, colony) && fleetCountsForColony(fleet, colony)) {', fails: ['planted: an unassigned fleet at the colony is counted'] },
  { label: 'an ambiguous fleet resolved silently', from: 'contested: reach.length > 1', to: 'contested: false', fails: ['planted: a fleet the game may give to two colonies leaves the term unavailable'] },
  { label: 'installation sum not rounded down', from: 'raceRate * Math.trunc(source.installations) * modifier.value', to: 'raceRate * source.installations * modifier.value', fails: ['arith', 'truncation', 'rate Falryx'] },
  { label: 'Math.PI for the body area', from: 'export const SURFACE_PI = 3.1416', to: 'export const SURFACE_PI = Math.PI', fails: ['arith', 'rate Falryx'] },
  { label: 'game speed ignored', from: '(values.installations + values.orbital) * speed / 100', to: '(values.installations + values.orbital)', fails: ['arith', 'speed Falryx'] },
  { label: 'naval admin chain ignored', from: 'group.admin * group.effective', to: 'group.effective', fails: ['arith'] },
  { label: 'crew share ignored', from: 'modules === null || known(ship.crew) === null ? null : modules * ship.crew', to: 'modules === null ? null : modules', fails: ['arith', 'unknown'] },
  { label: 'unknown crew read as 1', from: 'modules === null || known(ship.crew) === null ? null : modules * ship.crew', to: 'modules === null ? null : modules * (known(ship.crew) ?? 1)', fails: ['unknown'] },
  { label: 'unknown captain bonus read as 1', from: 'staffed === null || known(ship.captain) === null ? null : staffed * ship.captain', to: 'staffed === null ? null : staffed * (known(ship.captain) ?? 1)', fails: ['unknown'] },
  { label: 'unknown fleet assignment read as no ships', from: "source.shipsKnown === false ? ['the fleets assigned to the colony'] : []", to: '[]', fails: ['unknown'] },
  { label: 'the sector bonus counted in full', from: '1 + (modifier.sector - 1) / 4', to: 'modifier.sector', fails: ['arith', 'rate Falryx'] },
  { label: 'a missing captain read as 0', from: ': null) : 1)', to: ': null) : 0)', fails: ['rate Falryx'] },
  { label: 'a present bonus row without a value read as 1 (governor)', from: 'governor: row.BonusUnknown ? null : bonusOf(row.GovernorBonus, row.GovernorRows, row.GovernorKnown)', to: 'governor: row.BonusUnknown ? null : row.GovernorBonus ?? 1', fails: ['bonus value missing: governor and sector'] },
  { label: 'a present bonus row without a value read as 1 (sector)', from: 'sector: row.BonusUnknown || !isNumber(row.SectorID) ? null : row.SectorID === 0 ? 1 : bonusOf(row.SectorBonus, row.SectorRows, row.SectorKnown)', to: 'sector: row.BonusUnknown ? null : row.SectorBonus ?? 1', fails: ['bonus value missing: governor and sector'] },
  { label: 'an unknown sector association read as no sector', from: 'row.BonusUnknown || !isNumber(row.SectorID) ? null : row.SectorID === 0 ? 1 : bonusOf(', to: 'row.BonusUnknown ? null : bonusOf(', fails: ['sector association missing'] },
  { label: 'an explicit no-sector read as unknown', from: 'row.SectorID === 0 ? 1 : bonusOf(', to: 'row.SectorID === 0 ? null : bonusOf(', fails: ['sector association missing'] },
  { module: 'naval-admins', label: 'a naval admin bonus row without a value read as neutral', from: 'admin.BonusRow && !(Number.isFinite(admin.BonusValue) && Number.isFinite(admin.Share)) ? BONUS_UNKNOWN : null', to: 'null', fails: ['admin bonus missing: terraforming', 'admin bonus missing: another consumer'] },
  { module: 'naval-admins', label: 'a naval admin map of valueless bonuses returned empty', from: '(admin.BonusValue && admin.Share) || admin.BonusRow', to: 'admin.BonusValue && admin.Share', fails: ['admin bonus missing: terraforming', 'admin bonus missing: another consumer'] },
  { module: 'minerals', label: 'the chain ignores an unknown command bonus', from: 'if (current.BonusUnknown) {', to: 'if (false) {', fails: ['admin bonus missing: terraforming', 'admin bonus missing: another consumer'] },
  { label: 'Frigusium takes the whole year\'s gas as greenhouse gas', from: 'estimate(greenhouse + yearly / 10, anti + yearly)', to: 'estimate(greenhouse + yearly, anti + yearly)', fails: ['one-year: the played colony against the game\'s Environment tab', 'one-year: every body of the two saves'] },
  { label: 'Frigusium adds only a tenth of the year\'s gas as anti-greenhouse gas', from: 'estimate(greenhouse + yearly / 10, anti + yearly)', to: 'estimate(greenhouse + yearly / 10, anti + yearly / 10)', fails: ['one-year: the played colony against the game\'s Environment tab', 'one-year: every body of the two saves'] },
  { label: 'the anti-greenhouse gas left out of the sums', from: 'const anti = sum(unfrozen.map((gas) => (!gas.GHGas && gas.AntiGHGas ? gas.GasAtm : 0)))', to: 'const anti = 0', fails: ['one-year: planted cases', 'one-year: every body of the two saves'] },
  { label: 'gases frozen out counted', from: 'const unfrozen = (body.Atmosphere || []).filter((gas) => !gas.FrozenOut)', to: 'const unfrozen = body.Atmosphere || []', fails: ['one-year: planted cases', 'one-year: every body of the two saves'] },
  { label: 'dust left out of the anti-greenhouse factor', from: 'const dust = body.DustLevel / 20000', to: 'const dust = 0', fails: ['one-year: planted cases'] },
  { label: 'the cap of 3 dropped from the estimate', from: 'body.BaseTemp * Math.min(3, 1 + body.AtmosPress / 10 + greenhouseGas) * body.Albedo', to: 'body.BaseTemp * (1 + body.AtmosPress / 10 + greenhouseGas) * body.Albedo', fails: ['one-year: planted cases', 'one-year: every body of the two saves'] },
  { label: 'the temperature now taken as saved, not as the tab recomputes it', from: 'const current = surfaceTemperature(body, Math.min(3, 1 + body.AtmosPress / 10 + greenhouse), Math.min(3, 1 + dust + anti))', to: 'const current = body.SurfaceTemp', fails: ['one-year: planted cases'] },
  { label: 'a plus before every Aestusium figure', from: "label === AESTUSIUM && !figure.startsWith('-') ? '+' : ''", to: "label === AESTUSIUM ? '+' : ''", fails: ['one-year: every body of the two saves'] },
  { label: 'the figure floored, not rounded', from: 'Math.round(Number((Math.abs(value) * 10).toPrecision(15))) / 10', to: 'Math.floor(Number((Math.abs(value) * 10).toPrecision(15))) / 10', fails: ['one-year: the played colony against the game\'s Environment tab', 'one-year: every body of the two saves'] },
  { label: 'a colony that moves no pressure gets a line', from: 'if (!(rate.value > 0)) {', to: 'if (false) {', fails: ['one-year: planted cases'] },
  { module: 'terraforming', label: 'no dampening lever is ever pulled', from: 'return plan && plan.partial && reached ? raisedDampening(body, species, gasInfo, plan) || plan : plan', to: 'return plan', fails: ['planted: an eccentric body with a tolerable mean and an intolerable extreme gets a priced dampening step'] },
  { module: 'terraforming', label: 'a lever step is priced at half its atm', from: 'work: (Math.abs(to - from) + off / HYDRO_PER_ATM) * areaRatio })', to: 'work: (Math.abs(to - from) + off / HYDRO_PER_ATM) * areaRatio * (pulled ? 0.5 : 1) })', fails: ['planted: an eccentric body with a tolerable mean and an intolerable extreme gets a priced dampening step'] },
  { module: 'terraforming', label: 'the water step never names its lever', from: 'raisedWater ? LEVER.WATER : null', to: 'null', fails: ['planted: an eccentric body with a tolerable mean and an intolerable extreme gets a priced dampening step'] },
  { module: 'terraform-limits', label: 'the stage that settles the water does not name it', from: 'lever: waterLever ? LEVER.WATER : null', to: 'lever: null', fails: ['planted: an eccentric body with a tolerable mean and an intolerable extreme gets a priced dampening step'] },
]

const climateOf = async (modules, file, game, race) => {
  const bodies = await modules['colonization-data'].loadBodies(databaseOf(file), { GameID: game, RaceID: race })
  const residuals = []

  for (const body of bodies) {
    if (!(body.AtmosPress > 0)) {
      continue
    }

    const listed = body.Atmosphere.filter((gas) => !gas.FrozenOut)
    const greenhouse = Math.min(3, 1 + body.AtmosPress / 10 + listed.reduce((sum, gas) => sum + (gas.GHGas ? gas.GasAtm : 0), 0))
    const anti = Math.min(3, 1 + body.DustLevel / 20000 + listed.reduce((sum, gas) => sum + (gas.AntiGHGas ? gas.GasAtm : 0), 0))

    residuals.push(Math.abs(Math.max(1, body.BaseTemp * greenhouse * body.Albedo / anti) - body.SurfaceTemp))
  }

  return residuals
}

const hiddenOf = async (file, game) => firstOf(file, 'select count(*) n, sum(case when (select coalesce(sum(a.GasAtm), 0) from FCT_AtmosphericGas a where a.GameID = b.GameID and a.SystemBodyID = b.SystemBodyID and a.FrozenOut = 0) < b.AtmosPress - 0.000001 then 1 else 0 end) hidden from FCT_SystemBody b where b.GameID = ? and b.AtmosPress > 0', game)

const planOf = async (modules, file, game, race, populationId) => {
  const { habitability, terraforming } = modules
  const database = databaseOf(file)
  const [bodies, species, rules] = await Promise.all([
    modules['colonization-data'].loadBodies(database, { GameID: game, RaceID: race }),
    modules['colonization-data'].loadSpecies(database, { GameID: game, RaceID: race }),
    modules['colonization-data'].loadRaceRules(database, { GameID: game, RaceID: race }),
  ])
  const population = await firstOf(file, 'select SystemBodyID, SpeciesID from FCT_Population where GameID = ? and PopulationID = ?', game, populationId)
  const limits = habitability.speciesLimits(species.find((row) => row.SpeciesID === population.SpeciesID))
  const body = bodies.find((row) => row.SystemBodyID === population.SystemBodyID)
  const gases = Object.fromEntries((await modules['colonization-data'].loadGases(database)).map((row) => [row.GasID, { AtmosGasID: row.GasID, AtmosGasName: row.Name, ...row }]))
  const skill = (Array.isArray(rules) ? rules[0] : rules).ColonizationSkill
  const assessment = terraforming.assessTerraforming(body, limits, skill, (id) => gases[id])

  return { assessment, body, limits, skill, cost: (state) => habitability.colonyCost(state, limits, skill) }
}

const stepOf = (assessment, label) => assessment.plan.steps.find((step) => step.label === label)

const main = async () => {
  let passed = 0
  let total = 0
  let skipped = 0
  const failures = []

  const check = async (name, test) => {
    total += 1

    try {
      await test()
      passed += 1
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
    }
  }

  const skip = (group, files, reason = '') => {
    skipped += 1

    const missing = files.filter((file) => !present(file))

    console.log(`SKIP ${group}: ${missing.length ? `missing ${missing.join(', ')}` : reason}`)
  }

  const modules = await loadUtilities(['habitability', 'terraforming', 'terraform-limits', 'colonization-data', 'colonization', 'terraform-capacity', 'naval-admins', 'minerals'], { stubs: { 'lodash/groupBy': GROUP_BY } })

  const fixtures = []

  for (const [label, before, after, game, populationId] of EXACT) {
    if (!present(before, after)) {
      skip(`rate ${label}`, [before, after])
      continue
    }

    await check(`rate ${label}`, async () => {
      const pair = await pairOf(before, after, game, populationId)

      assert.ok(pair.same, 'the order changed inside the pair')
      assert.ok(Math.abs(pair.ratio - 1) < 0.0005, `observed ${pair.observed} predicted ${pair.predicted} ratio ${pair.ratio}`)
      fixtures.push({ label, ...pair.capacity, observed: pair.observed, years: pair.years, radius: pair.radius })
    })
  }

  if (present(falryx(2904201340), falryx(2930673230))) {
    await check('rate Verun III residual', async () => {
      const pair = await pairOf(falryx(2904201340), falryx(2930673230), 141, 49103)

      assert.ok(Math.abs(pair.observed - pair.predicted) < 1e-9, `residual ${pair.observed - pair.predicted}`)
    })
    await check('rate the game time as the clock is off by percent', async () => {
      const pair = await pairOf(falryx(2904201340), falryx(2930673230), 141, 49103, 'GameTime')

      assert.ok(pair.predicted / pair.observed > 0.98 && pair.predicted / pair.observed < 0.99, `ratio ${pair.predicted / pair.observed}`)
    })
  }

  const climateCases = [
    ['Egg', 'saves/AuroraDB.db', 138, 785, 127, 0],
    ['Falryx', falryx(2930673230), 141, 791, 206, 3],
  ]
  const hiddenCases = [
    ['Egg later', 'saves/AuroraDB.db', 138, 229, 7],
    ['Egg earlier', 'saves/AuroraDBSaveBackup.db', 138, 125, 17],
    ['Falryx last', falryx(2930673230), 141, 372, 43],
  ]
  const quickRepresentative = falryx(2930673230)

  if (!mutating() && !present(quickRepresentative)) {
    throw new Error(`the required quick climate and hidden representative is not there: ${quickRepresentative}`)
  }

  for (const [label, file, game, race, within, outside] of (mutating() ? climateCases : climateCases.filter(([label]) => label === 'Falryx'))) {
    if (!present(file) || !(await lineGases(file))) {
      skip(`climate ${label}`, [file], BEFORE_LINE)
      continue
    }

    await check(`climate ${label}`, async () => {
      const residuals = await climateOf(modules, file, game, race)

      assert.equal(residuals.filter((value) => value < 0.01).length, within)
      assert.equal(residuals.filter((value) => value >= 0.01).length, outside)
      assert.ok(Math.max(...residuals) < 0.1, `largest ${Math.max(...residuals)}`)
    })
  }

  for (const [label, file, game, bodies, hidden] of (mutating() ? hiddenCases : hiddenCases.filter(([label]) => label === 'Falryx last'))) {
    if (!present(file)) {
      skip(`hidden ${label}`, [file])
      continue
    }

    await check(`hidden ${label}`, async () => {
      const row = await hiddenOf(file, game)

      assert.deepEqual({ n: row.n, hidden: row.hidden }, { n: bodies, hidden })
    })
  }

  if (await lineGases(falryx(2398452450), falryx(2930673230))) {
    const first = falryx(2398452450)
    const last = falryx(2930673230)

    await check('plan Marcellin: the played final atmosphere is the plan', async () => {
      const { assessment, body } = await planOf(modules, first, 141, 791, 49195)
      const final = (await firstOf(last, 'select AtmosPress p from FCT_SystemBody where GameID = 141 and SystemBodyID = ?', body.SystemBodyID)).p
      const played = await gasOf(last, 141, body.SystemBodyID, 22)

      assert.equal(assessment.outcome, 'yes')
      assert.ok(Math.abs(stepOf(assessment, 'Frigusium').to - played) < 0.02, `plan ${stepOf(assessment, 'Frigusium').to} played ${played}`)
      assert.ok(final > 1.9)
    })
    await check('plan Pio: the played colony cost is 0 without the water the plan adds', async () => {
      const { assessment, body, cost } = await planOf(modules, first, 141, 791, 49202)
      const later = (await planOf(modules, last, 141, 791, 49202)).body
      const water = stepOf(assessment, 'Water Vapour')

      assert.ok(water && water.to - water.from > 0.2, 'the plan adds water')
      assert.ok(Math.abs(later.HydroExt - body.HydroExt) < 0.1, 'the played hydrosphere stays')
      assert.equal(cost(later).current, 0)
      assert.equal(cost(later).periapsis, 0)
      assert.equal(cost(later).apoapsis, 0)
    })
    await check('plan Aoede: the bounded search finds a full target and the played colony cost is 0', async () => {
      const { assessment, cost } = await planOf(modules, first, 141, 791, 49227)
      const later = (await planOf(modules, last, 141, 791, 49227)).body

      assert.equal(assessment.outcome, 'yes')
      assert.ok(assessment.plan && !assessment.plan.partial)
      assert.deepEqual(assessment.after.raws, { current: 0, periapsis: 0, apoapsis: 0 }, 'the selected target costs zero at every priced point')
      assert.equal(cost(later).current, 0)
      assert.equal(cost(later).periapsis, 0)
      assert.equal(cost(later).apoapsis, 0)
    })
  } else {
    skip('plan', [falryx(2398452450), falryx(2930673230)], BEFORE_LINE)
  }

  const plans = await lineGases(falryx(2398452450)) ? [[falryx(2398452450), 141, 791, 49195], [falryx(2398452450), 141, 791, 49202], [falryx(2398452450), 141, 791, 49227]] : []
  const appFixtures = [...ARITHMETIC, ...fixtures]

  if (!plans.length) {
    skip('app plan work', [falryx(2398452450)], BEFORE_LINE)
  }

  await check('app capacity, plan years and plan work agree with the rules', async () => appOutputs(modules, appFixtures, plans))

  for (const [label, file, from, to, needsPlans, fails] of mutating() ? APP_FAULTS : []) {
    if (needsPlans && !plans.length) {
      continue
    }

    await check(`app planted fault ${label} is caught`, async () => {
      refusePlanting(label)
      const text = fs.readFileSync(path.join(root, 'src', 'renderer', 'utilities', `${file}.js`), 'utf8')
      const planted = await loadUtilities(['habitability', 'terraforming', 'colonization-data'], { stubs: { 'lodash/groupBy': GROUP_BY }, sources: { [file]: plantedPatch(`${file}.js`, text, from, to) } })
      const results = await runChecks(fails.map((id) => ({ id, name: `app ${id}`, run: () => appOutputs(planted, appFixtures, plans, id) })), {})

      judged(results, label)

      const caught = caughtAll(results, { name: label })

      assert.ok(caught, 'the app-output assertions still pass')
    })
  }

  const breakdownModules = ['habitability', 'terraforming', 'terraform-limits', 'colonization-data', 'terraform-capacity', 'naval-admins', 'minerals']

  for (const [name, { needs, run }] of Object.entries(BREAKDOWN_CHECKS)) {
    if (!present(...needs)) {
      skip(`breakdown ${name}`, needs)
      continue
    }

    await check(`breakdown ${name}`, async () => run(modules))
  }

  for (const { module = 'terraform-capacity', label, from, to, fails } of mutating() ? BREAKDOWN_FAULTS : []) {
    const required = fails.filter((name) => present(...BREAKDOWN_CHECKS[name].needs))

    if (!required.length) {
      skip(`breakdown planted fault ${label}`, fails.flatMap((name) => BREAKDOWN_CHECKS[name].needs))
      continue
    }

    await check(`breakdown planted fault ${label} fails ${required.join(', ')}`, async () => {
      refusePlanting(label)
      const text = fs.readFileSync(path.join(root, 'src', 'renderer', 'utilities', `${module}.js`), 'utf8')
      const planted = await loadUtilities(breakdownModules, { stubs: { 'lodash/groupBy': GROUP_BY }, sources: { [module]: plantedPatch(`${module}.js`, text, from, to) } })

      const results = await runChecks(required.map((id) => ({ id, name: id, run: () => BREAKDOWN_CHECKS[id].run(planted) })), {})

      judged(results, label)
      assert.ok(caughtAll(results, { name: label }), `the named breakdown checks still pass: ${required.join(', ')}`)
    })
  }

  const ledgerFiles = LEDGER_INTERVALS.flatMap(([, before, after]) => [before, after])

  if (present(...ledgerFiles)) {
    await check('ledger covers every moving pair with a class', async () => {
      const ledger = await ledgerOf()
      const counts = ledger.reduce((map, row) => ({ ...map, [row.class]: (map[row.class] || 0) + 1 }), {})

      if (process.argv.includes('--ledger')) {
        printLedger(ledger)
      }

      assert.deepEqual(counts, LEDGER_COUNTS)
      assert.equal(ledger.length, 34)
      assert.equal(ledger.filter((row) => row.class === 'exact').length, EXACT.length)
    })
  } else {
    skip('ledger', ledgerFiles)
  }

  await Promise.allSettled([...handles.values()].map(async (handle) => (await handle).close()))

  for (const failure of failures) {
    console.log(`FAIL ${failure}`)
  }

  console.log(`${passed} of ${total} checks passed${skipped ? ` (${skipped} groups skipped)` : ''}`)
  process.exitCode = passed === total ? 0 : 1
}

main().catch((error) => {
  console.log(error.stack)
  process.exitCode = 1
})
