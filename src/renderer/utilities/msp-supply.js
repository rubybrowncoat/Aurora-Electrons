// The input minerals of a colony's maintenance production over time: what its stock, mining, mass-driver packets and feasible hauls give it, on the days they give it, against the colonies' other claims on the same minerals. The output of the present stock (`logistics.mspOutput`) stays apart from the supplied output built here, and a delivery whose timing or size is not known is listed, never counted. Evidence: docs/plans/backlog/evidence/AE-088-01.md.

import { colonyMinerals, loadPacketsInFlight, loadQueueNeeds } from './colony-minerals'
import { haulByClass, planHauls } from './haul-plan'
import { loadJumpPoints } from './jump-graph'
import { MSP_MINERALS, mspProduction } from './logistics'
import { MASS_DRIVER_TONS, MINERALS, SECONDS_PER_DAY } from './minerals'
import { KNOWN_SERVICE_COLUMNS, columnsOf, gaps, hasAll, knownServiceJoin, loadBootstrapFreight, loadShuttleTechnology, selectedColumns } from './mine-bootstrap-data'
import { miningSum, orbitalRateResult, surfaceRateResult } from './mineral-outlook'
import { routeResult, siteSupply } from './mineral-supply'
import { gateMiningRows, orbitalMiningQuery, surfaceMiningQuery } from './mining-data'
import { combine, isAvailable, ofRule, registerRule, unavailable } from './provenance'

export const DAYS_PER_YEAR = 365
// How far ahead the ledger looks, in years.
export const MSP_HORIZONS = [
  { years: 0.25, label: '3 mo' },
  { years: 0.5, label: '6 mo' },
  { years: 1, label: '1 y' },
  { years: 2, label: '2 y' },
]

const VERSIONS = ['2.7.x']
const EPSILON = 1e-9
// The game's launcher leaves a surplus below one tonne at the colony.
const MIN_LAUNCH = 1
const NAMES = MSP_MINERALS.map((mineral) => mineral.name)
const PER_MSP = Object.fromEntries(MSP_MINERALS.map((mineral) => [mineral.name, mineral.perMsp]))
const MATERIAL = Object.fromEntries(MSP_MINERALS.map((mineral) => [mineral.name, MINERALS.find((item) => item.name === mineral.name).id]))
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

registerRule({
  id: 'mspSupply.stockOnly',
  versions: VERSIONS,
  units: 'MSP/yr',
  verification: 'estimated',
  structure: ['FCT_Population stockpiles of the input minerals', 'logistics.mspProduction'],
  note: 'What the colony\'s maintenance facilities make over the period from the present stock alone: production, held to what the stock of the scarcest input mineral allows. No mining, packet or haul is counted, and no other consumer of the stock is. The mineral that limits it is named, with the conditional delivery that would lift it.',
  assumptions: ['No mining, packet or haul supplies the input minerals', 'The production rate stays what it is now'],
})

registerRule({
  id: 'mspSupply.supplied',
  versions: VERSIONS,
  units: 'MSP/yr',
  verification: 'estimated',
  structure: ['FCT_Population stockpiles, reserves and mass driver destination', 'FCT_MineralDeposit.Amount', 'FCT_MassDriverPackets', 'FCT_IndustrialProjects and shipyard tasks', 'the freighter classes and charted jump points'],
  note: 'What the colony\'s maintenance facilities make over the period when what mining, packets in flight and feasible hauls add is counted on the day each arrives, after the colony\'s other claims on the same minerals: its build queue, and its mass driver export of stock above the reserve. Each mineral is allocated once: a tonne a haul takes from a colony leaves its stock, a packet is counted at its one destination, and a deposit is drawn on by every mine and miner on it together, up to what it holds. The production of the game\'s order runs queue, then export, then maintenance, and the maintenance draw has no reserve to protect it. A delivery of unknown timing or size is not counted.',
  assumptions: ['Mining continues at today\'s rate until its deposit is spent', 'A packet arrives when its speed has covered its distance to the destination', 'A haul arrives whole once its freighter class has made every trip', 'A daily step stands for the game\'s production ticks', 'Packets the colonies launch during the period are not counted'],
})

registerRule({
  id: 'mspSupply.delivery',
  versions: VERSIONS,
  units: 't',
  verification: 'estimated',
  structure: ['FCT_MassDriverPackets.<mineral>, Speed, Xcor, Ycor, DestID', 'FCT_SystemBody.Xcor, Ycor', 'the Hauling Planner\'s plan and freighter classes'],
  note: 'The tonnes of the input minerals a conditional delivery brings the colony within the period, and the days it brings them on. A packet takes its distance over its speed; a haul takes the days its freighter class needs for every trip, a bound that is never earlier than the first load.',
  assumptions: ['A packet keeps its speed until it lands', 'A haul is counted when the freighter class has made every trip'],
})

registerRule({
  id: 'mspSupply.arrival',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['FCT_MassDriverPackets.Speed, Xcor, Ycor', 'FCT_SystemBody.Xcor, Ycor'],
  note: 'Days until a packet lands: its distance from the destination body in km over its speed in km/s, over 86,400 s. A destination body at 0, 0 stalls the packet in the game, so its arrival has no figure.',
})

