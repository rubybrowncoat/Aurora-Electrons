// The civilian mining summary of the Mineral Breakdown: per system, the bodies that could host a civilian mining complex of the race, split into the bodies a colony keeps off and those free, the race's largest colony there, the other race that controls the system, and the wealth the complexes move a year. It is the port of the game's civilian mining tab (the CMC Potential tab of the Economics window), which lists a system for every surveyed body meeting the deposit rule within reach of its star and for every colony of the race holding a complex. Evidence: docs/plans/backlog/evidence/AE-304-04.md.
//
// Available and blocked follow the founding rule the Minerals page and the Colonization Planner share (colonization.js `cmcBlocks`), not the tab's own body test: a colony with people, an automated mine, a civilian or ex-civilian mining complex, a mass driver or orbital miners at work keeps the complex off its body, and a body the race has banned is kept off too. The tab's own test reads the race's population records alone, counts a record with no orbital mining modules as blocking, and names neither a mass driver nor a complex; the two disagree on a body holding only an empty colony or orbital miners, and where they do this summary follows the founding rule. The check (scripts/check-cmc-summary.js) ports the tab beside it and reports every such body.

import { CMC_PURCHASE_COST, CMC_TAX_INCOME } from './cmc-policy'
import { CMC_MINERAL_IDS, depositReadable, qualifiesForCmc, wholeCapacity } from './minerals'
import { ofRule, registerRule, ruleSupports, unavailable, valueOrNull } from './provenance'

const SUMMARY_VERSIONS = ['3.2.x']

registerRule({
  id: 'cmcSummary.system',
  versions: SUMMARY_VERSIONS,
  units: 'bodies',
  verification: 'confirmed',
  structure: ['FCT_MineralDeposit.Amount, Accessibility', 'FCT_SystemBody.BodyClass, BodyTypeID, OrbitalDistance, Eccentricity', 'FCT_Star.ComponentNumber, OrbitingComponent, OrbitalDistance, Eccentricity', 'FCT_LagrangePoint.StarID, PlanetID', 'FCT_SystemBodySurveys.SystemBodyID', 'FCT_BannedBodies.SystemBodyID', 'FCT_Population.Population, SystemBodyID', 'FCT_PopulationInstallations.PlanetaryInstallationID, Amount', 'the undamaged orbital mining modules of the fleets'],
  note: 'The bodies of a system that could host a civilian mining complex. A system is listed, and its bodies are eligible, as the game\'s civilian mining tab lists them: every surveyed body with more than 10,000 t of Duranium or Gallicite at accessibility 0.7 or better within reach of its star, carrying no complex of the race. The split into the bodies free to host one and those a colony keeps off follows the founding rule the page and the Planner share, not the tab\'s own body test: a colony with people, an automated mine, a civilian or ex-civilian complex, a mass driver or orbital miners at work keeps the complex off its body, and a body the race has banned is kept off too. A body whose civilian mining complexes are not fully recorded, or whose Duranium or Gallicite deposit has no recorded amount or accessibility though it could still meet the rule, is counted in neither and listed apart.',
})

registerRule({
  id: 'cmcSummary.control',
  versions: SUMMARY_VERSIONS,
  units: 'race',
  verification: 'confirmed',
  structure: ['FCT_RaceSysSurvey.ControlRaceID', 'FCT_AlienRace.AlienRaceID, AlienRaceName, ViewRaceID'],
  note: 'The other race that controls a system, as the race\'s survey of the system records it and as the race\'s intelligence names that race. A system the race itself controls, or one no other race controls, has none.',
})

registerRule({
  id: 'cmcSummary.population',
  versions: SUMMARY_VERSIONS,
  units: 'million people',
  verification: 'confirmed',
  structure: ['FCT_Population.Population, SystemID'],
  note: 'The largest population of the race\'s colonies in a system, in millions, as stored; a system with no colony of the race has none. The game founds a civilian mining complex only in a system where a colony of the race holds more than 10 million people.',
})

