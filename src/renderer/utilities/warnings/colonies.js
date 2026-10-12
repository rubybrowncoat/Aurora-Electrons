import { linkTo } from '../deep-links'
import { roundToDecimal } from '../math'
import { amount, colonyText, COLONY_COLUMNS, COLONY_JOINS, levelTone, rowsOf } from './common'

export const group = { key: 'colonies', title: 'Colonies', summary: 'Colonies that are inefficient, stockpiling minerals or wasting their mines and terraformers, so I can fix what holds them back.' }

// One row per colony from a query with a row per installation: `valueKey` is the installation's output per unit.
const installationRows = (ctx, items, valueKey, link) => {
  const colonies = Object.values(items.reduce((aggregate, item) => {
    if (!aggregate[item.PopulationID]) {
      aggregate[item.PopulationID] = { ...item, Installations: [], TotalProductionValue: 0 }
    }

    aggregate[item.PopulationID].Installations.push(`${item.Amount}x ${item.Name}`)
    aggregate[item.PopulationID].TotalProductionValue += item[valueKey] * item.Amount

    return aggregate
  }, {}))

  return colonies.sort((alpha, beta) => beta.TotalProductionValue - alpha.TotalProductionValue).map((colony) => ({
    id: `colony:${colony.PopulationID}`,
    cells: {
      colony: colonyText(colony),
      installations: colony.Installations.join(', '),
      output: ctx.count(colony.TotalProductionValue, 1),
    },
    link: link(colony),
  }))
}

const populationRows = (populations, cell, link = (population) => linkTo.colonyOutlook(population.PopulationID)) => populations.map((population) => ({
  id: `colony:${population.PopulationID}`,
  cells: { colony: colonyText(population), ...cell(population) },
  link: link(population),
}))