const result = (rule, value, present, assumptions = []) => ofRule({ rule, value, inputs: { present }, assumptions })

// The day a delivery counts from: the tick that ends on or after its arrival.
const stepOf = (day) => Math.max(1, Math.ceil(day - EPSILON))

// What one deposit gives each day of the period when the colonies on its body ask `demand` t/yr together (the mines, the orbital miners and every civilian complex, taxed or bought) and it holds `amount` t now: the share of the ask it still meets ([0..1] by day, the same for every colony that draws on it) and the tonnes drawn. The deposit is spent once, whoever draws.
export const depositScales = ({ amount, demand, days }) => {
  const daily = demand / DAYS_PER_YEAR
  const scale = []
  let left = Math.max(0, amount)

  for (let step = 1; step <= days; step++) {
    const share = daily > EPSILON ? Math.min(1, left / daily) : 1

    scale.push(share)
    left -= daily > EPSILON ? daily * share : 0
  }

  return { scale, left: Math.max(0, left), drawn: Math.max(0, amount) - Math.max(0, left) }
}

// The deposits the race draws on, once each, by body and mineral (`${SystemBodyID}:${MaterialID}`): { amount, demand, missing, scale, left, drawn }. The ask is every mining row of the body together, the mines of each colony on it, the orbital miners and every civilian complex whether its output is taxed or bought (all of it comes out of the deposit; what a colony keeps of it is the colony's own rate). `scale` is null, and `missing` says why, where the deposit's amount or an ask is not known: nothing drawn from it is then counted.
export const depositsOf = ({ surface, orbital, navalAdmins, days }) => {
  const groups = new Map()
  const group = (row) => {
    const key = `${row.SystemBodyID}:${row.MaterialID}`

    if (!groups.has(key)) {
      groups.set(key, { amounts: [], rates: [] })
    }

    return groups.get(key)
  }

  surface.forEach((row) => {
    group(row).amounts.push(row.Amount)
    group(row).rates.push(surfaceRateResult(row, false))
  })
  orbital.forEach((row) => {
    group(row).amounts.push(row.Amount)
    group(row).rates.push(orbitalRateResult(row, navalAdmins))
  })

  return new Map([...groups].map(([key, entry]) => {
    const demand = miningSum(entry.rates)
    const known = entry.amounts.every(isNumber)
    const amount = known ? Math.max(...entry.amounts) : null
    const missing = [...(known ? [] : ['the deposit\'s remaining amount']), ...(isAvailable(demand) ? [] : demand.inputs.missing)]

    return [key, { amount, demand, missing, ...(missing.length ? { scale: null, left: null, drawn: null } : depositScales({ amount, demand: demand.value, days })) }]
  }))
}

