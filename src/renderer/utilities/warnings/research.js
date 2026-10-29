import { linkTo } from '../deep-links'
import { isKnownNumber } from '../math'
import { QUARTER, amount, bandOf, bandWords, checksOf, colonyText, COLONY_COLUMNS, COLONY_JOINS, figure, lacking, rowsOf, signatureOf, tokenWords, unknownCell, verdictRows } from './common'

export const group = { key: 'research', title: 'Research', summary: 'Idle labs, dead or forgotten projects and scientists working outside their field.' }

const LAB_INSTALLATIONS = 'the amount or the type of a research installation of the colony'
const PAUSED = 'whether the project is paused'
const ASSIGNED_LABS = 'the labs assigned to the project'

// Whether the colony has research installations, as 1, or null while an installation's type or amount is not stored and none is known to be a lab, and the labs themselves.
const HAS_LABS = '(case when VIR_Labs.Labs > 0 then 1 when VIR_Labs.Gaps > 0 then null else 0 end)'
const DEAD = `(FCT_ResearchProject.Pause = 0 and not ${HAS_LABS})`
const STALLED = `(FCT_ResearchProject.Pause <> 0 or (${HAS_LABS} and FCT_ResearchProject.Facilities = 0))`

// One row per research project of the race, from `FCT_ResearchProject` (its own `ProjectID` is the row id), with the lab total of its colony: the Amount of the colony's installations that carry a `ResearchValue`, 0 where it has none, and `Gaps` the installations whose type or amount is not stored. `condition` is the check's condition over `Pause`, `Facilities` and the labs; each row carries it as `Verdict`, null while a stored value it needs is missing. The colony and the technology are left joins, so a project whose colony or technology the save lacks still shows.
const researchProjectQuery = ({ GameID, RaceID }, condition) => `select FCT_ResearchProject.ProjectID, FCT_ResearchProject.PopulationID, FCT_ResearchProject.TechID, FCT_ResearchProject.Facilities, FCT_ResearchProject.Pause, ${condition} as Verdict, FCT_TechSystem.Name as ResearchName, FCT_Population.PopulationID as ColonyID, FCT_Population.PopName, ${COLONY_COLUMNS}, coalesce(VIR_Labs.Labs, 0) as Labs, coalesce(VIR_Labs.Gaps, 0) as LabGaps from FCT_ResearchProject left join FCT_Population on FCT_Population.PopulationID = FCT_ResearchProject.PopulationID and FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} ${COLONY_JOINS} left join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_ResearchProject.TechID left join (select FCT_PopulationInstallations.PopID, SUM(case when DIM_PlanetaryInstallation.ResearchValue > 0 then FCT_PopulationInstallations.Amount else 0 end) as Labs, sum(case when DIM_PlanetaryInstallation.ResearchValue is null or (DIM_PlanetaryInstallation.ResearchValue > 0 and FCT_PopulationInstallations.Amount is null) then 1 else 0 end) as Gaps from FCT_PopulationInstallations left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${GameID} and (DIM_PlanetaryInstallation.ResearchValue > 0 or DIM_PlanetaryInstallation.ResearchValue is null) group by FCT_PopulationInstallations.PopID) as VIR_Labs on VIR_Labs.PopID = FCT_ResearchProject.PopulationID where FCT_ResearchProject.GameID = ${GameID} and FCT_ResearchProject.RaceID = ${RaceID} and ${condition} is not 0 order by FCT_Population.PopName, FCT_ResearchProject.ProjectID`

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

// The labs of the colony: a dash while an installation's type or amount is not stored.
const labsCell = (ctx, project) => figure(ctx, project.LabGaps > 0 ? null : project.Labs, LAB_INSTALLATIONS)

