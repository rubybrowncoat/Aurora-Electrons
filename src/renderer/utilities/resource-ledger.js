// The timed ledger of what a source holds of fuel, maintenance supplies and each mineral: the stock now, what the source makes, the deliveries on the days they arrive and the withdrawals planned against it, taken day by day over a period. It is the daily ledger of utilities/msp-supply.js generalised from the maintenance minerals to every stock the race keeps at a colony, so a tonne or a litre is spent once however many consumers ask for it.
//
// Two figures the game keeps stay apart from the player's own: the minimum the save stores (a colony's reserve of a mineral) and the minimum of a ship class (what a ship of the class keeps when it gives fuel or supplies) are shown as saved, and the reserve the player keeps at a source is the player's own record. The player's reserve is never folded into either, and nothing here is written to the save or given to the game as an order.
//
// A reserve holds a source's stock back from the withdrawals planned against it. A withdrawal draws only on what the source holds above the reserve; what it cannot draw is its shortfall, which names the day, the resource and the withdrawal. A shortfall that the withdrawal's own scenario would not have had alone is a conflict between scenarios, naming the others that took the stock or raised the reserve before it.

import { MINERALS } from './minerals'
import { registerRule } from './provenance'

export const DAYS_PER_YEAR = 365

// How far ahead the ledger looks, in days: the periods of the maintenance supply ledger.
export const HORIZONS = Object.freeze([
  Object.freeze({ days: 91, label: '3 mo' }),
  Object.freeze({ days: 183, label: '6 mo' }),
  Object.freeze({ days: 365, label: '1 y' }),
  Object.freeze({ days: 730, label: '2 y' }),
])

// The consumer that is the Hauling plan's own, which no player record can take the name of.
export const PLAN_SCENARIO = 'Hauling plan'

export const RESOURCES = Object.freeze([
  Object.freeze({ key: 'fuel', label: 'Fuel', unit: 'L', group: 'supplies' }),
  Object.freeze({ key: 'msp', label: 'Maintenance supplies', unit: 'MSP', group: 'supplies' }),
  ...MINERALS.map((mineral) => Object.freeze({ key: mineral.name, label: mineral.name, unit: 't', group: 'minerals' })),
])

export const RESOURCE_KEYS = Object.freeze(RESOURCES.map((resource) => resource.key))

export const resourceOf = (key) => RESOURCES.find((resource) => resource.key === key) || null

// The keys of the resources a panel covers: 'supplies' (fuel and maintenance supplies) or 'minerals'.
export const resourcesOf = (group) => RESOURCES.filter((resource) => resource.group === group).map((resource) => resource.key)

const EPSILON = 1e-9
const LEDGER_VERSIONS = ['2.7.x']

registerRule({
  id: 'reserveLedger.shortfall',
  versions: LEDGER_VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['FCT_Population stockpiles of fuel, maintenance supplies and the minerals', 'FCT_MassDriverPackets.Speed, Xcor, Ycor', 'the Hauling Planner\'s plan', 'the player\'s own reserve records'],
  note: 'The day a planned withdrawal cannot be filled from what its source holds above the player\'s reserve, with the resource and the withdrawal. The stock is taken day by day from its present level: the deliveries of the day arrive first, the withdrawals due that day draw in the order listed and each on what the ones before it left, and what the source makes is added at the end of the day. A delivery or a withdrawal counts on the day that ends on or after its own, as the maintenance supply ledger counts a delivery.',
  assumptions: ['The source keeps making what it makes now for the whole period', 'A haul or a packet delivers when its time is over, whole', 'A withdrawal that cannot be filled on its day is not tried again', 'The order of the withdrawals on one day is the ledger\'s choice, not a game rule', 'Nothing here is an order to the game'],
})

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

// The tick a delivery or a withdrawal counts on: the one that ends on or after its day, and the first for a day of 0 or less than a tick.
export const tickOf = (day) => Math.max(1, Math.ceil(day - EPSILON))

const add = (map, key, item) => {
  if (!map.has(key)) {
    map.set(key, [])
  }

  map.get(key).push(item)
}

const withdrawalOf = (item, step) => ({ step, kind: 'withdrawal', id: item.id, label: item.label, scenario: item.scenario || null, source: item.source || null, day: item.day, amount: item.amount })

