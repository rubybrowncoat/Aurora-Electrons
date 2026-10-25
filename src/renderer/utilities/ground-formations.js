// The selected race's ground formations as one hierarchy: the model that the formation specialists, the map and the exports are to share. A formation is read from the save with its stable id, its parent link, its location (stationed at a colony, or embarked on a ship whose fleet gives the system), its actual elements and the original and replacement templates the save names. Its mass and its geological and xenoarchaeology ratings come from the actual elements and never from a template, and each figure lists the elements behind it. The saves are observational: a figure whose input the save lacks is unknown (null, with the missing input named), never 0.
//
// What the model reports and never drops:
// - Every formation row of the race is one entry, once. A row of another race or game is left out and counted in `summary.excluded`, and a formation of another race is never part of a total.
// - A parent link that names no formation of the game is an orphan (`orphan-parent`), one that names a formation of another race or game is `foreign-parent`, and a parent that is not stored is `parent-unknown`. The formation stays unresolved: it is a top-level entry whose `anchor` says so and so is every formation below it.
// - A parent link that loops (a formation that is its own parent, or two that are each other's) ends visibly: each loop is one entry of `cycles` naming its members, the member with the lowest id is where the loop is cut and shown as a top-level entry, and every member carries `parent-cycle`.
// - A template id that names no template of the race is `template-missing` (a template of another race is `template-foreign`); an id of 0 is a formation with no template recorded, shown as the state `none`; an id that is not stored (null, absent, negative or not a whole number) is the state `unknown` with `template-unknown`, never `none`.
// - A ship that is not found, a ship with no fleet found, a colony that is not found and a formation with no location are unresolved locations with their own problem kinds.
// - A formation with no element rows has no known mass or capability (`no-elements`); an element whose class, size, units or equipment the save does not give leaves the figure it feeds unknown.
//
// The game keeps a formation's parent link when it embarks or moves, so a formation may sit at another place than its parent. The game counts a formation's size as the sum of its classes' size times units; the model reports that sum as `mass` without rounding.

import { HOLDER_COLUMNS, holderIndex, holderSql, postCounts, postOf, postProblems, strayHolders } from './post-holders'

// The post type of a commander who serves in a ground formation (FCT_Commander.CommandType).
const GROUND_POST = 5

