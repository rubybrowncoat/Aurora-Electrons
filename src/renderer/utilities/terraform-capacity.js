// What a colony's terraforming capacity is made of, and what it moves on its own body: the one calculation behind the Production page's terraforming jobs and the Colonization Planner's body detail. The capacity is the installations' output plus the orbital modules' output, times the game's terraforming speed; the rate is that capacity spread over the body's surface against the Earth's. Each term is a provenance result (utilities/provenance.js): a missing factor leaves the result unavailable, naming it, and is never taken as 1 or 0. Evidence: docs/plans/backlog/evidence/AE-059-01.md and AE-072-01.md.

import { PI_APPROX } from './colonies'
import { fleetClaimable, fleetCountsForColony, fleetPlaced } from './colonization'
import { crewFraction } from './crew'
import { missingBodyInputs, surfaceTemperature } from './habitability'
import { navalAdminChain } from './minerals'
import { combine, ofRule, registerRule, unavailable } from './provenance'

const VERSIONS = ['3.2.x']
const TERRAFORMER_COMPONENT_TYPE = 33
const TERRAFORMING_BONUS = 9
const NONE = new Set()

// The labels of the two lines of the game's Environment tab that estimate a year of the colony's terraforming.
const AESTUSIUM = 'Add Aestusium for one year'
const FRIGUSIUM = 'Add Frigusium for one year'

// The surface of the Earth in the unit the game spreads pressure over. The pi it divides by is the shared 3.1416, not Math.PI: the saved pressure changes of the campaigns match that figure to 1e-15, Math.PI is off by 2.3e-6.
export const EARTH_SURFACE_AREA = 511187128

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const sum = (values) => values.reduce((total, value) => total + value, 0)

registerRule({
  id: 'terraform.installationOutput',
  versions: VERSIONS,
  units: 'atm/yr (Earth-equivalent, before the game speed)',
  verification: 'estimated',
  structure: ['FCT_Race.TerraformingRate', 'FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.TerraformValue', 'FCT_Population.Efficiency, UnrestPoints, PoliticalStatus', 'DIM_PopPoliticalStatus.ProductionMod', 'FCT_SystemBody.RadiationLevel', 'FCT_Commander, FCT_CommanderBonuses (Terraforming)', 'FCT_RaceSysSurvey.SectorID'],
  note: 'The race\'s terraforming rate times the installations\' summed terraform value rounded down to a whole number times the colony\'s modifier: the governor\'s Terraforming bonus, a quarter of the sector commander\'s, the colony\'s efficiency, the radiation and stability factors and the political status\'s production modifier (a missing commander counts as 1; the species and economy modifiers do not apply). The pressure changes of the Falryx and Rin campaigns match this term to four places where nothing changed between two saves; the rounding down is read from the game\'s rules and shows in two colonies with a fractional installation sum.',
  assumptions: ['A colony without a governor or a sector commander has a bonus of 1'],
})

// The game sums the terraformer modules of the fleets of the colony's race within one unit of the colony's body on both axes that are assigned to the colony or to none, and gives an unassigned fleet to the first colony that asks; the same rule the ordnance term and the civilian mining complex exclusion read.
registerRule({
  id: 'terraform.orbitalOutput',
  versions: VERSIONS,
  units: 'atm/yr (Earth-equivalent, before the game speed)',
  verification: 'estimated',
  structure: ['FCT_Race.TerraformingRate', 'FCT_Fleet.RaceID, AssignedPopulationID, OrbitBodyID, Xcor, Ycor, ParentCommandID', 'FCT_Population.RaceID, SystemBodyID', 'FCT_SystemBody.Xcor, Ycor', 'FCT_Ship.CurrentCrew', 'FCT_ShipClass.Crew', 'FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentTypeID', 'FCT_DamagedComponent.Number', 'FCT_Commander, FCT_CommanderBonuses (Terraforming)', 'FCT_NavalAdminCommand'],
  note: 'The race\'s terraforming rate times the undamaged terraforming modules of the ships in the fleets the game counts at the colony, each ship at the share of its class crew aboard and at its captain\'s Terraforming bonus, times the naval admin chain\'s Terraforming bonus at the Industrial share. A fleet counts at the colony when it is of the colony\'s race, within one unit of the colony\'s body on both axes, and assigned to the colony or to none; a fleet assigned to another colony, or assigned to this colony but away from it, adds nothing, and a fleet the game may give to more than one colony leaves the term unavailable. The colony\'s own modifiers do not apply to it. A ship\'s output matches the saved pressure changes of the Rin and Falryx campaigns; damaged modules, a short crew, the admin chain and the fleets away from, unassigned to or shared by a colony are read from the game\'s rules and have no saved case.',
  assumptions: ['A ship without a captain has a bonus of 1', 'A fleet or a colony body with no saved position is matched by the body the fleet orbits'],
})

