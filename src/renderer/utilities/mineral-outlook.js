// How the Mineral Outlook page's figures are built as provenance results (utilities/provenance.js): what the race holds, what its mines take, a mineral's production, use, net and runway, a deposit's forecast, the stockpile projection and the industry queue's demand. The plain numbers stay in minerals.js (`surfaceRate`, `orbitalMinerRate`, `depositForecast`, `stockProjection`, `annualQueueDemand`); each builder here checks that the inputs it reads are there, calls them, and returns a result that names its rule, its missing inputs and its assumptions. A figure with a missing input is unavailable (a dash on screen), never 0.

import { CATEGORIES, UNMODELLED } from './legacy-consumption'
import { CRITICAL_RUNWAY_YEARS, WARNING_RUNWAY_YEARS, depositForecast, orbitalChainGap, orbitalMinerRate, stockProjection, surfaceRate } from './minerals'
import { STATUS, combine, envelope, isAvailable, ofRule, registerRule, sumResults, unavailable, valueOrNull } from './provenance'

const VERSIONS = ['2.7.x']

registerRule({
  id: 'mineral.stock',
  versions: VERSIONS,
  units: 't',
  verification: 'confirmed',
  structure: ['FCT_Population (a column per mineral)', 'FCT_ShipCargo.CargoTypeID, CargoID, Amount', 'FCT_MassDriverPackets (a column per mineral)'],
  note: 'The tonnes of a mineral the race\'s colonies hold, and the tonnes in its freighters\' holds and in mass-driver packets in flight, summed from the stored values. A colony without a stored stockpile gives no figure.',
})

registerRule({
  id: 'mineral.surfaceRate',
  versions: VERSIONS,
  units: 't/yr',
  verification: 'confirmed',
  structure: ['DIM_PlanetaryInstallation.MiningProductionValue, Workers, CivilianInstallation', 'FCT_PopulationInstallations.Amount', 'FCT_Race.MineProduction', 'FCT_MineralDeposit.Accessibility', 'FCT_Population.Efficiency, UnrestPoints', 'FCT_SystemBody.RadiationLevel', 'DIM_PopPoliticalStatus.ProductionMod', 'FCT_Commander, FCT_CommanderBonuses'],
  note: 'The tonnes a year a colony\'s mines take from a deposit at its current accessibility: manned mines scale with the colony\'s efficiency, stability and political status, automated mines and civilian complexes do not, and radiation, the governor and a quarter of the sector commander\'s bonus scale them all, each kind of capacity cut to a whole number. It matched the mining the game logged for 385 colony and mineral series of a save (median relative error 1e-15, largest 0.2%). Radiation, stability and political status were all neutral in that save and the sparing of automated mines from the efficiency scale is inferred, so a result in which one of those matters is an estimate.',
})

registerRule({
  id: 'mineral.orbitalRate',
  versions: VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_ShipClass.MiningModules, Crew', 'FCT_Ship.CurrentCrew', 'FCT_Race.MineProduction, MaximumOrbitalMiningDiameter', 'FCT_MineralDeposit.Accessibility', 'FCT_SystemBody.Radius', 'FCT_Commander, FCT_CommanderBonuses', 'FCT_NavalAdminCommand'],
  note: 'The tonnes a year an orbital miner takes: its mining modules times the race\'s mine production, the commander\'s and the naval admins\' Mining bonuses, the share of its crew aboard and the deposit\'s accessibility; nothing from a body wider than the race can mine from orbit. The formula is the community workbook\'s plus the crew rule. Against the mineral ledger of the sampled saves it matches exactly at the last completed increment where the deposit\'s accessibility is not falling; one later save has an earlier discrepancy in its window that is unexplained. On a deposit mined below half its original amount the ledger ran up to two 0.01 steps of accessibility above it over those same increments, because the save holds the accessibility after the last mining step, so the estimate was low there; that is an observation over past increments, not a guarantee about future error. A short crew, a damaged mining module, a ship with no commander and a ship outside any naval admin command have no case in the sampled saves and are unobserved; the modules counted are the class\'s, damage is not read.',
})

