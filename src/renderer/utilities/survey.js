// How fast a survey fleet works and how many points a body takes: the rules behind the Survey Progress page. A fleet's points a day are its undamaged sensors' rating, times the officer factor, the crew morale and the crew aboard, times the naval admin Survey share in range and the game's survey speed. A colony's ground survey is its geosurvey formations' rating times the square of their commanders' effective Survey multiplier, times the survey speed. Evidence and checks against saved progress: docs/plans/backlog/evidence/AE-110-01.md (AE-110-02).

import { crewFraction } from './crew'
import { columnsOf, gaps } from './mine-bootstrap-data'
import { UNVERIFIED_SAVE, envelope, getRule, registerRule, ruleSupports, unavailable } from './provenance'

const HOURS_PER_DAY = 24
// DIM_ComponentType: Gravitational Survey Sensors, Geological Survey Sensors, Bridge and the other control components.
const GRAV_SENSOR = 6
const GEO_SENSOR = 7
const CONTROL = 10
// The baseline Science Department design (FCT_ShipDesignComponents.SDComponentID).
const SCIENCE_DEPARTMENT = 65739
// A class this small (FCT_ShipClass.Size) counts as having a control component when it has none.
const SMALL_CLASS_SIZE = 20
// FCT_CommanderBonuses.BonusID of the Survey bonus.
const SURVEY_BONUS = 2
// FCT_Commander.CommandType of a commander who serves in a ground formation.
const GROUND_POST = 5
const SURVEY_VERSIONS = ['2.7.x']

// The rules this module implements, each registered once with the game versions it holds for and how far it is checked (utilities/provenance.js).
registerRule({
  id: 'survey.officerFactor',
  versions: SURVEY_VERSIONS,
  units: '×',
  verification: 'confirmed',
  structure: ['FCT_Commander.CommandType, CommandID', 'FCT_CommanderBonuses.BonusValue', 'FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentTypeID, ComponentValue', 'FCT_DamagedComponent', 'FCT_ShipClass.Size'],
  note: 'A ship with a captain has the science officer\'s Survey bonus (only while its Science Department is undamaged) times the captain\'s half bonus, 1 + (bonus - 1) / 2 (only while it has an undamaged control component, a class of 20 hull spaces or less counting as having one). A ship without a captain has a factor of 1, whatever other officers it has. The product matched the saved progress of 15 fleets with both officers (median error 0.01%); the maximum of the two bonuses did not (median error 10%). A science officer alone, a damaged Science Department and a damaged control component are by the game\'s rule only: no save has a saved case.',
})

registerRule({
  id: 'survey.geoRate',
  versions: SURVEY_VERSIONS,
  units: 'points/day',
  verification: 'confirmed',
  structure: ['FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentValue', 'FCT_DamagedComponent', 'FCT_Ship.CurrentCrew, CrewMorale', 'FCT_ShipClass.Crew', 'FCT_Commander', 'FCT_CommanderBonuses', 'FCT_Game.SurveySpeed', 'FCT_NavalAdminCommand'],
  note: 'Points a day of the fleet\'s geological sensors: the undamaged sensors\' rating of each ship times the officer factor, the crew morale and the share of crew aboard, summed over the fleet\'s ships (embarked ones too), times the naval admin Survey share and the game\'s survey speed. Within 2% of the saved progress of 9 fleets in saves. A result that takes an embarked ship, a ship without a captain, damage, a short crew or a crew morale under 1 into account rests on the game\'s rule alone and is an estimate.',
  assumptions: ['the naval admin command is effective when its commander\'s rank is high enough'],
})