registerRule({
  id: 'terraform.capacity',
  versions: VERSIONS,
  units: 'atm/yr (Earth-equivalent)',
  verification: 'estimated',
  structure: ['terraform.installationOutput', 'terraform.orbitalOutput', 'FCT_Game.TerraformingSpeed'],
  note: 'The installations\' output plus the orbital modules\' output, times the game\'s terraforming speed (a percentage). The yearly pressure an Earth-sized body would gain; the rate on a body is this spread over its surface.',
})

registerRule({
  id: 'production.terraformRate',
  versions: VERSIONS,
  units: 'atm/yr',
  verification: 'estimated',
  structure: ['terraform.capacity', 'FCT_SystemBody.Radius', 'crew.terraforming'],
  note: `The colony's terraforming capacity spread over its own body: times the Earth's surface of ${EARTH_SURFACE_AREA} over the body's, 4 × ${PI_APPROX} × radius². The pressure of one gas on a body changes by this rate times the years the game's growth clock advanced between two saves; it matched the saved change of a gas to four places on 13 colonies of the Falryx and Rin campaigns where the order and the capacity held between the saves. The rate is not compared with a saved figure of the job.`,
  assumptions: ['The capacity holds over the whole job'],
})

// The game's Environment tab lists "Add Aestusium for one year" and "Add Frigusium for one year" for a colony whose annual terraform capacity is above 0. Its sums are the atm of unfrozen greenhouse gas (G) and the atm of unfrozen anti-greenhouse gas (A) (a gas flagged both counts as greenhouse); the colony's capacity spread over the body (C) is the rate of the rule above; the current surface temperature is recomputed before the lines are taken, and one temperature estimate works each line. Aestusium is the estimate with G raised by C and A as it is, Frigusium the estimate with G raised by a tenth of C and A raised by C, each minus the current surface temperature.
registerRule({
  id: 'terraform.oneYearTemperature',
  versions: ['3.2.x'],
  units: 'K',
  verification: 'estimated',
  structure: ['FCT_SystemBody.BaseTemp, Albedo, AtmosPress, DustLevel, SurfaceTemp, Year, Eccentricity, OrbitalDistance, DistanceToParent', 'FCT_SystemBody.ParentOrbitalDistance, ParentEccentricity, ParentYear', 'FCT_AtmosphericGas.GasAtm, FrozenOut', 'DIM_Gases.GHGas, AntiGHGas', 'production.terraformRate'],
  note: 'The temperature the Environment tab estimates for the body after one year of the colony\'s terraforming with each of two gases, beside the body\'s temperature now: the base temperature times the greenhouse multiplier, times the albedo, over the anti-greenhouse multiplier, each multiplier at most 3, with the year\'s gas added. Aestusium adds the whole of the colony\'s yearly pressure on the body to the greenhouse gas; Frigusium adds a tenth of it to the greenhouse gas and the whole of it to the anti-greenhouse gas. The estimate counts the pressure of the air as it stands and does not apply the dampening of the seasons, so on an eccentric body it stands against the dampened temperature of the body. The change shown is the estimate less the temperature now, which the game recomputes from the unfrozen gases. Worked from the game\'s rules and matched to an independent working of them on a saved terraforming colony; the game does not save the lines, so no saved figure confirms it.',
  assumptions: ['The body\'s base temperature is the one the game works with at the present orbital distance', 'A gas frozen out adds nothing to either sum'],
})