// The stocks of `items` taken together over `days` daily ticks, one pass: each item is `{ stock, production, productionLasts, productionBudget, arrivals, withdrawals, reserve }` and the result of each is `{ known, days, start, final, produced, arrived, taken, events, shortfalls, lowest, late, untimed, beyond, skipped, cut, residual }`; a stock that is not a number has `known: false` and no figures. `arrivals` and `withdrawals` are `{ id, label, scenario, day, amount }`: one with a `day` of null is listed as untimed (with its `why`) and never counted, an arrival after the period is listed as late and a withdrawal after it as beyond. The withdrawals due on one tick draw in the order given. `production` is what the source makes a year at its own rate, `productionLasts` the days it goes on for (null: the whole period) and `productionBudget` the most it can make in all, from the inputs it has (null: no limit), so a source short of inputs stops when they are spent however long the period. `reserve` is what the withdrawals leave in the stock. `lowest` is the least the stock reaches, taken after each withdrawal, before the production of its tick.
// A delivery with a `source` of 'haul' is the other end of the withdrawal that has its id (in this call, of any stock, inside the period or not): the haul leaves on the tick of the withdrawal and the delivery is credited what that withdrawal was served, on the tick its day gives or the tick of the withdrawal, whichever is later, so a stock is never spent before the withdrawal that fills it has been served. A delivery that lands on the tick its haul leaves is credited before the withdrawals of the destination, so the stocks are taken in the order the hauls need within the tick; hauls that wait on each other in a cycle (or a haul to its own source) land on the tick after instead, so no cycle funds itself, whatever the order of the stocks. What a delivery lost is kept in `cut` (`{ id, label, planned, given, why, tick }`, `tick` the tick the whole haul was to land on). A delivery whose haul does not leave within the period is listed in `skipped`. A haul delivery with no withdrawal in the call is credited whole. Within a tick: what arrived on it first, then the withdrawals, then production.
// A source with `productionInputs` (`[{ key, perUnit }]`, the tonnes of the stock with that `key` one unit of its output takes) and a `key` of its own makes from the balances of those stocks when every one of them is an item of the call: each tick, after the withdrawals of all the stocks, it makes at most what the least of them allows (an input that is empty now and filled later makes nothing until it is filled) and debits them, so a withdrawal of an input and the production draw on one stock; an input that is not in the call leaves the source to its `productionBudget` and `productionLasts`. The result also has `used`, what production took from the stock. A source whose own stock is not a number is not run as a stock (no arrival, no withdrawal, no figure), but the production it has a rate for still debits the inputs it draws on: what its stock is does not change what it takes from the others.
export const runStocks = (items, days) => {
  const lines = items.map((item) => lineOf(item, days))
  const running = lines.filter((line) => line.known)
  const leaving = new Set(items.flatMap((item) => (item.withdrawals || []).filter((withdrawal) => withdrawal.source === 'haul').map((withdrawal) => withdrawal.id)))
  const leaves = new Map()
  const pending = new Map()
  const deferred = new Set()
  const linked = (arrival) => arrival.source === 'haul' && leaving.has(arrival.id)

  running.forEach((line) => line.due.forEach((list, step) => list.forEach((withdrawal) => {
    if (withdrawal.source === 'haul') {
      leaves.set(withdrawal.id, { line, step })
    }
  })))
  running.forEach((line) => line.landing.forEach((list, tick) => {
    const kept = []

    list.forEach((arrival) => {
      if (!linked(arrival)) {
        kept.push(arrival)
      } else if (leaves.has(arrival.id)) {
        pending.set(arrival.id, { line, arrival })
      } else {
        line.skipped.push({ ...arrival, why: 'its haul does not leave within the period' })
      }
    })
    line.landing.set(tick, kept)
  }))

  // The stocks in the order a tick needs: the source of a delivery that lands on the tick its haul leaves comes before the destination. The deliveries of a cycle are put to the next tick.
  const orderOf = (step) => {
    const edges = []

    pending.forEach(({ line, arrival }, id) => {
      const from = leaves.get(id)

      if (from.step === step && tickOf(arrival.day) <= step) {
        edges.push({ id, from: from.line, to: line })
      }
    })

    if (!edges.length) {
      return running
    }

    const reaches = (start, goal, seen = new Set()) => start === goal || (!seen.has(start) && seen.add(start) && edges.some((edge) => edge.from === start && reaches(edge.to, goal, seen)))

    edges.filter((edge) => reaches(edge.to, edge.from)).forEach((edge) => deferred.add(edge.id))

    const rest = [...running]
    const order = []

    while (rest.length) {
      const next = rest.find((line) => !edges.some((edge) => edge.to === line && !deferred.has(edge.id) && rest.includes(edge.from)))

      order.push(next)
      rest.splice(rest.indexOf(next), 1)
    }

    return order
  }

  // The stocks that feed another's production, found by key: a source whose every input is a stock of the call makes from the balance of those stocks, as they stand after the withdrawals of the tick, and debits them; otherwise its own budget limits it.
  const byKey = new Map(running.filter((line) => line.key !== null).map((line) => [line.key, line]))

  lines.forEach((line) => {
    const inputs = line.inputs.map((input) => ({ line: byKey.get(input.key), perUnit: input.perUnit }))

    line.shared = inputs.length > 0 && inputs.every((input) => input.line && input.line !== line) ? inputs : null
  })

  for (let step = 1; step <= days; step++) {
    orderOf(step).forEach((line) => {
      ;(line.landing.get(step) || []).forEach((arrival) => {
        line.held += arrival.amount
        line.arrived += arrival.amount
        line.events.push({ step, kind: 'arrival', id: arrival.id, label: arrival.label, scenario: arrival.scenario || null, day: arrival.day, amount: arrival.amount, level: line.held })
      })

      ;(line.due.get(step) || []).forEach((withdrawal) => {
        const before = line.held
        const served = Math.min(withdrawal.amount, Math.max(0, before - line.keep))
        const short = withdrawal.amount - served

        line.held -= served
        line.taken += served
        line.events.push({ ...withdrawalOf(withdrawal, step), served, short: short > EPSILON ? short : 0, before, reserve: line.keep, level: line.held, ...(short > EPSILON ? { reason: before >= withdrawal.amount - EPSILON ? 'reserve' : 'stock' } : {}) })

        if (line.held < line.lowest.level) {
          line.lowest = { level: line.held, step }
        }

        if (pending.has(withdrawal.id)) {
          const { line: taker, arrival } = pending.get(withdrawal.id)
          const tick = deferred.has(withdrawal.id) ? step + 1 : Math.max(tickOf(arrival.day), step)

          pending.delete(withdrawal.id)

          if (served > EPSILON && tick > days) {
            taker.late.push(arrival)
          } else if (served > EPSILON) {
            add(taker.landing, tick, { ...arrival, amount: served })
          }

          if (served < arrival.amount - EPSILON) {
            taker.cut.push({ id: arrival.id, label: arrival.label, planned: arrival.amount, given: served, why: served > EPSILON ? 'the source held less above its reserves than the haul takes' : 'the source gave none of it', tick })
          }
        }
      })
    })

    lines.forEach((line) => {
      if (line.daily > 0 && (line.shared || (line.known && (line.productionLasts === null || line.productionLasts === undefined || step <= line.productionLasts)))) {
        const room = line.shared ? Math.min(...line.shared.map((input) => Math.max(0, input.line.held) / input.perUnit)) : Math.max(0, line.budget - line.produced)
        const made = Math.min(line.daily, room)

        if (line.known) {
          line.held += made
          line.produced += made
        }

        ;(line.shared || []).forEach((input) => {
          const used = Math.min(input.line.held, made * input.perUnit)

          input.line.held -= used
          input.line.used += used

          if (input.line.held < input.line.lowest.level) {
            input.line.lowest = { level: input.line.held, step }
          }
        })
      }
    })
  }

  return lines.map((line) => (line.known ? { known: true, days, start: line.start, final: line.held, produced: line.produced, arrived: line.arrived, taken: line.taken, used: line.used, events: line.events, shortfalls: line.events.filter((event) => event.kind === 'withdrawal' && event.short > 0), lowest: line.lowest, late: line.late, untimed: line.untimed, beyond: line.beyond, skipped: line.skipped, cut: line.cut, residual: Math.abs(line.start + line.produced + line.arrived - line.taken - line.used - line.held) } : { known: false, days, reason: line.reason }))
}