registerRule({
  id: 'survey.gravRate',
  versions: SURVEY_VERSIONS,
  units: 'points/day',
  verification: 'estimated',
  structure: ['FCT_ClassComponent', 'FCT_ShipDesignComponents.ComponentValue', 'FCT_DamagedComponent', 'FCT_Ship.CurrentCrew, CrewMorale', 'FCT_ShipClass.Crew', 'FCT_Commander', 'FCT_CommanderBonuses', 'FCT_Game.SurveySpeed', 'FCT_NavalAdminCommand'],
  note: 'Points a day of the fleet\'s gravitational sensors, by the same rule as the geological rate. The game keeps a fleet\'s gravitational rate until the save is reloaded and the save does not hold it, so a change of crew, officers or ships since is not seen. Within 5% of the saved progress of 33 of 35 fleets in saves; the largest error was 11.5%.',
  assumptions: ['the naval admin command is effective when its commander\'s rank is high enough'],
})

registerRule({
  id: 'survey.bodyPoints',
  versions: SURVEY_VERSIONS,
  units: 'points',
  verification: 'estimated',
  structure: ['FCT_SystemBody.Radius, BodyTypeID'],
  note: 'A body takes its radius in km over 10 points of geological survey, over 100 for a gas giant or superjovian, and at least 1; the floor applies to each body, so a system\'s points are the sum of the floored bodies. The rule is the game\'s; no save has a body that the floor or the giant divisor changes for the race that was checked.',
})

registerRule({
  id: 'survey.groundRate',
  versions: SURVEY_VERSIONS,
  units: 'points/day',
  verification: 'estimated',
  structure: ['FCT_GroundUnitFormationElement.Units', 'DIM_GroundComponentType.Geosurvey', 'FCT_CommanderBonuses.BonusValue', 'FCT_GroundUnitFormation.ParentFormationID, PopulationID', 'FCT_GroundUnitClass.Size, HQCapacity', 'FCT_Game.SurveySpeed'],
  note: 'Points a day of a colony\'s geosurvey units: the rating of each formation (its units\' equipment rating) times the square of its commander\'s effective Survey multiplier, added over the formations at the colony, times the game\'s survey speed. The game scales the rating by the multiplier when it reads it and again when it adds the day\'s points, so the multiplier counts twice. The multiplier is the commander\'s Survey bonus, cut to 1 + (bonus - 1) × share when the formation and the formations beneath it outgrow its largest headquarters (the share is 1 up to the capacity and 0 beyond it, a whole-number division), times, for each superior formation at the same colony that has a commander, 1 + (the superior\'s bonus - 1) × 0.25 × its share. The capacity cut matches the saved progress of 3 colonies to the second (a formation over its headquarters capacity works at its rating alone, whatever its commander\'s bonus; one colony in a save). The save has no colony that separates the second application of the multiplier from the first (the one colony within capacity fits both), so the rule rests on the game\'s own and is an estimate.',
})

// The points one body takes for a geological or ground survey, as an SQL expression over `alias`, a table with Radius and BodyTypeID. The floor is per body.
export const bodyPointsSql = (alias = 'FCT_SystemBody') => `(case when ${alias}.BodyTypeID in (4, 5) then max(1.0, ${alias}.Radius / 100.0) else max(1.0, ${alias}.Radius / 10.0) end)`

// An SQL condition: the ship in `shipTable` has a geological or gravitational sensor in its class. The class's own GeoSurvey and GravSurvey are whole numbers per sensor line, so a small sensor can leave them at 0.
export const surveyShipSql = (shipTable = 'FCT_Ship') => `exists (select 1 from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.ClassID = ${shipTable}.ShipClassID and FCT_ShipDesignComponents.ComponentTypeID in (${GRAV_SENSOR}, ${GEO_SENSOR}))`

const commanders = (gameId, raceId, commandType) => `select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ${SURVEY_BONUS} where FCT_Commander.GameID = ${gameId} and FCT_Commander.RaceID = ${raceId} and FCT_Commander.CommandType = ${commandType}`

