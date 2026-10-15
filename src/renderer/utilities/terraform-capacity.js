// What a colony's terraforming capacity is made of, and what it moves on its own body: the one calculation behind the Production page's terraforming jobs and the Colonization Planner's body detail. The capacity is the installations' output plus the orbital modules' output, times the game's terraforming speed; the rate is that capacity spread over the body's surface against the Earth's. Each term is a provenance result (utilities/provenance.js): a missing factor leaves the result unavailable, naming it, and is never taken as 1 or 0. Evidence: docs/plans/backlog/evidence/AE-059-01.md and AE-072-01.md.

import { crewFraction } from './crew'
import { navalAdminChain } from './minerals'
import { combine, ofRule, registerRule, unavailable } from './provenance'

const VERSIONS = ['2.7.x']
const TERRAFORMER_COMPONENT_TYPE = 33
const TERRAFORMING_BONUS = 9
const NONE = new Set()

// The surface of the Earth in the unit the game spreads pressure over, and the value of pi it divides by (3.1416, not Math.PI: the saved pressure changes of the campaigns match this figure to 1e-15, Math.PI is off by 2.3e-6).
export const EARTH_SURFACE_AREA = 511187128
export const SURFACE_PI = 3.1416

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

registerRule({
  id: 'terraform.orbitalOutput',
  versions: VERSIONS,
  units: 'atm/yr (Earth-equivalent, before the game speed)',
  verification: 'estimated',
  structure: ['FCT_Race.TerraformingRate', 'FCT_Fleet.AssignedPopulationID, ParentCommandID', 'FCT_Ship.CurrentCrew', 'FCT_ShipClass.Crew', 'FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.ComponentTypeID', 'FCT_DamagedComponent.Number', 'FCT_Commander, FCT_CommanderBonuses (Terraforming)', 'FCT_NavalAdminCommand'],
  note: 'The race\'s terraforming rate times the undamaged terraforming modules of the ships assigned to the colony, each ship at the share of its class crew aboard and at its captain\'s Terraforming bonus, times the naval admin chain\'s Terraforming bonus at the Industrial share. The colony\'s own modifiers do not apply to it. A ship\'s output matches the saved pressure changes of the Rin and Falryx campaigns; damaged modules, a short crew and the admin chain are read from the game\'s rules and have no saved case.',
  assumptions: ['A ship without a captain has a bonus of 1', 'A fleet is at the colony it is assigned to'],
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
  note: `The colony's terraforming capacity spread over its own body: times the Earth's surface of ${EARTH_SURFACE_AREA} over the body's, 4 × ${SURFACE_PI} × radius². The pressure of one gas on a body changes by this rate times the years the game's growth clock advanced between two saves; it matched the saved change of a gas to four places on 13 colonies of the Falryx and Rin campaigns where the order and the capacity held between the saves. The rate is not compared with a saved figure of the job.`,
  assumptions: ['The capacity holds over the whole job'],
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

// What the capacity of the race's colonies is made of, as `{ raceRate, speed, colonies: { [PopulationID]: source } }`: the race's terraforming rate and the game's terraforming speed (a percentage), and for each colony its modifier factors, installation sum and the terraformer ships assigned to it. A value the save does not hold (a column it lacks, a commander bonus its lookup row does not confirm: `blocked` has the bonus ID) is null, never a default. A colony with neither an installation nor a ship is in the map with 0 installations and no ships. Fleets are at the colony they are assigned to; the save holds the assignment the game uses.
export const loadTerraformSources = async (database, { GameID, RaceID, blocked = NONE }) => {
  const [population, body, survey, fleet, ship, shipClass, status, damaged, bonuses, commanders] = await Promise.all(['FCT_Population', 'FCT_SystemBody', 'FCT_RaceSysSurvey', 'FCT_Fleet', 'FCT_Ship', 'FCT_ShipClass', 'DIM_PopPoliticalStatus', 'FCT_DamagedComponent', 'FCT_CommanderBonuses', 'FCT_Commander'].map((table) => columnsOf(database, table)))
  const [[race]] = await database.query(`select FCT_Race.TerraformingRate, FCT_Game.TerraformingSpeed from FCT_Race inner join FCT_Game on FCT_Game.GameID = FCT_Race.GameID where FCT_Race.GameID = ${GameID} and FCT_Race.RaceID = ${RaceID}`)
  const bonusUnknown = blocked.has(TERRAFORMING_BONUS) || !bonuses.has('BonusValue') || !commanders.has('CommandType')
  const bonusTable = bonusUnknown ? 'select null as CommandType, null as CommandID, null as BonusValue, null as Rows, null as Known where 0' : `select FCT_Commander.CommandType, FCT_Commander.CommandID, max(FCT_CommanderBonuses.BonusValue) as BonusValue, count(*) as Rows, count(FCT_CommanderBonuses.BonusValue) as Known from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID where FCT_Commander.GameID = ${GameID} and FCT_Commander.RaceID = ${RaceID} and FCT_Commander.CommandType in (1, 3, 4) and FCT_CommanderBonuses.BonusID = ${TERRAFORMING_BONUS} group by FCT_Commander.CommandType, FCT_Commander.CommandID`
  const sector = survey.has('SectorID')
  const [colonies, installations, lines] = await Promise.all([
    database.query(`with VIR_Bonuses as materialized (${bonusTable}) select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.SystemBodyID, ${selectedColumns('FCT_SystemBody', body, ['Radius', 'RadiationLevel'])}, ${selectedColumns('FCT_Population', population, ['Efficiency', 'UnrestPoints'])}, ${status.has('ProductionMod') && population.has('PoliticalStatus') ? 'DIM_PopPoliticalStatus.ProductionMod' : 'null'} as StatusModifier, VIR_Governor.BonusValue as GovernorBonus, VIR_Governor.Rows as GovernorRows, VIR_Governor.Known as GovernorKnown, ${sector ? 'FCT_RaceSysSurvey.SectorID' : 'null'} as SectorID, ${sector ? 'VIR_Sector.BonusValue' : 'null'} as SectorBonus, ${sector ? 'VIR_Sector.Rows' : 'null'} as SectorRows, ${sector ? 'VIR_Sector.Known' : 'null'} as SectorKnown, ${bonusUnknown ? 1 : 0} as BonusUnknown from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join DIM_PopPoliticalStatus on DIM_PopPoliticalStatus.StatusID = FCT_Population.PoliticalStatus left join VIR_Bonuses as VIR_Governor on VIR_Governor.CommandType = 3 and VIR_Governor.CommandID = FCT_Population.PopulationID ${sector ? 'left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID and FCT_RaceSysSurvey.GameID = FCT_Population.GameID left join VIR_Bonuses as VIR_Sector on VIR_Sector.CommandType = 4 and VIR_Sector.CommandID = FCT_RaceSysSurvey.SectorID' : ''} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`).then(([rows]) => rows),
    database.query(`select FCT_PopulationInstallations.PopID as PopulationID, sum(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.TerraformValue) as Installations, count(*) as Lines, count(FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.TerraformValue) as Known from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID inner join FCT_Population on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID where FCT_PopulationInstallations.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and DIM_PlanetaryInstallation.TerraformValue > 0 group by FCT_PopulationInstallations.PopID`).then(([rows]) => rows),
    fleet.has('AssignedPopulationID') ? database.query(`with VIR_Bonuses as materialized (${bonusTable}) select FCT_Ship.ShipID, FCT_Ship.FleetID, FCT_Fleet.AssignedPopulationID as PopulationID, ${fleet.has('ParentCommandID') ? 'FCT_Fleet.ParentCommandID' : 'null'} as ParentCommandID, FCT_Fleet.SystemID as FleetSystemID, ${selectedColumns('FCT_Ship', ship, ['CurrentCrew'])}, ${selectedColumns('FCT_ShipClass', shipClass, ['Crew'])}, FCT_ClassComponent.NumComponent as Designed, ${damaged.has('Number') ? '(select FCT_DamagedComponent.Number from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID order by FCT_DamagedComponent.rowid limit 1)' : 'null'} as Damaged, ${damaged.has('Number') ? '(select count(*) from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID)' : 'null'} as DamageRows, ${damaged.has('Number') ? 1 : 0} as DamageKnown, VIR_Captain.BonusValue as CaptainBonus, VIR_Captain.Rows as CaptainRows, VIR_Captain.Known as CaptainKnown, ${bonusUnknown ? 1 : 0} as BonusUnknown from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID and FCT_ClassComponent.GameID = FCT_Ship.GameID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID = ${TERRAFORMER_COMPONENT_TYPE} inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID left join VIR_Bonuses as VIR_Captain on VIR_Captain.CommandType = 1 and VIR_Captain.CommandID = FCT_Ship.ShipID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Fleet.AssignedPopulationID > 0`).then(([rows]) => rows) : [],
  ])
  const colonyMap = Object.fromEntries(colonies.map((row) => [row.PopulationID, Object.freeze({
    PopulationID: row.PopulationID,
    PopName: row.PopName,
    SystemID: row.SystemID,
    SystemBodyID: row.SystemBodyID,
    radius: row.Radius,
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

  lines.forEach((row) => {
    const ship = shipMap.get(row.ShipID) || { ShipID: row.ShipID, PopulationID: row.PopulationID, ParentCommandID: row.ParentCommandID, FleetSystemID: row.FleetSystemID, crew: crewFraction({ CurrentCrew: row.CurrentCrew, ClassCrew: row.Crew }), captain: row.BonusUnknown ? null : bonusOf(row.CaptainBonus, row.CaptainRows, row.CaptainKnown), captained: isNumber(row.CaptainRows) && row.CaptainRows > 0, modules: 0 }

    ship.modules = ship.modules === null || !isNumber(row.Designed) || !row.DamageKnown || (row.DamageRows > 0 && !isNumber(row.Damaged)) ? null : ship.modules + Math.max(0, row.Designed - (row.DamageRows > 0 ? row.Damaged : 0))
    shipMap.set(row.ShipID, ship)
  })

  shipMap.forEach((ship) => {
    if (colonyMap[ship.PopulationID]) {
      colonyMap[ship.PopulationID] = Object.freeze({ ...colonyMap[ship.PopulationID], ships: [...colonyMap[ship.PopulationID].ships, Object.freeze(ship)] })
    }
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
      return { ...group, admin: null, adminGap: 'the fleet\'s command association (FCT_Fleet.ParentCommandID)' }
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
  const scale = radius === null ? null : EARTH_SURFACE_AREA / (4 * SURFACE_PI * radius * radius)

  const installationsMissing = source.installations === 0 ? [] : [...rateMissing, ...(isNumber(source.installations) ? [] : ['the colony\'s terraforming installations']), ...modifier.missing]
  const installations = installationsMissing.length ? unavailable({ rule: 'terraform.installationOutput', missing: installationsMissing }) : ofRule({ rule: 'terraform.installationOutput', value: source.installations === 0 ? 0 : raceRate * Math.trunc(source.installations) * modifier.value, inputs: { present: source.installations === 0 ? ['no installations'] : ['the race\'s terraforming rate', 'the installations', 'the colony\'s modifiers'] } })

  const shipsMissing = source.shipsKnown === false ? ['the fleets assigned to the colony (FCT_Fleet.AssignedPopulationID)'] : []
  const orbitalMissing = shipsMissing.length ? shipsMissing : groups.length === 0 ? [] : [...rateMissing, ...groups.flatMap((group) => [...(group.modules === null ? ['the modules of a terraformer ship (its class components or damage)'] : []), ...(group.staffed === null ? ['the crew of a terraformer ship or its class crew'] : []), ...(group.effective === null ? ['the captain\'s Terraforming bonus of a terraformer ship'] : []), ...(group.admin === null ? [group.adminGap || 'the naval admin chain\'s Terraforming bonus'] : [])])]
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
