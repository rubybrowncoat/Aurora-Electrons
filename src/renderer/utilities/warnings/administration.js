import { linkTo } from '../deep-links'
import { amount, checksOf, colonyText, COLONY_COLUMNS, COLONY_JOINS, figure, lacking, rowsOf, unknownCell, verdictRows } from './common'

export const group = { key: 'administration', title: 'Administration', summary: 'Review colonies, naval administrations and sectors missing a required governor or commander.' }

// The name of the colony a post is based at: blank where it has none (a colony id of 0), a dash with the unavailable result where its id or the colony's name is not stored.
const baseCell = (ctx, row) => row.PopName || (row.PopulationID === 0 ? '' : unknownCell(ctx, [row.PopulationID === null ? 'the colony the post is based at' : 'the name of the colony the post is based at']))

export const checks = checksOf([
  {
    key: 'governorless-populations',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'population') + ' without governor',
    rule: 'A colony with people on it has no governor.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_Population.Population', 'FCT_Commander.CommandID', 'FCT_Commander.CommandType'],
      note: 'A presence check on stored rows: a colony with a stored population above 0 that no governor (a commander row of command type 3) is assigned to. A commander of another command type whose command id equals the colony\'s, such as an academy commandant or a ground formation\'s commander, does not count. A colony whose population is not stored is listed apart, as not evaluated.',
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'population', text: 'Population', align: 'end' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const populations = await rowsOf(ctx, `select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, (FCT_Population.Population > 0) as Verdict, ${COLONY_COLUMNS} from FCT_Population left join FCT_Commander on FCT_Population.PopulationID = FCT_Commander.CommandID and FCT_Commander.CommandType = 3 and FCT_Commander.GameID = ${GameID} ${COLONY_JOINS} where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} and FCT_Commander.CommanderID is NULL and (FCT_Population.Population > 0) is not 0 order by FCT_Population.Population desc`)

      return verdictRows(ctx, populations, {
        missing: (population) => lacking(population, { Population: 'the colony\'s population' }),
        build: (population) => ({
          id: `colony:${population.PopulationID}`,
          cells: {
            colony: colonyText(population),
            population: figure(ctx, population.Population, 'the colony\'s population', (known) => ctx.count(known * 1000000)),
          },
          link: linkTo.commanders({ colony: population.PopulationID }),
        }),
      })
    },
  },
  {
    key: 'commanderless-naval-administrations',
    group: group.key,
    severity: 'attention',
    title: (count) => amount(count, 'naval administration') + ' without commander',
    rule: 'A naval administration has no commander.',
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_NavalAdminCommand', 'FCT_Commander.CommandID', 'FCT_Commander.CommandType'],
      note: 'A presence check on stored rows: a naval administration that no commander row of command type 12 is assigned to. A commander of another command type whose command id equals the administration\'s, such as a ground formation\'s commander, does not count.',
    },
    columns: [
      { key: 'administration', text: 'Administration' },
      { key: 'colony', text: 'Colony' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const administrations = await rowsOf(ctx, `select FCT_NavalAdminCommand.NavalAdminCommandID, FCT_NavalAdminCommand.AdminCommandName, FCT_NavalAdminCommand.PopulationID, FCT_Population.PopName from FCT_NavalAdminCommand left join FCT_Commander on FCT_NavalAdminCommand.NavalAdminCommandID = FCT_Commander.CommandID and FCT_Commander.CommandType = 12 and FCT_Commander.GameID = ${GameID} left join FCT_Population on FCT_NavalAdminCommand.PopulationID = FCT_Population.PopulationID where FCT_NavalAdminCommand.GameID = ${GameID} and FCT_NavalAdminCommand.RaceID = ${RaceID} and FCT_Commander.CommanderID is NULL`)

      return administrations.map((administration) => ({
        id: `admin:${administration.NavalAdminCommandID}`,
        cells: {
          administration: administration.AdminCommandName,
          colony: baseCell(ctx, administration),
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
    evidence: {
      verification: 'confirmed',
      structure: ['FCT_SectorCommand', 'FCT_Commander.CommandID', 'FCT_Commander.CommandType'],
      note: 'A presence check on stored rows: a sector that no commander row of command type 4 is assigned to. A commander of another command type whose command id equals the sector\'s, such as a ground formation\'s commander, does not count.',
    },
    columns: [
      { key: 'sector', text: 'Sector' },
      { key: 'colony', text: 'Colony' },
    ],
    async read(ctx) {
      const { GameID, RaceID } = ctx

      const sectors = await rowsOf(ctx, `select FCT_SectorCommand.SectorCommandID, FCT_SectorCommand.SectorName, FCT_SectorCommand.PopulationID, FCT_Population.PopName from FCT_SectorCommand left join FCT_Commander on FCT_SectorCommand.SectorCommandID = FCT_Commander.CommandID and FCT_Commander.CommandType = 4 and FCT_Commander.GameID = ${GameID} left join FCT_Population on FCT_SectorCommand.PopulationID = FCT_Population.PopulationID where FCT_SectorCommand.GameID = ${GameID} and FCT_SectorCommand.RaceID = ${RaceID} and FCT_Commander.CommanderID is NULL`)

      return sectors.map((sector) => ({
        id: `sector:${sector.SectorCommandID}`,
        cells: {
          sector: sector.SectorName,
          colony: baseCell(ctx, sector),
        },
        link: linkTo.commanders(),
      }))
    },
  },
])