// A commander's bonus row against its value: no row at all is the game's neutral 1 (a missing commander or bonus), a row whose value is missing is unknown (null).
const bonusOf = (value, rows, known) => (isNumber(rows) && rows > 0 ? (known === rows && isNumber(value) ? value : null) : 1)

const columnsOf = async (database, table) => {
  const [rows] = await database.query(`select name from pragma_table_info('${table}')`)

  return new Set(rows.map((row) => row.name))
}

// The select list of `names` from a table aliased `alias`: a column the save lacks is read as null, which means unknown, never 0.
const selectedColumns = (alias, columns, names) => names.map((name) => (columns.has(name) ? `${alias}.${name} as ${name}` : `null as ${name}`)).join(', ')

export const NO_TERRAFORM_SOURCES = Object.freeze({ raceRate: null, speed: null, colonies: Object.freeze({}) })

// What the capacity of the race's colonies is made of, as `{ raceRate, speed, colonies: { [PopulationID]: source } }`: the race's terraforming rate and the game's terraforming speed (a percentage), and for each colony its modifier factors, installation sum and the terraformer ships the game counts at it. A value the save does not hold (a column it lacks, a commander bonus its lookup row does not confirm: `blocked` has the bonus ID) is null, never a default. A colony with neither an installation nor a ship is in the map with 0 installations and no ships. A ship is listed for every colony of the race whose fleet the game counts there (colonization.js `fleetCountsForColony`: the fleet's race, within one unit of the colony's body on both axes, assigned to the colony or to none), and its `unplaced` (the save gives no place for the fleet or the body) and `contested` (the game may give its unassigned fleet to more than one colony) say where the save cannot settle it.
export const loadTerraformSources = async (database, { GameID, RaceID, blocked = NONE }) => {
  const [population, body, survey, fleet, ship, shipClass, status, damaged, bonuses, commanders] = await Promise.all(['FCT_Population', 'FCT_SystemBody', 'FCT_RaceSysSurvey', 'FCT_Fleet', 'FCT_Ship', 'FCT_ShipClass', 'DIM_PopPoliticalStatus', 'FCT_DamagedComponent', 'FCT_CommanderBonuses', 'FCT_Commander'].map((table) => columnsOf(database, table)))
  const [[race]] = await database.query(`select FCT_Race.TerraformingRate, FCT_Game.TerraformingSpeed from FCT_Race inner join FCT_Game on FCT_Game.GameID = FCT_Race.GameID where FCT_Race.GameID = ${GameID} and FCT_Race.RaceID = ${RaceID}`)
  const bonusUnknown = blocked.has(TERRAFORMING_BONUS) || !bonuses.has('BonusValue') || !commanders.has('CommandType')
  const bonusTable = bonusUnknown ? 'select null as CommandType, null as CommandID, null as BonusValue, null as Rows, null as Known where 0' : `select FCT_Commander.CommandType, FCT_Commander.CommandID, max(FCT_CommanderBonuses.BonusValue) as BonusValue, count(*) as Rows, count(FCT_CommanderBonuses.BonusValue) as Known from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.GameID = ${GameID} and FCT_Commander.RaceID = ${RaceID} and FCT_Commander.CommandType in (1, 3, 4) and FCT_CommanderBonuses.BonusID = ${TERRAFORMING_BONUS} group by FCT_Commander.CommandType, FCT_Commander.CommandID`
  const sector = survey.has('SectorID')
  const [colonies, installations, lines] = await Promise.all([
    database.query(`with VIR_Bonuses as materialized (${bonusTable}) select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.SystemBodyID, ${selectedColumns('FCT_SystemBody', body, ['Radius', 'Gravity', 'RadiationLevel', 'Xcor', 'Ycor'])}, ${selectedColumns('FCT_Population', population, ['Efficiency', 'UnrestPoints', 'RaceID'])}, ${status.has('ProductionMod') && population.has('PoliticalStatus') ? 'DIM_PopPoliticalStatus.ProductionMod' : 'null'} as StatusModifier, VIR_Governor.BonusValue as GovernorBonus, VIR_Governor.Rows as GovernorRows, VIR_Governor.Known as GovernorKnown, ${sector ? 'FCT_RaceSysSurvey.SectorID' : 'null'} as SectorID, ${sector ? 'VIR_Sector.BonusValue' : 'null'} as SectorBonus, ${sector ? 'VIR_Sector.Rows' : 'null'} as SectorRows, ${sector ? 'VIR_Sector.Known' : 'null'} as SectorKnown, ${bonusUnknown ? 1 : 0} as BonusUnknown from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join DIM_PopPoliticalStatus on DIM_PopPoliticalStatus.StatusID = FCT_Population.PoliticalStatus left join VIR_Bonuses as VIR_Governor on VIR_Governor.CommandType = 3 and VIR_Governor.CommandID = FCT_Population.PopulationID ${sector ? 'left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID and FCT_RaceSysSurvey.GameID = FCT_Population.GameID left join VIR_Bonuses as VIR_Sector on VIR_Sector.CommandType = 4 and VIR_Sector.CommandID = FCT_RaceSysSurvey.SectorID' : ''} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`).then(([rows]) => rows),
    database.query(`select FCT_PopulationInstallations.PopID as PopulationID, sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.TerraformValue) as Installations, count(*) as Lines, count(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.TerraformValue) as Known from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID inner join FCT_Population on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID where FCT_PopulationInstallations.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and DIM_PlanetaryInstallation.TerraformValue > 0 group by FCT_PopulationInstallations.PopID`).then(([rows]) => rows),
    fleet.has('AssignedPopulationID') ? database.query(`with VIR_Bonuses as materialized (${bonusTable}) select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Fleet.RaceID as FleetRaceID, FCT_Fleet.AssignedPopulationID, exists (select 1 from FCT_Population as VIR_Assigned where VIR_Assigned.PopulationID = FCT_Fleet.AssignedPopulationID) as AssignedExists, ${fleet.has('OrbitBodyID') ? 'FCT_Fleet.OrbitBodyID' : 'null'} as OrbitBodyID, ${fleet.has('Xcor') ? 'FCT_Fleet.Xcor' : 'null'} as Xcor, ${fleet.has('Ycor') ? 'FCT_Fleet.Ycor' : 'null'} as Ycor, ${fleet.has('ParentCommandID') ? 'FCT_Fleet.ParentCommandID' : 'null'} as ParentCommandID, FCT_Fleet.SystemID as FleetSystemID, ${selectedColumns('FCT_Ship', ship, ['CurrentCrew'])}, ${selectedColumns('FCT_ShipClass', shipClass, ['Crew'])}, FCT_ClassComponent.NumComponent as Designed, ${damaged.has('Number') ? '(select FCT_DamagedComponent.Number from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID order by FCT_DamagedComponent.rowid limit 1)' : 'null'} as Damaged, ${damaged.has('Number') ? '(select count(*) from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID)' : 'null'} as DamageRows, ${damaged.has('Number') ? 1 : 0} as DamageKnown, VIR_Captain.BonusValue as CaptainBonus, VIR_Captain.Rows as CaptainRows, VIR_Captain.Known as CaptainKnown, ${bonusUnknown ? 1 : 0} as BonusUnknown from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and FCT_ClassComponent.GameID = FCT_Ship.GameID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID = ${TERRAFORMER_COMPONENT_TYPE} inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID left join VIR_Bonuses as VIR_Captain on VIR_Captain.CommandType = 1 and VIR_Captain.CommandID = FCT_Ship.ShipID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID}`).then(([rows]) => rows) : [],
  ])
  const colonyMap = Object.fromEntries(colonies.map((row) => [row.PopulationID, Object.freeze({
    PopulationID: row.PopulationID,
    PopName: row.PopName,
    SystemID: row.SystemID,
    SystemBodyID: row.SystemBodyID,
    RaceID: row.RaceID,
    Xcor: row.Xcor,
    Ycor: row.Ycor,
    radius: row.Radius,
    gravity: row.Gravity,
    modifier: Object.freeze({ governor: row.BonusUnknown ? null : bonusOf(row.GovernorBonus, row.GovernorRows, row.GovernorKnown), sector: row.BonusUnknown || !isNumber(row.SectorID) ? null : row.SectorID === 0 ? 1 : bonusOf(row.SectorBonus, row.SectorRows, row.SectorKnown), efficiency: row.Efficiency, radiation: row.RadiationLevel, unrest: row.UnrestPoints, status: row.StatusModifier }),
    installations: 0,
    ships: [],
    shipsKnown: fleet.has('AssignedPopulationID'),
  })]))

  installations.forEach((row) => {
    if (colonyMap[row.PopulationID]) {
      colonyMap[row.PopulationID] = Object.freeze({ ...colonyMap[row.PopulationID], installations: row.Known === row.Lines ? row.Installations : null })
    }
  })

  // One row per terraformer line of a ship: the line's designed modules and the damaged ones of the same design. A ship with two lines of the modules adds the lines.
  const shipMap = new Map()
  const fleetOf = new Map()
  const places = colonies.map((row) => ({ PopulationID: row.PopulationID, RaceID: row.RaceID, SystemBodyID: row.SystemBodyID, Xcor: row.Xcor, Ycor: row.Ycor }))

  lines.forEach((row) => {
    const ship = shipMap.get(row.ShipID) || { ShipID: row.ShipID, FleetID: row.FleetID, ParentCommandID: row.ParentCommandID, FleetSystemID: row.FleetSystemID, crew: crewFraction({ CurrentCrew: row.CurrentCrew, ClassCrew: row.Crew }), captain: row.BonusUnknown ? null : bonusOf(row.CaptainBonus, row.CaptainRows, row.CaptainKnown), captained: isNumber(row.CaptainRows) && row.CaptainRows > 0, modules: 0 }

    ship.modules = ship.modules === null || !isNumber(row.Designed) || !row.DamageKnown || (row.DamageRows > 0 && !isNumber(row.Damaged)) ? null : ship.modules + Math.max(0, row.Designed - (row.DamageRows > 0 ? row.Damaged : 0))
    shipMap.set(row.ShipID, ship)
    fleetOf.set(row.ShipID, { RaceID: row.FleetRaceID, AssignedPopulationID: row.AssignedPopulationID, AssignedExists: row.AssignedExists, OrbitBodyID: row.OrbitBodyID, Xcor: row.Xcor, Ycor: row.Ycor })
  })

  // The colonies a ship's fleet counts for: those the game's test says it does (colonization.js `fleetCountsForColony`), and those the save cannot settle (a fleet of the race that the colony may count and whose place is not given). A ship whose unassigned fleet the game may give to more than one colony is marked contested.
  shipMap.forEach((ship) => {
    const fleet = fleetOf.get(ship.ShipID)
    const reach = []

    places.forEach((colony) => {
      const placed = fleetPlaced(fleet, colony)

      if (placed ? fleetCountsForColony(fleet, colony) : fleet.RaceID === colony.RaceID && fleetClaimable(fleet, colony)) {
        reach.push({ colony, unplaced: !placed })
      }
    })

    reach.forEach(({ colony, unplaced }) => {
      const source = colonyMap[colony.PopulationID]

      colonyMap[colony.PopulationID] = Object.freeze({ ...source, ships: [...source.ships, Object.freeze({ ...ship, unplaced, contested: reach.length > 1 })] })
    })
  })

  return Object.freeze({ raceRate: race ? race.TerraformingRate : null, speed: race ? race.TerraformingSpeed : null, colonies: Object.freeze(colonyMap) })
}

