import { linkTo } from '../deep-links'
import { isKnownNumber, roundToDecimal } from '../math'
import { amount, anyOf, checksOf, colonyText, COLONY_COLUMNS, COLONY_JOINS, figure, lacking, levelTone, rowsOf, unknownCell, verdictRows } from './common'

export const group = { key: 'colonies', title: 'Colonies', summary: 'Colonies that are inefficient, stockpiling minerals or wasting their mines and terraformers, so what holds them back can be fixed.' }

const POPULATION = 'the colony\'s population'
const OUTPUT_PER_UNIT = 'the output per unit of an installation'
const INSTALLATION_AMOUNT = 'the amount of an installation'

const installationText = (item) => `${isKnownNumber(item.Amount) ? `${item.Amount}x` : 'An unknown number of'} ${item.Name || 'an unknown installation'}`

// One row per colony from a query with a row per installation: `valueKey` is the installation's output per unit, and each row carries `Verdict` (the check's condition for that installation or colony, null while a stored value it needs is missing). A colony is a warning when any of its rows is one, and not evaluated when none is and one is null. Its total output is a dash, naming what is missing, when an amount or an output per unit is; such colonies come last.
const installationRows = (ctx, items, valueKey, link, missing) => {
  const colonies = Object.values(items.reduce((aggregate, item) => {
    if (!aggregate[item.PopulationID]) {
      aggregate[item.PopulationID] = { ...item, Installations: [], TotalProductionValue: 0, Gaps: new Set(), Verdict: 0 }
    }

    const colony = aggregate[item.PopulationID]

    colony.Installations.push(installationText(item))

    if (!isKnownNumber(item[valueKey])) {
      colony.Gaps.add(OUTPUT_PER_UNIT)
    } else if (!isKnownNumber(item.Amount)) {
      colony.Gaps.add(INSTALLATION_AMOUNT)
    } else {
      colony.TotalProductionValue += item[valueKey] * item.Amount
    }

    colony.Verdict = anyOf(item.Verdict, colony.Verdict)

    return aggregate
  }, {}))

  const ordered = colonies.sort((alpha, beta) => (alpha.Gaps.size > 0) - (beta.Gaps.size > 0) || beta.TotalProductionValue - alpha.TotalProductionValue)

  return verdictRows(ctx, ordered, {
    missing: (colony) => [...missing(colony), ...colony.Gaps],
    build: (colony) => ({
      id: `colony:${colony.PopulationID}`,
      cells: {
        colony: colonyText(colony),
        installations: colony.Installations.join(', '),
        output: colony.Gaps.size ? unknownCell(ctx, [...colony.Gaps]) : ctx.count(colony.TotalProductionValue, 1),
      },
      link: link(colony),
    }),
  })
}

// One row per colony of a query that selects `Verdict`; `cell(population)` gives the cells after the colony's name.
const populationRows = (ctx, populations, { missing, cell, link = (population) => linkTo.colonyOutlook(population.PopulationID) }) => verdictRows(ctx, populations, {
  missing,
  build: (population) => ({
    id: `colony:${population.PopulationID}`,
    cells: { colony: colonyText(population), ...cell(population) },
    link: link(population),
  }),
})

const LOW_EFFICIENCY = '(FCT_Population.Efficiency < 1 and FCT_Population.Population > 0)'

const SELF_SUSTAINING = '(FCT_Population.Efficiency = 1 and FCT_Population.Population > 10 and FCT_Population.Capital = 0 and FCT_Population.ColonistDestination = 0)'

const STOCKPILING = '(FCT_Population.PurchaseCivilianMinerals = 1 and FCT_Population.MassDriverDest = 0)'

