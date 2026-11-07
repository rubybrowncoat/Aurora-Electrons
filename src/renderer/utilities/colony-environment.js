// Colony Outlook uses the planner's climate model rather than trying to invert the integer ReqInf total. The climate is a snapshot: it is not advanced along the population horizon.
import { loadBodies, loadRaceRules, loadSpecies } from './colonization-data'
import { environmentCostResult } from './colonies'
import { missingBodyInputs, missingSpeciesInputs, speciesLimits } from './habitability'
import { combine, isAvailable, unavailable } from './provenance'

export const loadColonyEnvironments = async (database, scope) => {
  const [bodies, species, race] = await Promise.all([loadBodies(database, scope), loadSpecies(database, scope), loadRaceRules(database, scope)])
  const speciesById = new Map(species.map((row) => [row.SpeciesID, speciesLimits(row)]))
  const environments = {}

  bodies.forEach((body) => body.OwnPopulations.forEach((population) => {
    const species = speciesById.get(population.SpeciesID)
    const missing = [...missingBodyInputs(body), ...(species ? missingSpeciesInputs(species) : ['the colony\'s species']), ...(Number.isFinite(race.ColonizationSkill) ? [] : ['the race\'s colonisation skill'])]
    const rule = 'habitability.colonyCost'

    environments[population.PopulationID] = missing.length ? unavailable({ rule, missing }) : environmentCostResult(body, species, race.ColonizationSkill)
  }))

  return environments
}

export const withColonyEnvironment = (colony, environments) => {
  const environment = environments[colony.PopulationID] || unavailable({ rule: 'habitability.colonyCost', missing: ['the colony\'s body and species climate'] })
  const value = isAvailable(environment) ? environment.value : null

  return { ...colony, EnvironmentCost: environment, CurrentColonyCost: value ? (value.colonisable ? value.current : -1) : null, MaximumColonyCost: value ? (value.colonisable ? value.worst : -1) : null }
}

// Keep membership decisions, but require occupied berths only for ships actually counted here. The retained Ark coordinate-membership rule is not certified by the workforce arithmetic.
export const orbitalPopulationResult = (ark, colony) => {
  const ambiguous = ark.ships.filter((ship) => !ship.orbit || (ship.orbit.counted && ship.orbit.SystemBodyID === colony.SystemBodyID && ship.orbit.PopulationID === null))

  if (ambiguous.length) {
    return unavailable({ rule: 'colonies.workers', missing: ['the colony assignment of orbital population'] })
  }

  const countedHere = (ship) => ship.orbit.counted && ship.orbit.PopulationID === colony.PopulationID
  const parts = Object.fromEntries(ark.ships.flatMap((ship) => [[`orbit ${ship.ShipID}`, ship.results.orbit], ...(countedHere(ship) ? [[`occupied ${ship.ShipID}`, ship.results.occupied]] : [])]))

  return combine({ rule: 'colonies.workers', parts, compute: (values) => ark.ships.reduce((sum, ship) => sum + (countedHere(ship) ? values[`occupied ${ship.ShipID}`] : 0), 0), units: 'M people' })
}
