// Mineral maths shared by the Mineral Outlook page: deposit depletion, the
// game's mineral ledger and the industrial queue's demand. Validated against
// the sample save; see docs/plans/aurcalcs/sql-mining.md §§ 1–2.

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

// A body can host a civilian mining complex with at least 10,000 t of a qualifying
// mineral at accessibility 0.7 or better. The docs name Duranium only, the Aur_Calcs
// workbook adds Gallicite; the qualifying minerals are a setting (`cmcMinerals`).
export const CMC_CONFIG_KEY = 'cmcMinerals'
export const CMC_DEFAULT_MINERAL_IDS = [1, 11]
export const CMC_MIN_AMOUNT = 10000
export const CMC_MIN_ACCESSIBILITY = 0.7

// The stored setting, kept to known mineral IDs; anything else falls back to the default.
export const cmcMineralIds = (stored) => {
  if (!Array.isArray(stored)) {
    return [...CMC_DEFAULT_MINERAL_IDS]
  }

  return stored.map(Number).filter((id) => MINERALS.some((mineral) => mineral.id === id))
}

export const qualifiesForCmc = (deposit) => !!deposit && deposit.Amount >= CMC_MIN_AMOUNT && deposit.Accessibility >= CMC_MIN_ACCESSIBILITY

export const SECONDS_PER_DAY = 86400

// Accessibility never falls below this; the deposit is empty when it gets there.
export const ACCESSIBILITY_FLOOR = 0.1
// Forecasts past this are shown as "endless" (the sample's homeworld deposits run for millions of years).
export const ENDLESS_YEARS = 10000

// Manned installations scale with the colony's efficiency; automated ones don't.
// t/yr at the deposit's current accessibility. `owned` drops civilian complexes the race doesn't buy from.
export const surfaceRate = (row, owned = true) => {
  const mines = owned ? row.OwnedMineCount : row.MineCount
  const modifier = row.RadiationModifier * row.StabilityModifier * (row.PoliticalModifier ?? 1) * row.EconomicProdModifier

  return (row.ManualMineCount * row.Efficiency + (mines - row.ManualMineCount)) * row.MineProduction * row.Accessibility * row.GovernorBonus * row.SectorBonus * modifier
}

// The workbook's orbital formula; unverified, the sample has no player orbital miners.
export const orbitalRate = (row, adminBonus = 1) => row.MiningModules * row.MineProduction * row.CommanderBonus * adminBonus * row.Accessibility

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
// crosses zero at most once, and between the first two samples that bracket it.
// `deposits`: [{ deposit, rate (t/yr now), share (of the output that reaches the stockpile) }]
export const stockProjection = ({ start, otherNet, deposits, steps }) => {
  const initial = deposits.map(({ deposit, rate }) => depositStateAt(deposit, rate, 0).amount)
  const levelAt = (years) => deposits.reduce((sum, { deposit, rate, share }, index) => sum + (initial[index] - depositStateAt(deposit, rate, years).amount) * share, start + otherNet * years)
  const levels = steps.map(levelAt)
  const output = steps.map((years) => deposits.reduce((sum, { deposit, rate, share }) => sum + depositStateAt(deposit, rate, years).rate * share, 0))
  let runOut = null

  if (start <= 0 && output[0] + otherNet < 0) {
    runOut = 0
  } else {
    const index = levels.findIndex((level, i) => i > 0 && level <= 0 && levels[i - 1] > 0)

    if (index > 0) {
      let low = steps[index - 1]
      let high = steps[index]

      for (let iteration = 0; iteration < 60; iteration++) {
        const middle = (low + high) / 2

        if (levelAt(middle) > 0) {
          low = middle
        } else {
          high = middle
        }
      }

      runOut = high
    }
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

export const flowGroupOf = (type) => FLOW_GROUPS.find((group) => group.types.includes(type))

// How many days of history the ledger rows cover: each event stands for one
// production cycle, so add one step after the first event.
export const ledgerCoverageDays = ({ gameTime, firstTime, lastTime, events, windowDays }) => {
  if (!events || firstTime == null) {
    return 0
  }

  const stepDays = events > 1 ? (lastTime - firstTime) / (events - 1) / SECONDS_PER_DAY : 5

  return Math.min(windowDays, (gameTime - firstTime) / SECONDS_PER_DAY + stepDays)
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