const factor = (key, label, value) => ({ key, label, value: isNumber(value) ? value : null })

// The colony's modifier on its installations' output, as its factors and their product (null while one is unknown, with `missing` naming them): governor bonus, a quarter of the sector commander's, efficiency, the radiation factor (1 − radiation/10000, at least 0), the stability factor (1 − unrest/100, unrest held to 0–99) and the political status's production modifier.
export const colonyModifier = (modifier) => {
  const unrest = isNumber(modifier.unrest) ? Math.min(99, Math.max(0, modifier.unrest)) : null
  const factors = [
    factor('governor', 'Governor\'s Terraforming bonus', modifier.governor),
    factor('sector', 'Sector commander\'s bonus, a quarter of its size', isNumber(modifier.sector) ? 1 + (modifier.sector - 1) / 4 : null),
    factor('efficiency', 'Colony efficiency', modifier.efficiency),
    factor('radiation', 'Radiation factor', isNumber(modifier.radiation) ? Math.max(0, 1 - modifier.radiation / 10000) : null),
    factor('stability', 'Stability factor', unrest === null ? null : 1 - unrest / 100),
    factor('status', 'Political status', modifier.status),
  ]
  const missing = factors.filter((item) => item.value === null).map((item) => item.label.toLowerCase())

  return { factors, missing, value: missing.length ? null : factors.reduce((product, item) => product * item.value, 1) }
}

