// Mineral maths shared by the Mineral Outlook page: deposit depletion, the
// game's mineral ledger and the industrial queue's demand. Validated against
// the sample save; see docs/plans/aurcalcs/sql-mining.md §§ 1–2.

import { roundToDecimal } from './math'

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

// A civilian mining complex can be founded on a body with more than 10,000 t of Duranium or Gallicite at
// accessibility 0.7 or better (the game's TryEstablishCivilianMiningColony). The site's other conditions are
// in colonization.js `cmcSite`.
export const CMC_MINERAL_IDS = [1, 11]
const CMC_MIN_AMOUNT = 10000
const CMC_MIN_ACCESSIBILITY = 0.7

export const qualifiesForCmc = (deposit) => !!deposit && deposit.Amount > CMC_MIN_AMOUNT && deposit.Accessibility >= CMC_MIN_ACCESSIBILITY

// The Minerals page's mining potential of one deposit, 0 to 10. With r = sin(π/2 · accessibility), it is
// atan((Amount / 20,000 t)^r · r²) scaled from [0, π/2) to [0, 10): 20,000 t at accessibility 1 scores 5,
// 100,000 t at 0.7 about 8, and a deposit at 0.1 never passes 1 however large.
const POTENTIAL_REFERENCE_AMOUNT = 20000

export const depositPotential = (deposit) => {
  const reach = Math.sin((Math.PI / 2) * deposit.Accessibility)

  return (Math.atan(Math.pow(deposit.Amount / POTENTIAL_REFERENCE_AMOUNT, reach) * reach * reach) / (Math.PI / 2)) * 10
}

// What the game's own AI makes of a deposit: accessibility,
// halved under 10,000 t and raised for a big deposit that is still easy to reach (more than 100,000, 250,000
// and 1,000,000 t at accessibility above 0.4). Nothing under 2,000 t counts. An NPR seeds a mining colony on a
// body whose deposits add up to 6 and adds mines to a colony from 4.
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

// How short a mineral is for the race, from the runway the Mineral Outlook page shows (its stock and in-transit
// cargo over its net loss a year). The game's AI scales a deposit the same way by how little its capital holds
// (x3 under 1,000 t, x2 under 3,000, x1.5 under 5,000); here the runway decides. A mineral that holds or grows
// counts once, and so does one that lasts a century or more. `years` is the runway a tier covers, up to and
// excluding it.
export const CRITICAL_RUNWAY_YEARS = 5
export const WARNING_RUNWAY_YEARS = 25
export const SCARCITY = [
  { id: 'critical', label: 'Critical', years: CRITICAL_RUNWAY_YEARS, factor: 3 },
  { id: 'short', label: 'Short', years: WARNING_RUNWAY_YEARS, factor: 2 },
  { id: 'falling', label: 'Running down', years: 100, factor: 1.5 },
]
export const NOT_SCARCE = { id: 'ok', label: 'Holding', years: null, factor: 1 }

export const scarcityOf = (runway) => (Number.isFinite(runway) && SCARCITY.find((tier) => runway < tier.years)) || NOT_SCARCE

export const SECONDS_PER_DAY = 86400

// Accessibility never falls below this; the deposit is empty when it gets there.
export const ACCESSIBILITY_FLOOR = 0.1
// Forecasts past this are shown as "endless" (the sample's homeworld deposits run for millions of years).
export const ENDLESS_YEARS = 10000

// t/yr at the deposit's current accessibility, as the game's RecalculateMiningProductionTotals has it: each kind
// of capacity cut to a whole number; manned mines scale with the colony's efficiency, stability and political
// status, automated mines and civilian complexes don't; radiation, the governor and a quarter of the sector
// commander's bonus scale them all. `owned` drops civilian complexes the race taxes instead of buying from.
const whole = (capacity) => Math.floor(capacity + 1e-9)

export const surfaceRate = (row, owned = true) => {
  const manned = whole(row.ManualMineCount) * row.Efficiency * row.StabilityModifier * (row.PoliticalModifier ?? 1)
  const civilian = owned && !row.PurchaseCivilianMinerals ? 0 : whole(row.CivilianMineCount)

  return (manned + whole(row.AutomatedMineCount) + civilian) * row.MineProduction * row.Accessibility * row.GovernorBonus * row.SectorBonus * Math.max(0, row.RadiationModifier)
}

// A ship short of crew runs its mining modules at Current Crew / Class Crew (docs:
// crew-and-commanders, v2.6). Over-crewed ships don't mine faster; uncrewed classes always run.
export const crewFraction = (row) => (row.ClassCrew > 0 ? Math.min(1, Math.max(0, row.CurrentCrew) / row.ClassCrew) : 1)

// The workbook's orbital formula, plus the crew rule; unverified, the sample has no player orbital miners.
export const orbitalRate = (row, adminBonus = 1) => row.MiningModules * row.MineProduction * row.CommanderBonus * adminBonus * crewFraction(row) * row.Accessibility