// A colony's minerals run over `days` daily ticks. `colony`: { production (MSP/yr), stock ({ name: t }), inflows, outflows, queue, exporter }. An inflow with a `rate` (t/yr) digs from the colony's deposit day by day, and `scale` ([0..1] by day, 1 when absent) is the share of the asked rate its deposit still gave that day (`depositScales`); one with `tonnes` and a `day` lands at the tick that ends on or after the day. An outflow ({ mineral, tonnes }) leaves at the first tick. `queue` ({ name: t }) is what the build queue still takes, first; `exporter` ({ capacity (t/yr), reserve ({ name: t }), others ([{ stock, reserve }], the exportable minerals besides the input ones) }) ships stock above the reserve, the surplus of every mineral together within the drivers' capacity and only from a surplus of a tonne, before maintenance; maintenance draws last. A stock below 0 is held as 0. Returns the MSP made, what was lost and to which mineral, and every flow by mineral, which balance with the start stock to `residual`.
export const simulate = ({ production, stock, inflows = [], outflows = [], queue = null, exporter = null, days }) => {
  const start = Object.fromEntries(NAMES.map((name) => [name, Math.max(0, stock[name])]))
  const held = { ...start }
  const otherHeld = exporter ? exporter.others.map((other) => Math.max(0, other.stock)) : []
  const zero = () => Object.fromEntries(NAMES.map((name) => [name, 0]))
  const flows = { credited: zero(), given: zero(), queued: zero(), exported: zero(), used: zero() }
  const creditedBy = {}
  const windows = {}
  const lumps = new Map()
  const rates = inflows.filter((inflow) => inflow.rate !== undefined)
  const need = queue ? { ...queue } : null
  const lostBy = zero()
  let made = 0
  let lost = 0

  inflows.filter((inflow) => inflow.tonnes !== undefined).forEach((inflow) => {
    const step = stepOf(inflow.day)

    if (step <= days) {
      lumps.set(step, [...(lumps.get(step) || []), inflow])
    }
  })

  const credit = (inflow, tonnes, step) => {
    held[inflow.mineral] += tonnes
    flows.credited[inflow.mineral] += tonnes
    creditedBy[inflow.group] = (creditedBy[inflow.group] || 0) + tonnes
    windows[inflow.group] = windows[inflow.group] ? { first: Math.min(windows[inflow.group].first, step), last: Math.max(windows[inflow.group].last, step) } : { first: step, last: step }
  }

  for (let step = 1; step <= days; step++) {
    if (step === 1) {
      outflows.forEach((outflow) => {
        if (NAMES.includes(outflow.mineral)) {
          const given = Math.min(held[outflow.mineral], outflow.tonnes)

          held[outflow.mineral] -= given
          flows.given[outflow.mineral] += given
        } else if (exporter) {
          const index = exporter.others.findIndex((other) => other.name === outflow.mineral)

          if (index >= 0) {
            otherHeld[index] -= Math.min(otherHeld[index], outflow.tonnes)
          }
        }
      })
    }

    rates.forEach((inflow) => {
      const tonnes = inflow.rate / DAYS_PER_YEAR * (inflow.scale ? inflow.scale[step - 1] : 1)

      if (tonnes > 0) {
        credit(inflow, tonnes, step)
      }
    })

    const landing = lumps.get(step) || []

    landing.forEach((inflow) => credit(inflow, inflow.tonnes, step))

    if (need) {
      NAMES.forEach((name) => {
        const taken = Math.min(held[name], need[name])

        held[name] -= taken
        need[name] -= taken
        flows.queued[name] += taken
      })
    }

    if (exporter) {
      const surplus = Object.fromEntries(NAMES.map((name) => [name, Math.max(0, held[name] - exporter.reserve[name])]))
      const otherSurplus = exporter.others.map((other, index) => Math.max(0, otherHeld[index] - other.reserve))
      const total = otherSurplus.reduce((sum, value) => sum + value, 0) + NAMES.reduce((sum, name) => sum + surplus[name], 0)

      if (total >= MIN_LAUNCH) {
        const fraction = Math.min(1, exporter.capacity / DAYS_PER_YEAR / total)

        NAMES.forEach((name) => {
          held[name] -= surplus[name] * fraction
          flows.exported[name] += surplus[name] * fraction
        })
        otherSurplus.forEach((value, index) => {
          otherHeld[index] -= value * fraction
        })
      }
    }

    const wanted = production / DAYS_PER_YEAR
    const allowed = NAMES.map((name) => held[name] / PER_MSP[name])
    const lowest = allowed.reduce((best, value, index) => (value < allowed[best] ? index : best), 0)
    const done = Math.min(wanted, allowed[lowest])

    made += done
    NAMES.forEach((name) => {
      held[name] -= done * PER_MSP[name]
      flows.used[name] += done * PER_MSP[name]
    })

    if (wanted - done > EPSILON) {
      lost += wanted - done
      lostBy[NAMES[lowest]] += wanted - done
    }
  }

  const limiting = NAMES.reduce((best, name) => (lostBy[name] > (best ? lostBy[best] : EPSILON) ? name : best), null)
  const residual = Math.max(...NAMES.map((name) => Math.abs(start[name] + flows.credited[name] - flows.given[name] - flows.queued[name] - flows.exported[name] - flows.used[name] - held[name])))

  return { made, nominal: production * days / DAYS_PER_YEAR, lost, lostBy, limiting, final: held, flows, creditedBy, windows, residual }
}

// What each group of inflows adds to the MSP made: the run with the group left out, taken from the run with it. Biggest first.
const contributions = (colony, days, run) => [...new Set(colony.inflows.map((inflow) => inflow.group))].map((group) => ({ group, msp: run.made - simulate({ ...colony, inflows: colony.inflows.filter((inflow) => inflow.group !== group), days }).made, tonnes: run.creditedBy[group] || 0, window: run.windows[group] || null })).sort((a, b) => b.msp - a.msp)

// The three runs of one colony: its present stock alone, the supplied output with the build queue idle (`high`), and with the queue served first (`low`, null while the queue is not known). Each with what its inflow groups add.
export const allocateMsp = ({ colony, days }) => {
  const stockOnly = simulate({ production: colony.production, stock: colony.stock, days })
  const high = simulate({ ...colony, queue: null, days })
  const low = colony.queue ? simulate({ ...colony, days }) : null

  return { days, stockOnly, high, low, highGroups: contributions({ ...colony, queue: null }, days, high), lowGroups: low ? contributions(colony, days, low) : null }
}

// ---------- the reads ----------

const SOURCE_NAMES = {
  colonies: 'the colonies\' stock, reserves and mass drivers',
  needs: 'the build queues',
  packets: 'the mass-driver packets in flight',
  packetRows: 'the position and speed of each packet',
  mining: 'the mines and orbital miners',
  jumps: 'the charted jump points',
  freight: 'the freighter classes',
  handling: 'the cargo shuttle technology',
  plan: 'the haul plan',
}

const MINERAL_COLUMNS = MINERALS.flatMap((mineral) => [mineral.name, `Reserve${mineral.name}`])

// The game's count of a colony's mass drivers: the installations of a mass driver type, each amount floored to a whole one (a fractional amount, left by a cargo transfer, is not a driver yet), and how many installation rows have an amount or a driver value not recorded. One row per PopID.
const DRIVER_COUNT = (GameID) => `select FCT_PopulationInstallations.PopID, sum(case when DIM_PlanetaryInstallation.MassDriverValue > 0 then cast(FCT_PopulationInstallations.Amount + 1e-9 as integer) else 0 end) as Drivers, sum(case when FCT_PopulationInstallations.Amount is null or DIM_PlanetaryInstallation.MassDriverValue is null then 1 else 0 end) as Gaps from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${GameID} group by FCT_PopulationInstallations.PopID`