// The ships of one colony grouped by the naval admin command they sit under: { parent, system, ships, modules, staffed, effective, captainless, admin, adminGap }. `modules`: undamaged modules; `staffed`: the modules at the share of the class crew aboard; `effective`: staffed modules at their captains' bonuses. A figure is null while a ship's modules, crew or captain bonus is not in the save; `admin` is the chain's multiplier, null while it is unknown (`adminGap` says why).
const orbitalGroups = (ships, admins) => {
  const groups = new Map()

  ships.forEach((ship) => {
    const key = isNumber(ship.ParentCommandID) ? ship.ParentCommandID : null
    const group = groups.get(key) || { parent: key, system: ship.FleetSystemID, ships: 0, modules: 0, staffed: 0, effective: 0, captainless: 0 }
    const known = (value) => (value === null || !isNumber(value) ? null : value)
    const modules = known(ship.modules)
    const staffed = modules === null || known(ship.crew) === null ? null : modules * ship.crew
    const effective = staffed === null || known(ship.captain) === null ? null : staffed * ship.captain

    group.ships += 1
    group.captainless += ship.captained ? 0 : 1
    group.modules = group.modules === null || modules === null ? null : group.modules + modules
    group.staffed = group.staffed === null || staffed === null ? null : group.staffed + staffed
    group.effective = group.effective === null || effective === null ? null : group.effective + effective
    groups.set(key, group)
  })

  return [...groups.values()].map((group) => {
    if (group.parent === null) {
      return { ...group, admin: null, adminGap: 'the fleet\'s command association' }
    }

    const chain = navalAdminChain(admins, group.system, group.parent)

    return { ...group, admin: chain.bonus, adminGap: chain.unknown || null }
  })
}