// What each class component line of a ship leaves undamaged: the line's count less the ship's damaged ones (FCT_DamagedComponent, by component design).
const workingLines = (gameId, raceId) => `select FCT_Ship.ShipID, FCT_ClassComponent.ComponentID, FCT_ShipDesignComponents.ComponentTypeID as TypeID, FCT_ShipDesignComponents.ComponentValue as Value, FCT_ClassComponent.NumComponent as Designed, max(FCT_ClassComponent.NumComponent - coalesce((select FCT_DamagedComponent.Number from FCT_DamagedComponent where FCT_DamagedComponent.ShipID = FCT_Ship.ShipID and FCT_DamagedComponent.GameID = FCT_Ship.GameID and FCT_DamagedComponent.ComponentID = FCT_ClassComponent.ComponentID), 0), 0) as Working from FCT_Ship inner join FCT_ClassComponent on FCT_ClassComponent.ClassID = FCT_Ship.ShipClassID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID and FCT_ShipDesignComponents.ComponentTypeID in (${GRAV_SENSOR}, ${GEO_SENSOR}, ${CONTROL}) where FCT_Ship.GameID = ${gameId} and FCT_Ship.RaceID = ${raceId} and FCT_Ship.ShippingLineID = 0`

// What a ship's survey parts add up to: the sensor ratings as designed and undamaged (GeoValue, GravValue), the undamaged control components (ControlValue), the undamaged Science Departments, and how many lines have damage.
const shipParts = (gameId, raceId) => `select VIR_Line.ShipID, sum(case when VIR_Line.TypeID = ${GEO_SENSOR} then VIR_Line.Designed * VIR_Line.Value else 0 end) as GeoDesigned, sum(case when VIR_Line.TypeID = ${GRAV_SENSOR} then VIR_Line.Designed * VIR_Line.Value else 0 end) as GravDesigned, sum(case when VIR_Line.TypeID = ${GEO_SENSOR} then VIR_Line.Working * VIR_Line.Value else 0 end) as GeoValue, sum(case when VIR_Line.TypeID = ${GRAV_SENSOR} then VIR_Line.Working * VIR_Line.Value else 0 end) as GravValue, sum(case when VIR_Line.TypeID = ${CONTROL} then VIR_Line.Working * VIR_Line.Value else 0 end) as ControlValue, sum(case when VIR_Line.ComponentID = ${SCIENCE_DEPARTMENT} then VIR_Line.Working else 0 end) as ScienceDepartments, sum(case when VIR_Line.Working < VIR_Line.Designed then 1 else 0 end) as DamagedLines from (${workingLines(gameId, raceId)}) as VIR_Line group by VIR_Line.ShipID`

// The race's ships with a geological or gravitational sensor, one row each, with what their rate rests on: the fleet (`FleetID`, `SystemID`, `NavalAdminCommandID`), the crew (`CurrentCrew`, `CrewMorale`, `ClassCrew`), the sensors and control parts (`GeoValue` and `GravValue` undamaged, `GeoDesigned` and `GravDesigned` as designed, `ControlValue`, `ScienceDepartments`, `DamagedLines`, `ClassSize`) and the officers (`HasCaptain`, `CaptainBonus`, `HasScienceOfficer`, `ScienceBonus`, a bonus null when the officer has no Survey bonus). Ships of a shipping line are left out.
export const loadSurveyShips = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(`select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.SystemID, FCT_RaceSysSurvey.Name as SystemName, FCT_Fleet.ParentCommandID as NavalAdminCommandID, case when FCT_Fleet.Xcor <> FCT_Fleet.LastXcor or FCT_Fleet.Ycor <> FCT_Fleet.LastYcor then 1 else 0 end as Moving, FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.MothershipID, FCT_Ship.CurrentCrew, FCT_Ship.CrewMorale, FCT_ShipClass.Crew as ClassCrew, FCT_ShipClass.Size as ClassSize, VIR_Parts.GeoValue, VIR_Parts.GravValue, VIR_Parts.GeoDesigned, VIR_Parts.GravDesigned, VIR_Parts.ControlValue, VIR_Parts.ScienceDepartments, VIR_Parts.DamagedLines, case when VIR_Captain.CommandID is null then 0 else 1 end as HasCaptain, VIR_Captain.BonusValue as CaptainBonus, case when VIR_Science.CommandID is null then 0 else 1 end as HasScienceOfficer, VIR_Science.BonusValue as ScienceBonus from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID inner join (${shipParts(GameID, RaceID)}) as VIR_Parts on VIR_Parts.ShipID = FCT_Ship.ShipID and (VIR_Parts.GeoDesigned > 0 or VIR_Parts.GravDesigned > 0) left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Fleet.RaceID and FCT_RaceSysSurvey.GameID = FCT_Fleet.GameID left join (${commanders(GameID, RaceID, 1)}) as VIR_Captain on VIR_Captain.CommandID = FCT_Ship.ShipID left join (${commanders(GameID, RaceID, 10)}) as VIR_Science on VIR_Science.CommandID = FCT_Ship.ShipID where FCT_Ship.GameID = ${GameID} and FCT_Ship.RaceID = ${RaceID} and FCT_Ship.ShippingLineID = 0`)

  return rows
}

