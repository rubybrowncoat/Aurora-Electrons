import { linkTo } from '../deep-links'
import { amount, colonyText, COLONY_COLUMNS, COLONY_JOINS, rowsOf } from './common'

export const group = { key: 'administration', title: 'Administration', summary: 'Colonies, naval administrations and sectors that lack the governor or commander they need, so the posts can be filled.' }

export const checks = [
  {
    key: 'governorless-populations',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'population') + ' without governor',
    rule: 'A colony with people on it has no governor.',
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'population', text: 'Population', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, ${COLONY_COLUMNS} from FCT_Population left join FCT_Commander on FCT_Population.PopulationID = FCT_Commander.CommandID ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Commander.CommanderID is NULL and FCT_Population.Population > 0 order by FCT_Population.Population desc`)

      return populations.map((population) => ({
        id: `colony:${population.PopulationID}`,
        cells: {
          colony: colonyText(population),
          population: ctx.count(population.Population * 1000000),
        },
        link: linkTo.commanders({ colony: population.PopulationID }),
      }))
    },
  },
  {
    key: 'commanderless-naval-administrations',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'naval administration') + ' without commander',
    rule: 'A naval administration has no commander.',
    columns: [
      { key: 'administration', text: 'Administration' },
      { key: 'colony', text: 'Colony' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const administrations = await rowsOf(ctx, `select FCT_NavalAdminCommand.NavalAdminCommandID, FCT_NavalAdminCommand.AdminCommandName, FCT_Population.PopName from FCT_NavalAdminCommand left join FCT_Commander on FCT_NavalAdminCommand.NavalAdminCommandID = FCT_Commander.CommandID left join FCT_Population on FCT_NavalAdminCommand.PopulationID = FCT_Population.PopulationID where FCT_NavalAdminCommand.GameID = ${GameID} and FCT_NavalAdminCommand.RaceID = ${RaceID} and FCT_Commander.CommanderID is NULL`)

      return administrations.map((administration) => ({
        id: `admin:${administration.NavalAdminCommandID}`,
        cells: {
          administration: administration.AdminCommandName,
          colony: administration.PopName,
        },
        link: linkTo.commanders(),
      }))
    },
  },
  {
    key: 'commanderless-sectors',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'sector') + ' without commander',
    rule: 'A sector has no commander.',
    columns: [
      { key: 'sector', text: 'Sector' },
      { key: 'colony', text: 'Colony' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const sectors = await rowsOf(ctx, `select FCT_SectorCommand.SectorCommandID, FCT_SectorCommand.SectorName, FCT_Population.PopName from FCT_SectorCommand left join FCT_Commander on FCT_SectorCommand.SectorCommandID = FCT_Commander.CommandID left join FCT_Population on FCT_SectorCommand.PopulationID = FCT_Population.PopulationID where FCT_SectorCommand.GameID = ${GameID} and FCT_SectorCommand.RaceID = ${RaceID} and FCT_Commander.CommanderID is NULL`)

      return sectors.map((sector) => ({
        id: `sector:${sector.SectorCommandID}`,
        cells: {
          sector: sector.SectorName,
          colony: sector.PopName,
        },
        link: linkTo.commanders(),
      }))
    },
  },
]
