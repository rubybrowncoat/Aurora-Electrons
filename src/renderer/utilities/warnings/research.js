import { linkTo } from '../deep-links'
import * as decimal from '../decimal'
import { isKnownNumber } from '../math'
import { loadOrbitalCensus } from '../orbital-census'
import { getRule } from '../provenance'
import { loadNoResearchProjects } from '../research-data'
import { QUARTER, allOf, anyOf, amount, bandOf, bandWords, checksOf, colonyText, COLONY_COLUMNS, COLONY_JOINS, figure, lacking, rowsOf, signatureOf, tokenWords, unknownCell, verdictRows } from './common'

export const group = { key: 'research', title: 'Research', summary: 'Review idle labs, dead or forgotten projects and scientists working outside their field.' }

const LAB_INSTALLATIONS = 'the amount or the type of a research installation of the colony'
const PAUSED = 'whether the project is paused'
const ASSIGNED_LABS = 'the labs assigned to the project'

// Research and administration counts must be nonnegative whole numbers within Int32; unsupported saved counts remain unavailable.
const MAX_COUNT = 2147483647
const isCount = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_COUNT
const wholeCount = (value) => decimal.toInteger(decimal.floor(value))

// Sum decimal installation amounts times their research values, then truncate the effective capacity once.
const EMPTY_CAPACITY = { Labs: 0, LabGaps: 0, Known: 0, TypeGaps: 0 }
const researchCapacity = async (ctx) => {
  const { GameID } = ctx
  const installations = await rowsOf(ctx, `select FCT_PopulationInstallations.PopID, FCT_PopulationInstallations.Amount, DIM_PlanetaryInstallation.ResearchValue from FCT_PopulationInstallations left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${GameID}`)
  const capacities = new Map()

  for (const installation of installations) {
    if (installation.Amount === 0) {
      continue
    }

    const capacity = capacities.get(installation.PopID) || { Labs: decimal.ZERO, LabGaps: 0, Known: 0, TypeGaps: 0 }
    const value = isKnownNumber(installation.ResearchValue) ? decimal.fromDouble(installation.ResearchValue) : null

    if (value === null) {
      capacity.LabGaps += 1
      capacity.TypeGaps += 1
    } else if (decimal.positive(value)) {
      capacity.Known += 1

      if (isKnownNumber(installation.Amount)) {
        capacity.Labs = decimal.add(capacity.Labs, decimal.multiply(decimal.fromDouble(installation.Amount), value))
      } else {
        capacity.LabGaps += 1
      }
    }

    capacities.set(installation.PopID, capacity)
  }

  for (const capacity of capacities.values()) {
    capacity.Labs = wholeCount(capacity.Labs)

    if (!isCount(capacity.Labs)) {
      capacity.Labs = 0
      capacity.LabGaps += 1
    }
  }

  return capacities
}

// Missing installation lines can change a zero known whole capacity, but cannot erase a proven whole lab. A missing pause or assignment flag likewise remains unknown only while it can change the predicate.
const hasLabs = (project) => project.Labs > 0 ? 1 : project.LabGaps > 0 ? null : 0
const DEAD = (project) => allOf(isKnownNumber(project.Pause) ? project.Pause === 0 : null, hasLabs(project) === null ? null : hasLabs(project) === 0)
const STALLED = (project) => anyOf(isKnownNumber(project.Pause) ? project.Pause !== 0 : null, allOf(hasLabs(project), isKnownNumber(project.Facilities) ? project.Facilities === 0 : null))