// The officer factor of a ship's survey rate. A ship with no captain has 1, whatever else it has. With one, the factor is the science officer's Survey bonus (only with an undamaged Science Department) times half the captain's (only with an undamaged control component; a bonus an officer lacks is 1). `ship`: { HasCaptain, CaptainBonus, HasScienceOfficer, ScienceBonus, ScienceDepartments, ControlValue, ClassSize }.
export const officerFactor = (ship) => {
  if (!ship.HasCaptain) {
    return 1
  }

  const science = ship.HasScienceOfficer && ship.ScienceDepartments > 0 ? ship.ScienceBonus ?? 1 : 1
  const controls = Math.trunc(ship.ControlValue) || (ship.ClassSize <= SMALL_CLASS_SIZE ? 1 : 0)
  const captain = controls > 0 ? 1 + ((ship.CaptainBonus ?? 1) - 1) / 2 : 1

  return science * captain
}

const isShort = (ship) => crewFraction(ship) < 1

// The sensor rating a ship adds before the fleet's crew factor: the undamaged sensors' rating times the officer factor and the crew morale and the crew share.
const shipRating = (ship, value) => value * officerFactor(ship) * ship.CrewMorale * crewFraction(ship)

// The fleet's total, adding the ships in the order given. The game also applies a short-crewed ship's crew share to the running total once it has added that ship, so a short crew counts twice, and in a fleet of several ships the result depends on the order.
const fleetTotal = (ships, value) => ships.reduce((total, ship) => {
  const added = total + shipRating(ship, ship[value])

  return isShort(ship) ? added * crewFraction(ship) : added
}, 0)

const weight = (ship, value) => (shipRating(ship, ship[value]) * crewFraction(ship)) / (1 - crewFraction(ship))

// The lowest and highest total over every order of the ships, for a fleet whose order is not known. Each ship turns the running total t into share x (t + rating), a share of 1 for a ship with its full crew, so a ship's rating counts times the shares of the ships after it: the full-crewed ships go last for the highest total and first for the lowest, and the short-crewed ones go in rising order of rating x share / (1 - share) for the highest and in falling order for the lowest (the order of any two neighbours that gives the larger total depends only on that figure).
const fleetTotalRange = (ships, value) => {
  const full = ships.filter((ship) => !isShort(ship))
  const rising = ships.filter(isShort).sort((a, b) => weight(a, value) - weight(b, value))

  return { low: fleetTotal([...full, ...rising.slice().reverse()], value), high: fleetTotal([...rising, ...full], value) }
}