registerRule({
  id: 'mineral.miningRate',
  versions: VERSIONS,
  units: 't/yr',
  verification: 'confirmed',
  structure: ['the colonies\' and orbital miners\' rows of one deposit or mineral'],
  note: 'The sum of the rates of the colonies and orbital miners on one deposit, or of one mineral\'s deposits: as strong as the weakest rate summed, and unavailable while one of them is.',
})

registerRule({
  id: 'mineral.flowPerYear',
  versions: VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_RaceMineralData.MineralID, MineralDataType, Amount, Time', 'FCT_Game.GameTime'],
  note: 'A mineral\'s production or use in a year: the game\'s mineral ledger over the chosen window, scaled by 365 days over the days the ledger covers, plus the mining the ledger leaves out (colonies shipping their civilian complexes\' output by mass driver); transfers between the race\'s colonies are not counted. A save without a ledger has production from the mines\' output and use modelled from the industry queue, the refineries, the maintenance facilities and the shipyards (the fuel use rule, the maintenance use rule, the shipbuilding use rule), not measured; ground unit training is not counted there. A use the page switches off is left out of the use, ledger or not. The ledger\'s mining matched the formula rate to within 0.2%; the annualising rests on the window being typical.',
  assumptions: ['the rate of the ledger window holds for a year'],
})

registerRule({
  id: 'mineral.net',
  versions: VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['production and use of the same mineral'],
  note: 'A mineral\'s yearly production less its use, each at the rate of the ledger window.',
})

registerRule({
  id: 'mineral.runway',
  versions: VERSIONS,
  units: 'years',
  verification: 'estimated',
  structure: ['the mineral\'s stock and cargo in transit', 'its yearly net'],
  note: 'The years the stock and cargo in transit last at today\'s yearly net loss: the tonnes held over the net loss. A mineral whose net is not a loss has no end to run to, and its runway is infinite. The runway is as sure as the yearly net it divides by.',
})

registerRule({
  id: 'mineral.runwayStatus',
  versions: VERSIONS,
  units: '',
  verification: 'assumed',
  structure: ['the mineral\'s runway, production and use'],
  note: `The planner's own bands over the runway: critical under ${CRITICAL_RUNWAY_YEARS} years, a warning under ${WARNING_RUNWAY_YEARS}, otherwise falling; a mineral that holds or grows is growing, and one with no production or use is idle. The bands are a planning choice, not a game rule.`,
  assumptions: [`a runway under ${CRITICAL_RUNWAY_YEARS} years is critical and under ${WARNING_RUNWAY_YEARS} a warning`],
})

registerRule({
  id: 'mineral.depositForecast',
  versions: VERSIONS,
  units: 'years',
  verification: 'estimated',
  structure: ['FCT_MineralDeposit.Amount, Accessibility, HalfOriginalAmount, OriginalAcc', 'the deposit\'s mining rate'],
  note: 'Above half the original amount the rate is flat; below it accessibility falls toward 0.1 as the deposit is worked, so output slows until it is empty. The fall matched the stored accessibility of 37 declining deposits to within 0.005, the rounding of the stored value. The years assume today\'s mining rate throughout. A ground survey can raise accessibility without updating the original values, which makes the years indicative.',
  assumptions: ['the mining rate stays at today\'s level'],
})

registerRule({
  id: 'mineral.stockProjection',
  versions: VERSIONS,
  units: 't',
  verification: 'estimated',
  structure: ['the mineral\'s stock and cargo in transit', 'its deposits\' forecasts', 'its other production and its use'],
  note: 'The stockpile over the horizon: today\'s stock, what each deposit still delivers as it declines, and every other flow at today\'s net rate. The level rises while mining beats the net drain, peaks, then falls and crosses zero at most once.',
  assumptions: ['other production and all use stay at today\'s rates'],
})

