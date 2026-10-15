import { linkTo, place } from '../deep-links'
import { isKnownNumber, roundToDecimal } from '../math'
import { deliveryVerdict } from '../mining-sites'
import { assessRedeployment, assetText, unknownInputs } from '../mining-redeployment'
import { QUARTER, amount, anyOf, bandOf, bandWords, bodyText, categoriesOf, checksOf, colonyText, COLONY_COLUMNS, COLONY_JOINS, figure, lacking, levelTone, needInputs, needsCell, needsSignature, needWords, readMiningSites, readRedeploymentSites, rowsOf, signatureOf, unknownCell, verdictRows } from './common'

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

// One row per colony of a query that selects `Verdict`; `cell(population)` gives the cells after the colony's name and `signature(population)` the row's signature where the check declares one.
const populationRows = (ctx, populations, { missing, cell, signature = null, link = (population) => linkTo.colonyOutlook(population.PopulationID) }) => verdictRows(ctx, populations, {
  missing,
  build: (population) => ({
    id: `colony:${population.PopulationID}`,
    cells: { colony: colonyText(population), ...cell(population) },
    link: link(population),
    ...(signature ? { signature: signature(population) } : {}),
  }),
})

const LOW_EFFICIENCY = '(FCT_Population.Efficiency < 1 and FCT_Population.Population > 0)'

const SELF_SUSTAINING = '(FCT_Population.Efficiency = 1 and FCT_Population.Population > 10 and FCT_Population.Capital = 0 and FCT_Population.ColonistDestination = 0)'

const STOCKPILING = '(FCT_Population.PurchaseCivilianMinerals = 1 and FCT_Population.MassDriverDest = 0)'