const KINDS = {
  geo: { value: 'GeoValue', designed: 'GeoDesigned', rule: 'survey.geoRate', unit: 'geological' },
  grav: { value: 'GravValue', designed: 'GravDesigned', rule: 'survey.gravRate', unit: 'gravitational' },
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`

// The points a day of a fleet's `kind` ('geo' or 'grav') sensors, as a provenance result of 'survey.geoRate' or 'survey.gravRate' (utilities/provenance.js). `ships`: the fleet's rows from `loadSurveyShips`, embarked ones included. `options`: `speed`, the game's survey speed in percent (FCT_Game.SurveySpeed), `admin`, the naval admin Survey bonus in range (1 for none) and `version`, the formula version of the save (`loadFormulaVersion`, null when the save lacks the formula columns). A result is confirmed only when its rule is, the save has a formula version, and none of its inputs is one the rule has not been checked on; otherwise it is an estimate, with what makes it one in its assumptions. A missing input gives an unavailable result, never 0.
export const fleetSurveyRate = (ships, kind, { speed, admin = 1, adminGap = null, version = null }) => {
  const { value, designed, rule, unit } = KINDS[kind]
  const missing = []

  if (!Number.isFinite(speed)) {
    missing.push('the game\'s survey speed')
  }

  const sensors = ships.filter((ship) => ship[value] > 0).sort((a, b) => a.ShipID - b.ShipID)

  if (sensors.some((ship) => crewFraction(ship) === null || !Number.isFinite(ship.CrewMorale))) {
    missing.push('a ship\'s crew or morale')
  }

  if (adminGap || !Number.isFinite(admin)) {
    missing.push(adminGap || 'the naval admin command chain\'s Survey bonus')
  }

  if (missing.length) {
    return unavailable({ rule, missing, present: ['the sensors'] })
  }

  const assumptions = []
  const perDay = (total) => total * admin * (speed / 100) * HOURS_PER_DAY
  const embarked = sensors.filter((ship) => ship.MothershipID).length
  const short = sensors.filter(isShort)

  if (!ruleSupports(rule, version)) {
    assumptions.push(UNVERIFIED_SAVE)
  }

  if (kind === 'grav') {
    assumptions.push('Estimated: the game keeps its gravitational rate until the save reloads.')
  }

  if (embarked) {
    assumptions.push(`Includes ${plural(embarked, 'embarked ship', 'embarked ships')}.`)
  }

  if (sensors.some((ship) => ship.HasScienceOfficer && !ship.HasCaptain)) {
    assumptions.push('No captain: the science officer adds nothing.')
  }

  if (ships.some((ship) => ship[designed] > 0 && (ship.DamagedLines > 0 || ship[value] < ship[designed]))) {
    assumptions.push('Includes damage by the game\'s rule; not yet checked against a save.')
  }

  if (sensors.some((ship) => ship.CrewMorale < 1)) {
    assumptions.push('Includes crew morale.')
  }

  if (short.length) {
    if (sensors.length > 1) {
      const { low, high } = fleetTotalRange(sensors, value)

      assumptions.push(`Estimate: the crew is short and the game's order of the ships is not known, so the ${unit} rate is between ${Math.round(perDay(low))} and ${Math.round(perDay(high))} points a day.`)
    } else {
      assumptions.push('Estimate: the crew is short, and the game counts the crew share twice; not yet checked against a save.')
    }
  }

  const status = assumptions.length ? 'estimated' : getRule(rule).verification

  return envelope({
    value: perDay(fleetTotal(sensors, value)),
    status,
    rule,
    inputs: { present: ['the sensors', 'the officers', 'the crew', 'the naval admin command', 'the survey speed'] },
    assumptions,
  })
}

// The points a day of a colony's geosurvey formations, as a provenance result of 'survey.groundRate': `formations`, a list of { base, multiplier } (a formation's geosurvey rating and its commander's effective Survey multiplier, `groundCommandMultipliers`; 1 for a formation with no commander, null when the save does not give it), times the game's survey speed (`speed`, percent). The game multiplies the rating by the multiplier twice, so a formation gives base × multiplier². Unavailable without the speed, without the formations' rating (`formations` null when a formation at the colony has a geosurvey rating the save does not give) and without a multiplier.
export const groundSurveyRate = (formations, speed) => {
  const missing = []

  if (!Number.isFinite(speed)) {
    missing.push('the game\'s survey speed')
  }

  if (!Array.isArray(formations) || formations.some((formation) => !Number.isFinite(formation.base))) {
    missing.push('the geosurvey rating of the formations at the colony')
  } else if (formations.some((formation) => !Number.isFinite(formation.multiplier))) {
    missing.push('the command capacity and Survey bonus of a formation commander')
  }

  if (missing.length) {
    return unavailable({ rule: 'survey.groundRate', missing, present: ['the geosurvey units'] })
  }

  return envelope({ value: formations.reduce((total, { base, multiplier }) => total + base * multiplier * multiplier, 0) * (speed / 100), status: 'estimated', rule: 'survey.groundRate', inputs: { present: ['the geosurvey units', 'the formation commanders', 'the survey speed'] }, assumptions: ['Estimate: the game counts the commander\'s Survey multiplier twice by its rule; no save separates two applications from one.'] })
}

