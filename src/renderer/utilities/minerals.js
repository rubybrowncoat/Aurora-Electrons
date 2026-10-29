// Mineral maths shared by the Mineral Outlook page: deposit depletion, the game's mineral ledger and the industrial queue's demand. Validated against the sample save; see docs/plans/aurcalcs/sql-mining.md §§ 1–2.

import { crewFraction } from './crew'
import { roundToDecimal, separatedNumber } from './math'
import { combine, ofRule, registerRule, unavailable, valueOrNull } from './provenance'

const MINERALS_VERSIONS = ['2.7.x']
const DEPOSIT_COLUMNS = ['FCT_MineralDeposit.Amount', 'FCT_MineralDeposit.Accessibility']

// The rules of the Minerals page's deposit scores, site ranking, distances and stockpile checks, each registered once with the game versions it holds for and how far it is checked (utilities/provenance.js). The flow, forecast and runway rules are registered further down; the colony stock rules in colony-minerals.js.
registerRule({
  id: 'minerals.potential',
  versions: MINERALS_VERSIONS,
  units: 'points (0 to 10)',
  verification: 'estimated',
  structure: DEPOSIT_COLUMNS,
  note: 'The page\'s own score of a deposit: atan of (amount over 20,000 t) to the power r times r squared, with r = sin(π/2 × accessibility), scaled to 0 to 10. An approximation of how the game\'s own AI weighs a deposit; not compared with any stored game value. A deposit with no recorded amount or accessibility has no score.',
})

registerRule({
  id: 'minerals.bodyPotential',
  versions: MINERALS_VERSIONS,
  units: 'points (0 to 10)',
  verification: 'estimated',
  structure: DEPOSIT_COLUMNS,
  note: 'The mean of the deposit scores of a body over the 11 minerals, by the same approximation as the deposit score. A body with a deposit that has no recorded amount or accessibility has no score.',
  assumptions: ['a mineral with no deposit on the body, or outside the options, counts as 0'],
})

registerRule({
  id: 'minerals.depositValue',
  versions: MINERALS_VERSIONS,
  units: 'value',
  verification: 'estimated',
  structure: DEPOSIT_COLUMNS,
  note: 'Accessibility times a size factor (1 by default, 0.5 under 10,000 t, 1.25, 1.5 and 2 above 100,000, 250,000 and 1,000,000 t at accessibility over 0.4), as the game\'s own AI is understood to value a deposit; nothing under the minimum amount (2,000 t unless given) counts. Not compared with any stored game value. A deposit under the minimum is worth 0, which stays apart from a deposit with no recorded amount or accessibility, which has no value.',
})

registerRule({
  id: 'minerals.scarcity',
  versions: MINERALS_VERSIONS,
  units: 'tier',
  verification: 'assumed',
  structure: ['the mineral\'s runway'],
  note: 'The planner\'s own policy, not a game rule: a runway under 5 years is critical (factor 3), under 25 short (factor 2) and under 100 running down (factor 1.5); a mineral that holds, grows or lasts a century counts once. A mineral with no known runway has no tier.',
  assumptions: ['runway thresholds of 5, 25 and 100 years', 'a mineral that holds or grows counts once'],
})

registerRule({
  id: 'minerals.siteOrder',
  versions: MINERALS_VERSIONS,
  units: 'site',
  verification: 'assumed',
  structure: DEPOSIT_COLUMNS,
  note: 'The page\'s own order for an untapped site: the higher potential to a tenth, then the higher accessibility, then the larger amount. A deposit with no recorded amount or accessibility cannot be ranked and is left out, and the result says how many were.',
  assumptions: ['sites are ordered by potential, then accessibility, then amount'],
})

registerRule({
  id: 'minerals.distance',
  versions: MINERALS_VERSIONS,
  units: 'km',
  verification: 'estimated',
  structure: ['FCT_JumpPoint.Xcor, Ycor, WPLink', 'FCT_RaceJumpPointSurvey.Explored, Charted', 'FCT_Population.SystemID, Capital, Population', 'FCT_SystemBody.Xcor, Ycor'],
  note: 'The shortest charted route in km from the nearest capital or sizeable colony to the body: straight lines inside a system and no distance through a jump point, over explored jump points the race did not mark to ignore. The route search is not compared with a route the game plans. A body that no explored route reaches, or a race with no colony to start from, has no distance.',
  assumptions: ['routes start at the capital and colonies of the supply base size'],
})

registerRule({
  id: 'minerals.perMine',
  versions: MINERALS_VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_Race.MineProduction', 'FCT_MineralDeposit.Accessibility'],
  note: 'What one mine digs a year at the deposit\'s current accessibility: the race\'s mine production times accessibility, before the colony\'s efficiency, stability, governor and radiation. The full surface rate of this product reproduced the logged mining of 385 colony-by-mineral series in the sample save (docs/plans/aurcalcs/sql-mining.md); this page\'s product on its own was not re-checked. A race with no mine production recorded has no figure.',
})

registerRule({
  id: 'minerals.depletion',
  versions: MINERALS_VERSIONS,
  units: 'deposit state',
  verification: 'estimated',
  structure: ['FCT_MineralDeposit.Amount, HalfOriginalAmount'],
  note: 'A deposit is past half when its amount is under its stored half of the original amount, and accessibility then falls with what is left; above it, the amount above half holds accessibility. The decline model fit 37 declining deposits within 0.005 (docs/plans/aurcalcs/sql-mining.md); deposits upgraded by a ground survey keep a stale original amount, which this page reads as stored. A deposit with no recorded half has no state.',
})