registerRule({
  id: 'mineral.queueDemand',
  versions: VERSIONS,
  units: 't',
  verification: 'estimated',
  structure: ['FCT_IndustrialProjects.Amount, ProdPerUnit, Percentage, Queue, <mineral>', 'each colony\'s production capacity (production.populationCapacity)'],
  note: 'The minerals the industry queue will take in the next year: each project\'s cost scaled to one year of work at its share of the colony\'s capacity, with queued entries counted only while the year has capacity left. The ordnance capacity behind it matched the logged use of five minerals to within 0.15%; queued entries have no saved case.',
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

const LABELS = {
  ManualMineCount: 'manned mines',
  AutomatedMineCount: 'automated mines',
  CivilianMineCount: 'civilian mining complexes',
  MineProduction: 'the race\'s mine production',
  Accessibility: 'accessibility',
  GovernorBonus: 'the governor\'s Mining bonus',
  SectorBonus: 'the sector commander\'s Mining bonus',
  Efficiency: 'colony efficiency',
  StabilityModifier: 'colony stability',
  RadiationModifier: 'radiation',
  PoliticalModifier: 'political status',
  MiningModules: 'mining modules',
  CommanderBonus: 'the commander\'s Mining bonus',
  Diameter: 'body diameter',
  MaximumOrbitalMiningDiameter: 'the race\'s orbital mining limit',
  ClassCrew: 'the class crew',
  CurrentCrew: 'the ship\'s crew',
  Amount: 'deposit amount',
  HalfOriginalAmount: 'half the original amount',
  OriginalAcc: 'original accessibility',
}

const BONUS_FIELDS = ['GovernorBonus', 'SectorBonus', 'CommanderBonus']

const labelled = (fields, row) => fields.filter((field) => !finite(row[field])).map((field) => `${LABELS[field] || field}${row.BonusWithheld && BONUS_FIELDS.includes(field) ? ` (${row.BonusWithheld})` : ''}`)

const SURFACE_FIELDS = ['ManualMineCount', 'AutomatedMineCount', 'CivilianMineCount', 'MineProduction', 'Accessibility', 'GovernorBonus', 'SectorBonus', 'Efficiency', 'StabilityModifier', 'RadiationModifier', 'PoliticalModifier']

// What a colony's mines take a year from the deposit its row names, as a result of 'mineral.surfaceRate': `owned` leaves out civilian complexes the race does not buy from (`surfaceRate`). A column the row lacks makes it unavailable. It is confirmed unless radiation is not neutral (it scales every kind of mine), stability or political status is not neutral for manned mines, or automated mines work at a colony below full efficiency, which the rule was not checked on.
export const surfaceRateResult = (row, owned = true) => {
  const missing = labelled(SURFACE_FIELDS, row)

  if (missing.length) {
    return unavailable({ rule: 'mineral.surfaceRate', missing })
  }

  const assumptions = []
  const manned = row.ManualMineCount > 0
  const mines = manned || row.AutomatedMineCount > 0 || row.CivilianMineCount > 0

  if (mines && row.RadiationModifier !== 1) {
    assumptions.push('radiation scales the mines\' output as the game documents, a case no saved game has checked')
  }

  if (manned && (row.StabilityModifier !== 1 || row.PoliticalModifier !== 1)) {
    assumptions.push('stability and political status scale manned mines as the game documents, a case no saved game has checked')
  }

  if (row.AutomatedMineCount > 0 && row.Efficiency < 1) {
    assumptions.push('automated mines are not slowed by a colony below full efficiency')
  }

  return envelope({ value: surfaceRate(row, owned), status: assumptions.length ? STATUS.ESTIMATED : STATUS.CONFIRMED, rule: 'mineral.surfaceRate', inputs: { present: ['the colony\'s mines and modifiers'] }, assumptions })
}

const ORBITAL_FIELDS = ['MiningModules', 'MineProduction', 'CommanderBonus', 'Accessibility', 'Diameter', 'MaximumOrbitalMiningDiameter', 'ClassCrew']

// What an orbital miner takes a year from the deposit its row names, as a result of 'mineral.orbitalRate' (`orbitalMinerRate`, with the naval admins' chain bonus). A column the row lacks makes it unavailable.
export const orbitalRateResult = (row, navalAdmins) => {
  const chain = orbitalChainGap(row, navalAdmins)
  const missing = [...labelled(ORBITAL_FIELDS, row), ...(row.ClassCrew > 0 ? labelled(['CurrentCrew'], row) : []), ...(chain ? [chain] : [])]

  return missing.length ? unavailable({ rule: 'mineral.orbitalRate', missing }) : ofRule({ rule: 'mineral.orbitalRate', value: orbitalMinerRate(row, navalAdmins), inputs: { present: ['the ship\'s mining modules and crew'] } })
}

// The rates of a deposit's sources, or of a mineral's, as one result of 'mineral.miningRate'; an empty list is a real 0.
export const miningSum = (results) => sumResults({ rule: 'mineral.miningRate', results })

// A mineral's holdings as `{ stock, transit, held }` results of 'mineral.stock'. `stockpile`: the summed colony row by mineral name, null where no colony row exists or a colony records none (the read leaves a partial sum out); a value that is not a number is unavailable. `cargo`: tonnes in ships' holds by material id, null for a material whose hold amount is not recorded; a material with no key has no cargo (0). `packets`: `{ Packets, <mineral name> }` for the mass-driver packets in flight, `Packets` their count, the mineral's tonnes null where a packet records none; no packets (`Packets` 0) is 0 in transit.
export const holdingsResult = ({ stockpile, cargo, packets, mineral }) => {
  const stored = stockpile ? stockpile[mineral.name] : null
  const stock = finite(stored) ? ofRule({ rule: 'mineral.stock', value: stored, inputs: { present: [`${mineral.name} stockpile`] } }) : unavailable({ rule: 'mineral.stock', missing: [`${mineral.name} stockpile`] })
  const held = cargo || {}
  const missing = []
  let carried = 0
  let packed = 0

  if (Object.prototype.hasOwnProperty.call(held, mineral.id)) {
    carried = held[mineral.id]

    if (!finite(carried)) {
      missing.push(`${mineral.name} in ships' holds`)
    }
  }

  if (!packets) {
    missing.push('the mass-driver packets in flight')
  } else if (finite(packets[mineral.name])) {
    packed = packets[mineral.name]
  } else if (packets.Packets !== 0) {
    missing.push(`${mineral.name} in mass-driver packets`)
  }

  const transit = missing.length ? unavailable({ rule: 'mineral.stock', missing }) : ofRule({ rule: 'mineral.stock', value: carried + packed, inputs: { present: ['cargo and packets in transit'] } })

  return { stock, transit, held: sumResults({ rule: 'mineral.stock', results: [stock, transit] }) }
}

// `queue`: `annualQueueDemand`'s result, `name` a mineral's name: the 12-month demand as a result of 'mineral.queueDemand', unavailable while a colony with queued projects that use it has no known capacity or a queued project lacks an input that sets what it takes in the year.
export const queueDemandResult = (queue, name) => {
  const colonies = queue.unknown[name].length
  const lacking = queue.incomplete ? queue.incomplete[name] : []
  const missing = [...(colonies ? [`the production capacity of ${colonies === 1 ? 'a colony' : `${colonies} colonies`} with queued projects`] : []), ...lacking]

  if (missing.length) {
    return unavailable({ rule: 'mineral.queueDemand', missing })
  }

  return ofRule({ rule: 'mineral.queueDemand', value: queue.demand[name], inputs: { present: ['the industry queue', 'the colonies\' production capacity'] } })
}

const NO_LEDGER_USE = 'without a ledger, use is modelled from the industry queue, the refineries, the maintenance facilities and the shipyards, not measured; ground unit training is not counted'
const NO_LEDGER_PRODUCTION = 'without a ledger, production is the mines\' output alone'

// The modelled uses of one mineral for `flowResults`, by category: `modelled` is the page's `{ [category key]: { byMineral } }` (null with a ledger, which observes the uses) and `disabled` the keys of the categories switched off. `result` is null where the category does not take the mineral.
export const categoryUses = ({ modelled, disabled, mineralName }) => CATEGORIES.map((category) => ({ key: category.key, label: category.label, groups: category.groups, enabled: !disabled.includes(category.key), result: modelled && modelled[category.key] ? modelled[category.key].byMineral[mineralName] || null : null }))

const switchedOff = (uses) => uses.filter((use) => !use.enabled).map((use) => `${use.label} is switched off and not counted`)

// A figure the ledger gives per year: `value` t/yr over `coverageDays` of ledger, unavailable when the ledger covers none.
const ledgerFlow = (value, coverageDays, assumptions = []) => {
  if (!(coverageDays > 0)) {
    return unavailable({ rule: 'mineral.flowPerYear', missing: ['the days the ledger covers'] })
  }

  return ofRule({ rule: 'mineral.flowPerYear', value, inputs: { present: ['the mineral ledger'] }, assumptions: [`the last ${Math.round(coverageDays)} days of the ledger repeat for a year`, ...assumptions] })
}

const netResult = (produced, used) => combine({ rule: 'mineral.net', parts: { production: produced, use: used }, compute: (values) => values.production - values.use })

// One mineral's yearly flows as results of 'mineral.flowPerYear' and 'mineral.net': `{ mining, otherIncome, produced, used, net }`. With a ledger, `ledger` holds its t/yr by flow group (mining excludes the mining the ledger leaves out, which is `unlogged`, a mining-rate result or null for none), over `coverageDays`. Without one (`hasLedger` false) production is `mined`, the mines' rate result. `uses` (`categoryUses`) are the categories that can be switched off: with a ledger a category switched off leaves its flow groups out of the use, and without one the use is the modelled results of the categories switched on, a category with no result for the mineral taking none of it. A save with a ledger never gets modelled use on top of the observed one.
export const flowResults = ({ hasLedger, coverageDays, ledger, incomeGroups, spendGroups, unlogged = null, mined, uses = [] }) => {
  const sum = (groups) => groups.reduce((total, key) => total + ledger[key], 0)

  if (!hasLedger) {
    const produced = combine({ rule: 'mineral.flowPerYear', parts: { 'mines\' output': mined }, compute: (values) => values['mines\' output'], assumptions: [NO_LEDGER_PRODUCTION] })
    const counted = uses.filter((use) => use.enabled && use.result)
    const assumptions = [NO_LEDGER_USE, ...switchedOff(uses)]
    const used = counted.length ? combine({ rule: 'mineral.flowPerYear', parts: Object.fromEntries(counted.map((use) => [use.label, use.result])), compute: (values) => Object.values(values).reduce((total, value) => total + value, 0), assumptions }) : ofRule({ rule: 'mineral.flowPerYear', value: 0, inputs: { present: ['no use switched on takes this mineral'] }, assumptions })
    const otherIncome = ofRule({ rule: 'mineral.flowPerYear', value: 0, inputs: { present: ['no ledger'] }, assumptions: [NO_LEDGER_PRODUCTION] })

    return { mining: produced, otherIncome, produced, used, net: netResult(produced, used) }
  }

  const loggedMining = ledgerFlow(ledger.mining, coverageDays)
  const mining = unlogged ? combine({ rule: 'mineral.flowPerYear', parts: { ledger: loggedMining, 'unlogged mining': unlogged }, compute: (values) => values.ledger + values['unlogged mining'] }) : loggedMining
  const otherIncome = ledgerFlow(sum(incomeGroups.filter((key) => key !== 'mining')), coverageDays)
  const produced = combine({ rule: 'mineral.flowPerYear', parts: { mining, 'other income': otherIncome }, compute: (values) => values.mining + values['other income'] })
  const left = uses.filter((use) => !use.enabled).flatMap((use) => use.groups)
  const used = ledgerFlow(sum(spendGroups.filter((key) => !left.includes(key))), coverageDays, switchedOff(uses))

  return { mining, otherIncome, produced, used, net: netResult(produced, used) }
}

const sumFlows = (flows, groups) => groups.reduce((total, key) => total + flows[key], 0)

// The table of what the race's uses are made of, one row per category and the unmodelled ground training: `{ key, label, toggle, enabled, coverage, basis, total, focus, result, reason, forecast }`. `coverage` is 'observed' (the ledger holds it), 'modelled' (worked out from the save without a ledger, a forecast) or 'missing' (not known, `reason` says why and `total` is null, never 0). `total` is t/yr over every mineral, `focus` the t/yr of the mineral `focus` ({ id, name }), null when not known; `result` a provenance result of the total. `ledgerFlows`: `{ [MaterialID]: { [group key]: t/yr } }`; `modelled`: as `categoryUses` (null with a ledger); `disabled`: the keys switched off.
export const categoryRows = ({ hasLedger, coverageDays, ledgerFlows, minerals, modelled, disabled, focus }) => [...CATEGORIES, UNMODELLED].map((category) => {
  const toggle = category !== UNMODELLED
  const base = { key: category.key, label: category.label, toggle, enabled: !toggle || !disabled.includes(category.key) }
  let result
  let focused = null
  let basis = ''

  if (hasLedger) {
    const total = minerals.reduce((sum, mineral) => sum + sumFlows(ledgerFlows[mineral.id], category.groups), 0)

    result = ledgerFlow(total, coverageDays)
    focused = focus && isAvailable(result) ? sumFlows(ledgerFlows[focus.id], category.groups) : null
    basis = isAvailable(result) ? `the mineral ledger, last ${Math.round(coverageDays)} days` : ''
  } else if (!toggle) {
    result = unavailable({ rule: 'mineral.flowPerYear', missing: [UNMODELLED.reason] })
  } else {
    const model = modelled[category.key]

    result = sumResults({ rule: category.rule, results: Object.values(model.byMineral) })
    focused = focus ? (focus.name in model.byMineral ? valueOrNull(model.byMineral[focus.name]) : 0) : null
    basis = model.basis
  }

  const known = isAvailable(result)

  return { ...base, coverage: known ? (hasLedger ? 'observed' : 'modelled') : 'missing', basis, total: valueOrNull(result), focus: focused, result, reason: known ? '' : [...new Set(result.inputs.missing)].join('; '), forecast: known && !hasLedger }
})

// A mineral's runway as a result of 'mineral.runway': the years the held stock lasts at the yearly net, Infinity when the net is not a loss.
export const runwayResult = (held, net) => combine({ rule: 'mineral.runway', parts: { 'stock and transit': held, 'yearly net': net }, compute: (values) => (values['yearly net'] < 0 ? values['stock and transit'] / -values['yearly net'] : Infinity) })

// The runway as the page's states, a result of 'mineral.runwayStatus': 'critical', 'warning', 'ok' (falling, but past the bands), 'growing' (net not a loss), 'idle' (no production and no use), unavailable when the runway is.
export const runwayStateResult = (runway, produced, used) => combine({
  rule: 'mineral.runwayStatus',
  parts: { runway, production: produced, use: used },
  compute: (values) => {
    if (values.runway === Infinity) {
      return values.production === 0 && values.use === 0 ? 'idle' : 'growing'
    }

    return values.runway < CRITICAL_RUNWAY_YEARS ? 'critical' : values.runway < WARNING_RUNWAY_YEARS ? 'warning' : 'ok'
  },
})

// A deposit's forecast as a result of 'mineral.depositForecast' whose value is `depositForecast`'s (years to half, years to depletion, idle, upgraded). Unavailable when the deposit lacks an amount or accessibility, or its mining rate (`rate`, a mining-rate result) is not known. A deposit nothing is mining is a real, idle forecast.
export const depositForecastResult = (deposit, rate) => {
  const missing = labelled(['Amount', 'Accessibility', 'HalfOriginalAmount', 'OriginalAcc'], deposit)

  if (missing.length) {
    return unavailable({ rule: 'mineral.depositForecast', missing: [...missing, ...(isAvailable(rate) ? [] : ['mining rate'])] })
  }

  const forecast = isAvailable(rate) ? depositForecast(deposit, rate.value) : null

  return combine({
    rule: 'mineral.depositForecast',
    parts: { 'mining rate': rate },
    compute: () => forecast,
    assumptions: forecast && forecast.upgraded ? ['a ground survey raised the accessibility, so the forecast uses the stored decline values as they are'] : [],
  })
}

// The stockpile over `steps` (years) as a result of 'mineral.stockProjection' whose value is `stockProjection`'s ({ stock, output, runOut }). `held`, `otherIncome` and `used` are results (the other yearly net is the income that is not mining less the use); `deposits`: [{ deposit, rate (a mining-rate result), forecast (a deposit-forecast result), share }]. Unavailable when any of them is.
export const projectionResult = ({ held, otherIncome, used, deposits, steps }) => {
  const rates = Object.fromEntries(deposits.map(({ rate }, index) => [`mining rate ${index + 1}`, rate]))
  const forecasts = Object.fromEntries(deposits.map(({ forecast }, index) => [`forecast ${index + 1}`, forecast]))

  return combine({
    rule: 'mineral.stockProjection',
    parts: { 'stock and transit': held, 'other production': otherIncome, use: used, ...rates, ...forecasts },
    compute: (values) => stockProjection({ start: values['stock and transit'], otherNet: values['other production'] - values.use, deposits: deposits.map(({ deposit, share }, index) => ({ deposit, rate: values[`mining rate ${index + 1}`], share })), steps }),
  })
}