// Whether the colony has mines and drivers, as 1, or null while an installation's amount or type is missing, and whether a body has a deposit: SQLite's three-valued logic, in the query and the verdict.
const MINES = '(case when VIR_Installations.Mines > 0 then 1 when VIR_Installations.MineGaps > 0 then null else 0 end)'
const DRIVERS = '(case when VIR_Installations.Drivers > 0 then 1 when VIR_Installations.DriverGaps > 0 then null else 0 end)'
const DEPOSITS = '(case when exists (select 1 from FCT_MineralDeposit where FCT_MineralDeposit.SystemBodyID = FCT_Population.SystemBodyID and FCT_MineralDeposit.GameID = FCT_Population.GameID and FCT_MineralDeposit.Amount > 0) then 1 when exists (select 1 from FCT_MineralDeposit where FCT_MineralDeposit.SystemBodyID = FCT_Population.SystemBodyID and FCT_MineralDeposit.GameID = FCT_Population.GameID and FCT_MineralDeposit.Amount is null) then null else 0 end)'
const ORPHAN = `(${MINES} and ${DRIVERS} and FCT_Population.MassDriverDest = 0 and ${DEPOSITS})`

export const checks = checksOf([
  {
    key: 'low-efficiency-populations',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'low efficiency population'),
    rule: 'A colony with people on it runs at under 100% efficiency, which scales what its factories, mines and labs produce.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_Population.Efficiency', 'FCT_Population.Population'],
      note: 'The condition is a stored efficiency under 1 on a colony with people. The colour of the efficiency (above 85% good, under 30% bad) is this page\'s choice, not a figure the game states. A colony whose efficiency or population is not stored is listed apart, as not evaluated.',
      assumptions: ['The colour bands of the efficiency (85% and 30%) are a choice of this page.'],
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'efficiency', text: 'Efficiency', align: 'end' },
      { key: 'population', text: 'Population', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Efficiency, FCT_Population.Population, ${LOW_EFFICIENCY} as Verdict, ${COLONY_COLUMNS} from FCT_Population ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and ${LOW_EFFICIENCY} is not 0 order by FCT_Population.Efficiency asc, FCT_Population.Population desc`)

      return populationRows(ctx, populations, {
        missing: (population) => lacking(population, { Efficiency: 'the colony\'s efficiency', Population: POPULATION }),
        cell: (population) => ({
          efficiency: figure(ctx, population.Efficiency, 'the colony\'s efficiency', (known) => `${roundToDecimal(known * 100, 1)}%`, levelTone),
          population: figure(ctx, population.Population, POPULATION, (known) => ctx.count(known * 1000000)),
        }),
      })
    },
  },
  {
    key: 'self-sustaining-destinations',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'self-sustaining colonist destination'),
    rule: 'A colony of more than 10 million at full efficiency that isn\'t the capital is not a colonist destination, so its people no longer need to be shipped there.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_Population.Efficiency', 'FCT_Population.Population', 'FCT_Population.Capital', 'FCT_Population.ColonistDestination'],
      note: 'The 10 million threshold is a rule of this page, not a figure the game states; the efficiency, capital and destination flags are stored values. A colony with any of them not stored is listed apart, as not evaluated.',
      assumptions: ['A colony above 10 million at full efficiency no longer needs colonists shipped to it.'],
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'population', text: 'Population', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Efficiency, FCT_Population.Population, FCT_Population.Capital, FCT_Population.ColonistDestination, ${SELF_SUSTAINING} as Verdict, ${COLONY_COLUMNS} from FCT_Population ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and ${SELF_SUSTAINING} is not 0 order by FCT_Population.Population desc`)

      return populationRows(ctx, populations, {
        missing: (population) => lacking(population, { Efficiency: 'the colony\'s efficiency', Population: POPULATION, Capital: 'whether the colony is the capital', ColonistDestination: 'whether the colony is a colonist destination' }),
        cell: (population) => ({ population: figure(ctx, population.Population, POPULATION, (known) => ctx.count(known * 1000000)) }),
      })
    },
  },
  {
    key: 'stockpiling-civilian-minerals',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'stockpiling civilian mining colony', 'stockpiling civilian mining colonies'),
    rule: 'A colony buys its civilian mining complexes\' output and has no mass driver destination, so the minerals pile up there.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_Population.PurchaseCivilianMinerals', 'FCT_Population.MassDriverDest', 'FCT_Population mineral stockpiles'],
      note: 'A presence check on two stored flags; the stockpile shown is the sum of the stored mineral columns. A colony with a flag not stored is listed apart, as not evaluated; a stockpile with a mineral not stored shows a dash.',
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'stock', text: 'Stockpile', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.PurchaseCivilianMinerals, FCT_Population.MassDriverDest, FCT_Population.Duranium + FCT_Population.Neutronium + FCT_Population.Corbomite + FCT_Population.Tritanium + FCT_Population.Boronide + FCT_Population.Mercassium + FCT_Population.Vendarite + FCT_Population.Sorium + FCT_Population.Uridium + FCT_Population.Corundium + FCT_Population.Gallicite as TotalStockpile, ${STOCKPILING} as Verdict, ${COLONY_COLUMNS} from FCT_Population ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and ${STOCKPILING} is not 0 order by TotalStockpile desc`)

      return populationRows(ctx, populations, {
        missing: (population) => lacking(population, { PurchaseCivilianMinerals: 'whether the colony buys civilian minerals', MassDriverDest: 'the colony\'s mass driver destination' }),
        cell: (population) => ({ stock: figure(ctx, population.TotalStockpile, 'a mineral stockpile of the colony', (known) => `${ctx.count(known)} t`) }),
      })
    },
  },
  {
    key: 'wasted-mining-capacity',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'colony with wasted mining capacity', 'colonies with wasted mining capacity'),
    rule: 'A colony has mines but no mineral deposit on its body, so they produce nothing.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MiningProductionValue', 'FCT_MineralDeposit.MaterialID'],
      note: 'A presence check on stored rows: an installation with a mining value on a body with no deposit row. A colony with an installation whose mining value is not stored is listed apart, as not evaluated; a total with an amount or value not stored shows a dash.',
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'installations', text: 'Mines' },
      { key: 'output', text: 'Mining value', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const items = await rowsOf(ctx, `
          select DIM_PlanetaryInstallation.Name, DIM_PlanetaryInstallation.MiningProductionValue, (DIM_PlanetaryInstallation.MiningProductionValue > 0) as Verdict, FCT_PopulationInstallations.Amount, FCT_Population.PopulationID, FCT_Population.PopName, ${COLONY_COLUMNS} from FCT_Population

          ${COLONY_JOINS}

          join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID
          left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID
          left join FCT_MineralDeposit ON FCT_Population.SystemBodyID = FCT_MineralDeposit.SystemBodyID

          where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and (DIM_PlanetaryInstallation.MiningProductionValue > 0) is not 0 and FCT_MineralDeposit.MaterialID is null
        `)

      return installationRows(ctx, items, 'MiningProductionValue', (colony) => linkTo.colonyOutlook(colony.PopulationID), () => [])
    },
  },
  {
    key: 'wasted-terraforming-capacity',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'colony with wasted terraforming capacity', 'colonies with wasted terraforming capacity'),
    rule: 'A colony has terraforming installations but no gas selected to add or remove, so they change nothing.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_Population.TerraformingGasID', 'FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.TerraformValue'],
      note: 'A presence check on stored rows: terraforming installations on a colony whose stored gas selection is 0. A colony whose gas selection is not stored is listed apart, as not evaluated; a total with an amount or value not stored shows a dash.',
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'installations', text: 'Installations' },
      { key: 'output', text: 'Terraform value', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const items = await rowsOf(ctx, `
          select DIM_PlanetaryInstallation.Name, DIM_PlanetaryInstallation.TerraformValue, FCT_Population.TerraformingGasID, (FCT_Population.TerraformingGasID = 0) as Verdict, FCT_PopulationInstallations.Amount, FCT_Population.PopulationID, FCT_Population.PopName, ${COLONY_COLUMNS} from FCT_Population

          ${COLONY_JOINS}

          join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID
          join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID

          where (FCT_Population.TerraformingGasID = 0) is not 0 AND DIM_PlanetaryInstallation.Name = 'Terraforming Installation' and FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}
        `)

      return installationRows(ctx, items, 'TerraformValue', (colony) => linkTo.planner({ bodies: [colony] }), (colony) => lacking(colony, { TerraformingGasID: 'the gas the colony terraforms with' }))
    },
  },
  {
    key: 'mass-driver-orphans',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'mining colony', 'mining colonies') + ' without a mass driver destination',
    rule: 'A colony mines, has mass drivers and shares its system with other colonies but sends nothing anywhere, so minerals pile up where they\'re dug; colonies that receive packets themselves are left out.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MassDriverValue', 'FCT_Population.MassDriverDest', 'FCT_MineralDeposit.Amount', 'FCT_SystemBodySurveys'],
      note: 'A presence check on stored rows: mines and mass drivers on a surveyed body with a deposit, no destination, and another colony of the race in the system. A colony with an installation amount or type, the destination or a deposit amount not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'mines', text: 'Mines', align: 'end' },
      { key: 'drivers', text: 'Drivers', align: 'end' },
      { key: 'others', text: 'Colonies here', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.MassDriverDest, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, VIR_Installations.Mines, VIR_Installations.MineGaps, VIR_Installations.Drivers, VIR_Installations.DriverGaps, ${DEPOSITS} as Deposits, ${ORPHAN} as Verdict, (select count(*) from FCT_Population as VIR_Other where VIR_Other.SystemID = FCT_Population.SystemID and VIR_Other.RaceID = FCT_Population.RaceID and VIR_Other.GameID = FCT_Population.GameID and VIR_Other.PopulationID <> FCT_Population.PopulationID) as OtherColonies from FCT_Population inner join (select FCT_PopulationInstallations.PopID, sum(case when FCT_PopulationInstallations.PlanetaryInstallationID in (7, 12, 48) then FCT_PopulationInstallations.Amount else 0 end) as Mines, sum(case when FCT_PopulationInstallations.PlanetaryInstallationID in (7, 12, 48) and FCT_PopulationInstallations.Amount is null then 1 else 0 end) as MineGaps, sum(case when DIM_PlanetaryInstallation.MassDriverValue > 0 then FCT_PopulationInstallations.Amount else 0 end) as Drivers, sum(case when DIM_PlanetaryInstallation.PlanetaryInstallationID is null or DIM_PlanetaryInstallation.MassDriverValue is null or (DIM_PlanetaryInstallation.MassDriverValue > 0 and FCT_PopulationInstallations.Amount is null) then 1 else 0 end) as DriverGaps from FCT_PopulationInstallations left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${GameID} group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID and (VIR_Installations.Mines > 0 or VIR_Installations.MineGaps > 0) and (VIR_Installations.Drivers > 0 or VIR_Installations.DriverGaps > 0) inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_Population.SystemBodyID and FCT_SystemBodySurveys.RaceID = FCT_Population.RaceID and FCT_SystemBodySurveys.GameID = FCT_Population.GameID left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_Population.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and ${ORPHAN} is not 0 and exists (select 1 from FCT_Population as VIR_Other where VIR_Other.SystemID = FCT_Population.SystemID and VIR_Other.RaceID = FCT_Population.RaceID and VIR_Other.GameID = FCT_Population.GameID and VIR_Other.PopulationID <> FCT_Population.PopulationID) and not exists (select 1 from FCT_Population as VIR_Sender where VIR_Sender.MassDriverDest = FCT_Population.PopulationID and VIR_Sender.GameID = FCT_Population.GameID) order by FCT_Population.PopName`)

      const MINES_NAME = 'the amount of the colony\'s mines'
      const DRIVERS_NAME = 'the amount or the type of an installation of the colony'

      return verdictRows(ctx, populations, {
        missing: (population) => [
          ...(population.Mines > 0 || !(population.MineGaps > 0) ? [] : [MINES_NAME]),
          ...(population.Drivers > 0 || !(population.DriverGaps > 0) ? [] : [DRIVERS_NAME]),
          ...lacking(population, { MassDriverDest: 'the colony\'s mass driver destination' }),
          ...(population.Deposits === null ? ['the amount of a mineral deposit on the body'] : []),
        ],
        build: (population) => ({
          id: `colony:${population.PopulationID}`,
          cells: {
            colony: colonyText(population),
            mines: figure(ctx, population.MineGaps > 0 ? null : population.Mines, MINES_NAME),
            drivers: figure(ctx, population.DriverGaps > 0 ? null : population.Drivers, DRIVERS_NAME),
            others: ctx.count(population.OtherColonies),
          },
          link: linkTo.colonyOutlook(population.PopulationID),
        }),
      })
    },
  },
])