// The share of a superior formation commander's bonus that reaches each formation beneath it.
const SUPERIOR_SHARE = 0.25

// The columns the ground command read needs; a save that lacks one has no ground survey rate, and the read says which.
const GROUND_COMMAND_COLUMNS = {
  FCT_GroundUnitFormation: ['FormationID', 'ParentFormationID', 'PopulationID', 'GameID', 'RaceID'],
  FCT_GroundUnitFormationElement: ['FormationID', 'ClassID', 'Units'],
  FCT_GroundUnitClass: ['GroundUnitClassID', 'Size', 'HQCapacity'],
  FCT_Commander: ['CommanderID', 'CommandID', 'CommandType', 'GameID', 'RaceID'],
  FCT_CommanderBonuses: ['CommanderID', 'BonusID', 'BonusValue'],
}

// The race's ground formations with what the multiplier of a commander rests on, the rows `groundCommandMultipliers` takes: { supported: true, rows } or { supported: false, missing } for a save without a column the read needs. A row is a formation (id, parent, colony), whether a commander serves it (`HasCommander`) and that commander's Survey bonus, the size of the formation's own elements (`Size`), how many elements there are (`Elements`), how many of them give a class size and a unit count (`Known`) and how many give a headquarters capacity (`Capable`), and the largest headquarters capacity of their classes.
export const loadGroundCommand = async (database, { GameID, RaceID }) => {
  const missing = []

  for (const [table, wanted] of Object.entries(GROUND_COMMAND_COLUMNS)) {
    missing.push(...gaps(table, await columnsOf(database, table), wanted))
  }

  if (missing.length) {
    return { supported: false, missing }
  }

  const [rows] = await database.query(`select FCT_GroundUnitFormation.FormationID, FCT_GroundUnitFormation.ParentFormationID, FCT_GroundUnitFormation.PopulationID, case when FCT_Commander.CommanderID is null then 0 else 1 end as HasCommander, FCT_CommanderBonuses.BonusValue, VIR_Elements.Size, VIR_Elements.Elements, VIR_Elements.Known, VIR_Elements.Capable, VIR_Elements.HQCapacity from FCT_GroundUnitFormation left join FCT_Commander on FCT_Commander.CommandID = FCT_GroundUnitFormation.FormationID and FCT_Commander.CommandType = ${GROUND_POST} and FCT_Commander.GameID = FCT_GroundUnitFormation.GameID and FCT_Commander.RaceID = FCT_GroundUnitFormation.RaceID left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ${SURVEY_BONUS} left join (select FCT_GroundUnitFormationElement.FormationID, count(*) as Elements, sum(case when FCT_GroundUnitClass.Size is not null and FCT_GroundUnitFormationElement.Units is not null then 1 else 0 end) as Known, sum(case when FCT_GroundUnitClass.HQCapacity is not null then 1 else 0 end) as Capable, sum(FCT_GroundUnitClass.Size * FCT_GroundUnitFormationElement.Units) as Size, max(FCT_GroundUnitClass.HQCapacity) as HQCapacity from FCT_GroundUnitFormationElement left join FCT_GroundUnitClass on FCT_GroundUnitClass.GroundUnitClassID = FCT_GroundUnitFormationElement.ClassID where FCT_GroundUnitFormationElement.FormationID in (select FCT_GroundUnitFormation.FormationID from FCT_GroundUnitFormation where FCT_GroundUnitFormation.GameID = ${GameID} and FCT_GroundUnitFormation.RaceID = ${RaceID}) group by FCT_GroundUnitFormationElement.FormationID) VIR_Elements on VIR_Elements.FormationID = FCT_GroundUnitFormation.FormationID where FCT_GroundUnitFormation.GameID = ${GameID} and FCT_GroundUnitFormation.RaceID = ${RaceID}`)

  return { supported: true, rows }
}