export const checks = [
  {
    key: 'low-efficiency-populations',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'low efficiency population'),
    rule: 'A colony with people on it runs at under 100% efficiency, which scales what its factories, mines and labs produce.',
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'efficiency', text: 'Efficiency', align: 'end' },
      { key: 'population', text: 'Population', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Efficiency, FCT_Population.Population, ${COLONY_COLUMNS} from FCT_Population ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Population.Efficiency < 1 and FCT_Population.Population > 0 order by FCT_Population.Efficiency asc, FCT_Population.Population desc`)

      return populationRows(populations, (population) => ({
        efficiency: { text: `${roundToDecimal(population.Efficiency * 100, 1)}%`, tone: levelTone(population.Efficiency) },
        population: ctx.count(population.Population * 1000000),
      }))
    },
  },
  {
    key: 'self-sustaining-destinations',
    group: group.key,
    severity: 'info',
    title: (count) => amount(count, 'self-sustaining colonist destination'),
    rule: 'A colony of more than 10 million at full efficiency that isn\'t my capital is not a colonist destination, so its people no longer need to be shipped there.',
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'population', text: 'Population', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, ${COLONY_COLUMNS} from FCT_Population ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Population.Efficiency = 1 and FCT_Population.Population > 10 and FCT_Population.Capital = 0 and FCT_Population.ColonistDestination = 0 order by FCT_Population.Population desc`)

      return populationRows(populations, (population) => ({ population: ctx.count(population.Population * 1000000) }))
    },
  },
  {
    key: 'stockpiling-civilian-minerals',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'stockpiling civilian mining colony', 'stockpiling civilian mining colonies'),
    rule: 'A colony buys its civilian mining complexes\' output and has no mass driver destination, so the minerals pile up there.',
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'stock', text: 'Stockpile', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Duranium + FCT_Population.Neutronium + FCT_Population.Corbomite + FCT_Population.Tritanium + FCT_Population.Boronide + FCT_Population.Mercassium + FCT_Population.Vendarite + FCT_Population.Sorium + FCT_Population.Uridium + FCT_Population.Corundium + FCT_Population.Gallicite as TotalStockpile, ${COLONY_COLUMNS} from FCT_Population ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Population.PurchaseCivilianMinerals = 1 and MassDriverDest = 0 order by TotalStockpile desc`)

      return populationRows(populations, (population) => ({ stock: `${ctx.count(population.TotalStockpile)} t` }))
    },
  },
  {
    key: 'wasted-mining-capacity',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'colony with wasted mining capacity', 'colonies with wasted mining capacity'),
    rule: 'A colony has mines but no mineral deposit on its body, so they produce nothing.',
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'installations', text: 'Mines' },
      { key: 'output', text: 'Mining value', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const items = await rowsOf(ctx, `
          select DIM_PlanetaryInstallation.Name, DIM_PlanetaryInstallation.MiningProductionValue, FCT_PopulationInstallations.Amount, FCT_Population.PopulationID, FCT_Population.PopName, ${COLONY_COLUMNS} from FCT_Population

          ${COLONY_JOINS}

          join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID
          left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID
          left join FCT_MineralDeposit ON FCT_Population.SystemBodyID = FCT_MineralDeposit.SystemBodyID

          where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and DIM_PlanetaryInstallation.MiningProductionValue > 0 and FCT_MineralDeposit.MaterialID is null
        `)

      return installationRows(ctx, items, 'MiningProductionValue', (colony) => linkTo.colonyOutlook(colony.PopulationID))
    },
  },
  {
    key: 'wasted-terraforming-capacity',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'colony with wasted terraforming capacity', 'colonies with wasted terraforming capacity'),
    rule: 'A colony has terraforming installations but no gas selected to add or remove, so they change nothing.',
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'installations', text: 'Installations' },
      { key: 'output', text: 'Terraform value', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const items = await rowsOf(ctx, `
          select DIM_PlanetaryInstallation.Name, DIM_PlanetaryInstallation.TerraformValue, FCT_PopulationInstallations.Amount, FCT_Population.PopulationID, FCT_Population.PopName, ${COLONY_COLUMNS} from FCT_Population

          ${COLONY_JOINS}

          join FCT_PopulationInstallations on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID
          join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID

          where FCT_Population.TerraformingGasID = 0 AND DIM_PlanetaryInstallation.Name = 'Terraforming Installation' and FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}
        `)

      return installationRows(ctx, items, 'TerraformValue', (colony) => linkTo.planner({ bodies: [colony] }))
    },
  },
  {
    key: 'mass-driver-orphans',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'mining colony', 'mining colonies') + ' without a mass driver destination',
    rule: 'A colony mines, has mass drivers and shares its system with other colonies but sends nothing anywhere, so minerals pile up where they\'re dug; colonies that receive packets themselves are left out.',
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'mines', text: 'Mines', align: 'end' },
      { key: 'drivers', text: 'Drivers', align: 'end' },
      { key: 'others', text: 'Colonies here', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_RaceSysSurvey.Name as SystemName, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_Star.Component, VIR_Installations.Mines, VIR_Installations.Drivers, (select count(*) from FCT_Population as VIR_Other where VIR_Other.SystemID = FCT_Population.SystemID and VIR_Other.RaceID = FCT_Population.RaceID and VIR_Other.GameID = FCT_Population.GameID and VIR_Other.PopulationID <> FCT_Population.PopulationID) as OtherColonies from FCT_Population inner join (select FCT_PopulationInstallations.PopID, sum(case when FCT_PopulationInstallations.PlanetaryInstallationID in (7, 12, 48) then FCT_PopulationInstallations.Amount else 0 end) as Mines, sum(case when DIM_PlanetaryInstallation.MassDriverValue > 0 then FCT_PopulationInstallations.Amount else 0 end) as Drivers from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${GameID} group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID and VIR_Installations.Mines > 0 and VIR_Installations.Drivers > 0 inner join FCT_SystemBodySurveys on FCT_SystemBodySurveys.SystemBodyID = FCT_Population.SystemBodyID and FCT_SystemBodySurveys.RaceID = FCT_Population.RaceID and FCT_SystemBodySurveys.GameID = FCT_Population.GameID left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_Population.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Population.MassDriverDest = 0 and exists (select 1 from FCT_MineralDeposit where FCT_MineralDeposit.SystemBodyID = FCT_Population.SystemBodyID and FCT_MineralDeposit.GameID = FCT_Population.GameID and FCT_MineralDeposit.Amount > 0) and exists (select 1 from FCT_Population as VIR_Other where VIR_Other.SystemID = FCT_Population.SystemID and VIR_Other.RaceID = FCT_Population.RaceID and VIR_Other.GameID = FCT_Population.GameID and VIR_Other.PopulationID <> FCT_Population.PopulationID) and not exists (select 1 from FCT_Population as VIR_Sender where VIR_Sender.MassDriverDest = FCT_Population.PopulationID and VIR_Sender.GameID = FCT_Population.GameID) order by FCT_Population.PopName`)

      return populationRows(populations, (population) => ({
        mines: ctx.count(population.Mines),
        drivers: ctx.count(population.Drivers),
        others: ctx.count(population.OtherColonies),
      }))
    },
  },
]