// The columns each table must have for the model to be read from a save; a save that lacks one is unsupported and the loader says which. The template's Obsolete column, the class's STOWeapon and the component type's STO are not required (an earlier save may lack them) and read as unknown.
export const GROUND_FORMATION_COLUMNS = {
  FCT_GroundUnitFormation: ['FormationID', 'Name', 'Abbreviation', 'RaceID', 'GameID', 'OriginalTemplateID', 'ReplacementTemplateID', 'PopulationID', 'ShipID', 'ParentFormationID'],
  FCT_GroundUnitFormationElement: ['ElementID', 'FormationID', 'ClassID', 'SpeciesID', 'Units'],
  FCT_GroundUnitClass: ['GroundUnitClassID', 'ClassName', 'Size', 'ComponentA', 'ComponentB', 'ComponentC', 'ComponentD'],
  DIM_GroundComponentType: ['ComponentTypeID', 'ComponentName', 'Geosurvey', 'Xenoarchaeology'],
  FCT_GroundUnitFormationTemplate: ['TemplateID', 'GameID', 'RaceID', 'Name', 'Abbreviation'],
  FCT_GroundUnitFormationElementTemplates: ['FormationTemplateID', 'GameID', 'ClassID', 'Units'],
  FCT_Ship: ['ShipID', 'ShipName', 'FleetID', 'MothershipID'],
  FCT_Fleet: ['FleetID', 'FleetName', 'RaceID', 'SystemID', 'OrbitBodyID'],
  FCT_Population: ['PopulationID', 'PopName', 'RaceID', 'SystemID', 'SystemBodyID'],
  FCT_RaceSysSurvey: ['SystemID', 'RaceID', 'GameID', 'Name'],
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const isCount = (value) => isNumber(value) && value >= 0
const isId = (value) => Number.isInteger(value) && value > 0
const byNumber = (a, b) => a - b

const requireIds = ({ GameID, RaceID }) => {
  if (!Number.isInteger(GameID) || !Number.isInteger(RaceID)) {
    throw new TypeError('The ground formations are read for a game and a race given as whole numbers')
  }
}

const OWN = (g, r) => `select FCT_GroundUnitFormation.FormationID from FCT_GroundUnitFormation where FCT_GroundUnitFormation.GameID = ${g} and FCT_GroundUnitFormation.RaceID = ${r}`
const OWN_TEMPLATES = (g, r) => `select FCT_GroundUnitFormation.OriginalTemplateID from FCT_GroundUnitFormation where FCT_GroundUnitFormation.GameID = ${g} and FCT_GroundUnitFormation.RaceID = ${r} union select FCT_GroundUnitFormation.ReplacementTemplateID from FCT_GroundUnitFormation where FCT_GroundUnitFormation.GameID = ${g} and FCT_GroundUnitFormation.RaceID = ${r}`
const OWN_SHIPS = (g, r) => `select FCT_GroundUnitFormation.ShipID from FCT_GroundUnitFormation where FCT_GroundUnitFormation.GameID = ${g} and FCT_GroundUnitFormation.RaceID = ${r} and FCT_GroundUnitFormation.ShipID > 0`
const CARRIERS = (g, r) => `select FCT_Ship.ShipID from FCT_Ship where FCT_Ship.ShipID in (${OWN_SHIPS(g, r)}) union select FCT_Ship.MothershipID from FCT_Ship where FCT_Ship.ShipID in (${OWN_SHIPS(g, r)}) and FCT_Ship.MothershipID > 0`

// The statements that read the model for a game and a race, each a SELECT, by name. Rows are found by their ids, which no two games share, except the templates, which are read for the game. Nothing is filtered by an element's own game, so no stored element is lost. `obsolete` is whether the save has the template's Obsolete column, `stoWeapon` whether it has the class's STOWeapon column and `stoComponent` whether it has the component type's STO column; an earlier save may lack any of them, and the figure then reads null (not known).
export const groundFormationSql = ({ GameID, RaceID, obsolete = true, stoWeapon = true, stoComponent = true }) => {
  requireIds({ GameID, RaceID })

  const g = GameID
  const r = RaceID

  return {
    formations: `select FCT_GroundUnitFormation.FormationID, FCT_GroundUnitFormation.Name, FCT_GroundUnitFormation.Abbreviation, FCT_GroundUnitFormation.RaceID, FCT_GroundUnitFormation.GameID, FCT_GroundUnitFormation.OriginalTemplateID, FCT_GroundUnitFormation.ReplacementTemplateID, FCT_GroundUnitFormation.PopulationID, FCT_GroundUnitFormation.ShipID, FCT_GroundUnitFormation.ParentFormationID from FCT_GroundUnitFormation where FCT_GroundUnitFormation.GameID = ${g} and FCT_GroundUnitFormation.RaceID = ${r} order by FCT_GroundUnitFormation.FormationID`,
    outsideParents: `select FCT_GroundUnitFormation.FormationID, FCT_GroundUnitFormation.RaceID, FCT_GroundUnitFormation.GameID from FCT_GroundUnitFormation where FCT_GroundUnitFormation.FormationID in (select FCT_GroundUnitFormation.ParentFormationID from FCT_GroundUnitFormation where FCT_GroundUnitFormation.GameID = ${g} and FCT_GroundUnitFormation.RaceID = ${r} and FCT_GroundUnitFormation.ParentFormationID > 0) and not (FCT_GroundUnitFormation.GameID = ${g} and FCT_GroundUnitFormation.RaceID = ${r})`,
    elements: `select FCT_GroundUnitFormationElement.rowid as RowID, FCT_GroundUnitFormationElement.ElementID, FCT_GroundUnitFormationElement.FormationID, FCT_GroundUnitFormationElement.ClassID, FCT_GroundUnitFormationElement.SpeciesID, FCT_GroundUnitFormationElement.Units from FCT_GroundUnitFormationElement where FCT_GroundUnitFormationElement.FormationID in (${OWN(g, r)}) order by FCT_GroundUnitFormationElement.FormationID, FCT_GroundUnitFormationElement.ElementID, FCT_GroundUnitFormationElement.rowid`,
    classes: `select FCT_GroundUnitClass.GroundUnitClassID, FCT_GroundUnitClass.ClassName, FCT_GroundUnitClass.Size, FCT_GroundUnitClass.ComponentA, FCT_GroundUnitClass.ComponentB, FCT_GroundUnitClass.ComponentC, FCT_GroundUnitClass.ComponentD, ${stoWeapon ? 'FCT_GroundUnitClass.STOWeapon' : 'null as STOWeapon'} from FCT_GroundUnitClass where FCT_GroundUnitClass.GroundUnitClassID in (select FCT_GroundUnitFormationElement.ClassID from FCT_GroundUnitFormationElement where FCT_GroundUnitFormationElement.FormationID in (${OWN(g, r)})) or FCT_GroundUnitClass.GroundUnitClassID in (select FCT_GroundUnitFormationElementTemplates.ClassID from FCT_GroundUnitFormationElementTemplates where FCT_GroundUnitFormationElementTemplates.GameID = ${g} and FCT_GroundUnitFormationElementTemplates.FormationTemplateID in (${OWN_TEMPLATES(g, r)}))`,
    components: `select DIM_GroundComponentType.ComponentTypeID, DIM_GroundComponentType.ComponentName, DIM_GroundComponentType.Geosurvey, DIM_GroundComponentType.Xenoarchaeology, ${stoComponent ? 'DIM_GroundComponentType.STO' : 'null as STO'} from DIM_GroundComponentType`,
    templates: `select FCT_GroundUnitFormationTemplate.TemplateID, FCT_GroundUnitFormationTemplate.RaceID, FCT_GroundUnitFormationTemplate.Name, FCT_GroundUnitFormationTemplate.Abbreviation, ${obsolete ? 'FCT_GroundUnitFormationTemplate.Obsolete' : 'null as Obsolete'} from FCT_GroundUnitFormationTemplate where FCT_GroundUnitFormationTemplate.GameID = ${g} and FCT_GroundUnitFormationTemplate.TemplateID in (${OWN_TEMPLATES(g, r)})`,
    templateElements: `select FCT_GroundUnitFormationElementTemplates.FormationTemplateID, FCT_GroundUnitFormationElementTemplates.ClassID, FCT_GroundUnitFormationElementTemplates.Units from FCT_GroundUnitFormationElementTemplates where FCT_GroundUnitFormationElementTemplates.GameID = ${g} and FCT_GroundUnitFormationElementTemplates.FormationTemplateID in (${OWN_TEMPLATES(g, r)})`,
    ships: `select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.FleetID, FCT_Ship.MothershipID from FCT_Ship where FCT_Ship.ShipID in (${CARRIERS(g, r)})`,
    fleets: `select FCT_Fleet.FleetID, FCT_Fleet.FleetName, FCT_Fleet.RaceID, FCT_Fleet.SystemID, FCT_Fleet.OrbitBodyID, FCT_RaceSysSurvey.Name as SystemName from FCT_Fleet left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Fleet.SystemID and FCT_RaceSysSurvey.RaceID = ${r} and FCT_RaceSysSurvey.GameID = ${g} where FCT_Fleet.FleetID in (select FCT_Ship.FleetID from FCT_Ship where FCT_Ship.ShipID in (${CARRIERS(g, r)}))`,
    populations: `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.RaceID, FCT_Population.SystemID, FCT_Population.SystemBodyID, FCT_RaceSysSurvey.Name as SystemName from FCT_Population left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = ${r} and FCT_RaceSysSurvey.GameID = ${g} where FCT_Population.PopulationID in (select FCT_GroundUnitFormation.PopulationID from FCT_GroundUnitFormation where FCT_GroundUnitFormation.GameID = ${g} and FCT_GroundUnitFormation.RaceID = ${r} and FCT_GroundUnitFormation.PopulationID > 0)`,
  }
}

const firstBy = (rows, key, prefer = () => false) => {
  const map = new Map()

  rows.forEach((row) => {
    const kept = map.get(row[key])

    if (!kept || (!prefer(kept) && prefer(row))) {
      map.set(row[key], row)
    }
  })

  return map
}

// What a class gives per unit: its size, the geological and xenoarchaeology rating of the equipment in its four component slots, and whether it is an STO class. A slot recorded as 0 or less is empty and adds nothing; a slot that is not stored (null, absent or not a number) leaves both ratings unknown. A figure the save does not give is null and named in `unknown`, each entry `{ kind, slot, componentId, reason }`. A class is an STO class (`sto` true) when its STOWeapon is above 0 or the equipment in a slot is of a type flagged STO; it is not (false) only when both are known and neither is; where one is not stored, and no known one makes it STO, the flag is null (not known) and no problem is raised for it.
const classFigures = (row, components) => {
  const unknown = []
  const note = (entry) => {
    if (!unknown.some((known) => known.slot === entry.slot && known.reason === entry.reason)) {
      unknown.push(entry)
    }
  }
  const sum = (key) => {
    let total = 0
    let known = true

    ;['ComponentA', 'ComponentB', 'ComponentC', 'ComponentD'].forEach((slot) => {
      const id = row[slot]

      if (!isNumber(id)) {
        known = false
        note({ kind: 'component-unknown', slot, componentId: null, reason: 'the component of the slot is not stored' })

        return
      }

      if (id <= 0) {
        return
      }

      const component = components.get(id)

      if (!component || !isNumber(component[key])) {
        known = false
        note({ kind: 'component-missing', slot, componentId: id, reason: component ? `the component's ${key === 'Geosurvey' ? 'geosurvey' : 'xenoarchaeology'} rating is not stored` : 'the component is not in the catalogue' })

        return
      }

      total += component[key]
    })

    return known ? total : null
  }

  const stoOf = () => {
    let known = isNumber(row.STOWeapon)
    let found = known && row.STOWeapon > 0

    ;['ComponentA', 'ComponentB', 'ComponentC', 'ComponentD'].forEach((slot) => {
      const id = row[slot]
      const component = isNumber(id) && id > 0 ? components.get(id) : undefined

      if (!isNumber(id) || (id > 0 && (!component || !isNumber(component.STO)))) {
        known = false
      } else if (component && component.STO > 0) {
        found = true
      }
    })

    return found ? true : known ? false : null
  }

  return { size: isNumber(row.Size) && row.Size >= 0 ? row.Size : null, geo: sum('Geosurvey'), xeno: sum('Xenoarchaeology'), sto: stoOf(), unknown }
}

// An element of a formation: its class, the class's size per unit and STO flag (null where the class or the figure is not stored) and its units (null where not stored).
const element = (row, classes, figures) => {
  const cls = classes.get(row.ClassID)
  const known = cls ? figures.get(row.ClassID) : null

  return { id: isId(row.ElementID) ? row.ElementID : null, rowId: row.RowID ?? null, classId: row.ClassID, className: cls ? cls.ClassName ?? null : null, speciesId: row.SpeciesID ?? null, units: isCount(row.Units) ? row.Units : null, size: known ? known.size : null, sto: known ? known.sto : null }
}

// A figure from the elements: the sum of units times the per-unit figure `pick` ('size', 'geo' or 'xeno'). `from` lists the elements that add to it (for the ratings, those with equipment of that kind) and `unknown` each element that leaves it unknown, with the reason; then `value` is null.
const figure = (elements, classes, figures, pick) => {
  const from = []
  const unknown = []
  let value = 0

  elements.forEach((item) => {
    const cls = classes.get(item.classId)
    const per = cls ? figures.get(item.classId)[pick] : undefined

    if (item.units === null) {
      unknown.push({ elementId: item.id, classId: item.classId, reason: 'the units are not stored' })
    } else if (!cls) {
      unknown.push({ elementId: item.id, classId: item.classId, reason: 'the class is not stored' })
    } else if (per === null) {
      unknown.push({ elementId: item.id, classId: item.classId, reason: pick === 'size' ? 'the size of the class is not stored' : 'a component slot of the class is not stored, or its component is not in the catalogue or has no stored rating' })
    } else {
      value += item.units * per

      if (pick === 'size' || per > 0) {
        from.push({ elementId: item.id, classId: item.classId, className: item.className, units: item.units, perUnit: per, contribution: item.units * per })
      }
    }
  })

  return { value: unknown.length ? null : value, from, unknown }
}

// The template a formation names, by its id: `none` (the id 0), `unknown` (the id is not stored as one), `missing`, `foreign` (of another race) or `found`. A found template lists its elements, each { classId, className, units, size, mass, sto } with the class's size per unit, the mass (units times size) and the STO flag of the class, each null where the save does not give it, and `mass`, the figure of the whole template (the same size and unknown rules as the mass of a formation's actual elements, so a class with no stored size, units that are not stored or a class that is not stored leaves it unknown). A template that lists no elements has no known mass. The other states have no element list and no mass.
const templateRef = (id, templates, templateElements, classes, figures, { RaceID }) => {
  if (id === 0) {
    return { id: 0, state: 'none', name: null, abbreviation: null, obsolete: null, elements: null, mass: null }
  }

  if (!isId(id)) {
    return { id: isNumber(id) ? id : null, state: 'unknown', name: null, abbreviation: null, obsolete: null, elements: null, mass: null }
  }

  const row = templates.get(id)

  if (!row) {
    return { id, state: 'missing', name: null, abbreviation: null, obsolete: null, elements: null, mass: null }
  }

  const base = { id, name: row.Name ?? null, abbreviation: row.Abbreviation ?? null, obsolete: row.Obsolete === undefined || row.Obsolete === null ? null : Boolean(row.Obsolete) }

  if (row.RaceID !== RaceID) {
    return { ...base, state: 'foreign', raceId: row.RaceID ?? null, elements: null, mass: null }
  }

  const items = (templateElements.get(id) || []).map((item) => ({ id: null, rowId: null, classId: item.ClassID, className: classes.has(item.ClassID) ? classes.get(item.ClassID).ClassName ?? null : null, speciesId: null, units: isCount(item.Units) ? item.Units : null }))
  const mass = items.length ? figure(items, classes, figures, 'size') : { value: null, from: [], unknown: [{ elementId: null, classId: null, reason: 'the template lists no elements' }] }

  return {
    ...base,
    state: 'found',
    elements: items.map((item) => {
      const known = figures.get(item.classId)
      const size = known ? known.size : null

      return { classId: item.classId, className: item.className, units: item.units, size, mass: item.units !== null && size !== null ? item.units * size : null, sto: known ? known.sto : null }
    }),
    mass,
  }
}

const locate = (row, { populations, ships, fleets }) => {
  const problems = []
  const empty = { kind: 'unlocated', state: 'unresolved', population: null, ship: null, fleet: null, system: null }

  if (isId(row.PopulationID)) {
    if (isId(row.ShipID)) {
      problems.push({ kind: 'both-locations', message: 'The formation is stored at a colony and aboard a ship; the colony is used, as the game does' })
    }

    const population = populations.get(row.PopulationID)

    if (!population) {
      problems.push({ kind: 'population-missing', populationId: row.PopulationID, message: `Colony ${row.PopulationID} is not in the save` })

      return { location: { ...empty, kind: 'colony', population: { id: row.PopulationID, name: null, systemId: null, systemName: null, bodyId: null, raceId: null } }, problems }
    }

    const system = isId(population.SystemID) ? { id: population.SystemID, name: population.SystemName ?? null } : null

    if (!system) {
      problems.push({ kind: 'system-unknown', message: `The system of colony ${row.PopulationID} is not stored` })
    }

    return { location: { kind: 'colony', state: system ? 'resolved' : 'unresolved', population: { id: population.PopulationID, name: population.PopName ?? null, systemId: system ? system.id : null, systemName: system ? system.name : null, bodyId: isId(population.SystemBodyID) ? population.SystemBodyID : null, raceId: population.RaceID ?? null }, ship: null, fleet: null, system }, problems }
  }

  if (!isId(row.ShipID)) {
    problems.push({ kind: 'unlocated', message: 'The formation is stored neither at a colony nor aboard a ship' })

    return { location: empty, problems }
  }

  const ship = ships.get(row.ShipID)

  if (!ship) {
    problems.push({ kind: 'ship-missing', shipId: row.ShipID, message: `Ship ${row.ShipID} is not in the save` })

    return { location: { ...empty, kind: 'ship', ship: { id: row.ShipID, name: null, mothershipId: null, carriedBy: null } }, problems }
  }

  const mothership = isId(ship.MothershipID) ? ships.get(ship.MothershipID) : undefined
  const shipRef = { id: ship.ShipID, name: ship.ShipName ?? null, mothershipId: isId(ship.MothershipID) ? ship.MothershipID : null, carriedBy: mothership ? { id: mothership.ShipID, name: mothership.ShipName ?? null } : null }
  let fleet = isId(ship.FleetID) ? fleets.get(ship.FleetID) : undefined
  let via = 'ship'

  if (!fleet && mothership && isId(mothership.FleetID) && fleets.get(mothership.FleetID)) {
    fleet = fleets.get(mothership.FleetID)
    via = 'mothership'
  }

  if (!fleet) {
    problems.push({ kind: 'fleet-missing', shipId: ship.ShipID, fleetId: isId(ship.FleetID) ? ship.FleetID : null, message: isId(ship.FleetID) ? `Fleet ${ship.FleetID} of ship ${ship.ShipID} is not in the save` : `Ship ${ship.ShipID} has no fleet in the save` })

    return { location: { ...empty, kind: 'ship', ship: shipRef }, problems }
  }

  const system = isId(fleet.SystemID) ? { id: fleet.SystemID, name: fleet.SystemName ?? null } : null

  if (!system) {
    problems.push({ kind: 'system-unknown', message: `The system of fleet ${fleet.FleetID} is not stored` })
  }

  return { location: { kind: 'ship', state: system ? 'resolved' : 'unresolved', population: null, ship: shipRef, fleet: { id: fleet.FleetID, name: fleet.FleetName ?? null, systemId: system ? system.id : null, systemName: system ? system.name : null, bodyId: isId(fleet.OrbitBodyID) ? fleet.OrbitBodyID : null, raceId: fleet.RaceID ?? null, via }, system }, problems }
}

// The loops of the parent links: `parentOf` maps a formation to its parent when that parent is one of the race's formations. A formation has one parent, so each loop is simple. Each is the list of its members starting at the lowest id and following the parent links.
export const findCycles = (parentOf) => {
  const seen = new Map()
  const cycles = []

  Array.from(parentOf.keys()).sort(byNumber).forEach((start) => {
    if (seen.has(start)) {
      return
    }

    const path = []
    let at = start

    while (at !== undefined && !seen.has(at)) {
      seen.set(at, 1)
      path.push(at)
      at = parentOf.get(at)
    }

    if (at !== undefined && seen.get(at) === 1) {
      const loop = path.slice(path.indexOf(at))
      const head = Math.min(...loop)
      const from = loop.indexOf(head)

      cycles.push([...loop.slice(from), ...loop.slice(0, from)])
    }

    path.forEach((id) => seen.set(id, 2))
  })

  return cycles
}

const KINDS = ['mass', 'geo', 'xeno']

const emptyTree = () => ({ formations: 0, mass: { value: 0, unknownFormations: 0 }, geo: { value: 0, unknownFormations: 0 }, xeno: { value: 0, unknownFormations: 0 } })

const noElements = () => ({ value: null, from: [], unknown: [{ elementId: null, classId: null, reason: 'the formation has no element rows' }] })

// The model of a race's ground formations from the rows of `groundFormationSql` (the arrays `formations`, `outsideParents`, `elements`, `classes`, `components`, `templates`, `templateElements`, `ships`, `fleets` and `populations`; one that is left out is empty) and, optionally, the `commanders` of `holderSql` for the ground formation post (left out, the posts are unread). Gives { GameID, RaceID, formations, byId, roots, cycles, problems, summary, holders }:
// - `formations` is one entry per row of the race, by id: { id, name, abbreviation, parent: { id, state, ... }, children (ids), anchor: { kind, id } (the top-level entry it hangs from: 'root', 'orphan', 'foreign', 'unknown' or 'cycle'), resolved (whether that top is a formation with no parent), depth, location, post (the commander who serves in the formation: { state: 'held' | 'shared' | 'vacant' | 'unknown' | 'unread', holders: [{ id, name }], unsettled }, from the rows `commanders` of `holderSql`; without them every post is `unread`), elements, mass, geo, xeno (each { value, from, unknown }), tree (the formation with everything below it: { formations, mass, geo, xeno }, each figure { value, unknownFormations } where value adds the known formations and unknownFormations counts those whose figure is unknown), templates: { original, replacement } (each { id, state: 'none' | 'found' | 'missing' | 'foreign' | 'unknown', name, abbreviation, obsolete, elements, mass }: a found template's elements are { classId, className, units, size, mass, sto } and its `mass` a figure { value, from, unknown } summed as the mass of actual elements is), problems }.
// - `roots` are the ids of the top-level entries: formations with no parent, then orphans, then the rest by id, each once. Every formation is under exactly one of them.
// - `cycles` are { id, members, cutAt }. `problems` is every problem of every formation, each { formationId, kind, message, ... }.
// - `summary` reconciles with the rows: `formations` is the number of rows kept, `excluded` the rows given that are not the race's, and the totals of the race only. `summary.posts` counts the formations by the state of their post and `summary.strayHolders` the serving commanders whose formation is not one of the race's.
export const buildGroundFormations = (rows, { GameID, RaceID }) => {
  const { formations: formationRows = [], outsideParents = [], elements: elementRows = [], classes: classRows = [], components: componentRows = [], templates: templateRows = [], templateElements: templateElementRows = [], ships: shipRows = [], fleets: fleetRows = [], populations: populationRows = [], commanders: commanderRows } = rows
  const owned = []
  const duplicates = []
  const seenIds = new Set()
  let excluded = 0

  formationRows.forEach((row) => {
    if (row.RaceID !== RaceID || row.GameID !== GameID) {
      excluded++
    } else if (seenIds.has(row.FormationID)) {
      duplicates.push(row.FormationID)
    } else {
      seenIds.add(row.FormationID)
      owned.push(row)
    }
  })

  owned.sort((a, b) => a.FormationID - b.FormationID)

  const components = firstBy(componentRows, 'ComponentTypeID')
  const classes = firstBy(classRows, 'GroundUnitClassID')
  const figures = new Map(Array.from(classes.entries()).map(([id, row]) => [id, classFigures(row, components)]))
  const templates = firstBy(templateRows, 'TemplateID', (row) => row.RaceID === RaceID)
  const templateElements = new Map()

  templateElementRows.forEach((row) => {
    templateElements.set(row.FormationTemplateID, [...(templateElements.get(row.FormationTemplateID) || []), row])
  })

  const lookups = { populations: firstBy(populationRows, 'PopulationID'), ships: firstBy(shipRows, 'ShipID'), fleets: firstBy(fleetRows, 'FleetID') }
  const outside = firstBy(outsideParents, 'FormationID')
  const elementsByFormation = new Map()
  let strayElements = 0

  elementRows.forEach((row) => {
    if (seenIds.has(row.FormationID)) {
      elementsByFormation.set(row.FormationID, [...(elementsByFormation.get(row.FormationID) || []), element(row, classes, figures)])
    } else {
      strayElements++
    }
  })

  const holders = holderIndex(commanderRows, GROUND_POST)
  const parentOf = new Map()
  const nodes = new Map()

  owned.forEach((row) => {
    const problems = []
    const raw = row.ParentFormationID
    let parent

    if (raw === 0) {
      parent = { id: null, state: 'none' }
    } else if (!isId(raw)) {
      parent = { id: null, state: 'unknown' }
      problems.push({ kind: 'parent-unknown', message: 'The parent link of the formation is not stored' })
    } else if (seenIds.has(raw)) {
      parent = { id: raw, state: 'resolved' }
      parentOf.set(row.FormationID, raw)
    } else if (outside.has(raw)) {
      parent = { id: raw, state: 'foreign', raceId: outside.get(raw).RaceID ?? null, gameId: outside.get(raw).GameID ?? null }
      problems.push({ kind: 'foreign-parent', parentId: raw, message: `Parent ${raw} is a formation of another race or game` })
    } else {
      parent = { id: raw, state: 'orphan' }
      problems.push({ kind: 'orphan-parent', parentId: raw, message: `Parent ${raw} is not a formation in the save` })
    }

    const items = elementsByFormation.get(row.FormationID) || []

    if (!items.length) {
      problems.push({ kind: 'no-elements', message: 'The save holds no element rows for the formation' })
    }

    items.forEach((item) => {
      if (item.units === null) {
        problems.push({ kind: 'units-unknown', elementId: item.id, message: `The units of element ${item.id ?? item.rowId} are not stored` })
      }

      if (!classes.has(item.classId)) {
        problems.push({ kind: 'class-missing', elementId: item.id, classId: item.classId, message: `Class ${item.classId} of element ${item.id ?? item.rowId} is not in the save` })
      }
    })

    const seenClasses = new Set()

    items.forEach((item) => {
      if (classes.has(item.classId) && !seenClasses.has(item.classId)) {
        seenClasses.add(item.classId)

        const known = figures.get(item.classId)

        if (known.size === null) {
          problems.push({ kind: 'size-unknown', classId: item.classId, message: `The size of class ${item.classId} is not stored` })
        }

        known.unknown.forEach((entry) => problems.push({ kind: entry.kind, classId: item.classId, slot: entry.slot, componentId: entry.componentId, message: `Class ${item.classId}: ${entry.reason} (${entry.slot}${entry.componentId === null ? '' : ` is ${entry.componentId}`})` }))
      }
    })

    const sized = items.length ? { mass: figure(items, classes, figures, 'size'), geo: figure(items, classes, figures, 'geo'), xeno: figure(items, classes, figures, 'xeno') } : { mass: noElements(), geo: noElements(), xeno: noElements() }

    const refs = { original: templateRef(row.OriginalTemplateID, templates, templateElements, classes, figures, { RaceID }), replacement: templateRef(row.ReplacementTemplateID, templates, templateElements, classes, figures, { RaceID }) }

    ;['original', 'replacement'].forEach((which) => {
      if (refs[which].state === 'missing') {
        problems.push({ kind: 'template-missing', which, templateId: refs[which].id, message: `The ${which} template ${refs[which].id} is not in the save` })
      } else if (refs[which].state === 'foreign') {
        problems.push({ kind: 'template-foreign', which, templateId: refs[which].id, message: `The ${which} template ${refs[which].id} belongs to another race` })
      } else if (refs[which].state === 'unknown') {
        problems.push({ kind: 'template-unknown', which, templateId: refs[which].id, message: `The ${which} template of the formation is not stored as a template id` })
      }
    })

    const { location, problems: placed } = locate(row, lookups)
    const post = postOf(holders, row.FormationID)

    nodes.set(row.FormationID, { id: row.FormationID, name: row.Name ?? null, abbreviation: row.Abbreviation ?? null, parent, children: [], anchor: null, resolved: false, depth: 0, location, post, elements: items, mass: sized.mass, geo: sized.geo, xeno: sized.xeno, tree: emptyTree(), templates: refs, problems: [...problems, ...placed, ...postProblems(post)] })
  })

  const cycles = findCycles(parentOf).map((members) => ({ id: `cycle:${members[0]}`, members, cutAt: members[0] }))
  const cut = new Set(cycles.map((cycle) => cycle.cutAt))

  cycles.forEach((cycle) => {
    cycle.members.forEach((id) => {
      const node = nodes.get(id)

      node.parent = { ...node.parent, state: cycle.cutAt === id ? 'cycle' : node.parent.state, cycleId: cycle.id }
      node.problems.push({ kind: 'parent-cycle', cycleId: cycle.id, members: cycle.members, message: `The parent links of formations ${cycle.members.join(', ')} form a loop${cycle.cutAt === id ? '; it is cut here' : ''}` })
    })
  })

  nodes.forEach((node) => {
    if (node.parent.state === 'resolved') {
      nodes.get(parentOf.get(node.id)).children.push(node.id)
    }
  })

  nodes.forEach((node) => node.children.sort(byNumber))

  const rank = (node) => (node.parent.state === 'none' ? 0 : node.parent.state === 'orphan' ? 1 : 2)
  const topLevel = Array.from(nodes.values()).filter((node) => !parentOf.has(node.id) || cut.has(node.id)).sort((a, b) => rank(a) - rank(b) || a.id - b.id)
  const order = []

  topLevel.forEach((top) => {
    top.anchor = { kind: top.parent.state === 'none' ? 'root' : top.parent.state, id: top.id }
    top.resolved = top.parent.state === 'none'
    top.depth = 0
    order.push(top)
  })

  for (let index = 0; index < order.length; index++) {
    const node = order[index]

    node.children.forEach((childId) => {
      const child = nodes.get(childId)

      child.anchor = node.anchor
      child.resolved = node.resolved
      child.depth = node.depth + 1
      order.push(child)
    })
  }

  for (let index = order.length - 1; index >= 0; index--) {
    const node = order[index]

    node.tree.formations++

    KINDS.forEach((kind) => {
      if (node[kind].value === null) {
        node.tree[kind].unknownFormations++
      } else {
        node.tree[kind].value += node[kind].value
      }
    })

    if (node.parent.state === 'resolved') {
      const up = nodes.get(parentOf.get(node.id)).tree

      up.formations += node.tree.formations
      KINDS.forEach((kind) => {
        up[kind].value += node.tree[kind].value
        up[kind].unknownFormations += node.tree[kind].unknownFormations
      })
    }
  }

  const list = Array.from(nodes.values()).sort((a, b) => a.id - b.id)
  const problems = list.flatMap((node) => node.problems.map((problem) => ({ formationId: node.id, ...problem })))
  const count = (kind) => problems.filter((problem) => problem.kind === kind).length
  const total = (kind) => list.reduce((sum, node) => (node[kind].value === null ? { value: sum.value, unknownFormations: sum.unknownFormations + 1 } : { value: sum.value + node[kind].value, unknownFormations: sum.unknownFormations }), { value: 0, unknownFormations: 0 })
  const templateCount = (state) => ['original', 'replacement'].reduce((sums, which) => ({ ...sums, [which]: list.filter((node) => node.templates[which].state === state).length }), {})

  const summary = {
    posts: postCounts(list),
    strayHolders: strayHolders(holders, seenIds),
    formations: list.length,
    excluded,
    duplicateRows: duplicates.length,
    strayElements,
    roots: topLevel.filter((node) => node.parent.state === 'none').length,
    topLevel: topLevel.length,
    orphans: count('orphan-parent'),
    foreignParents: count('foreign-parent'),
    unknownParents: count('parent-unknown'),
    cycles: cycles.length,
    cycleMembers: cycles.reduce((sum, cycle) => sum + cycle.members.length, 0),
    unresolved: list.filter((node) => !node.resolved).length,
    templates: { missing: templateCount('missing'), foreign: templateCount('foreign'), none: templateCount('none'), unknown: templateCount('unknown'), found: templateCount('found') },
    locations: { colony: list.filter((node) => node.location.kind === 'colony' && node.location.state === 'resolved').length, ship: list.filter((node) => node.location.kind === 'ship' && node.location.state === 'resolved').length, unresolved: list.filter((node) => node.location.state === 'unresolved').length },
    noElements: count('no-elements'),
    elements: list.reduce((sum, node) => sum + node.elements.length, 0),
    units: { value: list.reduce((sum, node) => sum + node.elements.reduce((inner, item) => inner + (item.units ?? 0), 0), 0), unknownElements: list.reduce((sum, node) => sum + node.elements.filter((item) => item.units === null).length, 0) },
    mass: total('mass'),
    geo: total('geo'),
    xeno: total('xeno'),
  }

  return { GameID, RaceID, formations: list, byId: nodes, roots: topLevel.map((node) => node.id), cycles, problems, summary, holders: { read: holders !== null, missing: [] } }
}

// The roles a formation is told apart by, from the model's own ratings: `geo` and `xeno` when the rating of that kind is above 0, `other` when both are 0. A formation with both ratings is in both roles. A role is null where an unknown rating leaves it undecided (a formation with no proven role and an unknown rating is `undetermined`, with no role to count under).
export const GROUND_ROLES = ['geo', 'xeno', 'other']

const rated = (figure) => (figure.value === null ? null : figure.value > 0)

export const formationRoles = (node) => {
  const geo = rated(node.geo)
  const xeno = rated(node.xeno)
  const states = { geo, xeno, other: geo === true || xeno === true ? false : geo === false && xeno === false ? true : null }
  const list = GROUND_ROLES.filter((role) => states[role] === true)

  return { ...states, list, unknownRoles: GROUND_ROLES.filter((role) => states[role] === null), undetermined: list.length === 0 }
}

// The problems of `locate` that leave a location unresolved.
const UNRESOLVED_LOCATIONS = new Set(['unlocated', 'ship-missing', 'fleet-missing', 'population-missing', 'system-unknown'])

// Where a formation is and whether it is remote: stationed at no colony of the race. The game keeps a formation's colony (its population record, which exists with or without residents) apart from the ship it is embarked on; supply from logistics units, fortification, morale recovery and the survey and recovery work all need the colony, and a ship's presence in a colony's system does not give one. So a formation aboard a ship, or stored with neither, is remote; one at a colony of the race is not; one at a colony of another race is remote; and one whose colony the save does not hold, or does not say the race of, is null (not known). `system` is { id, name } only when the race's survey name for the system is stored (the system the race can open on its map), else null with the reasons in `reasons` ({ kind, message }, the model's own locate problems and `system-not-surveyed`).
export const formationPlace = (node, { RaceID }) => {
  const { location } = node
  const reasons = node.problems.filter((problem) => UNRESOLVED_LOCATIONS.has(problem.kind)).map(({ kind, message }) => ({ kind, message }))
  const named = Boolean(location.system) && typeof location.system.name === 'string' && location.system.name !== ''

  if (location.system && !named) {
    reasons.push({ kind: 'system-not-surveyed', message: `The race holds no survey name for system ${location.system.id}` })
  }

  const owner = location.population ? location.population.raceId : null
  const remote = location.kind === 'colony' ? (Number.isInteger(owner) ? owner !== RaceID : null) : true

  return { kind: location.kind, remote, system: named ? { id: location.system.id, name: location.system.name } : null, reasons }
}

// The formations `include(node, place, roles)` keeps (all by default), grouped by system: { formations, systems, unplaced }. `systems` is keyed by SystemID as a string, each { id, name, formations (ids), roles (formations in each role, undetermined as `unknown`), sets (formations by the roles they hold, '+'-joined, `unknown` for none) }; a formation in two roles is one entry of `formations` and counts once under each role. `unplaced` lists { id, reasons (kinds) } for kept formations with no known system, which are never given a system. Every kept formation is in exactly one place: formations = the systems' formations + unplaced.
export const groupBySystem = (model, include = () => true) => {
  const systems = {}
  const unplaced = []
  let formations = 0

  model.formations.forEach((node) => {
    const place = formationPlace(node, model)
    const roles = formationRoles(node)

    if (!include(node, place, roles)) {
      return
    }

    formations++

    if (!place.system) {
      unplaced.push({ id: node.id, reasons: place.reasons.map((reason) => reason.kind) })

      return
    }

    const key = String(place.system.id)
    const entry = systems[key] || (systems[key] = { id: place.system.id, name: place.system.name, formations: [], roles: { geo: 0, xeno: 0, other: 0, unknown: 0 }, sets: {} })
    const set = roles.list.join('+') || 'unknown'

    entry.formations.push(node.id)
    entry.sets[set] = (entry.sets[set] || 0) + 1

    if (roles.undetermined) {
      entry.roles.unknown++
    }

    roles.list.forEach((role) => {
      entry.roles[role]++
    })
  })

  return { formations, systems, unplaced }
}

// The roles of the formations `include(node, place, roles)` keeps (all by default): { formations, geo, xeno, other, both, unknown } where `both` is the formations in both geo and xeno (counted in each), `unknown` those with no role to count under, and formations = geo + xeno - both + other + unknown.
export const roleTotals = (model, include = () => true) => {
  const totals = { formations: 0, geo: 0, xeno: 0, other: 0, both: 0, unknown: 0 }

  model.formations.forEach((node) => {
    const roles = formationRoles(node)

    if (!include(node, formationPlace(node, model), roles)) {
      return
    }

    totals.formations++
    totals.both += roles.geo === true && roles.xeno === true ? 1 : 0
    totals.unknown += roles.undetermined ? 1 : 0
    roles.list.forEach((role) => {
      totals[role]++
    })
  })

  return totals
}

const columnsOf = async (database, table) => {
  const [rows] = await database.query(`select name from pragma_table_info('${table}')`)

  return new Set(rows.map((row) => row.name))
}

// The columns of `wanted` ({ [table]: [column] }, GROUND_FORMATION_COLUMNS by default) that a save lacks, as 'Table.Column' (or the table alone when it is not there).
export const missingColumns = async (database, wanted = GROUND_FORMATION_COLUMNS) => {
  const missing = []

  for (const [table, columns] of Object.entries(wanted)) {
    const present = await columnsOf(database, table)

    if (!present.size) {
      missing.push(table)
    } else {
      columns.filter((column) => !present.has(column)).forEach((column) => missing.push(`${table}.${column}`))
    }
  }

  return missing
}

// The rows of the formations of a game and a race, with SELECT statements only: { rows } or, for a save that lacks a table or column of GROUND_FORMATION_COLUMNS, { missing }. The template's Obsolete column is read when the save has it and is null otherwise.
const readRows = async (database, { GameID, RaceID }) => {
  requireIds({ GameID, RaceID })

  const missing = await missingColumns(database)

  if (missing.length) {
    return { missing }
  }

  const obsolete = (await columnsOf(database, 'FCT_GroundUnitFormationTemplate')).has('Obsolete')
  const stoWeapon = (await columnsOf(database, 'FCT_GroundUnitClass')).has('STOWeapon')
  const stoComponent = (await columnsOf(database, 'DIM_GroundComponentType')).has('STO')
  const statements = groundFormationSql({ GameID, RaceID, obsolete, stoWeapon, stoComponent })
  const rows = {}

  for (const [name, sql] of Object.entries(statements)) {
    ;[rows[name]] = await database.query(sql)
  }

  return { rows }
}

// Reads the model for a game and a race from the open save. A save that lacks a table or column of GROUND_FORMATION_COLUMNS gives { supported: false, missing } and no figures; otherwise { supported: true, ...model } (see `buildGroundFormations`). No commander is read: every post is `unread` and `holders` is { read: false, missing: [] }.
export const loadGroundFormations = async (database, { GameID, RaceID }) => {
  const { rows, missing } = await readRows(database, { GameID, RaceID })

  if (missing) {
    return { supported: false, missing, GameID, RaceID }
  }

  return { supported: true, ...buildGroundFormations(rows, { GameID, RaceID }) }
}

// The model of `loadGroundFormations` with the serving commander of each formation, read when the save has the columns of HOLDER_COLUMNS. `holders` says what the save lacks; the posts are `unread` when it lacks any.
export const loadGroundFormationPosts = async (database, { GameID, RaceID }) => {
  const { rows, missing } = await readRows(database, { GameID, RaceID })

  if (missing) {
    return { supported: false, missing, GameID, RaceID }
  }

  const holderGaps = await missingColumns(database, HOLDER_COLUMNS)

  if (!holderGaps.length) {
    ;[rows.commanders] = await database.query(holderSql({ GameID, RaceID }, [GROUND_POST]))
  }

  return { supported: true, ...buildGroundFormations(rows, { GameID, RaceID }), holders: { read: !holderGaps.length, missing: holderGaps } }
}

// The statements that read what an observation of a race's formations compares: each formation's place (colony, ship and the system of either) and its elements counted by class. Read apart from the model so that the recorder reads two small statements and no template, class or commander table.
export const formationObservationSql = ({ GameID, RaceID }) => {
  requireIds({ GameID, RaceID })

  return {
    formations: `select FCT_GroundUnitFormation.FormationID, FCT_GroundUnitFormation.PopulationID, FCT_GroundUnitFormation.ShipID, FCT_Population.SystemID as PopulationSystemID, coalesce(FCT_Fleet.SystemID, CarrierFleet.SystemID) as FleetSystemID from FCT_GroundUnitFormation left join FCT_Population on FCT_Population.PopulationID = FCT_GroundUnitFormation.PopulationID left join FCT_Ship on FCT_Ship.ShipID = FCT_GroundUnitFormation.ShipID left join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID left join FCT_Ship as Carrier on Carrier.ShipID = FCT_Ship.MothershipID left join FCT_Fleet as CarrierFleet on CarrierFleet.FleetID = Carrier.FleetID where FCT_GroundUnitFormation.GameID = ${GameID} and FCT_GroundUnitFormation.RaceID = ${RaceID} order by FCT_GroundUnitFormation.FormationID`,
    elements: `select FCT_GroundUnitFormationElement.FormationID, FCT_GroundUnitFormationElement.ClassID, count(*) as Elements, sum(FCT_GroundUnitFormationElement.Units) as Units from FCT_GroundUnitFormationElement where FCT_GroundUnitFormationElement.FormationID in (${OWN(GameID, RaceID)}) group by FCT_GroundUnitFormationElement.FormationID, FCT_GroundUnitFormationElement.ClassID order by FCT_GroundUnitFormationElement.FormationID, FCT_GroundUnitFormationElement.ClassID`,
  }
}

const orZero = (value) => (isNumber(value) ? value : 0)

// What an observation of a formation compares, as one text: where it is (colony, ship, and the system of the colony or of the ship's fleet) and what it holds (each class's elements and units). It says nothing of a name, a parent link or a template: renaming or regrouping a formation is not a move and does not restart its span. The text is the signature the recorder hashes; `[[FormationID, signature]]` in the order of the ids.
export const formationSignatures = ({ formations, elements }) => {
  const held = new Map()

  elements.forEach((row) => {
    if (!held.has(row.FormationID)) {
      held.set(row.FormationID, [])
    }

    held.get(row.FormationID).push(`${row.ClassID}x${orZero(row.Elements)}u${orZero(row.Units)}`)
  })

  return formations.map((row) => [row.FormationID, `${orZero(row.PopulationID)}/${orZero(row.ShipID)}/${orZero(row.PopulationSystemID)}/${orZero(row.FleetSystemID)}|${(held.get(row.FormationID) || []).join(',')}`])
}

// The formations of a race at the open save for an observation: `[[FormationID, signature]]`, read with `options` (the recorder's transaction). A save that lacks a table or column the statements read makes the statement fail, so the recorder notes a failed read and not an empty one.
export const readFormationObservations = async (database, { GameID, RaceID }, options = undefined) => {
  const statements = formationObservationSql({ GameID, RaceID })
  const [formations] = await database.query(statements.formations, options)
  const [elements] = await database.query(statements.elements, options)

  return formationSignatures({ formations, elements })
}