// The effective Survey multiplier of each formation that has a commander, as a map from the formation's id to a number, or to null when a figure it rests on is missing. `rows`: one per formation of the race { FormationID, ParentFormationID, PopulationID, HasCommander, BonusValue (null when the commander has no Survey bonus, which counts as 1), Size (the sum of the class size times the units), Elements (the formation's element rows), Known (those whose class gives a size and whose units are stored), Capable (those whose class gives a headquarters capacity) and HQCapacity (the largest of the elements' classes) }. A formation with no commander is not in the map and counts as 1.
// The game's rule: a commander's own multiplier is the bonus, cut to 1 + (bonus - 1) × share when the share is below 1. The share is the largest headquarters capacity among the formation's own elements against the size of the formation with every formation beneath it (each formation's own size cut to a whole number first), in whole numbers: 1 up to that capacity and 0 beyond it. The superiors add their part: each parent at the same colony that has a commander gives 1 + (its bonus - 1) × 0.25 × its own share, and the parent's parents follow while each link holds.
export const groundCommandMultipliers = (rows) => {
  const byId = new Map(rows.map((row) => [row.FormationID, row]))
  const formations = [...byId.values()]
  const children = new Map()

  formations.forEach((row) => {
    if (byId.has(row.ParentFormationID) && row.ParentFormationID !== row.FormationID) {
      children.set(row.ParentFormationID, [...(children.get(row.ParentFormationID) || []), row.FormationID])
    }
  })

  const ownSize = (row) => (!(row.Elements > 0) ? 0 : row.Elements > row.Known || !Number.isFinite(row.Size) ? null : Math.trunc(row.Size))
  const sizes = new Map()
  const sizeOf = (id, path = new Set()) => {
    if (sizes.has(id)) {
      return sizes.get(id)
    } else if (path.has(id)) {
      return null
    }

    path.add(id)

    const total = (children.get(id) || []).reduce((sum, child) => {
      const part = sizeOf(child, path)

      return sum === null || part === null ? null : sum + part
    }, ownSize(byId.get(id)))

    path.delete(id)
    sizes.set(id, total)

    return total
  }

  const bonusOf = (row) => (row.BonusValue === null || row.BonusValue === undefined ? 1 : Number.isFinite(row.BonusValue) ? row.BonusValue : null)
  const shareOf = (row) => {
    const size = sizeOf(row.FormationID)
    const capacity = row.Elements > 0 ? (row.Elements > row.Capable ? null : row.HQCapacity) : 0

    return size === null || !Number.isFinite(capacity) ? null : size > capacity ? 0 : 1
  }

  const superiors = (row, path) => {
    const parent = byId.get(row.ParentFormationID)

    if (!parent || !(parent.PopulationID > 0) || parent.PopulationID !== row.PopulationID || !parent.HasCommander) {
      return 1
    } else if (path.has(parent.FormationID)) {
      return null
    }

    const bonus = bonusOf(parent)
    const share = shareOf(parent)
    const above = superiors(parent, new Set([...path, parent.FormationID]))

    return bonus === null || share === null || above === null ? null : (1 + (bonus - 1) * SUPERIOR_SHARE * share) * above
  }

  return new Map(formations.filter((row) => row.HasCommander).map((row) => {
    const bonus = bonusOf(row)
    const share = shareOf(row)
    const above = superiors(row, new Set([row.FormationID]))

    return [row.FormationID, bonus === null || share === null || above === null ? null : (share < 1 ? 1 + (bonus - 1) * share : bonus) * above]
  }))
}