registerRule({
  id: 'minerals.orbitalReach',
  versions: MINERALS_VERSIONS,
  units: 'yes or no',
  verification: 'estimated',
  structure: ['FCT_SystemBody.Radius', 'FCT_Race.MaximumOrbitalMiningDiameter'],
  note: 'A body is open to orbital miners when its diameter (twice the radius) is no more than the race\'s maximum orbital mining diameter. Compared on stored values; the game\'s own check was not compared. A body with no radius, or a race with no maximum recorded, is neither open nor closed.',
})

registerRule({
  id: 'minerals.cmcCandidate',
  versions: MINERALS_VERSIONS,
  units: 'yes or no',
  verification: 'estimated',
  structure: ['FCT_MineralDeposit.Amount, Accessibility', 'FCT_Game.AllowCMC'],
  note: 'A body could host a civilian mining complex on its mineral deposits alone when it holds more than 10,000 t of Duranium or Gallicite at accessibility 0.7 or better. The body\'s other conditions are not checked here (the Colonization Planner checks them per body). Thresholds as the game\'s rules state them; not reproduced against a saved founding.',
})

registerRule({
  id: 'minerals.massDriverRate',
  versions: MINERALS_VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MassDriverValue'],
  note: 'What a colony\'s mass drivers can send a year: 5,000 t per driver. The constant is the game\'s rule as documented; it was not compared with saved packets. A colony with no driver sends nothing, and one with no destination sends nothing whatever its drivers.',
})

export const MINERALS = [
  { id: 1, name: 'Duranium' },
  { id: 2, name: 'Neutronium' },
  { id: 3, name: 'Corbomite' },
  { id: 4, name: 'Tritanium' },
  { id: 5, name: 'Boronide' },
  { id: 6, name: 'Mercassium' },
  { id: 7, name: 'Vendarite' },
  { id: 8, name: 'Sorium' },
  { id: 9, name: 'Uridium' },
  { id: 10, name: 'Corundium' },
  { id: 11, name: 'Gallicite' },
]

// A civilian mining complex can be founded on a body with more than 10,000 t of Duranium or Gallicite at accessibility 0.7 or better. The site's other conditions are in colonization.js `cmcSite`.
export const CMC_MINERAL_IDS = [1, 11]
const CMC_MIN_AMOUNT = 10000
const CMC_MIN_ACCESSIBILITY = 0.7

export const qualifiesForCmc = (deposit) => !!deposit && deposit.Amount > CMC_MIN_AMOUNT && deposit.Accessibility >= CMC_MIN_ACCESSIBILITY

// The Minerals page's mining potential of one deposit, 0 to 10. With r = sin(π/2 · accessibility), it is atan((Amount / 20,000 t)^r · r²) scaled from [0, π/2) to [0, 10): 20,000 t at accessibility 1 scores 5, 100,000 t at 0.7 about 8, and a deposit at 0.1 never passes 1 however large.
const POTENTIAL_REFERENCE_AMOUNT = 20000

export const depositPotential = (deposit) => {
  const reach = Math.sin((Math.PI / 2) * deposit.Accessibility)

  return (Math.atan(Math.pow(deposit.Amount / POTENTIAL_REFERENCE_AMOUNT, reach) * reach * reach) / (Math.PI / 2)) * 10
}

// What the game's own AI makes of a deposit: accessibility, halved under 10,000 t and raised for a big deposit that is still easy to reach (more than 100,000, 250,000 and 1,000,000 t at accessibility above 0.4). Nothing under 2,000 t counts. An NPR seeds a mining colony on a body whose deposits add up to 6 and adds mines to a colony from 4.
export const DEPOSIT_MINIMUM_AMOUNT = 2000
export const RICH_DEPOSIT_VALUE = 6
export const WORTH_MINING_VALUE = 4

export const depositValue = (deposit, minimumAmount = DEPOSIT_MINIMUM_AMOUNT) => {
  if (deposit.Amount < minimumAmount) {
    return 0
  }

  const reachable = deposit.Accessibility > 0.4
  const size = deposit.Amount > 1000000 && reachable ? 2 : deposit.Amount > 250000 && reachable ? 1.5 : deposit.Amount > 100000 && reachable ? 1.25 : deposit.Amount < 10000 ? 0.5 : 1

  return deposit.Accessibility * size
}

// How short a mineral is for the race, from the runway the Mineral Outlook page shows (its stock and in-transit cargo over its net loss a year). The game's AI scales a deposit the same way by how little its capital holds (x3 under 1,000 t, x2 under 3,000, x1.5 under 5,000); here the runway decides. A mineral that holds or grows counts once, and so does one that lasts a century or more. `years` is the runway a tier covers, up to and excluding it.
export const CRITICAL_RUNWAY_YEARS = 5
export const WARNING_RUNWAY_YEARS = 25
export const SCARCITY = [
  { id: 'critical', label: 'Critical', years: CRITICAL_RUNWAY_YEARS, factor: 3 },
  { id: 'short', label: 'Short', years: WARNING_RUNWAY_YEARS, factor: 2 },
  { id: 'falling', label: 'Running down', years: 100, factor: 1.5 },
]
export const NOT_SCARCE = { id: 'ok', label: 'Holding', years: null, factor: 1 }

export const scarcityOf = (runway) => (Number.isFinite(runway) && SCARCITY.find((tier) => runway < tier.years)) || NOT_SCARCE

// A recorded figure: a finite number, not negative. Null, undefined and NaN are unknown, and unknown is never read as 0.
const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const inputsOfDeposit = (deposit, columns = ['Amount', 'Accessibility']) => ({
  present: columns.filter((column) => deposit && known(deposit[column])).map((column) => `FCT_MineralDeposit.${column}`),
  missing: columns.filter((column) => !deposit || !known(deposit[column])).map((column) => `FCT_MineralDeposit.${column}`),
})

// Whether a deposit has the amount and accessibility every score of it reads.
export const depositReadable = (deposit) => inputsOfDeposit(deposit).missing.length === 0