export const checks = checksOf([
  {
    key: 'idle-research-labs',
    group: group.key,
    severity: 'attention',
    material: 'the idle share crossing 25% of the labs',
    captured: [bandWords('idle share under 25% of the labs', 'idle share at 25% or more of the labs')],
    title: (count) => amount(count, 'colony with idle research labs', 'colonies with idle research labs'),
    rule: 'A colony has more research facilities than its projects use, so some labs sit idle.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.ResearchValue', 'FCT_ResearchProject.Facilities'],
      note: 'A count comparison on stored rows: the colony\'s research facilities against the labs its projects are assigned. A colony with an installation\'s type or amount, or a project\'s assigned labs, not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'labs', text: 'Labs', align: 'end' },
      { key: 'used', text: 'In use', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select VIR_Facilities.*, ((case when VIR_Facilities.Known > 0 then 1 when VIR_Facilities.TypeGaps > 0 then null else 0 end) and VIR_Facilities.AvailableFacilities > VIR_Facilities.OccupiedFacilities) as Verdict from (select FCT_Population.PopulationID, FCT_Population.PopName, case when sum(case when DIM_PlanetaryInstallation.ResearchValue > 0 and FCT_PopulationInstallations.Amount is null then 1 else 0 end) > 0 then null else SUM(case when DIM_PlanetaryInstallation.ResearchValue > 0 then FCT_PopulationInstallations.Amount else 0 end) end as AvailableFacilities, sum(case when DIM_PlanetaryInstallation.ResearchValue > 0 then 1 else 0 end) as Known, sum(case when DIM_PlanetaryInstallation.ResearchValue is null then 1 else 0 end) as TypeGaps, case when VIR_PopulationResearch.Gaps > 0 then null else coalesce(VIR_PopulationResearch.Facilities, 0) end as OccupiedFacilities, ${COLONY_COLUMNS} from FCT_Population join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID left join DIM_PlanetaryInstallation ON FCT_PopulationInstallations.PlanetaryInstallationID = DIM_PlanetaryInstallation.PlanetaryInstallationID ${COLONY_JOINS} left join (select FCT_ResearchProject.PopulationID, SUM(FCT_ResearchProject.Facilities) as Facilities, sum(case when FCT_ResearchProject.Facilities is null then 1 else 0 end) as Gaps from FCT_ResearchProject where FCT_ResearchProject.GameID = ${GameID} and FCT_ResearchProject.RaceID = ${RaceID} group by FCT_ResearchProject.PopulationID) as VIR_PopulationResearch on FCT_Population.PopulationID = VIR_PopulationResearch.PopulationID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and (DIM_PlanetaryInstallation.ResearchValue > 0 or DIM_PlanetaryInstallation.ResearchValue is null) GROUP BY FCT_Population.PopulationID) as VIR_Facilities where Verdict is not 0 order by VIR_Facilities.PopulationID`)

      return verdictRows(ctx, populations, {
        missing: (population) => [
          ...(population.Known > 0 || !(population.TypeGaps > 0) ? [] : ['the type of an installation of the colony']),
          ...(isKnownNumber(population.AvailableFacilities) ? [] : ['the amount of a research facility of the colony']),
          ...(isKnownNumber(population.OccupiedFacilities) ? [] : ['the labs assigned to a research project of the colony']),
        ],
        build: (population) => ({
          id: `colony:${population.PopulationID}`,
          cells: {
            colony: colonyText(population),
            labs: figure(ctx, population.AvailableFacilities, 'the amount of a research facility of the colony'),
            used: figure(ctx, population.OccupiedFacilities, 'the labs assigned to a research project of the colony'),
          },
          link: linkTo.techTree(),
          signature: signatureOf(bandOf(isKnownNumber(population.AvailableFacilities) && isKnownNumber(population.OccupiedFacilities) && population.AvailableFacilities > 0 ? (population.AvailableFacilities - population.OccupiedFacilities) / population.AvailableFacilities : null, [QUARTER])),
        }),
      })
    },
  },
  {
    key: 'dead-research-projects',
    group: group.key,
    severity: 'needs-action',
    title: (count) => amount(count, 'dead research project'),
    rule: 'A research project that is not paused sits at a colony with no research facilities installed (none at all, or only other installations, or labs of zero amount), so it never advances. Paused projects and projects with no labs assigned are listed apart.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_ResearchProject.Pause, Facilities', 'FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.ResearchValue'],
      note: 'A count comparison on stored rows: a project not paused at a colony with no research facilities. A project whose paused flag is not stored, or whose colony has an installation\'s type or amount not stored and no lab known, is listed apart, as not evaluated; labs assigned that are not stored show a dash.',
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'project', text: 'Project' },
      { key: 'labs', text: 'Labs installed', align: 'end' },
      { key: 'assigned', text: 'Labs assigned', align: 'end' },
    ],
    async read(ctx) {
      const projects = await rowsOf(ctx, researchProjectQuery(ctx, DEAD))

      return verdictRows(ctx, projects, {
        missing: (project) => [...lacking(project, { Pause: PAUSED }), ...(project.Labs > 0 || !(project.LabGaps > 0) ? [] : [LAB_INSTALLATIONS])],
        build: (project) => projectRow(project, { labs: labsCell(ctx, project), assigned: figure(ctx, project.Facilities, ASSIGNED_LABS) }),
      })
    },
  },
  {
    key: 'stalled-research-projects',
    group: group.key,
    severity: 'info',
    material: 'the project going from paused to unassigned, or back',
    captured: [tokenWords({ paused: 'paused', unassigned: 'unassigned' })],
    title: (count) => amount(count, 'paused or unassigned research project'),
    rule: 'A research project is paused, or sits at a colony with labs while none of them are assigned to it, so it makes no progress until the player acts. A project at a colony with no labs at all is a dead project instead.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_ResearchProject.Pause, Facilities', 'FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.ResearchValue'],
      note: 'A flag and count comparison on stored rows: a paused project, or one with no labs assigned at a colony that has labs. A project whose paused flag or assigned labs are not stored, or whose colony has an installation\'s type or amount not stored and no lab known, is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'project', text: 'Project' },
      { key: 'status', text: 'Status' },
      { key: 'assigned', text: 'Labs assigned', align: 'end' },
    ],
    async read(ctx) {
      const projects = await rowsOf(ctx, researchProjectQuery(ctx, STALLED))

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