registerRule({
  id: 'cmcSummary.wealth',
  versions: SUMMARY_VERSIONS,
  units: 'wealth/yr',
  verification: 'estimated',
  structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.CivilianInstallation, MiningProductionValue', 'FCT_Population.PurchaseCivilianMinerals', 'the civilian mining rates'],
  note: 'A year\'s wealth the complexes of a system move: 250 for each complex whose output the colony buys, 125 collected for each complex it taxes. The tab shows the full year at these rates whatever the complexes dig; the wealth ledger records the amounts actually charged, which are less while a complex produces only part of a year. Unknown while the number of complexes on a colony is not recorded, or for a save whose game rules are not known.',
})

const known = (value) => typeof value === 'number' && Number.isFinite(value)
const whole = wholeCapacity

// A Duranium or Gallicite deposit that does not meet the rule for certain but could: its amount or accessibility is not recorded, and what is recorded does not rule it out. The recorded part is tested at the best the unrecorded one allows.
const couldQualify = (deposit) => !depositReadable(deposit) && qualifiesForCmc({ Amount: known(deposit.Amount) ? deposit.Amount : Infinity, Accessibility: known(deposit.Accessibility) ? deposit.Accessibility : 1 })

// Whether a body's star and the body itself are in reach of a civilian mining complex: the page marks a body in reach of its star (`cmcBodyInReach`) and its star in reach (`cmcStarInReach`).
const reachOf = (body) => !!body.cmcInReach && !!body.cmcStarInReach

const mineralDeposits = (body) => (body.depositList || []).filter((deposit) => CMC_MINERAL_IDS.includes(deposit.MaterialID))

// One body's part in its system: whether it meets the deposit rule, whether it could and cannot be told, whether a complex of the race stands on it, whether its installations leave that open, and what keeps a complex off it.
const partOf = (body) => {
  const deposits = mineralDeposits(body)
  const quals = deposits.some(qualifiesForCmc)

  return {
    SystemID: body.SystemID,
    qualifies: reachOf(body) && quals,
    possible: reachOf(body) && !quals && deposits.some(couldQualify),
    active: (body.complexes || 0) > 0,
    complexUnknown: (body.complexGaps || 0) > 0,
    keptOff: !!body.cmcBlocked || !!body.banned,
  }
}

// A colony's complexes as the game counts them: the whole number of civilian mining complexes it holds, or null while an installation of the colony's is not fully recorded.
const complexesOf = (colony) => (known(colony.Complexes) && !(colony.ComplexGaps > 0) ? whole(Math.max(0, colony.Complexes), colony.ComplexesTerms) : null)

// The wealth a year of one colony's complexes, by the choice of its output; null while their number is not recorded.
const wealthOf = (colony) => {
  const complexes = complexesOf(colony)

  return complexes === null ? { choice: colony.PurchaseCivilianMinerals ? 'buy' : 'tax', value: null } : { choice: colony.PurchaseCivilianMinerals ? 'buy' : 'tax', value: complexes * (colony.PurchaseCivilianMinerals ? CMC_PURCHASE_COST : CMC_TAX_INCOME) }
}

const sumOf = (entries) => entries.reduce((total, value) => total + value, 0)

// A year's wealth of one side of the choice: 0 when no complex moves it, unknown while a complex count is, and unknown for a save whose rules the rates are not known to hold for.
const wealthResult = (entries, version) => {
  if (entries.some((entry) => entry.value === null)) {
    return unavailable({ rule: 'cmcSummary.wealth', missing: ['the number of civilian mining complexes on a colony in the system'] })
  }

  if (entries.length && ruleSupports('cmcSummary.wealth', version) !== true) {
    return unavailable({ rule: 'cmcSummary.wealth', missing: ['the civilian mining rates for the save\'s game version'] })
  }

  return ofRule({ rule: 'cmcSummary.wealth', value: sumOf(entries.map((entry) => entry.value)), inputs: { present: entries.length ? ['FCT_PopulationInstallations.Amount', 'the civilian mining rates'] : [] } })
}

const rowOf = (SystemID, system) => ({ SystemID, system, candidates: [], possible: 0, active: 0, activeUnknown: false, populations: [], complexes: [] })