// t/yr one orbital miner takes, with its naval admin chain; nothing over a body wider than the race can mine
// from orbit.
export const orbitalMinerRate = (row, navalAdmins) => (row.Diameter <= row.MaximumOrbitalMiningDiameter ? orbitalRate(row, navalAdminChainBonus(navalAdmins, row.SystemID, row.NavalAdminCommandID)) : 0)

// Mining the game's mineral ledger leaves out, t/yr by MaterialID: everything mined at a colony that buys its
// civilian complexes' output and ships it by mass driver (`MassDriverExport`, mining-data.js). The game records
// nothing for that colony, neither its own mines nor the complexes, and the shipment arrives as a mass-driver
// transfer, which isn't income.
export const unloggedMining = ({ surface, orbital, navalAdmins }) => {
  const totals = {}
  const add = (row, rate) => {
    totals[row.MaterialID] = (totals[row.MaterialID] || 0) + rate
  }

  surface.filter((row) => row.MassDriverExport).forEach((row) => add(row, surfaceRate(row)))
  orbital.filter((row) => row.MassDriverExport).forEach((row) => add(row, orbitalMinerRate(row, navalAdmins)))

  return totals
}

const declineShape = (deposit) => {
  const { Amount: amount, Accessibility: accessibility, HalfOriginalAmount: half, OriginalAcc: original } = deposit
  const declines = original > ACCESSIBILITY_FLOOR && half > 0
  const slope = declines ? (original - ACCESSIBILITY_FLOOR) / half : 0
  // Where the decline starts: the original value at the halfway point or, already below
  // half, the unrounded current value (the stored one is rounded to 2 decimals).
  const startAccessibility = !declines ? accessibility : amount > half ? original : ACCESSIBILITY_FLOOR + slope * amount

  return { amount, accessibility, half, declines, slope, startAccessibility }
}