const text = (value, places = 4) => (value === null ? 'not known' : `${Number(value.toFixed(places))}`)

// Whether a colony has anything that terraforms, or may have it (its fleet assignments are not in the save): the colonies that get a job and a breakdown.
export const hasTerraformers = (source) => source.installations !== 0 || source.ships.length > 0 || source.shipsKnown === false

// The capacity of one colony on its body, from its `source` (`loadTerraformSources`) and the race's `raceRate` and game `speed` (a percentage): { installations, orbital, capacity, rate } results of 'terraform.installationOutput', 'terraform.orbitalOutput', 'terraform.capacity' (Earth-equivalent atm a year) and 'production.terraformRate' (atm a year on the body), the `scale` of the body's area against the Earth's (null while the radius is unknown), and `lines`, the contributions in the order they multiply: { key, label, value (null while unknown), text }. `admins`: the race's naval admin commands (`loadNavalAdmins`, bonus 9, share 'Industrial'). The same figures give the Production recap's rate and the Planner's explanation.
export const terraformBreakdown = ({ raceRate, speed, source, admins = {} }) => {
  const modifier = colonyModifier(source.modifier)
  const groups = orbitalGroups(source.ships, admins)
  const rateMissing = isNumber(raceRate) ? [] : ['the race\'s terraforming rate']
  const speedMissing = isNumber(speed) ? [] : ['the game\'s terraforming speed']
  const radius = isNumber(source.radius) && source.radius > 0 ? source.radius : null
  const scale = radius === null ? null : EARTH_SURFACE_AREA / (4 * PI_APPROX * radius * radius)

  const installationsMissing = source.installations === 0 ? [] : [...rateMissing, ...(isNumber(source.installations) ? [] : ['the colony\'s terraforming installations']), ...modifier.missing]
  const installations = installationsMissing.length ? unavailable({ rule: 'terraform.installationOutput', missing: installationsMissing }) : ofRule({ rule: 'terraform.installationOutput', value: source.installations === 0 ? 0 : raceRate * Math.trunc(source.installations) * modifier.value, inputs: { present: source.installations === 0 ? ['no installations'] : ['the race\'s terraforming rate', 'the installations', 'the colony\'s modifiers'] } })

  const shipsMissing = source.shipsKnown === false ? ['the fleets assigned to the colony'] : []
  const placementMissing = source.ships.flatMap((ship) => (ship.modules === 0 ? [] : [...(ship.unplaced ? ['where a fleet with terraformer modules is (the save gives no position for the fleet or the colony\'s body, and no body the fleet orbits)'] : []), ...(ship.contested ? ['which colony of the race an unassigned fleet with terraformer modules goes to: it is within one unit of more than one, and the game gives it to the first that asks'] : [])]))
  const orbitalMissing = shipsMissing.length || placementMissing.length ? [...shipsMissing, ...placementMissing] : groups.length === 0 ? [] : [...rateMissing, ...groups.flatMap((group) => [...(group.modules === null ? ['the modules of a terraformer ship (its class components or damage)'] : []), ...(group.staffed === null ? ['the crew of a terraformer ship or its class crew'] : []), ...(group.effective === null ? ['the captain\'s Terraforming bonus of a terraformer ship'] : []), ...(group.admin === null ? [group.adminGap || 'the naval admin chain\'s Terraforming bonus'] : [])])]
  const orbital = orbitalMissing.length ? unavailable({ rule: 'terraform.orbitalOutput', missing: [...new Set(orbitalMissing)] }) : ofRule({ rule: 'terraform.orbitalOutput', value: groups.length === 0 ? 0 : raceRate * sum(groups.map((group) => group.admin * group.effective)), inputs: { present: groups.length === 0 ? ['no terraformer ships'] : ['the race\'s terraforming rate', 'the ships\' undamaged modules, crews and captains', 'the naval admin chain'] }, assumptions: groups.some((group) => group.captainless) ? ['A ship without a captain has a bonus of 1'] : [] })

  const capacity = speedMissing.length ? unavailable({ rule: 'terraform.capacity', missing: speedMissing }) : combine({ rule: 'terraform.capacity', parts: { installations, orbital }, compute: (values) => (values.installations + values.orbital) * speed / 100, inputs: { present: ['the game\'s terraforming speed'] } })
  const rate = scale === null ? unavailable({ rule: 'production.terraformRate', missing: ['the body\'s radius'] }) : combine({ rule: 'production.terraformRate', parts: { capacity }, compute: (values) => values.capacity * scale, inputs: { present: ['the body\'s radius'] } })

  const lines = [{ key: 'rate', label: 'Racial rate', value: isNumber(raceRate) ? raceRate : null, text: `${text(isNumber(raceRate) ? raceRate : null)} atm a year for each installation and module` }]

  if (source.installations !== 0) {
    const whole = isNumber(source.installations) ? Math.trunc(source.installations) : null

    lines.push({ key: 'installations', label: 'Terraforming installations', value: whole, text: whole === null ? 'not known' : whole === source.installations ? `${whole}` : `${whole} (${text(source.installations, 2)} before the game rounds down)` })
    modifier.factors.forEach((item) => lines.push({ key: item.key, label: item.label, value: item.value, text: item.value === null ? 'not known' : `×${text(item.value)}` }))
    lines.push({ key: 'installationOutput', label: 'Installations\' output', value: installations.value, text: `${text(installations.value)} atm a year` })
  }

  groups.forEach((group, index) => {
    const name = groups.length > 1 ? ` (group ${index + 1} of ${groups.length})` : ''

    lines.push(
      { key: `modules${index}`, label: `Undamaged orbital modules${name}`, value: group.modules, text: `${text(group.modules, 0)} on ${group.ships} ${group.ships === 1 ? 'ship' : 'ships'}` },
      { key: `staffed${index}`, label: 'At the crews aboard', value: group.staffed, text: text(group.staffed, 2) },
      { key: `effective${index}`, label: 'With the captains\' bonuses', value: group.effective, text: `${text(group.effective, 2)}${group.captainless ? ` (${group.captainless} without a captain, ×1)` : ''}` },
      { key: `admin${index}`, label: 'Naval admin chain\'s bonus', value: group.admin, text: group.admin === null ? 'not known' : `×${text(group.admin)}` }
    )
  })

  if (groups.length) {
    lines.push({ key: 'orbitalOutput', label: 'Orbital modules\' output', value: orbital.value, text: `${text(orbital.value)} atm a year` })
  }

  lines.push(
    { key: 'speed', label: 'Game speed', value: isNumber(speed) ? speed / 100 : null, text: isNumber(speed) ? `×${text(speed / 100)} (${text(speed, 2)}%)` : 'not known' },
    { key: 'capacity', label: 'Earth-equivalent capacity', value: capacity.value, text: `${text(capacity.value)} atm a year` },
    { key: 'area', label: 'Body area against the Earth\'s', value: scale, text: radius === null ? 'not known' : `×${text(scale)} (radius ${radius} km)` },
    { key: 'result', label: 'Rate on this body', value: rate.value, text: `${text(rate.value)} atm a year` }
  )

  return { installations, orbital, capacity, rate, scale, lines }
}