// The race's colonies with place, stock and reserve of every mineral, the mass driver destination (with that colony's race and system) and the drivers, and what serves their cargo handling. A figure the save does not hold reads as null.
export const loadMspColonies = async (database, { GameID, RaceID }) => {
  const [population, body, installation, built] = await Promise.all(['FCT_Population', 'FCT_SystemBody', 'DIM_PlanetaryInstallation', 'FCT_PopulationInstallations'].map((table) => columnsOf(database, table)))
  const lacking = [...gaps('FCT_Population', population, ['PopulationID', 'PopName', 'SystemID', 'SystemBodyID', 'GameID', 'RaceID']), ...gaps('FCT_SystemBody', body, ['SystemBodyID', 'Xcor', 'Ycor'])]

  if (lacking.length) {
    throw new Error(`the save lacks ${lacking.join(', ')}`)
  }

  const served = hasAll(installation, ['PlanetaryInstallationID', 'Name', 'CargoShuttleValue']) && hasAll(built, ['GameID', 'PopID', 'PlanetaryInstallationID', 'Amount'])
  const driven = hasAll(installation, ['PlanetaryInstallationID', 'MassDriverValue']) && hasAll(built, ['GameID', 'PopID', 'PlanetaryInstallationID', 'Amount'])
  const [rows] = await database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, ${population.has('MassDriverDest') ? 'FCT_Population.MassDriverDest' : 'null as MassDriverDest'}, ${selectedColumns('FCT_Population', population, MINERAL_COLUMNS)}, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor, ${served ? KNOWN_SERVICE_COLUMNS : 'null as ShuttleCapacity, null as ServiceNames'}, ${driven ? 'VIR_Drivers.Drivers as Drivers, VIR_Drivers.Gaps as DriverGaps' : 'null as Drivers, 1 as DriverGaps'}, VIR_Destination.PopulationID as DestinationID, VIR_Destination.PopName as DestinationName, VIR_Destination.RaceID as DestinationRaceID, VIR_Destination.SystemID as DestinationSystemID from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID ${served ? knownServiceJoin(GameID, 'FCT_Population.PopulationID') : ''} ${driven ? `left join (${DRIVER_COUNT(GameID)}) as VIR_Drivers on VIR_Drivers.PopID = FCT_Population.PopulationID` : ''} left join FCT_Population as VIR_Destination on VIR_Destination.PopulationID = ${population.has('MassDriverDest') ? 'FCT_Population.MassDriverDest' : '0'} and VIR_Destination.GameID = FCT_Population.GameID and ${population.has('MassDriverDest') ? 'FCT_Population.MassDriverDest' : '0'} > 0 where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`)

  return Object.freeze(rows.map((row) => Object.freeze({ ...row, Drivers: driven ? row.Drivers ?? 0 : null, DriverGaps: driven ? row.DriverGaps ?? 0 : 1 })))
}

// The packets bound for the race's colonies in flight: the input minerals each carries (null where the save does not hold the column), its speed and position, and the position of the colony it is bound for (null when that colony is not there). A packet keeps the race that launched it when its destination changes hands, and still lands there, so a packet is the race's when its destination is the race's colony, or the race launched it.
export const loadPacketRows = async (database, { GameID, RaceID }) => {
  const [packet, population, body] = await Promise.all(['FCT_MassDriverPackets', 'FCT_Population', 'FCT_SystemBody'].map((table) => columnsOf(database, table)))
  const lacking = [...gaps('FCT_MassDriverPackets', packet, ['PacketID', 'GameID', 'RaceID', 'DestID', 'Speed', 'Xcor', 'Ycor']), ...gaps('FCT_Population', population, ['PopulationID', 'GameID', 'RaceID', 'SystemBodyID']), ...gaps('FCT_SystemBody', body, ['SystemBodyID', 'Xcor', 'Ycor'])]

  if (lacking.length) {
    throw new Error(`the save lacks ${lacking.join(', ')}`)
  }

  const [rows] = await database.query(`select FCT_MassDriverPackets.PacketID, FCT_MassDriverPackets.DestID, FCT_MassDriverPackets.Speed, FCT_MassDriverPackets.Xcor, FCT_MassDriverPackets.Ycor, ${selectedColumns('FCT_MassDriverPackets', packet, NAMES)}, FCT_SystemBody.Xcor as DestXcor, FCT_SystemBody.Ycor as DestYcor from FCT_MassDriverPackets left join FCT_Population on FCT_Population.PopulationID = FCT_MassDriverPackets.DestID and FCT_Population.GameID = FCT_MassDriverPackets.GameID left join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID where FCT_MassDriverPackets.GameID = ${GameID} and (FCT_MassDriverPackets.RaceID = ${RaceID} or FCT_Population.RaceID = ${RaceID})`)

  return Object.freeze(rows)
}

const stocksKnown = (colony) => MINERALS.every((mineral) => isNumber(colony[mineral.name]) && isNumber(colony[`Reserve${mineral.name}`]))
const needsKnown = (needs, colony) => !needs[colony.PopulationID] || MINERALS.every((mineral) => isNumber(needs[colony.PopulationID][mineral.name]) && !(needs[colony.PopulationID][`Missing${mineral.name}`] > 0))
const packetsKnown = (packets, colony) => !packets[colony.PopulationID] || MINERALS.every((mineral) => isNumber(packets[colony.PopulationID][mineral.name]) && !(packets[colony.PopulationID][`Missing${mineral.name}`] > 0))

// The Hauling Planner's hauls over the colonies whose place, stock, reserve, queue needs and inbound packets are all in the save: { hauls, unmet, left } with `left` the colonies not in the plan. A colony the plan cannot read is left out, not read as holding nothing.
export const planColonyHauls = ({ colonies, needs, packets, jumpPoints }) => {
  const planned = colonies.filter((colony) => isNumber(colony.Xcor) && isNumber(colony.Ycor) && stocksKnown(colony) && needsKnown(needs, colony) && packetsKnown(packets, colony))
  const plan = planHauls(planned.map((colony) => ({ colony, minerals: colonyMinerals(colony, needs[colony.PopulationID], packets[colony.PopulationID], false) })), { jumpPoints, reserves: true })

  return { ...plan, left: colonies.filter((colony) => !planned.includes(colony)).map((colony) => colony.PopulationID) }
}

// Every source the supply reads, each on its own: { colonies, needs, packets, packetRows, surface, orbital, plan, freighters, shuttleTechnology, problems }. A read that fails (a save of another shape) is null and named in `problems` ([{ source, text }]), and what rests on it is counted as unknown. `blocked` is the set of commander bonus IDs the save's lookup does not confirm.
export const loadMspSupply = async (database, { GameID, RaceID, blocked = new Set() }) => {
  const problems = []
  const attempt = async (source, read) => {
    try {
      return await read()
    } catch (error) {
      problems.push({ source, retry: true, text: `${SOURCE_NAMES[source]} could not be read (${String(error.message).split('\n')[0]})` })

      return null
    }
  }
  const [colonies, needs, packets, packetRows, surface, orbital, jumpPoints, freight, shuttleTechnology] = await Promise.all([
    attempt('colonies', () => loadMspColonies(database, { GameID, RaceID })),
    attempt('needs', () => loadQueueNeeds(database, { GameID, RaceID })),
    attempt('packets', () => loadPacketsInFlight(database, { GameID, RaceID })),
    attempt('packetRows', () => loadPacketRows(database, { GameID, RaceID })),
    attempt('mining', async () => (await database.query(surfaceMiningQuery({ GameID, RaceID })))[0]),
    attempt('mining', async () => (await database.query(orbitalMiningQuery({ GameID, RaceID })))[0]),
    attempt('jumps', () => loadJumpPoints(database, { GameID, RaceID })),
    attempt('freight', () => loadBootstrapFreight(database, { GameID, RaceID })),
    attempt('handling', () => loadShuttleTechnology(database, { RaceID })),
  ])

  if (freight && freight.gaps.length) {
    problems.push({ source: 'freight', text: `the save lacks ${freight.gaps.join(', ')}` })
  }

  const planned = colonies && needs && packets && jumpPoints ? await attempt('plan', async () => planColonyHauls({ colonies, needs, packets, jumpPoints })) : null

  return {
    colonies,
    needs,
    packets,
    packetRows,
    surface: surface && gateMiningRows(surface, blocked),
    orbital: orbital && gateMiningRows(orbital, blocked),
    plan: planned,
    freighters: freight && !freight.gaps.length ? freight.freighters : null,
    shuttleTechnology,
    problems,
  }
}

// ---------- the rows ----------

// Days until a packet lands, or the reason it has no figure.
export const packetArrival = (packet) => {
  if (!isNumber(packet.Speed) || !(packet.Speed > 0)) {
    return { days: null, why: 'its speed is not recorded or is 0' }
  } else if (![packet.Xcor, packet.Ycor, packet.DestXcor, packet.DestYcor].every(isNumber)) {
    return { days: null, why: 'a position it needs is not recorded' }
  } else if (packet.DestXcor === 0 && packet.DestYcor === 0) {
    return { days: null, why: 'its destination body sits at 0, 0, where the game stalls it' }
  }

  return { days: Math.hypot(packet.Xcor - packet.DestXcor, packet.Ycor - packet.DestYcor) / packet.Speed / SECONDS_PER_DAY, why: null }
}

// Each haul of the plan with the freighters that carry it, in the plan's order, each ship given to one haul only: { haul, best, days, ships, why }. A haul takes the class that finishes it soonest from the ships still free (up to one ship for every hold it fills), and `days` is the days those ships need for all its trips; `days` is null with no class that can carry it, or none of whose ships are still free (`why` says so). A ship is taken to start at the haul's source colony, and the order of the plan is the planner's choice, not a game rule.
export const timeHauls = ({ plan, freighters, shuttleTechnology, formulaVersion }) => {
  const free = freighters.map((shipClass) => Math.max(1, shipClass.Ships))

  return plan.hauls.map((haul) => {
    let estimates = []

    try {
      estimates = freighters.map((shipClass, index) => ({ index, estimate: haulByClass(haul, shipClass, shuttleTechnology, formulaVersion) })).filter(({ estimate }) => estimate.status === 'ok' && isNumber(estimate.holds) && estimate.holds > 0 && isNumber(estimate.tripDays))
    } catch (error) {
      return { haul, best: null, days: null, ships: 0, why: `its timing could not be worked out (${String(error.message).split('\n')[0]})` }
    }

    if (!estimates.length) {
      return { haul, best: null, days: null, ships: 0, why: freighters.length ? 'no freighter class can carry it' : 'the race has no freighter class' }
    }

    const options = estimates.filter(({ index }) => free[index] > 0).map(({ index, estimate }) => {
      const ships = Math.min(estimate.holds, free[index])

      return { index, estimate, ships, days: Math.ceil(estimate.holds / ships) * estimate.tripDays }
    })
    const best = options.reduce((soonest, option) => (!soonest || option.days < soonest.days ? option : soonest), null)

    if (!best) {
      return { haul, best: null, days: null, ships: 0, why: 'every freighter that could carry it is already given to another haul of the plan' }
    }

    free[best.index] -= best.ships

    return { haul, best: best.estimate, days: best.days, ships: best.ships, why: null }
  })
}

const skip = (colony) => !(colony.MaintenanceFacilities > 0) || colony.MaintProdStatus === 0

// The ledger of every colony that makes maintenance supplies. `colonies`: the Logistics page's rows; `sources`: `loadMspSupply`'s; `modifierOf(PopulationID)`: the colony's production modifier or null; `navalAdmins`: the mining admins for orbital miners; `formulaVersion`: the save's formula version; `RaceID`; `years`: the period. A colony whose production, stock or modifier is not known has unavailable figures.
export const mspSupplyRows = ({ colonies, sources, modifierOf, navalAdmins, formulaVersion, RaceID, years }) => {
  const days = Math.max(1, Math.round(years * DAYS_PER_YEAR))
  const failed = new Set(sources.problems.map((problem) => problem.source))
  const problemText = (source) => (sources.problems.find((problem) => problem.source === source) || { text: SOURCE_NAMES[source] }).text
  const sourceBy = Object.fromEntries((sources.colonies || []).map((colony) => [colony.PopulationID, colony]))
  const sites = sources.colonies && sources.surface && sources.orbital ? Object.fromEntries(NAMES.map((name) => [name, new Map(siteSupply({ surface: sources.surface, orbital: sources.orbital, navalAdmins, routes: sources.colonies, packets: null, RaceID, materialId: MATERIAL[name], flows: null }).map((site) => [site.populationId, site]))])) : null
  const timed = sources.plan && sources.freighters ? timeHauls({ plan: sources.plan, freighters: sources.freighters, shuttleTechnology: sources.shuttleTechnology, formulaVersion }) : null
  const inPlan = (id) => sources.plan && !sources.plan.left.includes(id)
  const producing = new Map(colonies.filter((colony) => !skip(colony)).map((colony) => [colony.PopulationID, colony]))
  const scaled = new Map()
  const deposits = sources.surface && sources.orbital ? depositsOf({ surface: sources.surface, orbital: sources.orbital, navalAdmins, days }) : null
  const gives = new Map()

  // A colony makes its own maintenance supplies before it gives to a haul: the hauls from it are cut to what its stock holds beyond what its production takes over the period, so a tonne is either given or used, never both.
  if (timed) {
    timed.filter((entry) => entry.days !== null).forEach(({ haul }) => haul.minerals.filter((mineral) => NAMES.includes(mineral.name)).forEach((mineral) => {
      const key = `${haul.from.PopulationID}:${mineral.name}`

      gives.set(key, [...(gives.get(key) || []), { key: `${haul.key}:${mineral.name}`, tonnes: mineral.tonnes }])
    }))
    gives.forEach((entries, key) => {
      const [fromId, name] = key.split(':')
      const source = producing.get(Number(fromId))
      const production = source ? mspProduction(source, modifierOf(source.PopulationID)) : null
      const total = entries.reduce((sum, entry) => sum + entry.tonnes, 0)
      const cap = source && isNumber(source[name]) && isAvailable(production) ? Math.max(0, source[name] - production.value * days / DAYS_PER_YEAR * PER_MSP[name]) : total
      const share = total > cap && total > 0 ? cap / total : 1

      entries.forEach((entry) => scaled.set(entry.key, entry.tonnes * share))
    })
  }

  return colonies.filter((colony) => !skip(colony)).map((colony) => {
    const id = colony.PopulationID
    const own = sourceBy[id] || null
    const production = mspProduction(colony, modifierOf(id))
    const notCounted = []
    const inflows = []
    const outflows = []
    const meta = {}
    const note = (kind, text) => notCounted.push({ kind, text })
    const mark = (group, kind, label, conditional) => {
      meta[group] = { group, kind, label, conditional }
    }
    const missing = [...(isAvailable(production) ? [] : production.inputs.missing), ...(colony.MaintProdStatus === null || colony.MaintProdStatus === undefined ? ['whether maintenance production is on'] : []), ...NAMES.filter((name) => !isNumber(colony[name])).map((name) => `the colony's stock of ${name}`)]

    if (missing.length) {
      const none = unavailable({ rule: 'mspSupply.supplied', missing })

      return { colony, populationId: id, production, stockOnly: { result: unavailable({ rule: 'mspSupply.stockOnly', missing }), limiting: null, delivery: null }, high: { result: none, limiting: null, delivery: null }, low: { result: none, limiting: null, delivery: null, why: 'the figures above are not known' }, deliveries: [], notCounted, balance: null, ledger: null }
    }

    // Mining: what the colony's own mines and orbital miners add to its stock, from a deposit that every colony of the body, every orbital miner and every civilian complex draws on together (`depositsOf`), and only the share the colony keeps (not the taxed or shipped civilian output).
    if (sites && deposits) {
      NAMES.forEach((name) => {
        const site = sites[name].get(id)

        if (!site) {
          return
        }

        const rows = [...sources.surface, ...sources.orbital].filter((row) => row.PopulationID === id && row.MaterialID === MATERIAL[name])
        const deposit = deposits.get(`${rows[0].SystemBodyID}:${MATERIAL[name]}`)

        if (!deposit.scale) {
          note('mining', `${name} from the mines and orbital miners: ${deposit.missing.join(', ')}`)

          return
        }

        const orbital = miningSum(sources.orbital.filter((row) => row.PopulationID === id && row.MaterialID === MATERIAL[name]).map((row) => orbitalRateResult(row, navalAdmins)))
        const surface = combine({ rule: 'mspSupply.delivery', parts: { local: site.local, orbital }, compute: (values) => Math.max(0, values.local - values.orbital) })

        if (isAvailable(surface) && surface.value > 0) {
          mark('mines', 'mining', 'the colony\'s mines', false)
          inflows.push({ group: 'mines', kind: 'mining', mineral: name, rate: surface.value, scale: deposit.scale })
        } else if (!isAvailable(surface) && sources.surface.some((row) => row.PopulationID === id && row.MaterialID === MATERIAL[name])) {
          note('mining', `${name} from the mines: ${surface.inputs.missing.join(', ') || 'the rate is not known'}`)
        }

        if (isAvailable(orbital) && orbital.value > 0) {
          mark('orbital', 'orbital', 'the orbital miners', false)
          inflows.push({ group: 'orbital', kind: 'orbital', mineral: name, rate: orbital.value, scale: deposit.scale })
        } else if (!isAvailable(orbital)) {
          note('orbital', `${name} from the orbital miners: ${orbital.inputs.missing.join(', ') || 'the rate is not known'}`)
        }
      })
    } else {
      note('mining', `the mines and orbital miners: ${failed.has('mining') ? problemText('mining') : problemText('colonies')}`)
    }

    // Packets in flight to the colony, each on the day its distance over its speed gives.
    if (sources.packetRows) {
      const packets = sources.packetRows.filter((packet) => packet.DestID === id)

      packets.forEach((packet) => {
        const arrival = packetArrival(packet)
        const loads = NAMES.filter((name) => packet[name] === null || packet[name] === undefined || packet[name] > 0)

        if (!loads.length) {
          return
        }

        if (arrival.days === null) {
          note('packets', `packet ${packet.PacketID}: ${arrival.why}`)

          return
        }

        loads.forEach((name) => {
          if (isNumber(packet[name])) {
            mark('packets', 'packets', 'packets in flight', true)
            inflows.push({ group: 'packets', kind: 'packets', mineral: name, tonnes: packet[name], day: arrival.days })
          } else {
            note('packets', `packet ${packet.PacketID}: its ${name} is not recorded`)
          }
        })
      })
    } else {
      note('packets', `the packets in flight: ${failed.has('packetRows') ? problemText('packetRows') : 'not read'}`)
    }

    // Hauls the plan makes to and from the colony, counted when a freighter class can carry them.
    if (timed) {
      timed.filter(({ haul }) => haul.to.PopulationID === id || haul.from.PopulationID === id).forEach(({ haul, days: haulDays, why }) => {
        const carried = haul.minerals.filter((mineral) => NAMES.includes(mineral.name))
        const aboard = haul.minerals.filter((mineral) => !NAMES.includes(mineral.name))

        if (!carried.length && (haul.to.PopulationID === id || !aboard.length)) {
          return
        }

        const incoming = haul.to.PopulationID === id
        const other = incoming ? haul.from : haul.to
        const group = `${incoming ? 'haul from' : 'haul to'} ${other.PopulationID}`

        if (haulDays === null) {
          note('hauls', `${group.replace(/ \d+$/, ` ${other.PopName}`)}: ${why}`)

          return
        }

        carried.forEach((mineral) => {
          if (incoming) {
            mark(group, 'haul', `a haul from ${other.PopName}`, true)
            inflows.push({ group, kind: 'haul', mineral: mineral.name, tonnes: scaled.get(`${haul.key}:${mineral.name}`), day: haulDays })
          } else {
            mark(group, 'haul', `a haul to ${other.PopName}`, true)
            outflows.push({ group, mineral: mineral.name, tonnes: scaled.get(`${haul.key}:${mineral.name}`) })
          }
        })

        // What else the haul carries away leaves the stock the export shares among the minerals, on the day it sets out.
        if (!incoming) {
          aboard.forEach((mineral) => outflows.push({ group, mineral: mineral.name, tonnes: mineral.tonnes }))
        }
      })
    } else {
      note('hauls', `the hauls: ${['colonies', 'needs', 'packets', 'jumps', 'freight', 'handling', 'plan'].filter((source) => failed.has(source)).map(problemText)[0] || 'not planned'}`)
    }

    if (own && sources.plan && !inPlan(id)) {
      note('hauls', 'the colony is not in the haul plan: its place, stock, reserve, queue or inbound packets are not all recorded')
    }

    // The colony's other claims: its build queue and its mass driver export.
    const needRow = sources.needs ? sources.needs[id] : undefined
    const queue = sources.needs ? Object.fromEntries(NAMES.map((name) => [name, needRow ? (needRow[`Missing${name}`] > 0 || !isNumber(needRow[name]) ? null : needRow[name]) : 0])) : null
    const queueKnown = queue && NAMES.every((name) => queue[name] !== null)
    let exporter = null

    if (!queueKnown) {
      note('queue', sources.needs ? 'the queue needs of an input mineral are not all recorded' : problemText('needs'))
    }

    if (own) {
      const route = routeResult({ colony: own, civilian: false, RaceID })
      const routed = isAvailable(route) ? route.value : null

      if (routed && routed.stock === 'ships') {
        const capacity = own.Drivers * MASS_DRIVER_TONS
        const reserve = Object.fromEntries(NAMES.map((name) => [name, own[`Reserve${name}`]]))

        if (isNumber(capacity) && NAMES.every((name) => isNumber(reserve[name])) && stocksKnown(own)) {
          exporter = { capacity, reserve, others: MINERALS.filter((mineral) => !NAMES.includes(mineral.name)).map((mineral) => ({ name: mineral.name, stock: own[mineral.name], reserve: own[`Reserve${mineral.name}`] })) }
        } else {
          note('export', 'the colony\'s mass driver export: a stock, reserve or driver count is not recorded')
        }
      } else if (!routed) {
        note('export', `the colony's mass driver export: ${route.inputs.missing.join(', ')} not recorded`)
      }
    } else {
      note('export', `the colony's mass driver export: ${problemText('colonies')}`)
    }

    const description = { production: production.value, stock: Object.fromEntries(NAMES.map((name) => [name, colony[name]])), inflows, outflows, queue: queueKnown ? queue : null, exporter }
    const allocation = allocateMsp({ colony: description, days })
    const perYear = (value) => value / (days / DAYS_PER_YEAR)
    const counted = [...new Set(inflows.filter((inflow) => !inflow.sink).map((inflow) => meta[inflow.group].label))]
    const left = [...new Set(notCounted.map((entry) => entry.kind))]
    const standing = [`The period is ${days} days`, ...(counted.length ? [`Counted: ${counted.join(', ')}`] : ['No mining, packet or haul is counted']), ...(left.length ? [`Not counted for want of a figure: ${left.join(', ')}`] : [])]
    const deliveryOf = (groups) => {
      const leading = groups.filter((entry) => meta[entry.group] && meta[entry.group].conditional && entry.msp > EPSILON && entry.window)[0]

      return leading ? { group: leading.group, label: meta[leading.group].label, kind: meta[leading.group].kind, tonnes: result('mspSupply.delivery', leading.tonnes, ['FCT_MassDriverPackets', 'the Hauling Planner\'s plan']), firstDay: leading.window.first, lastDay: leading.window.last, msp: result('mspSupply.supplied', perYear(leading.msp), ['the ledger run with and without the delivery'], standing) } : null
    }
    const figure = (run, groups, rule) => ({ result: result(rule, perYear(run.made), ['the colony\'s stock of the input minerals', 'the colony\'s production'], standing), limiting: run.limiting, delivery: deliveryOf(groups) })
    const deliveries = allocation.highGroups.filter((entry) => meta[entry.group]).map((entry) => ({ ...meta[entry.group], tonnes: result('mspSupply.delivery', entry.tonnes, ['the sources the group reads']), firstDay: entry.window ? entry.window.first : null, lastDay: entry.window ? entry.window.last : null, msp: result('mspSupply.supplied', perYear(entry.msp), ['the ledger run with and without the group'], standing), mspLow: allocation.lowGroups ? result('mspSupply.supplied', perYear((allocation.lowGroups.find((low) => low.group === entry.group) || { msp: 0 }).msp), ['the ledger run with and without the group'], standing) : null }))

    return {
      colony,
      populationId: id,
      production,
      stockOnly: { result: result('mspSupply.stockOnly', perYear(allocation.stockOnly.made), ['the colony\'s stock of the input minerals', 'the colony\'s production'], ['No mining, packet or haul is counted']), limiting: allocation.stockOnly.limiting, delivery: deliveryOf(allocation.highGroups) },
      high: figure(allocation.high, allocation.highGroups, 'mspSupply.supplied'),
      low: allocation.low ? figure(allocation.low, allocation.lowGroups, 'mspSupply.supplied') : { result: unavailable({ rule: 'mspSupply.supplied', missing: ['the queue needs of the input minerals'] }), limiting: null, delivery: null },
      deliveries,
      notCounted,
      balance: Math.max(allocation.stockOnly.residual, allocation.high.residual, allocation.low ? allocation.low.residual : 0),
      ledger: { high: allocation.high.flows, low: allocation.low ? allocation.low.flows : null },
      days,
      years,
    }
  })
}