export const checks = checksOf([
  {
    key: 'low-efficiency-populations',
    group: group.key,
    severity: 'attention',
    material: 'the efficiency crossing 75%',
    captured: [bandWords('efficiency under 75%', 'efficiency at 75% or more')],
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
        signature: (population) => signatureOf(bandOf(population.Efficiency, [1 - QUARTER])),
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
    material: 'another prerequisite of mining being missing',
    captured: [needWords],
    title: (count) => amount(count, 'colony with wasted mining capacity', 'colonies with wasted mining capacity'),
    rule: 'A colony has mines that can\'t work: its body holds no mineral deposit, radiation stops mine output, the race has no mine production, or its manned mines have no workforce. Each missing prerequisite is named; a body the race has not surveyed is listed apart, as its deposits are not known.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MiningProductionValue, Workers, CivilianInstallation', 'FCT_MineralDeposit.Amount', 'FCT_SystemBodySurveys', 'FCT_Population.Efficiency, Population', 'FCT_SystemBody.RadiationLevel', 'FCT_Race.MineProduction'],
      note: 'The deposits and the survey are stored rows, so a surveyed body with no deposit left (empty or exhausted: the save does not tell them apart) is a confirmed fact, while a body the race has not surveyed is unknown, not empty. That manned mines need a workforce (the colony\'s stored efficiency above 0) and that radiation of 10000 or more stops all output are read from the game\'s rules for 2.7 and apply to 2.7-shaped saves only, so on any other save they are unknown; a race mine production of 0 stops the mines whatever the version. A colony with an installation amount or type, a deposit amount, the efficiency, the radiation or the survey not stored is listed apart, as not evaluated; a mining total with an amount not stored shows a dash.',
      assumptions: ['A colony whose stored efficiency is 0 has no workforce for its manned mines.'],
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'installations', text: 'Mines' },
      { key: 'reason', text: 'Missing' },
      { key: 'output', text: 'Mining value', align: 'end' },
    ],
    async read(ctx) {
      const { colonies } = await readMiningSites(ctx)

      const sites = colonies.filter((site) => site.surface).map((site) => ({ ...site, Verdict: site.idle })).sort((alpha, beta) => (alpha.capacity === null) - (beta.capacity === null) || beta.capacity - alpha.capacity)

      return verdictRows(ctx, sites, {
        missing: (site) => needInputs(site),
        build: (site) => ({
          id: `colony:${site.id}`,
          cells: {
            colony: colonyText(site.row),
            installations: site.row.MineNames || unknownCell(ctx, ['the amount of an installation of the colony']),
            reason: needsCell(ctx, site),
            output: figure(ctx, site.capacity, 'the amount or the type of an installation of the colony', (known) => ctx.count(known, 1)),
          },
          link: linkTo.minerals({ bodies: [site.row] }),
          signature: needsSignature(site),
        }),
      })
    },
  },
  {
    key: 'mining-redeployment',
    group: group.key,
    severity: 'attention',
    material: 'another reason for moving the asset being added or cleared',
    captured: [needWords],
    title: (count) => amount(count, 'mining asset to redeploy', 'mining assets to redeploy'),
    rule: 'Mines at a body whose deposits are exhausted or gone, and orbital miners at a body that is exhausted, empty, wider than the race\'s orbital mining limit or with no colony of the race, can\'t produce where they are. Each row names why, how many mines or ships and modules there are, what a destination must satisfy and the inputs that stay unknown (the destination, the route and travel time, what would be dug there). A body the race has not surveyed, or a diameter limit not stored, is listed apart, as it is not known.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MiningProductionValue, Workers, CivilianInstallation', 'FCT_MineralDeposit.Amount', 'FCT_SystemBodySurveys', 'FCT_Fleet.OrbitBodyID, AssignedPopulationID, MothershipID, Speed', 'FCT_Population.SystemBodyID', 'FCT_ShipClass.MiningModules', 'FCT_ClassComponent.NumComponent', 'FCT_DamagedComponent.Number', 'FCT_SystemBody.Radius', 'FCT_Race.MaximumOrbitalMiningDiameter, MineProduction'],
      note: 'The mines, the deposits and their survey, the body\'s diameter against the race\'s orbital mining limit and the fleet\'s modules are stored facts: a body with deposit rows at 0 t only is exhausted, and one the race has surveyed with no deposit row is empty (mined out or never deposited: the save does not tell them apart). That the output of an orbital miner needs the race\'s colony on the body, and the workforce, radiation and export a destination needs for mines, are read from the game\'s rules for 2.7 and apply to 2.7-shaped saves only. A fleet that fails only another prerequisite (damaged modules, no crew, assigned to another colony) is not queued. No destination is chosen, so the route, the travel time and the output at a destination are always unknown; the fleet\'s stored speed is shown. An asset on a body the race has not surveyed, or whose diameter limit, deposit amount or mine count is not stored, is listed apart, as not evaluated.',
      assumptions: ['A deposit row at 0 t or less is exhausted; a surveyed body with no row is empty.', 'Civilian complexes are not mines to move.', 'A fleet not assigned to a colony, or assigned to one that is gone, is assigned to the colony on its body.'],
    },
    columns: [
      { key: 'asset', text: 'Asset' },
      { key: 'reason', text: 'Why it is stuck' },
      { key: 'assets', text: 'Assets' },
      { key: 'destination', text: 'A destination needs' },
      { key: 'unknown', text: 'Not known' },
    ],
    async read(ctx) {
      const { ground, orbital } = assessRedeployment(await readRedeploymentSites(ctx), { count: ctx.count })

      const bySize = (size) => (alpha, beta) => (size(alpha) === null) - (size(beta) === null) || size(beta) - size(alpha)

      const queue = [...[...ground].sort(bySize((item) => item.assets.total)), ...[...orbital].sort(bySize((item) => item.assets.modules))]

      return verdictRows(ctx, queue, {
        verdict: (item) => item.verdict,
        missing: (item) => item.unknown.stored,
        build: (item) => {
          const assets = assetText(item.assets, ctx.count)
          const stated = item.constraints.filter((need) => need.state === 'known')
          const unstated = item.constraints.filter((need) => need.state === 'unknown')
          const current = item.current.length ? `Other current blockers, which a suitable destination cures: ${item.current.map((need) => need.text).join('; ')}` : ''
          const carried = item.carried.length ? `Also missing, which moving does not fix: ${item.carried.map((need) => need.text).join('; ')}` : ''
          const why = [item.reasons.map((reason) => reason.need.text).join('; '), current, carried].filter(Boolean).join('. ')

          return {
            id: `${item.kind}:${item.id}`,
            cells: {
              asset: item.kind === 'colony' ? colonyText(item.row) : item.row.FleetName,
              reason: why ? { text: why, tone: 'warning', ...(item.undecided.length ? { result: ctx.unknown(item.unknown.stored) } : {}) } : unknownCell(ctx, item.unknown.stored),
              assets: assets.lacking.length ? { text: assets.text, result: ctx.unknown(assets.lacking) } : assets.text,
              destination: { text: `Needs ${stated.map((need) => need.text).join('; ')}${unstated.length ? `. Not stated: ${unstated.map((need) => need.text).join('; ')}` : ''}`, ...(unstated.length ? { result: ctx.unknown([...new Set(unstated.flatMap((need) => need.inputs))]) } : {}) },
              unknown: { text: `Travel: ${item.unknown.travel.join('; ')}. Production: ${item.unknown.production.join('; ')}.${item.unknown.stored.length ? ` Stored: ${item.unknown.stored.join('; ')}.` : ''}`, result: ctx.unknown(unknownInputs(item)) },
            },
            ...(item.kind === 'fleet' ? { caption: bodyText(item.row) } : {}),
            link: item.kind === 'colony' ? linkTo.minerals({ bodies: [item.row] }) : linkTo.routes({ from: place.fleet(item.id) }),
            signature: item.unknown.stored.length ? null : signatureOf(categoriesOf(item.reasons.map((reason) => `${item.kind}:${reason.need.key}`))),
          }
        },
      })
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
    material: 'another prerequisite of the export being missing',
    captured: [needWords],
    title: (count) => amount(count, 'mining colony', 'mining colonies') + ' with no mineral export set up',
    rule: 'A colony, or orbital miners at it, mine but the save holds no way to deliver the minerals: no mass driver pointing at a colony of the race in the same system that has drivers too, no such colony pointing its drivers at it and no fleet order loading minerals at it. Colonies that receive packets, the capital and colonies with factories use their minerals where they lie and are left out; so are mines that don\'t produce, which the mining checks above list. A freighter can still collect minerals without a stored order, so this lists the setup the save shows, not minerals that never leave.',
    evidence: {
      verification: 'estimated',
      structure: ['FCT_Population.MassDriverDest, Capital, SystemID', 'FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MassDriverValue, MiningProductionValue, ConstructionValue', 'FCT_MoveOrders.MoveActionID, PopulationID', 'FCT_Fleet.OrbitBodyID, AssignedPopulationID', 'FCT_MineralDeposit.Amount', 'FCT_SystemBodySurveys'],
      note: 'A site that mines (a deposit on a surveyed body and mines or orbital miners that work) is delivery-blocked, never non-producing, when the save shows none of the exports: drivers with a valid destination whose colony has drivers too, an order loading minerals at the colony, a colony with drivers pointing its drivers at it, the capital or factories. That a loading order is carrying minerals, that a freighter collects minerals with no stored order and the use of minerals at a colony with factories are not checked: the check reads the current stored setup, not the mineral ledger. Civilian complexes are left to the stockpiling check. A colony whose destination, installation amounts, survey, deposit amounts or game version are not known is listed apart, as not evaluated.',
      assumptions: ['A colony that receives packets, the capital and a colony with factories use their minerals on the spot.', 'An order to load minerals at the colony is an export; it shows a haul is set up, not that it runs.', 'A colony with no stored export may still be served by a freighter without a stored order.'],
    },
    columns: [
      { key: 'colony', text: 'Colony' },
      { key: 'mining', text: 'Mining' },
      { key: 'missing', text: 'Missing' },
      { key: 'others', text: 'Colonies here', align: 'end' },
    ],
    async read(ctx) {
      const { colonies } = await readMiningSites(ctx)

      const sites = colonies.map((site) => ({ ...site, Verdict: deliveryVerdict(site) }))

      return verdictRows(ctx, sites, {
        missing: (site) => needInputs(site, { delivery: true }),
        build: (site) => ({
          id: `colony:${site.id}`,
          cells: {
            colony: colonyText(site.row),
            mining: [site.row.MineNames, site.orbital.length ? amount(site.orbital.length, 'orbital mining fleet') : null].filter(Boolean).join(' · ') || unknownCell(ctx, ['the amount of an installation of the colony']),
            missing: needsCell(ctx, site, { delivery: true }),
            others: ctx.count(site.row.OtherColonies),
          },
          ...(deliveryVerdict(site) === 1 ? { caption: 'The save shows no export set up here, so minerals leave only if a freighter collects them without a stored order' } : {}),
          link: linkTo.minerals({ bodies: [site.row] }),
          signature: needsSignature(site, { delivery: true }),
        }),
      })
    },
  },
])