// `depositPotential` as a provenance result: unavailable, naming what is missing, for a deposit without a recorded amount or accessibility.
export const depositPotentialResult = (deposit) => {
  const inputs = inputsOfDeposit(deposit)

  return inputs.missing.length ? unavailable({ rule: 'minerals.potential', ...inputs }) : ofRule({ rule: 'minerals.potential', value: depositPotential(deposit), inputs })
}

// A body's potential: the mean over the 11 minerals of the potential of its `deposits` (those in view), a mineral without one counting as 0. `unreadable` is how many of the body's deposits have no recorded amount or accessibility: with any, the mean is unknown.
export const bodyPotentialResult = (deposits, unreadable = 0) => (unreadable ? unavailable({ rule: 'minerals.bodyPotential', missing: [`Amount or Accessibility of ${unreadable} ${unreadable === 1 ? 'deposit' : 'deposits'}`] }) : ofRule({ rule: 'minerals.bodyPotential', value: deposits.reduce((total, deposit) => total + depositPotential(deposit), 0) / MINERALS.length, inputs: { present: DEPOSIT_COLUMNS } }))

// `depositValue` as a provenance result. A deposit under the minimum amount is worth 0, a known figure that needs no accessibility; one without a recorded amount, or without an accessibility when the amount passes, has no value.
export const depositValueResult = (deposit, minimumAmount = DEPOSIT_MINIMUM_AMOUNT) => {
  const inputs = inputsOfDeposit(deposit)
  const assumptions = [`the minimum deposit is ${minimumAmount} t`]

  if (deposit && known(deposit.Amount) && deposit.Amount < minimumAmount) {
    return ofRule({ rule: 'minerals.depositValue', value: 0, inputs: { present: ['FCT_MineralDeposit.Amount'] }, assumptions })
  }

  return inputs.missing.length ? unavailable({ rule: 'minerals.depositValue', ...inputs, assumptions }) : ofRule({ rule: 'minerals.depositValue', value: depositValue(deposit, minimumAmount), inputs, assumptions })
}

const tierOf = (runway) => SCARCITY.find((tier) => runway < tier.years) || NOT_SCARCE

// `scarcityOf` as a provenance result whose value is the tier ({ id, label, years, factor }). `runway` is the years the stock lasts, as a number or a provenance result of one; Infinity is a mineral that holds, grows or has no net loss. Null, undefined, NaN and an unavailable result are an unknown runway, which has no tier: it is not the same as holding.
export const scarcityResult = (runway) => {
  if (runway && typeof runway === 'object') {
    return combine({ rule: 'minerals.scarcity', parts: { runway }, compute: (values) => tierOf(values.runway) })
  }

  return typeof runway === 'number' && !Number.isNaN(runway) ? ofRule({ rule: 'minerals.scarcity', value: tierOf(runway), inputs: { present: ['runway'] } }) : unavailable({ rule: 'minerals.scarcity', missing: ['runway'] })
}

// Deposits and bodies ranked for an untapped site: the higher potential (to a tenth, as shown), then accessibility, then size. Positive when `a` is the better site.
export const betterSite = (a, b) => roundToDecimal(a.potential, 1) - roundToDecimal(b.potential, 1) || a.accessibility - b.accessibility || a.amount - b.amount

// The best untapped `site` as a result (value: the site) with its `potential` result. `unranked` is how many untapped deposits could not be ranked for want of a recorded amount, accessibility or mining on their body. No site and none unranked is a result of nothing to rank: null. No site but some unranked is unknown.
export const bestSiteResult = (site, potential, unranked = 0) => {
  const assumptions = unranked ? [`${unranked} untapped ${unranked === 1 ? 'deposit' : 'deposits'} with no recorded amount, accessibility or mining left out of the ranking`] : []

  if (!site) {
    return unranked ? unavailable({ rule: 'minerals.siteOrder', missing: DEPOSIT_COLUMNS, assumptions }) : null
  }

  return combine({ rule: 'minerals.siteOrder', parts: { potential }, compute: () => site, assumptions })
}

// Whether a deposit is past half its original amount, so its accessibility falls with what is left: true or false, or null when the amount or the half is not recorded. A half of 0 means no decline.
export const pastHalf = (deposit) => (known(deposit.Amount) && known(deposit.HalfOriginalAmount) ? deposit.Amount < deposit.HalfOriginalAmount : null)

// Whether orbital miners can work a body: true or false, or null when the diameter or the race's maximum is not recorded.
export const withinOrbitalReach = (diameter, maximum) => (known(diameter) && known(maximum) ? diameter <= maximum : null)

// What one mine digs a year at each of `deposits`' accessibility, summed, at the race's `mineProduction`: unavailable when the race's mine production or a deposit's accessibility is not recorded.
export const perMineResult = (mineProduction, deposits) => {
  const missing = [...(known(mineProduction) ? [] : ['FCT_Race.MineProduction']), ...(deposits.every((deposit) => known(deposit.Accessibility)) ? [] : ['FCT_MineralDeposit.Accessibility'])]

  return missing.length ? unavailable({ rule: 'minerals.perMine', missing }) : ofRule({ rule: 'minerals.perMine', value: deposits.reduce((total, deposit) => total + mineProduction * deposit.Accessibility, 0), inputs: { present: ['FCT_Race.MineProduction', 'FCT_MineralDeposit.Accessibility'] } })
}

// A body's distance from the race's colonies as a result (value: { km, jumps, from } of `buildDistanceMap`). `route` is the route found or null; `origins` how many capitals and colonies the routes start from; `placed` whether the body has a position.
export const miningDistanceResult = (route, { origins, placed }) => {
  if (!placed) {
    return unavailable({ rule: 'minerals.distance', missing: ['FCT_SystemBody.Xcor, Ycor'] })
  } else if (!origins) {
    return unavailable({ rule: 'minerals.distance', missing: ['a capital or colony to route from'] })
  }

  return route ? ofRule({ rule: 'minerals.distance', value: route, inputs: { present: ['explored jump routes', 'colonies to route from'] } }) : unavailable({ rule: 'minerals.distance', missing: ['an explored route from a colony'], present: ['colonies to route from'] })
}