// Read operands before deciding the project condition: filtering a binary SQL capacity first can discard the very row whose exact decimal total reaches a whole lab.
const researchProjects = async (ctx, condition) => {
  const { GameID, RaceID } = ctx
  const projects = await rowsOf(ctx, `select FCT_ResearchProject.ProjectID, FCT_ResearchProject.PopulationID, FCT_ResearchProject.TechID, FCT_ResearchProject.Facilities, FCT_ResearchProject.Pause, FCT_TechSystem.Name as ResearchName, FCT_Population.PopulationID as ColonyID, FCT_Population.PopName, ${COLONY_COLUMNS} from FCT_ResearchProject left join FCT_Population on FCT_Population.PopulationID = FCT_ResearchProject.PopulationID and FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} ${COLONY_JOINS} left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_ResearchProject.TechID where FCT_ResearchProject.GameID = ${GameID} and FCT_ResearchProject.RaceID = ${RaceID} order by FCT_Population.PopName, FCT_ResearchProject.ProjectID`)
  const capacities = await researchCapacity(ctx)

  for (const project of projects) {
    Object.assign(project, capacities.get(project.PopulationID) || EMPTY_CAPACITY)
    project.Facilities = isCount(project.Facilities) ? project.Facilities : null
    project.Verdict = condition(project)
  }

  return projects.filter((project) => project.Verdict !== 0)
}

const projectRow = (project, cells, signature = undefined) => ({
  id: `project:${project.ProjectID}`,
  cells: {
    colony: project.ColonyID ? colonyText(project) : `Colony ${project.PopulationID} (missing from the save)`,
    project: project.ResearchName || `Unnamed technology ${project.TechID}`,
    ...cells,
  },
  link: linkTo.techTree(),
  ...(signature === undefined ? {} : { signature }),
})

// A race that starts no research projects has no idle-lab or dead-project fault; an unstored setting remains unknown.
const NO_RESEARCH_SETTING = 'the race\'s No Research Projects setting'

const noResearchOf = async (ctx) => (await loadNoResearchProjects(ctx.database, ctx)).value

// The colony's effective whole research facilities: a dash while an installation's type or amount is not stored.
const labsCell = (ctx, project) => figure(ctx, project.LabGaps > 0 ? null : project.Labs, LAB_INSTALLATIONS)