// One stock over `days`: `runStocks` of one item.
export const runStock = ({ days, ...item }) => runStocks([item], days)[0]

// The state of one stock before its first tick: its arrivals and withdrawals sorted onto the ticks, or the answer for a stock that is not a number.
const lineOf = ({ key = null, stock, production = null, productionLasts = null, productionBudget = null, productionInputs = [], arrivals = [], withdrawals = [], reserve = 0 }, days) => {
  const known = isNumber(stock) && stock >= 0
  const line = { known, reason: 'The stock is not in the save.', key, inputs: productionInputs || [], shared: null, start: known ? stock : 0, held: known ? stock : 0, keep: isNumber(reserve) && reserve > 0 ? reserve : 0, daily: isNumber(production) && production > 0 ? production / DAYS_PER_YEAR : 0, budget: isNumber(productionBudget) && productionBudget >= 0 ? productionBudget : Infinity, productionLasts, landing: new Map(), due: new Map(), late: [], untimed: [], beyond: [], skipped: [], cut: [], events: [], produced: 0, arrived: 0, taken: 0, used: 0, lowest: { level: known ? stock : 0, step: 0 } }

  if (!known) {
    return line
  }

  arrivals.forEach((arrival) => {
    if (!isNumber(arrival.amount) || !(arrival.amount > 0)) {
      line.skipped.push({ ...arrival, why: 'its amount is not a positive number' })
    } else if (arrival.day === null || arrival.day === undefined) {
      line.untimed.push(arrival)
    } else if (!isNumber(arrival.day) || arrival.day < 0) {
      line.skipped.push({ ...arrival, why: 'its day is not a number of days from now' })
    } else if (tickOf(arrival.day) > days) {
      line.late.push(arrival)
    } else {
      add(line.landing, tickOf(arrival.day), arrival)
    }
  })

  withdrawals.forEach((withdrawal) => {
    if (!isNumber(withdrawal.amount) || !(withdrawal.amount > 0)) {
      line.skipped.push({ ...withdrawal, why: 'its amount is not a positive number' })
    } else if (withdrawal.day === null || withdrawal.day === undefined) {
      line.untimed.push(withdrawal)
    } else if (!isNumber(withdrawal.day) || withdrawal.day < 0) {
      line.skipped.push({ ...withdrawal, why: 'its day is not a number of days from now' })
    } else if (tickOf(withdrawal.day) > days) {
      line.beyond.push(withdrawal)
    } else {
      add(line.due, tickOf(withdrawal.day), withdrawal)
    }
  })

  return line
}