// Tonnes a year per mass driver.
export const MASS_DRIVER_TONS = 5000

// What a colony's `drivers` can send a year, as a result; unavailable when the driver count is not recorded, or when `gaps` of the installations it sums over (an amount or a driver value not recorded) are.
export const massDriverRateResult = (drivers, gaps = 0) => (known(drivers) && !(gaps > 0) ? ofRule({ rule: 'minerals.massDriverRate', value: drivers * MASS_DRIVER_TONS, inputs: { present: ['FCT_PopulationInstallations.Amount'] } }) : unavailable({ rule: 'minerals.massDriverRate', missing: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MassDriverValue'] }))

export const SECONDS_PER_DAY = 86400

// Accessibility never falls below this; the deposit is empty when it gets there.
export const ACCESSIBILITY_FLOOR = 0.1

// t/yr at the deposit's current accessibility, as the game works it out: each kind of capacity cut to a whole number; manned mines scale with the colony's efficiency, stability and political status, automated mines and civilian complexes don't; radiation, the governor and a quarter of the sector commander's bonus scale them all. `owned` drops civilian complexes the race taxes instead of buying from.
const whole = (capacity) => Math.floor(capacity + 1e-9)

export const surfaceRate = (row, owned = true) => {
  const manned = whole(row.ManualMineCount) * row.Efficiency * row.StabilityModifier * (row.PoliticalModifier ?? 1)
  const civilian = owned && !row.PurchaseCivilianMinerals ? 0 : whole(row.CivilianMineCount)

  return (manned + whole(row.AutomatedMineCount) + civilian) * row.MineProduction * row.Accessibility * row.GovernorBonus * row.SectorBonus * Math.max(0, row.RadiationModifier)
}

// The workbook's orbital formula, plus the crew rule: the modules run at the crew share of utilities/crew.js. Null while the ship's crew or its class crew is not in the save, or the naval admin chain `adminBonus` is unknown (null). Compared with the saved ledger by scripts/check-orbital-mining.js: in the sampled saves it matches exactly at the last completed increment where the deposit's accessibility is not falling, while one later save has an unexplained discrepancy earlier in its window. On a deposit mined below half its original amount the ledger ran up to two 0.01 steps of accessibility above the estimate over those same increments, because the save holds the accessibility after the last mining step; that is an observation, not a bound on future error. A short crew, a damaged module and a ship with no commander or outside any naval admin command have no case in the saves; the modules counted are the class's, damage is not read.
export const orbitalRate = (row, adminBonus = 1) => {
  const crew = crewFraction(row)

  return crew === null || adminBonus === null || !Number.isFinite(row.CommanderBonus) ? null : row.MiningModules * row.MineProduction * row.CommanderBonus * adminBonus * crew * row.Accessibility
}

// Whether an orbital miner's rate rests on a naval admin chain the save does not settle: the reason as text, null when the chain is known or the body is too wide for the race to mine from orbit.
export const orbitalChainGap = (row, navalAdmins) => (row.Diameter <= row.MaximumOrbitalMiningDiameter ? navalAdminChain(navalAdmins, row.SystemID, row.NavalAdminCommandID).unknown : null)

// t/yr one orbital miner takes, with its naval admin chain; nothing over a body wider than the race can mine from orbit; null while the chain is unknown.
export const orbitalMinerRate = (row, navalAdmins) => (row.Diameter <= row.MaximumOrbitalMiningDiameter ? orbitalRate(row, navalAdminChainBonus(navalAdmins, row.SystemID, row.NavalAdminCommandID)) : 0)

// Mining the game's mineral ledger leaves out, t/yr by MaterialID: everything mined at a colony that buys its civilian complexes' output and ships it by mass driver (`MassDriverExport`, mining-data.js). The game records nothing for that colony, neither its own mines nor the complexes, and the shipment arrives as a mass-driver transfer, which isn't income. A mineral whose total includes a rate that is not known (a Mining bonus the save's lookup does not confirm, a naval admin chain the save does not settle) is null, never the smaller sum.
export const unloggedMining = ({ surface, orbital, navalAdmins }) => {
  const totals = {}
  const add = (row, rate) => {
    totals[row.MaterialID] = totals[row.MaterialID] === null || rate === null || !Number.isFinite(rate) ? null : (totals[row.MaterialID] || 0) + rate
  }

  surface.filter((row) => row.MassDriverExport).forEach((row) => add(row, Number.isFinite(row.GovernorBonus) && Number.isFinite(row.SectorBonus) ? surfaceRate(row) : null))
  orbital.filter((row) => row.MassDriverExport).forEach((row) => add(row, orbitalMinerRate(row, navalAdmins)))

  return totals
}

const declineShape = (deposit) => {
  const { Amount: amount, Accessibility: accessibility, HalfOriginalAmount: half, OriginalAcc: original } = deposit
  const declines = original > ACCESSIBILITY_FLOOR && half > 0
  const slope = declines ? (original - ACCESSIBILITY_FLOOR) / half : 0
  // Where the decline starts: the original value at the halfway point or, already below half, the unrounded current value (the stored one is rounded to 2 decimals).
  const startAccessibility = !declines ? accessibility : amount > half ? original : ACCESSIBILITY_FLOOR + slope * amount

  return { amount, accessibility, half, declines, slope, startAccessibility }
}

// Above half the rate is flat. Below it, dA/dt = -k(0.1 + s·A), so accessibility decays exponentially to the floor, where the deposit is empty.
// `rate`: t/yr at the current accessibility, every colony and ship on the deposit summed.
export const depositForecast = (deposit, rate) => {
  const { amount, accessibility, half, declines, slope, startAccessibility } = declineShape(deposit)

  if (!(rate > 0) || !(amount > 0) || !(accessibility > 0)) {
    return { yearsToHalf: null, yearsToDepletion: null, idle: true }
  }

  const k = rate / accessibility
  const yearsToHalf = declines ? Math.max(0, amount - half) / rate : null
  const yearsToDepletion = declines ? (yearsToHalf + Math.log(startAccessibility / ACCESSIBILITY_FLOOR) / (k * slope)) : amount / rate

  return {
    yearsToHalf,
    yearsToDepletion,
    idle: false,
    // A ground survey can raise accessibility without updating the original values.
    upgraded: half > 0 && (amount > 2 * half + 1 || accessibility > deposit.OriginalAcc + 0.005),
  }
}

// Output (t/yr) and accessibility of one deposit `years` from now.
export const depositStateAt = (deposit, rate, years) => {
  const { amount, accessibility, half, declines, slope, startAccessibility } = declineShape(deposit)

  if (!(rate > 0) || !(amount > 0) || !(accessibility > 0)) {
    return { accessibility, amount, rate: 0 }
  }

  const k = rate / accessibility

  if (!declines) {
    const remaining = Math.max(0, amount - rate * years)

    return { accessibility: remaining > 0 ? accessibility : 0, amount: remaining, rate: remaining > 0 ? rate : 0 }
  }

  const yearsToHalf = Math.max(0, amount - half) / rate

  if (years <= yearsToHalf) {
    return { accessibility, amount: amount - rate * years, rate }
  }

  const current = startAccessibility * Math.exp(-k * slope * (years - yearsToHalf))

  if (current <= ACCESSIBILITY_FLOOR + 1e-9) {
    return { accessibility: ACCESSIBILITY_FLOOR, amount: 0, rate: 0 }
  }

  return { accessibility: current, amount: (current - ACCESSIBILITY_FLOOR) / slope, rate: k * current }
}

// Evenly spaced [0, horizon] samples for a chart.
export const yearSteps = (horizon, points = 80) => Array.from({ length: points + 1 }, (_, index) => (horizon * index) / points)

// One mineral's stockpile over `steps` (years): today's stock, what each deposit still delivers (exactly, from depositStateAt's remaining amounts, so a deposit never gives more than it holds), and every other flow at today's net rate. Mining only slows down, so the level is concave: it rises while the output beats the net drain, peaks where the two meet, then only falls, and so crosses zero downwards at most once, after the peak. The peak is found on the output directly (not on the samples, which can step over a rise and fall that fit between two of them). `deposits`: [{ deposit, rate (t/yr now), share (of the output that reaches the stockpile) }]
export const stockProjection = ({ start, otherNet, deposits, steps }) => {
  const initial = deposits.map(({ deposit, rate }) => depositStateAt(deposit, rate, 0).amount)
  const levelAt = (years) => deposits.reduce((sum, { deposit, rate, share }, index) => sum + (initial[index] - depositStateAt(deposit, rate, years).amount) * share, start + otherNet * years)
  const outputAt = (years) => deposits.reduce((sum, { deposit, rate, share }) => sum + depositStateAt(deposit, rate, years).rate * share, 0)
  const levels = steps.map(levelAt)
  const output = steps.map(outputAt)
  const first = steps[0]
  const last = steps[steps.length - 1]
  let runOut = null

  // Bisects [low, high] for where `above` stops holding; `above` must hold at `low`, fail at `high`, and not recover.
  const bisect = (low, high, above) => {
    for (let iteration = 0; iteration < 60; iteration++) {
      const middle = (low + high) / 2

      if (above(middle)) {
        low = middle
      } else {
        high = middle
      }
    }

    return [low, high]
  }

  // The level is at its highest where output + otherNet turns from positive to negative.
  const peak = output[0] + otherNet <= 0 ? first : output[output.length - 1] + otherNet > 0 ? last : bisect(first, last, (years) => outputAt(years) + otherNet > 0)[0]

  if (levelAt(peak) > 0) {
    if (levels[levels.length - 1] <= 0) {
      runOut = bisect(peak, last, (years) => levelAt(years) > 0)[1]
    }
  } else if (start <= 0 && output[0] + otherNet < 0) {
    // An empty stockpile that is only drawn down is already out.
    runOut = 0
  }

  return { stock: levels.map((level) => Math.max(0, level)), output, runOut }
}

// The ledger's purposes, folded to eight groups so a chart never needs a ninth colour. Transfers between the race's own colonies (freighters, mass drivers) and the starting stockpile aren't empire income or spending, so they're left out.
export const FLOW_GROUPS = [
  { key: 'mining', label: 'Mining', income: true, types: [1, 11] },
  { key: 'salvage', label: 'Salvage', income: true, types: [10, 15, 17, 18, 19] },
  { key: 'construction', label: 'Construction', income: false, types: [4, 40, 45] },
  { key: 'shipbuilding', label: 'Shipbuilding', income: false, types: [5, 9] },
  { key: 'ordnance', label: 'Ordnance & fighters', income: false, types: [2, 3] },
  { key: 'ground', label: 'Ground units', income: false, types: [6] },
  { key: 'fuel', label: 'Fuel refining', income: false, types: [14] },
  { key: 'maintenance', label: 'Maintenance', income: false, types: [16] },
]

export const TRANSFER_TYPES = new Set([7, 8, 12, 13, 20])

// Types the game logs in its production phase, once per cycle and all at the same time (on the sample, every one of them falls on a mining tick). Salvage and transfers come at other times.
export const PRODUCTION_TYPES = FLOW_GROUPS.filter((group) => group.key !== 'salvage').flatMap((group) => group.types)

export const flowGroupOf = (type) => FLOW_GROUPS.find((group) => group.types.includes(type))

// How many days of history the ledger rows cover, the same span for every flow. Production events (mining, construction, maintenance…) come once per cycle, each standing for the cycle before it; transfers can fall in between. So the history starts where the cycle holding the earliest event of any kind starts. `anchorTime` is a production tick (the latest one) and `cycleDays` the cycle length.
export const ledgerCoverageDays = ({ gameTime, firstTime, anchorTime, cycleDays, windowDays }) => {
  if (firstTime == null || anchorTime == null || !(cycleDays > 0)) {
    return 0
  }

  const anchorBack = (gameTime - anchorTime) / SECONDS_PER_DAY
  const firstBack = (gameTime - firstTime) / SECONDS_PER_DAY
  const cycles = Math.floor((firstBack - anchorBack) / cycleDays + 1e-9) + 1

  return Math.min(windowDays, anchorBack + cycles * cycleDays)
}

// The ledger's cycle when it has too few production ticks to measure one (the game's default).
const DEFAULT_CYCLE_DAYS = 5
const DAYS_PER_YEAR = 365

const ledgerCoverage = (ledger, gameTime, windowDays) => {
  if (!ledger.length) {
    return 0
  }

  const { ProductionTicks: ticks, FirstTick: firstTick, LastTick: lastTick } = ledger[0]

  return ledgerCoverageDays({
    gameTime,
    firstTime: Math.min(...ledger.map((row) => row.FirstTime)),
    anchorTime: ticks ? lastTick : Math.max(...ledger.map((row) => row.LastTime)),
    cycleDays: ticks > 1 ? (lastTick - firstTick) / (ticks - 1) / SECONDS_PER_DAY : DEFAULT_CYCLE_DAYS,
    windowDays,
  })
}

// Each mineral's runway as the Mineral Outlook page reads it from the ledger: the year's income (mining and salvage, plus the mining the ledger leaves out) against its spending, the stock and cargo in transit over the net loss, and the scarcity that sets. `ledger`: rows of { MaterialID, MineralDataType, Amount, FirstTime, LastTime, ProductionTicks, FirstTick, LastTick } over the last `windowDays`; `stock`, `transit` (tonnes) and `unlogged` (t/yr, from `unloggedMining`): { [MaterialID]: value }, where a stock or transit that is null or absent is unknown, never 0, and an unlogged rate that is null leaves that mineral's flow unknown. Without a ledger (an empty one, or a save without the ledger table) nothing is known of the flows and every mineral counts as holding (`known` is false).
// A mineral's `runway` is the years its stock lasts over a net loss; Infinity when it has no net loss (it holds or grows, whatever the stock); null when it is not known: a loss over a stock or transit that is unknown, or a ledger row of the mineral with no amount (then `net` is null too). `scarcityResult` is the provenance result of the tier, `scarcity` its value (null while unknown), and `stock` is null while the stock or the cargo in transit is unknown.
export const mineralOutlook = ({ ledger, gameTime, windowDays = DAYS_PER_YEAR, stock, transit, unlogged = {} }) => {
  const coverageDays = ledgerCoverage(ledger, gameTime, windowDays)
  const perYear = coverageDays ? DAYS_PER_YEAR / coverageDays : 0
  const held = (id) => (Number.isFinite(stock[id]) && Number.isFinite(transit[id]) ? stock[id] + transit[id] : null)
  const outlook = Object.fromEntries(MINERALS.map((mineral) => [mineral.id, { name: mineral.name, stock: held(mineral.id), produced: coverageDays ? unlogged[mineral.id] || 0 : 0, used: 0, flowKnown: !(coverageDays && unlogged[mineral.id] === null) }]))

  ledger.forEach((row) => {
    const group = !TRANSFER_TYPES.has(row.MineralDataType) && flowGroupOf(row.MineralDataType)

    if (group && outlook[row.MaterialID]) {
      if (Number.isFinite(row.Amount)) {
        outlook[row.MaterialID][group.income ? 'produced' : 'used'] += row.Amount * perYear
      } else {
        outlook[row.MaterialID].flowKnown = false
      }
    }
  })

  Object.values(outlook).forEach((mineral) => {
    mineral.net = mineral.flowKnown ? mineral.produced - mineral.used : null
    mineral.runway = !mineral.flowKnown ? null : mineral.net < 0 ? (mineral.stock === null ? null : mineral.stock / -mineral.net) : Infinity
    mineral.scarcityResult = scarcityResult(mineral.runway)
    mineral.scarcity = valueOrNull(mineral.scarcityResult)
  })

  return { known: coverageDays > 0, minerals: outlook }
}

// Minerals the industrial queue will consume over the next year: each project's cost scaled to one year of work at its share of the colony's capacity; queued entries count only while the year has capacity left (as "mineral use.sql" does), and only for the capacity earlier entries leave.
// `capacityOf(PopulationID, facility)`: BP/yr at 100% of the colony's 'construction', 'ordnance' or 'fighter' capacity, or null when it is not known. Returns `{ demand, unknown, incomplete }`: `demand` is t by mineral name, over the projects whose inputs are known; `unknown` lists by mineral name the colonies (PopulationID) whose queued projects use that mineral but have no known capacity; `incomplete` lists by mineral name the project inputs a queued project lacks: the mineral's own cost (also at a colony with unknown capacity), a production type, or at a colony with known capacity its place in the queue, units left, build points per unit or share, which set how much of the year each project gets. The demand of a mineral with either is not known. A real capacity of 0 means no work gets done and demands nothing, whatever the queue lacks.
const SCHEDULE_INPUTS = [['Queue', 'place in the queue'], ['Amount', 'units left'], ['ProdPerUnit', 'build points per unit'], ['Percentage', 'share of the colony\'s capacity']]

const recorded = (value) => typeof value === 'number' && Number.isFinite(value)

// The capacity a project draws on: ordnance and fighters have their own and everything else uses construction; null for a production type the save lacks, which is never taken as construction.
const facilityOf = (productionType) => (!recorded(productionType) ? null : productionType === 1 ? 'ordnance' : productionType === 2 ? 'fighter' : 'construction')

export const annualQueueDemand = (projects, capacityOf) => {
  const demand = Object.fromEntries(MINERALS.map((mineral) => [mineral.name, 0]))
  const unknown = Object.fromEntries(MINERALS.map((mineral) => [mineral.name, []]))
  const incomplete = Object.fromEntries(MINERALS.map((mineral) => [mineral.name, []]))
  const groups = {}
  const lack = (mineral, input) => {
    if (!incomplete[mineral.name].includes(input)) {
      incomplete[mineral.name].push(input)
    }
  }

  projects.forEach((project) => {
    const key = `${project.PopulationID}-${facilityOf(project.ProductionType)}`

    ;(groups[key] = groups[key] || []).push(project)
  })

  // The colonies with a project whose production type is not in the save: which capacity it draws on is not known, so neither is the share of the year any project of the colony gets.
  const undecided = new Set(projects.filter((project) => facilityOf(project.ProductionType) === null).map((project) => project.PopulationID))

  Object.values(groups).forEach((group) => {
    if (undecided.has(group[0].PopulationID)) {
      MINERALS.forEach((mineral) => {
        if (group.some((project) => !recorded(project[mineral.name]) || project[mineral.name] > 0)) {
          lack(mineral, 'a queued project\'s production type')
        }
      })

      return
    }

    const capacity = capacityOf(group[0].PopulationID, facilityOf(group[0].ProductionType))

    if (capacity === null || capacity === undefined || Number.isNaN(capacity)) {
      MINERALS.forEach((mineral) => {
        if (group.some((project) => !recorded(project[mineral.name]) || project[mineral.name] > 0) && !unknown[mineral.name].includes(group[0].PopulationID)) {
          unknown[mineral.name].push(group[0].PopulationID)
        }

        if (group.some((project) => !recorded(project[mineral.name]))) {
          lack(mineral, `a queued project's ${mineral.name} cost`)
        }
      })

      return
    }

    // A colony that does no work builds nothing, whatever its queue lacks.
    if (capacity === 0) {
      return
    }

    // A project missing what sets its share of the year leaves the share of every later one open too, so every mineral the colony's queue may use is unknown.
    const gaps = SCHEDULE_INPUTS.filter(([field]) => group.some((project) => !recorded(project[field])))

    if (gaps.length) {
      MINERALS.forEach((mineral) => {
        if (group.some((project) => !recorded(project[mineral.name]) || project[mineral.name] > 0)) {
          gaps.forEach(([, label]) => lack(mineral, `a queued project's ${label}`))
        }
      })

      return
    }

    // The year's capacity spent so far, in percent of a full year at 100%.
    let usedPercent = 0

    ;[...new Set(group.map((project) => project.Queue))].sort((a, b) => a - b).forEach((queue) => {
      if (usedPercent >= 100) {
        return
      }

      group.filter((project) => project.Queue === queue).forEach((project) => {
        const remainingBP = project.Amount * project.ProdPerUnit

        if (!capacity || !project.Percentage || !remainingBP) {
          return
        }

        // A year at the project's own share, but no more than earlier projects left.
        const availablePercent = Math.max(0, Math.min(project.Percentage, 100 - usedPercent))
        const builtBP = Math.min(remainingBP, (capacity * availablePercent) / 100)
        const oneYearFactor = builtBP / remainingBP

        MINERALS.forEach((mineral) => {
          if (!recorded(project[mineral.name])) {
            lack(mineral, `a queued project's ${mineral.name} cost`)

            return
          }

          demand[mineral.name] += project.Amount * project[mineral.name] * oneYearFactor
        })

        usedPercent += (100 * builtBP) / capacity
      })
    })
  })

  return { demand, unknown, incomplete }
}

// What a colony's stock can't cover of an industrial project's remaining units, the material that runs out first leading: each mineral, then the fuel, with the units the stock covers. Each cycle the game cuts a build to what the colony's stock covers, minerals first and then fuel. The project's mineral columns are per unit, with the stock as `Stock<Mineral>` and `StockFuel`.
export const projectShortages = (project) => {
  const short = []
  const check = (limit, need, stock) => {
    const covered = (stock || 0) / need

    if (covered < project.Amount - 1e-6) {
      short.push({ ...limit, covered: Math.max(0, covered) })
    }
  }

  MINERALS.forEach((mineral) => {
    if (project[mineral.name] > 0) {
      check({ mineralId: mineral.id, name: mineral.name }, project[mineral.name], project[`Stock${mineral.name}`])
    }
  })

  if (project.FuelRequired > 0) {
    check({ mineralId: null, name: 'fuel' }, project.FuelRequired, project.StockFuel)
  }

  return short.sort((alpha, beta) => alpha.covered - beta.covered)
}

// Systems within `jumps` jumps of `systemId`, over a { SystemID: Set(neighbourIDs) } graph.
export const systemsWithinJumps = (graph, systemId, jumps) => {
  const reached = new Set([systemId])
  let frontier = [systemId]

  for (let step = 0; step < jumps; step++) {
    const next = []

    frontier.forEach((id) => {
      ;(graph[id] || new Set()).forEach((neighbour) => {
        if (!reached.has(neighbour)) {
          reached.add(neighbour)
          next.push(neighbour)
        }
      })
    })

    frontier = next
  }

  return reached
}

// An admin command's radius in jumps. A Naval Headquarters adds one jump per doubling of its level (levels 1, 2, 4, 8 give 1, 2, 3, 4; a fractional level is cut to a whole one first), times the command type's multiplier (Patrol and Survey 2). A population with no headquarters capacity still reaches its own system (radius 0), and so does a command on a flag bridge; a command with no location at all has no system to reach (`loadNavalAdmins` leaves its range empty).
export const navalAdminRadius = ({ ShipID, HeadquartersLevel, Radius }) => {
  if (ShipID || !(HeadquartersLevel >= 1)) {
    return 0
  }

  return (1 + Math.floor(Math.log2(HeadquartersLevel))) * (Radius || 1)
}

// The rank each admin command's commander needs, as an `FCT_Ranks.Priority` (1 is the
// highest): one rank above the best captain in its directly attached fleets, above each
// direct subordinate's required rank and commander, and at least its set minimum.
// `admins`: { [NavalAdminCommandID]: { ParentCommandID, RankPriority, MinimumRankPriority } }
// `captainRanks`: { [NavalAdminCommandID]: best captain's Priority }
export const navalAdminRequiredRanks = (admins, captainRanks) => {
  const children = {}
  const required = {}

  Object.values(admins).forEach((admin) => {
    ;(children[admin.ParentCommandID] = children[admin.ParentCommandID] || []).push(admin)
  })

  const visit = (admin, path) => {
    const id = admin.NavalAdminCommandID

    if (id in required) {
      return required[id]
    } else if (path.has(id)) {
      return Infinity
    }

    path.add(id)

    const candidates = [admin.MinimumRankPriority > 0 ? admin.MinimumRankPriority : Infinity, (captainRanks[id] || Infinity) - 1]

    ;(children[id] || []).forEach((child) => {
      candidates.push(visit(child, path) - 1, (child.RankPriority || Infinity) - 1)
    })

    path.delete(id)
    required[id] = Math.max(1, Math.min(...candidates))

    return required[id]
  }

  Object.values(admins).forEach((admin) => visit(admin, new Set()))

  return required
}

// Naval admin bonuses chain up the command tree: the ship must be within its own command's range, and each command's HQ within its parent's range for the parent to apply too. A command without a commander of the required rank breaks the chain (docs/DATABASE.md § Commander bonus rules). Each one passes on its commander's bonus scaled by the command type's share.
// `admins`: { [NavalAdminCommandID]: { SystemID, ParentCommandID, BonusValue, Share, Eligible, Unknown, BonusUnknown, Systems: Set } }. A command in range whose rank or bonus the save does not settle (`Unknown`, the reason as text, with `Eligible` null), or an eligible one whose commander holds the bonus row without a value (`BonusUnknown`, the reason as text), makes the chain unknown: `{ bonus: null, unknown: reason }`, never a multiplier of 1.
export const navalAdminChain = (admins, systemId, commandId) => {
  let bonus = 1
  let location = systemId
  const visited = new Set()
  let current = admins[commandId]

  while (current && !visited.has(current.NavalAdminCommandID) && current.Systems.has(location)) {
    if (current.Unknown) {
      return { bonus: null, unknown: current.Unknown }
    } else if (!current.Eligible) {
      break
    }

    if (current.BonusUnknown) {
      return { bonus: null, unknown: current.BonusUnknown }
    }

    visited.add(current.NavalAdminCommandID)

    if (current.BonusValue) {
      bonus *= 1 + (current.BonusValue - 1) * current.Share
    }

    location = current.SystemID
    current = admins[current.ParentCommandID]
  }

  return { bonus, unknown: null }
}

// The chain's multiplier, null while the chain is unknown (`navalAdminChain`).
export const navalAdminChainBonus = (admins, systemId, commandId) => navalAdminChain(admins, systemId, commandId).bonus

// The naval admin chain a ship's fleet answers to: the fleet's own command up the tree, and for a fleet with no command (0 or null) the race's root command, the one with no parent. `admins`: as `loadNavalAdmins` gives them; `systemId`: where the ship is, or loads; `commandId`: the fleet's NavalAdminCommandID. Returns `navalAdminChain`'s { bonus, unknown }.
export const fleetCommandChain = (admins, systemId, commandId) => {
  const root = Object.values(admins).find((admin) => !admin.ParentCommandID)

  return navalAdminChain(admins, systemId, commandId || (root ? root.NavalAdminCommandID : 0))
}

// Tons at a readable precision: 47.3 Mt, 307 kt. Teratonnes only come from deposits set in the game's editor.
export const compact = (value) => {
  const size = Math.abs(value)

  if (size >= 1e12) {
    return `${roundToDecimal(value / 1e12, 1)} Tt`
  } else if (size >= 1e9) {
    return `${roundToDecimal(value / 1e9, 1)} Gt`
  } else if (size >= 1e6) {
    return `${roundToDecimal(value / 1e6, 1)} Mt`
  } else if (size >= 1e3) {
    return `${roundToDecimal(value / 1e3, 1)} kt`
  }

  return `${roundToDecimal(value, 0)} t`
}

// Years at a readable precision from COMPACT_YEARS on: 120 k, 2.4 M, 1.3 bn. At today's rate the sample's homeworld deposits last millions of years.
export const COMPACT_YEARS = 100000
const YEAR_UNITS = [[1e9, 'bn'], [1e6, 'M'], [1e3, 'k']]

export const compactYears = (value, separator) => {
  // A value that rounds up to the next unit takes it: 999,960 is 1 M, not 1,000 k.
  const [size, suffix] = YEAR_UNITS.find(([unit]) => value >= unit * 0.9995) || [1, '']
  const scaled = value / size
  const number = separatedNumber(roundToDecimal(scaled, scaled < 100 ? 1 : 0), separator)

  return suffix ? `${number} ${suffix}` : number
}