// Above half the rate is flat. Below it, dA/dt = -k(0.1 + s·A), so accessibility
// decays exponentially to the floor, where the deposit is empty.
// `rate`: t/yr at the current accessibility, every colony and ship on the deposit summed.
export const depositForecast = (deposit, rate) => {
  const { amount, accessibility, half, declines, slope, startAccessibility } = declineShape(deposit)

  if (!(rate > 0) || !(amount > 0) || !(accessibility > 0)) {
    return { yearsToHalf: null, yearsToDepletion: null, endless: false, idle: true }
  }

  const k = rate / accessibility
  const yearsToHalf = declines ? Math.max(0, amount - half) / rate : null
  const yearsToDepletion = declines ? (yearsToHalf + Math.log(startAccessibility / ACCESSIBILITY_FLOOR) / (k * slope)) : amount / rate

  return {
    yearsToHalf,
    yearsToDepletion,
    endless: yearsToDepletion > ENDLESS_YEARS,
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

// One mineral's stockpile over `steps` (years): today's stock, what each deposit still delivers
// (exactly, from depositStateAt's remaining amounts, so a deposit never gives more than it holds),
// and every other flow at today's net rate. Mining only slows down, so the level is concave: it
// rises while the output beats the net drain, peaks where the two meet, then only falls, and so
// crosses zero downwards at most once, after the peak. The peak is found on the output directly
// (not on the samples, which can step over a rise and fall that fit between two of them).
// `deposits`: [{ deposit, rate (t/yr now), share (of the output that reaches the stockpile) }]
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

// The ledger's purposes, folded to eight groups so a chart never needs a ninth colour.
// Transfers between your own colonies (freighters, mass drivers) and the starting stockpile
// aren't empire income or spending, so they're left out.
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

// Types the game logs in its production phase, once per cycle and all at the same time (on the
// sample, every one of them falls on a mining tick). Salvage and transfers come at other times.
export const PRODUCTION_TYPES = FLOW_GROUPS.filter((group) => group.key !== 'salvage').flatMap((group) => group.types)

export const flowGroupOf = (type) => FLOW_GROUPS.find((group) => group.types.includes(type))

// How many days of history the ledger rows cover, the same span for every flow. Production
// events (mining, construction, maintenance…) come once per cycle, each standing for the cycle
// before it; transfers can fall in between. So the history starts where the cycle holding the
// earliest event of any kind starts. `anchorTime` is a production tick (the latest one) and
// `cycleDays` the cycle length.
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

// Each mineral's runway as the Mineral Outlook page reads it from the ledger: the year's income (mining and
// salvage, plus the mining the ledger leaves out) against its spending, the stock and cargo in transit over the
// net loss, and the scarcity that sets. `ledger`: rows of { MaterialID, MineralDataType, Amount, FirstTime,
// LastTime, ProductionTicks, FirstTick, LastTick } over the last `windowDays`; `stock`, `transit` (tonnes) and
// `unlogged` (t/yr, from `unloggedMining`): { [MaterialID]: value }. Without a ledger (a save before Aurora 2.6)
// nothing is known and every mineral counts as holding.
export const mineralOutlook = ({ ledger, gameTime, windowDays = DAYS_PER_YEAR, stock, transit, unlogged = {} }) => {
  const coverageDays = ledgerCoverage(ledger, gameTime, windowDays)
  const perYear = coverageDays ? DAYS_PER_YEAR / coverageDays : 0
  const outlook = Object.fromEntries(MINERALS.map((mineral) => [mineral.id, { name: mineral.name, stock: (stock[mineral.id] || 0) + (transit[mineral.id] || 0), produced: coverageDays ? unlogged[mineral.id] || 0 : 0, used: 0 }]))

  ledger.forEach((row) => {
    const group = !TRANSFER_TYPES.has(row.MineralDataType) && flowGroupOf(row.MineralDataType)

    if (group && outlook[row.MaterialID]) {
      outlook[row.MaterialID][group.income ? 'produced' : 'used'] += row.Amount * perYear
    }
  })

  Object.values(outlook).forEach((mineral) => {
    mineral.net = mineral.produced - mineral.used
    mineral.runway = mineral.net < 0 ? mineral.stock / -mineral.net : null
    mineral.scarcity = scarcityOf(mineral.runway)
  })

  return { known: coverageDays > 0, minerals: outlook }
}

const facilityOf = (productionType) => (productionType === 1 ? 'ordnance' : productionType === 2 ? 'fighter' : 'construction')

// Minerals the industrial queue will consume over the next year: each project's
// cost scaled to one year of work at its share of the colony's capacity; queued
// entries count only while the year has capacity left (as "mineral use.sql" does),
// and only for the capacity earlier entries leave.
// `capacityOf(PopulationID, ProductionType)`: BP/yr at 100%.
export const annualQueueDemand = (projects, capacityOf) => {
  const demand = Object.fromEntries(MINERALS.map((mineral) => [mineral.name, 0]))
  const groups = {}

  projects.forEach((project) => {
    const key = `${project.PopulationID}-${facilityOf(project.ProductionType)}`

    ;(groups[key] = groups[key] || []).push(project)
  })

  Object.values(groups).forEach((group) => {
    // The year's capacity spent so far, in percent of a full year at 100%.
    let usedPercent = 0

    ;[...new Set(group.map((project) => project.Queue))].sort((a, b) => a - b).forEach((queue) => {
      if (usedPercent >= 100) {
        return
      }

      group.filter((project) => project.Queue === queue).forEach((project) => {
        const capacity = capacityOf(project.PopulationID, project.ProductionType)
        const remainingBP = project.Amount * project.ProdPerUnit

        if (!capacity || !project.Percentage || !remainingBP) {
          return
        }

        // A year at the project's own share, but no more than earlier projects left.
        const availablePercent = Math.max(0, Math.min(project.Percentage, 100 - usedPercent))
        const builtBP = Math.min(remainingBP, (capacity * availablePercent) / 100)
        const oneYearFactor = builtBP / remainingBP

        MINERALS.forEach((mineral) => {
          demand[mineral.name] += project.Amount * (project[mineral.name] || 0) * oneYearFactor
        })

        usedPercent += (100 * builtBP) / capacity
      })
    })
  })

  return demand
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

// An admin command's radius in jumps, or null when it has no base. A Naval Headquarters
// adds one jump per doubling of its level (levels 1, 2, 4, 8 give 1, 2, 3, 4), times the
// command type's multiplier (Patrol and Survey 2). A command on a flag bridge reaches
// only its own system.
export const navalAdminRadius = ({ ShipID, HeadquartersLevel, Radius }) => {
  if (ShipID) {
    return 0
  }

  if (!(HeadquartersLevel >= 1)) {
    return null
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

// Naval admin bonuses chain up the command tree: the ship must be within its own
// command's range, and each command's HQ within its parent's range for the parent
// to apply too. A command without a commander of the required rank breaks the chain
// (docs/DATABASE.md § Commander bonus rules). Each one passes on its commander's
// bonus scaled by the command type's share.
// `admins`: { [NavalAdminCommandID]: { SystemID, ParentCommandID, BonusValue, Share, Eligible, Systems: Set } }
export const navalAdminChainBonus = (admins, systemId, commandId) => {
  let bonus = 1
  let location = systemId
  const visited = new Set()
  let current = admins[commandId]

  while (current && !visited.has(current.NavalAdminCommandID) && current.Eligible && current.Systems.has(location)) {
    visited.add(current.NavalAdminCommandID)

    if (current.BonusValue) {
      bonus *= 1 + (current.BonusValue - 1) * current.Share
    }

    location = current.SystemID
    current = admins[current.ParentCommandID]
  }

  return bonus
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