// The figure the game's tab prints for a temperature change (`#,0.#`): the number read at 15 significant digits, rounded half away from zero to one decimal, thousands set apart by commas, and a negative that rounds to zero without its sign.
const tabFigure = (value) => {
  const rounded = Math.round(Number((Math.abs(value) * 10).toPrecision(15))) / 10
  const text = rounded.toFixed(1).replace(/\.0$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  return value < 0 && rounded > 0 ? `-${text}` : text
}

// What one year of the colony's terraforming does to the temperature of its body by each of the two gases the Environment tab lists, as `{ rate, current, aestusium, frigusium }` of the rule 'terraform.oneYearTemperature': `rate` is the colony's yearly pressure on the body (the result of 'production.terraformRate', `breakdown.rate`), `current` the temperature the tab recomputes for the body now, and each gas `{ label, temperature, change, text }` with the line's label, the estimated temperature, its change from `current` and the change as the tab writes it (the tab puts a plus before the Aestusium figure whatever its sign, which reads "+-0.4" for a fall; here a fall reads "-0.4"). Null where the colony moves no pressure (the tab lists no line), unavailable where the rate or a figure of the body is not in the save, never a default.
export const oneYearEstimate = (body, rate) => {
  if (!rate || rate.status === 'unavailable') {
    return unavailable({ rule: 'terraform.oneYearTemperature', missing: rate && rate.inputs.missing.length ? rate.inputs.missing : ['the colony\'s terraforming rate'] })
  }

  if (!(rate.value > 0)) {
    return null
  }

  const missing = [...missingBodyInputs(body), ...(isNumber(body.DustLevel) ? [] : ['body dust level'])]

  if (missing.length) {
    return unavailable({ rule: 'terraform.oneYearTemperature', missing })
  }

  const unfrozen = (body.Atmosphere || []).filter((gas) => !gas.FrozenOut)
  const greenhouse = sum(unfrozen.map((gas) => (gas.GHGas ? gas.GasAtm : 0)))
  const anti = sum(unfrozen.map((gas) => (!gas.GHGas && gas.AntiGHGas ? gas.GasAtm : 0)))
  const dust = body.DustLevel / 20000
  const current = surfaceTemperature(body, Math.min(3, 1 + body.AtmosPress / 10 + greenhouse), Math.min(3, 1 + dust + anti))
  const estimate = (greenhouseGas, antiGas) => body.BaseTemp * Math.min(3, 1 + body.AtmosPress / 10 + greenhouseGas) * body.Albedo / Math.min(3, 1 + dust + antiGas)
  const line = (label, temperature) => {
    const figure = tabFigure(temperature - current)

    return { label, temperature, change: temperature - current, text: `${label === AESTUSIUM && !figure.startsWith('-') ? '+' : ''}${figure}` }
  }

  return combine({ rule: 'terraform.oneYearTemperature', parts: { rate }, compute: ({ rate: yearly }) => ({ rate: yearly, current, aestusium: line(AESTUSIUM, estimate(greenhouse + yearly, anti)), frigusium: line(FRIGUSIUM, estimate(greenhouse + yearly / 10, anti + yearly)) }), inputs: { present: ['the body\'s climate figures', 'the body\'s gases'] } })
}