export const checks = checksOf([
  // Free facilities are allocated only where player research is processed; the census owns the population decision.
  {
    key: 'idle-research-labs',
    group: group.key,
    severity: 'attention',
    material: 'the idle share crossing 25% of the labs',
    captured: [bandWords('idle share under 25% of the labs', 'idle share at 25% or more of the labs')],
    title: (count) => amount(count, 'colony with idle research labs', 'colonies with idle research labs'),
    rule: 'A colony has whole research facilities left after its stored assignments and, where research is processed, automatic allocation to projects set to take new labs automatically up to their scientists\' administration limits. A race that starts no research projects is not checked.',
    evidence: {
      verification: 'estimated',
      versions: ['3.2.x'],
      structure: ['the shared surface and orbital population census and the race\'s research-processing settings', 'the amount and research value of the colony\'s installations', 'the assigned labs and automatic-assignment settings of its projects', 'the assigned scientists and their administration ratings'],
      note: 'The whole weighted research-facility total is compared with stored assignments. For a colony with surface or orbital people whose race is neither non-player-controlled nor Ancient, free facilities are allocated to projects set to take new labs automatically up to each scientist\'s whole Research Administration rating before unused facilities are counted. A colony skipped by research processing receives no predicted allocation, and its free labs remain idle. The figures apply that allocation to the stored snapshot, including paused projects, not a forecast of later changes. Missing installation, assignment or processing inputs that could change the allocation are listed apart, as not evaluated. A race whose No Research Projects setting is on is not checked, and a colony of a race whose setting is not stored is listed apart, as not evaluated.',
      assumptions: getRule('population.orbitalCensus').assumptions,
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'labs', text: 'Whole lab capacity', align: 'end' },
      { key: 'used', text: 'Allocated after automatic assignment', align: 'end' },
    ],
    async read(ctx) {
      const exempt = await noResearchOf(ctx)

      if (exempt === true) {
        return []
      }

      const { GameID, RaceID } = ctx

      const candidates = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Race.NPR, FCT_Race.SpecialNPRID, case when VIR_PopulationResearch.Gaps > 0 then null else coalesce(VIR_PopulationResearch.Facilities, 0) end as OccupiedFacilities, ${COLONY_COLUMNS} from FCT_Population left join FCT_Race on FCT_Race.GameID = FCT_Population.GameID and FCT_Race.RaceID = ${RaceID} ${COLONY_JOINS} left join (select FCT_ResearchProject.PopulationID, SUM(FCT_ResearchProject.Facilities) as Facilities, sum(case when FCT_ResearchProject.Facilities is null then 1 else 0 end) as Gaps from FCT_ResearchProject where FCT_ResearchProject.GameID = ${GameID} and FCT_ResearchProject.RaceID = ${RaceID} group by FCT_ResearchProject.PopulationID) as VIR_PopulationResearch on FCT_Population.PopulationID = VIR_PopulationResearch.PopulationID where FCT_Population.GameID = ${GameID} and (FCT_Population.RaceID = ${RaceID} or FCT_Population.RaceID is null) order by FCT_Population.PopulationID`)
      const capacities = await researchCapacity(ctx)
      const populations = []

      for (const population of candidates) {
        const capacity = capacities.get(population.PopulationID) || EMPTY_CAPACITY

        Object.assign(population, capacity)
        population.OccupiedFacilities = isCount(population.OccupiedFacilities) ? population.OccupiedFacilities : null
        population.AvailableFacilities = capacity.LabGaps > 0 ? null : capacity.Labs
        population.Verdict = allOf(capacity.Known > 0 ? 1 : capacity.TypeGaps > 0 ? null : 0, isKnownNumber(population.AvailableFacilities) && isKnownNumber(population.OccupiedFacilities) ? population.AvailableFacilities > population.OccupiedFacilities : null)

        if (population.Verdict !== 0) {
          populations.push(population)
        }
      }

      if (populations.length) {
        // Descending project order changes which projects receive facilities, not the total unused count.
        const projects = await rowsOf(ctx, `select FCT_ResearchProject.PopulationID, FCT_ResearchProject.Facilities, FCT_ResearchProject.AssignNew, case when FCT_Commander.CommanderID is null then null when FCT_CommanderBonuses.CommanderID is null then 0 else FCT_CommanderBonuses.BonusValue end as Admin from FCT_ResearchProject left join FCT_Commander on FCT_Commander.CommandID = FCT_ResearchProject.ProjectID and FCT_Commander.CommandType = 7 and FCT_Commander.GameID = ${GameID} and FCT_Commander.RaceID = ${RaceID} left join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 27 where FCT_ResearchProject.GameID = ${GameID} and FCT_ResearchProject.RaceID = ${RaceID}`)
        const roomByColony = new Map()
        const census = await loadOrbitalCensus(ctx.database, ctx)

        for (const project of projects) {
          const room = roomByColony.get(project.PopulationID) || { known: 0, gaps: false }

          if (project.AssignNew !== 0) {
            // Round the loaded administration bonus to three places before taking its whole-lab limit.
            const admin = isKnownNumber(project.Admin) ? wholeCount(decimal.round(decimal.fromDouble(project.Admin), 3)) : null
            const availableRoom = isCount(admin) && isCount(project.Facilities) ? Math.max(0, admin - project.Facilities) : null

            if (availableRoom !== 0) {
              if (!isKnownNumber(project.AssignNew) || availableRoom === null) {
                room.gaps = true
              } else {
                room.known += availableRoom
              }
            }
          }

          roomByColony.set(project.PopulationID, room)
        }

        for (const population of populations) {
          const room = roomByColony.get(population.PopulationID) || { known: 0, gaps: false }
          const counted = census.get(population.PopulationID)
          population.RaceMatches = counted?.raceMatches ?? null

          const entry = allOf(population.RaceMatches, counted?.hasPopulation.value, population.NPR === 0 ? 1 : population.NPR === 1 ? 0 : null, isKnownNumber(population.SpecialNPRID) ? population.SpecialNPRID !== 6 : null)

          population.PopulationMissing = counted ? [...(counted.raceMatches === null ? ['the colony race'] : []), ...counted.hasPopulation.inputs.missing] : ['the colony population census']

          population.AllocationGaps = false

          if (isKnownNumber(population.AvailableFacilities) && isKnownNumber(population.OccupiedFacilities) && population.AvailableFacilities > population.OccupiedFacilities) {
            const used = Math.min(population.AvailableFacilities, population.OccupiedFacilities + (entry === 0 ? 0 : room.known))

            population.ProcessingGaps = entry === null && (room.known > 0 || room.gaps)
            population.AllocationGaps = population.ProcessingGaps || (entry !== 0 && room.gaps && used < population.AvailableFacilities)
            population.OccupiedFacilities = population.AllocationGaps ? null : used
            population.Verdict = population.AllocationGaps ? null : population.AvailableFacilities > used
          }
        }
      }

      return verdictRows(ctx, populations, {
        verdict: (population) => allOf(population.RaceMatches, population.Verdict, exempt === null ? null : 1),
        missing: (population) => [
          ...(population.RaceMatches === null ? ['the colony race'] : []),
          ...(population.Known > 0 || !(population.TypeGaps > 0) ? [] : ['the type of an installation of the colony']),
          ...(isKnownNumber(population.AvailableFacilities) ? [] : ['the amount of a research facility of the colony']),
          ...(isKnownNumber(population.OccupiedFacilities) ? [] : [population.AllocationGaps ? 'the automatic-assignment setting or scientist administration limit of a research project' : 'the labs assigned to a research project of the colony']),
          ...(population.ProcessingGaps ? ['the colony\'s surface or orbital population, or the race\'s research-processing status', ...population.PopulationMissing] : []),
          ...(exempt === null ? [NO_RESEARCH_SETTING] : []),
        ],
        build: (population) => ({
          id: `colony:${population.PopulationID}`,
          cells: {
            colony: colonyText(population),
            labs: figure(ctx, population.AvailableFacilities, 'the amount of a research facility of the colony'),
            used: figure(ctx, population.OccupiedFacilities, population.AllocationGaps ? 'the automatic-assignment setting or scientist administration limit of a research project' : 'the labs assigned to a research project of the colony'),
          },
          link: linkTo.techTree(),
          signature: signatureOf(bandOf(isKnownNumber(population.AvailableFacilities) && isKnownNumber(population.OccupiedFacilities) && population.AvailableFacilities > 0 ? (population.AvailableFacilities - population.OccupiedFacilities) / population.AvailableFacilities : null, [QUARTER])),
        }),
      })
    },
  },
  // A nonpaused project with no whole effective research capacity cannot advance.
  {
    key: 'dead-research-projects',
    group: group.key,
    severity: 'needs-action',
    title: (count) => amount(count, 'dead research project'),
    rule: 'A research project that is not paused sits at a colony with less than one whole research facility of effective capacity, so it cannot advance with the stored capacity. Paused projects and projects with no labs assigned at a colony with whole capacity are listed apart. A race that starts no research projects is not checked.',
    evidence: {
      verification: 'confirmed',
      versions: ['3.2.x'],
      structure: ['whether the project is paused and its assigned labs', 'the amount and research value of the colony\'s installations'],
      note: 'Research is processed only with a positive whole weighted sum of installation amounts times their research value; fractional capacity below one supplies no whole facility. A nonpaused project at a colony with zero whole capacity cannot advance with that capacity, regardless of its assigned labs. Missing paused flags or installation data that could change the zero-capacity verdict are listed apart, as not evaluated. A race whose No Research Projects setting is on is not checked, and a project of a race whose setting is not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'project', text: 'Project' },
      { key: 'labs', text: 'Whole lab capacity', align: 'end' },
      { key: 'assigned', text: 'Labs assigned', align: 'end' },
    ],
    async read(ctx) {
      const exempt = await noResearchOf(ctx)

      if (exempt === true) {
        return []
      }

      const projects = await researchProjects(ctx, DEAD)

      return verdictRows(ctx, projects, {
        verdict: (project) => allOf(project.Verdict, exempt === null ? null : 1),
        missing: (project) => [...lacking(project, { Pause: PAUSED }), ...(project.Labs > 0 || !(project.LabGaps > 0) ? [] : [LAB_INSTALLATIONS]), ...(exempt === null ? [NO_RESEARCH_SETTING] : [])],
        build: (project) => projectRow(project, { labs: labsCell(ctx, project), assigned: figure(ctx, project.Facilities, ASSIGNED_LABS) }),
      })
    },
  },
  // Automatic allocation precedes progress; this warning reports the stored assignment inventory.
  {
    key: 'stalled-research-projects',
    group: group.key,
    severity: 'info',
    material: 'the project going from paused to unassigned, or back',
    captured: [tokenWords({ paused: 'paused', unassigned: 'unassigned' })],
    title: (count) => amount(count, 'paused or unassigned research project'),
    rule: 'The stored snapshot has a paused research project, or a project with no labs assigned at a colony with whole lab capacity. This is an assignment inventory, not a claim that player action is required: the game can assign free labs automatically before research advances. A nonpaused project with zero whole capacity is a dead project instead.',
    evidence: {
      verification: 'confirmed',
      versions: ['3.2.x'],
      structure: ['whether the project is paused and its assigned labs', 'the amount and research value of the colony\'s installations'],
      note: 'The paused flag and assigned facilities are stored inventory facts; colony capacity is counted in whole facilities. Free labs are allocated to projects set to accept them before progress, so zero stored assignment does not establish a need for player action. A project whose paused flag or assigned labs are missing, or whose missing installation data could change the capacity-presence verdict, is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'project', text: 'Project' },
      { key: 'status', text: 'Status' },
      { key: 'assigned', text: 'Labs assigned', align: 'end' },
    ],
    async read(ctx) {
      const projects = await researchProjects(ctx, STALLED)

      return verdictRows(ctx, projects, {
        missing: (project) => [...lacking(project, { Pause: PAUSED, Facilities: ASSIGNED_LABS }), ...(project.Labs > 0 || !(project.LabGaps > 0) ? [] : [LAB_INSTALLATIONS])],
        build: (project) => projectRow(project, {
          status: project.Pause === null ? unknownCell(ctx, [PAUSED]) : project.Pause ? 'Paused' : 'No labs assigned',
          assigned: figure(ctx, project.Facilities, ASSIGNED_LABS),
        }, signatureOf(isKnownNumber(project.Pause) ? (project.Pause ? 'paused' : 'unassigned') : null)),
      })
    },
  },
  {
    key: 'forgotten-prototypes',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'research prototype') + ' with no project',
    rule: 'A component is marked for research but no lab is researching it and no colony has it queued.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_ShipDesignComponents.Prototype', 'FCT_ResearchProject', 'FCT_ResearchQueue'],
      note: 'A presence check on stored rows: a component marked for research with no project and no queue entry. A component whose research mark is not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'component', text: 'Component' },
      { key: 'type', text: 'Type' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const components = await rowsOf(ctx, `select FCT_ShipDesignComponents.SDComponentID, FCT_ShipDesignComponents.Name, FCT_ShipDesignComponents.Prototype, (FCT_ShipDesignComponents.Prototype = 3) as Verdict, DIM_ComponentType.TypeDescription from FCT_RaceTech inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_RaceTech.TechID left join DIM_ComponentType on DIM_ComponentType.ComponentTypeID = FCT_ShipDesignComponents.ComponentTypeID where FCT_RaceTech.GameID = ${GameID} and FCT_RaceTech.RaceID = ${RaceID} and (FCT_ShipDesignComponents.Prototype = 3) is not 0 and not exists (select 1 from FCT_ResearchProject where FCT_ResearchProject.TechID = FCT_RaceTech.TechID and FCT_ResearchProject.RaceID = FCT_RaceTech.RaceID and FCT_ResearchProject.GameID = FCT_RaceTech.GameID) and not exists (select 1 from FCT_ResearchQueue inner join FCT_Population on FCT_Population.PopulationID = FCT_ResearchQueue.PopulationID where FCT_ResearchQueue.TechSystemID = FCT_RaceTech.TechID and FCT_ResearchQueue.GameID = FCT_RaceTech.GameID and FCT_Population.RaceID = FCT_RaceTech.RaceID) order by FCT_ShipDesignComponents.Name`)

      return verdictRows(ctx, components, {
        missing: (component) => lacking(component, { Prototype: 'whether the component is marked for research' }),
        build: (component) => ({
          id: `component:${component.SDComponentID}`,
          cells: {
            component: component.Name,
            type: component.TypeDescription,
          },
          link: linkTo.techTree(),
        }),
      })
    },
  },
  {
    key: 'mismatched-research-fields',
    group: group.key,
    severity: 'attention',
    material: 'the project field or the scientist\'s specialty changing',
    captured: [(token) => `research field ${token}`, (token) => `specialty ${token}`],
    title: (count) => amount(count, 'researcher') + ' with mismatched projects',
    rule: 'A scientist leads a project outside their own research field.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_Commander.ResSpecID', 'FCT_TechSystem.TechTypeID', 'DIM_TechType.FieldID', 'FCT_ResearchProject.ResearchPointsRequired'],
      note: 'A comparison of two stored fields: the scientist\'s specialty against the field of the project\'s technology. A scientist leading a project whose field, or whose own specialty, is not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'commander', text: 'Researcher' },
      { key: 'project', text: 'Project' },
      { key: 'field', text: 'Project field' },
      { key: 'specialty', text: 'Specialty' },
      { key: 'points', text: 'RP required', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const FIELD = 'the research field of the project\'s technology'
      const SPECIALTY = 'the research specialty of the scientist'
      const MISMATCH = '(case when FCT_Commander.CommanderID is null then 0 else (DIM_ResearchField.ResearchFieldID != DIM_ResearchField_2.ResearchFieldID) end)'

      const scientists = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, ${COLONY_COLUMNS}, FCT_Commander.CommanderID, FCT_Commander.Name as CommanderName, DIM_ResearchField_2.FieldName as CommanderFieldName, FCT_TechSystem.Name as ResearchName, DIM_ResearchField.FieldName, DIM_ResearchField.ResearchFieldID as FieldID, DIM_ResearchField_2.ResearchFieldID as SpecialtyID, FCT_ResearchProject.ResearchPointsRequired, ${MISMATCH} as Verdict from FCT_ResearchProject inner join FCT_Population on FCT_ResearchProject.PopulationID = FCT_Population.PopulationID ${COLONY_JOINS} left join FCT_TechSystem on FCT_ResearchProject.TechID = FCT_TechSystem.TechSystemID left join DIM_TechType on FCT_TechSystem.TechTypeID = DIM_TechType.TechTypeID left join DIM_ResearchField on DIM_TechType.FieldID = DIM_ResearchField.ResearchFieldID left join FCT_Commander on FCT_ResearchProject.ProjectID = FCT_Commander.CommandID and FCT_Commander.CommanderType = 3 left join DIM_ResearchField as DIM_ResearchField_2 on FCT_Commander.ResSpecID = DIM_ResearchField_2.ResearchFieldID where FCT_ResearchProject.GameID = ${GameID} and FCT_ResearchProject.RaceID = ${RaceID} and ${MISMATCH} is not 0`)

      return verdictRows(ctx, scientists, {
        missing: (scientist) => lacking(scientist, { FieldID: FIELD, SpecialtyID: SPECIALTY }),
        build: (scientist) => ({
          id: `commander:${scientist.CommanderID}`,
          cells: {
            commander: scientist.CommanderName,
            project: scientist.ResearchName,
            field: scientist.FieldName || unknownCell(ctx, [FIELD]),
            specialty: scientist.CommanderFieldName || unknownCell(ctx, [SPECIALTY]),
            points: figure(ctx, scientist.ResearchPointsRequired, 'the research points the project requires', (known) => ctx.count(known, 1)),
          },
          caption: colonyText(scientist),
          link: linkTo.commanders({ commander: scientist.CommanderID }),
          signature: signatureOf(scientist.FieldID, scientist.SpecialtyID),
        }),
      })
    },
  },
])