const planNumber = (plan) => (isNumber(plan.day) ? plan.day : null)

// The records of the player that hold one source and one resource, as the ledger's own inputs: the reserve each keeps and the withdrawals and refills it plans. `entries`: [{ uuid, scenario, sourceId, reserves, plans }], only those the repository holds as applying to the open save.
const recordsFor = (entries, sourceId, resource) => entries.filter((entry) => entry.sourceId === sourceId).map((entry) => ({
  scenario: entry.scenario,
  uuid: entry.uuid,
  reserve: isNumber(entry.reserves[resource]) ? entry.reserves[resource] : null,
  withdrawals: entry.plans.filter((plan) => plan.resource === resource && plan.kind === 'withdraw').map((plan) => ({ id: `${entry.uuid}:${plan.id}`, label: plan.label, scenario: entry.scenario, day: planNumber(plan), amount: plan.amount })),
  refills: entry.plans.filter((plan) => plan.resource === resource && plan.kind === 'refill').map((plan) => ({ id: `${entry.uuid}:${plan.id}`, label: plan.label, scenario: entry.scenario, day: planNumber(plan), amount: plan.amount, source: 'plan' })),
}))

const byScenario = (a, b) => a.scenario.localeCompare(b.scenario) || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0)

const maxOf = (values) => (values.length ? Math.max(...values) : null)

// The reserve the scenario keeps at a source (the largest of its records there), 0 when it keeps none; the Hauling plan keeps none.
const ownReserve = (records, scenario) => (scenario === PLAN_SCENARIO ? 0 : maxOf(records.filter((record) => record.scenario === scenario && record.reserve !== null).map((record) => record.reserve)) || 0)

// The scenarios, other than the one that is short, that took stock from the same source before the withdrawal did (a withdrawal that drew something), or that kept a larger reserve than the short scenario's own (which raised the one the combined run held back).
const rivalsOf = (run, short, own, records) => {
  const index = run.events.indexOf(short)
  const drew = run.events.slice(0, index).filter((event) => event.kind === 'withdrawal' && event.served > 0 && event.scenario !== short.scenario).map((event) => event.scenario)
  const reserved = records.filter((record) => record.scenario !== short.scenario && record.reserve !== null && record.reserve > own).map((record) => record.scenario)

  return { drew: [...new Set(drew)], reserved: [...new Set(reserved)] }
}

