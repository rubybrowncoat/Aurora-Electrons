// The production types of an industrial project (`FCT_IndustrialProjects.ProductionType`), what each is called and the capacity it draws on. One list for every reader, so a type the app names is never classified by a second table.
//
// The game numbers the production types Construction 0, Ordnance 1, LightNaval 2, Components 3, SpaceStation 4, EngineeringProjects 5, OrdnanceProjects 6, GroundUnitProjects 7. The capacity a project draws on follows from its type, which the game sets when it loads or creates the project, and the build points of a cycle are taken from it: Ground Unit Projects, Engineering Projects, Components, Construction and Space Station draw on construction capacity, Ordnance and Ordnance Projects on ordnance capacity, Light Naval on light naval (fighter) capacity. The colony's project list the game draws groups the types the same way, and the game limits each capacity's running projects to 100%.

export const PRODUCTION_TYPE = Object.freeze({
  CONSTRUCTION: 0,
  ORDNANCE: 1,
  LIGHT_NAVAL: 2,
  COMPONENTS: 3,
  SPACE_STATION: 4,
  ENGINEERING_PROJECTS: 5,
  ORDNANCE_PROJECTS: 6,
  GROUND_UNIT_PROJECTS: 7,
})

// The name of each type as the Industry jobs of the Production page give it.
export const PRODUCTION_TYPE_NAMES = Object.freeze({
  [PRODUCTION_TYPE.CONSTRUCTION]: 'Construction',
  [PRODUCTION_TYPE.ORDNANCE]: 'Ordnance',
  [PRODUCTION_TYPE.LIGHT_NAVAL]: 'Light Naval',
  [PRODUCTION_TYPE.COMPONENTS]: 'Component',
  [PRODUCTION_TYPE.SPACE_STATION]: 'Space station',
  [PRODUCTION_TYPE.ENGINEERING_PROJECTS]: 'Engineering project',
  [PRODUCTION_TYPE.ORDNANCE_PROJECTS]: 'Ordnance project',
  [PRODUCTION_TYPE.GROUND_UNIT_PROJECTS]: 'Ground unit project',
})

// What each development project develops: the stored table of the item its `ProductionID` names (the id is that of the component, the missile or the ground unit class, by type).
export const DEVELOPMENT_ITEMS = Object.freeze({
  [PRODUCTION_TYPE.ENGINEERING_PROJECTS]: 'component',
  [PRODUCTION_TYPE.ORDNANCE_PROJECTS]: 'missile',
  [PRODUCTION_TYPE.GROUND_UNIT_PROJECTS]: 'ground unit class',
})

const ORDNANCE_TYPES = Object.freeze([PRODUCTION_TYPE.ORDNANCE, PRODUCTION_TYPE.ORDNANCE_PROJECTS])
const FIGHTER_TYPES = Object.freeze([PRODUCTION_TYPE.LIGHT_NAVAL])

// Whether the type is one of the three projects that develop a race-designed item (an Engineering, Ordnance or Ground Unit Project).
export const isDevelopmentType = (productionType) => Object.prototype.hasOwnProperty.call(DEVELOPMENT_ITEMS, productionType)

// The capacity a project of the type draws on: 'ordnance', 'fighter' (light naval) or 'construction', which is every other type the save holds, the development projects included.
export const capacityKind = (productionType) => (ORDNANCE_TYPES.includes(productionType) ? 'ordnance' : FIGHTER_TYPES.includes(productionType) ? 'fighter' : 'construction')

// The types drawing on one capacity, as the list of a SQL `in (...)`.
export const typesOf = (kind) => Object.values(PRODUCTION_TYPE).filter((productionType) => capacityKind(productionType) === kind)

// The clause that keeps a row of `FCT_IndustrialProjects` to the projects the game loads: the game skips a row whose race, colony, species (`SpeciesID` of the game's `FCT_Species`) or wealth use (`DIM_WealthUse`) the game does not hold, so such a row is no project of the game and the readers that count the development projects leave it out. The table is named in full so that the capability scan sees the columns; the clause stands in a `where` beside the game and race tests.
export const loadedProject = () => 'FCT_IndustrialProjects.RaceID in (select FCT_Race.RaceID from FCT_Race where FCT_Race.GameID = FCT_IndustrialProjects.GameID) and FCT_IndustrialProjects.PopulationID in (select FCT_Population.PopulationID from FCT_Population where FCT_Population.GameID = FCT_IndustrialProjects.GameID) and FCT_IndustrialProjects.SpeciesID in (select FCT_Species.SpeciesID from FCT_Species where FCT_Species.GameID = FCT_IndustrialProjects.GameID) and FCT_IndustrialProjects.WealthUse in (select DIM_WealthUse.WealthUseID from DIM_WealthUse)'