const byName = (a, b) => a.name.localeCompare(b.name) || a.SystemID - b.SystemID

// The systems that hold a candidate body or a colony with a complex, in the tab's order by name; each with its figures as results. `bodies` are the page's body rows (SystemID, depositList, complexes, complexGaps, cmcInReach, cmcStarInReach, cmcBlocked, banned); `colonies` the race's colonies (SystemID, Population, Complexes, ComplexGaps, PurchaseCivilianMinerals); `systems` the known systems (SystemID, Name, ControllerName); `version` the save's formula version, which decides whether the wealth rates hold. `possible` counts the bodies that could qualify for want of a recorded deposit figure, in every system.
export const cmcSummary = ({ bodies = [], colonies = [], systems = [], version = null }) => {
  const systemById = new Map(systems.map((system) => [system.SystemID, system]))
  const rows = new Map()
  const rowFor = (SystemID) => {
    if (!rows.has(SystemID)) {
      rows.set(SystemID, rowOf(SystemID, systemById.get(SystemID) || null))
    }

    return rows.get(SystemID)
  }
  let possible = 0

  const parts = bodies.map((body) => ({ body, part: partOf(body) }))

  parts.forEach(({ body, part }) => {
    if (!part.qualifies && !part.complexUnknown && !part.possible) {
      return
    }

    const row = rowFor(body.SystemID)

    if (part.complexUnknown) {
      row.activeUnknown = true
    }

    if (part.qualifies && !part.active) {
      row.candidates.push(part)
    }
  })

  parts.forEach(({ body, part }) => {
    if (!part.possible) {
      return
    }

    possible += 1

    if (rows.has(body.SystemID)) {
      rows.get(body.SystemID).possible += 1
    }
  })

  colonies.forEach((colony) => {
    const complexes = complexesOf(colony)
    const row = rowFor(colony.SystemID)

    if (complexes === null) {
      row.activeUnknown = true
    }

    row.populations.push(colony.Population)

    if (complexes === null || complexes > 0) {
      row.complexes.push(wealthOf(colony))
    }

    if (complexes !== null && complexes > 0) {
      row.active += 1
    }
  })

  const listed = [...rows.values()].filter((row) => row.candidates.length > 0 || row.active > 0 || row.activeUnknown)
  const summaryRows = listed.map((row) => {
    const populations = row.populations.filter(known)
    const population = row.populations.every(known) ? Math.max(0, ...populations) : null
    const countsKnown = !row.activeUnknown && row.candidates.every((part) => !part.complexUnknown)
    const missingComplexes = ['the number of civilian mining complexes on a colony in the system']
    const populationResult = population === null ? unavailable({ rule: 'cmcSummary.population', missing: ['the population of a colony in the system'] }) : ofRule({ rule: 'cmcSummary.population', value: population, inputs: { present: ['FCT_Population.Population'] } })
    const countsResult = countsKnown ? ofRule({ rule: 'cmcSummary.system', value: row.active, inputs: { present: ['FCT_PopulationInstallations.Amount', 'FCT_MineralDeposit.Amount, Accessibility'] } }) : unavailable({ rule: 'cmcSummary.system', missing: missingComplexes })
    const income = wealthResult(row.complexes.filter((entry) => entry.choice === 'tax'), version)
    const expenditure = wealthResult(row.complexes.filter((entry) => entry.choice === 'buy'), version)

    return {
      key: row.SystemID,
      SystemID: row.SystemID,
      name: row.system ? row.system.Name : '',
      controller: row.system ? row.system.ControllerName || null : null,
      population,
      populationResult,
      founds: population === null ? null : population > 10,
      active: countsKnown ? row.active : null,
      available: countsKnown ? row.candidates.filter((part) => !part.keptOff).length : null,
      blocked: countsKnown ? row.candidates.filter((part) => part.keptOff).length : null,
      countsResult,
      possible: row.possible,
      income: valueOrNull(income),
      incomeResult: income,
      expenditure: valueOrNull(expenditure),
      expenditureResult: expenditure,
    }
  })

  return { rows: summaryRows.sort(byName), systems: summaryRows.length, possible }
}