// The ledger of every source of `feeds` over `days` for the records the player kept, as one combined scenario. A feed is one source's one resource as the host reads it from the save: `{ key, sourceId, sourceName, place, resource, stock, production, productionLasts, productionBudget, arrivals, withdrawals, minimums }`, its arrivals and withdrawals the game's own (a packet in flight, the hauls of the Hauling plan, tagged with a `source` of 'packet' or 'haul' and the plan's `scenario`). `entries` are the records that apply; `scenarios` the names the combined scenario is made of (null or empty: every one); `countPlan` whether the Hauling plan's hauls count; `resources` the resources the panel covers, so a record's line for another resource is left to the panel that covers it. Every source's stock is spent once: all the feeds run together in one pass (`runStocks`), the withdrawals of all the scenarios drawing on a stock in turn, the records' first, by scenario name, then the plan's, so two consumers cannot both have the same tonne, and a haul's destination is credited what its source gave. A shortfall is competing when the scenario's own records, run the same way with the plan on and with the plan off, would have been served more of the withdrawal than the combined run served: the rivals are then the scenarios that drew first, kept a larger reserve, or did either at the source of a haul that delivered less than planned. Returns `{ days, scenarios, rows, shortfalls, conflicts, unfed }`.
// A feed may carry `productionInputs` (`[{ key, perUnit }]`, the feeds whose stock its production draws on, as `runStocks` reads them), so the withdrawals and hauls of a mineral and the production that needs it spend one stock; a feed with `support: true` is run with the others but is not a row of the result and its shortfalls are not listed (the stocks another panel's sources draw on). A source is active when a record or a plan touches it, and a destination of a counted haul is active, cut or untimed ones too.
export const combinedLedger = ({ feeds, entries = [], scenarios = null, days, countPlan = true, resources = RESOURCE_KEYS }) => {
  const names = scenarios && scenarios.length ? scenarios : null
  const chosen = entries.filter((entry) => !names || names.includes(entry.scenario))
  const fed = new Set(feeds.map((feed) => `${feed.sourceId}:${feed.resource}`))
  const hasPlan = countPlan && feeds.some((feed) => (feed.withdrawals || []).length > 0)
  const simulate = (use, planOn) => {
    const lines = feeds.map((feed) => {
      const records = recordsFor(use, feed.sourceId, feed.resource).sort(byScenario)
      const reserves = records.filter((record) => record.reserve !== null)
      const player = maxOf(reserves.map((record) => record.reserve))
      const gameArrivals = (feed.arrivals || []).filter((arrival) => planOn || arrival.source !== 'haul')
      const planned = planOn ? (feed.withdrawals || []) : []
      const withdrawals = [...records.flatMap((record) => record.withdrawals), ...planned]
      const refills = records.flatMap((record) => record.refills)

      return { feed, records, reserves, player, planned, active: records.some((record) => record.reserve !== null || record.withdrawals.length > 0 || record.refills.length > 0) || planned.length > 0 || (planOn && (feed.arrivals || []).some((arrival) => arrival.source === 'haul')), input: { key: feed.key, stock: feed.stock, production: feed.production, productionLasts: feed.productionLasts, productionBudget: feed.productionBudget, productionInputs: feed.productionInputs || [], arrivals: [...gameArrivals, ...refills], withdrawals, reserve: player === null ? 0 : player } }
    })
    const runs = runStocks(lines.map((line) => line.input), days)

    return lines.map((line, index) => ({ ...line, run: runs[index] }))
  }
  const base = simulate(chosen, countPlan)
  const baselines = new Map()
  const baselineOf = (scenario) => {
    if (!baselines.has(scenario)) {
      const use = scenario === PLAN_SCENARIO ? [] : chosen.filter((entry) => entry.scenario === scenario)

      baselines.set(scenario, [simulate(use, countPlan), ...(hasPlan ? [simulate(use, false)] : [])])
    }

    return baselines.get(scenario)
  }
  const departures = new Map()
  const feedAt = new Map(feeds.map((feed, at) => [feed.key, at]))

  base.forEach((line, index) => line.run.known && line.run.events.forEach((event) => {
    if (event.kind === 'withdrawal' && event.source === 'haul') {
      departures.set(event.id, { index, event })
    }
  }))

  // The scenarios that took stock from the stocks a source's production draws on before the tick of its shortfall: production runs after the withdrawals of a tick, so a withdrawal on the tick of the shortfall cannot have lessened what was made for it.
  const inputsOf = (index, until) => ({ drew: [...new Set((feeds[index].productionInputs || []).flatMap((input) => (feedAt.has(input.key) && base[feedAt.get(input.key)].run.known ? base[feedAt.get(input.key)].run.events : []).filter((event) => event.kind === 'withdrawal' && event.served > 0 && event.step < until).map((event) => event.scenario)))] })

  // The rivals at the sources of the hauls to a stock that delivered less than planned, only for those deliveries that were due by `until` (the tick of the shortfall), and the same upstream of each source up to the tick its haul left. A reserve is a rival only when it is larger than the reserve the short scenario `affected` keeps at that source.
  const upstreamOf = (index, until, seen, affected) => {
    const found = { drew: [], reserved: [] }

    if (!(seen.get(index) >= until)) {
      seen.set(index, until)
      base[index].run.cut.filter((cut) => cut.tick <= until).forEach((cut) => {
        const departure = departures.get(cut.id)

        if (departure) {
          const from = base[departure.index]
          const near = rivalsOf(from.run, departure.event, ownReserve(from.records, affected), from.records)
          const far = upstreamOf(departure.index, departure.event.step, seen, affected)

          found.drew.push(...near.drew, ...far.drew)
          found.reserved.push(...near.reserved, ...far.reserved)
        }
      })
    }

    return found
  }
  const rows = base.map((line, index) => {
    const { feed, records, reserves, player, run } = line
    const shortfalls = run.known ? run.shortfalls.map((event) => {
      const aloneEvents = baselineOf(event.scenario).map((alone) => alone[index].run).filter((alone) => alone.known).map((alone) => alone.events.find((other) => other.kind === 'withdrawal' && other.id === event.id)).filter(Boolean)
      const aloneServed = aloneEvents.length ? Math.max(...aloneEvents.map((other) => other.served)) : event.amount
      const own = ownReserve(records, event.scenario)
      const worse = Math.max(0, aloneServed - event.served)
      const competing = worse > EPSILON
      const near = competing ? rivalsOf(run, event, own, records) : { drew: [], reserved: [] }
      const far = competing ? upstreamOf(index, event.step, new Map(), event.scenario) : { drew: [], reserved: [] }
      const supply = competing ? inputsOf(index, event.step) : { drew: [] }
      const unique = (list) => [...new Set(list)].filter((name) => name !== event.scenario)

      return { key: feed.key, step: event.step, day: event.day, sourceId: feed.sourceId, sourceName: feed.sourceName, resource: feed.resource, withdrawal: { id: event.id, label: event.label, scenario: event.scenario }, wanted: event.amount, served: event.served, short: event.short, reason: event.reason, held: event.before, reserve: event.reserve, kind: competing ? 'competing' : 'own', worse, alone: { served: aloneServed, short: event.amount - aloneServed }, rivals: { drew: unique([...near.drew, ...far.drew, ...supply.drew]), reserved: unique([...near.reserved, ...far.reserved]) } }
    }) : []

    // The sources whose production draws on this stock and cannot be worked out: what they take from it is not counted.
    return {
      key: feed.key,
      sourceId: feed.sourceId,
      sourceName: feed.sourceName,
      place: feed.place || '',
      resource: feed.resource,
      stock: feed.stock,
      production: feed.production,
      minimums: { game: feed.minimums ? feed.minimums.game : null, class: feed.minimums ? feed.minimums.class : null, player: { value: player, recorded: player !== null, by: reserves.map((record) => ({ scenario: record.scenario, value: record.reserve })) } },
      active: line.active,
      records: records.length,
      run,
      cut: run.known ? run.cut : [],
      shortfalls,
      unknownUse: feeds.filter((other) => (other.productionInputs || []).some((input) => input.key === feed.key) && !isNumber(other.production)).map((other) => ({ key: other.key, resource: other.resource, sourceName: other.sourceName })),
    }
  }).filter((_, index) => !feeds[index].support)
  const shortfalls = rows.flatMap((row) => row.shortfalls).sort((a, b) => a.step - b.step || a.sourceName.localeCompare(b.sourceName) || a.resource.localeCompare(b.resource) || (a.withdrawal.id < b.withdrawal.id ? -1 : 1))
  const unfed = chosen.flatMap((entry) => resources.filter((resource) => (hasOwn(entry.reserves, resource) || entry.plans.some((plan) => plan.resource === resource)) && !fed.has(`${entry.sourceId}:${resource}`)).map((resource) => ({ scenario: entry.scenario, sourceId: entry.sourceId, resource })))

  return { days, scenarios: [...new Set(chosen.map((entry) => entry.scenario))].sort((a, b) => a.localeCompare(b)), rows, shortfalls, conflicts: shortfalls.filter((shortfall) => shortfall.kind === 'competing'), unfed }
}
