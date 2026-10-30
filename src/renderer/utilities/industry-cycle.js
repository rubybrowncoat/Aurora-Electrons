// The production cycle of one colony's industrial projects, run forward cycle by cycle as the game runs it, for the Production page's forecast. Pure functions on plain numbers in and out (no provenance, no page state), so the results are keyed by project ID for anything that wants them (the staffing demand of AE-060, the maintenance outlook of AE-088); inside, every conserved quantity is an exact decimal of the game's own type (utilities/decimal.js).
//
// Each cycle every project that is out of the queue and not paused takes its share of the colony's capacity for its kind times the years the cycle covers, builds that many units (no more than it has left), is cut to what the colony's stock covers (each mineral from the stock the projects ahead of it left, in the game's order), has the build rounded to 4 decimals (a tie to the even digit), is cut again to the fuel and, for a conversion, to the whole source installations the colony holds, debits the stock and adds the build to its partial unit; a whole unit is delivered when the partial unit passes 1, and the project finishes when what it built is exactly what it had left. When one finishes, the queued projects of its kind start in queue order, each that fits in the share the running and paused ones leave, skipping any that do not; they build from the next cycle on. A paused project keeps its share and builds nothing.
//
// The figures of the save are read the way the platform converts a double into the game's decimal type (15 significant digits, a tie to the even digit on the double's exact value), the length of a cycle as the years of an increment of that many seconds. A project whose amount has more than 4 decimals (a fuel or installation limit left a part of a unit finer than a build) can never build exactly what it has left, since a build has 4: its project is stuck, which no save shows, so what the game does with it is taken as not known: it frees no share, starts no queued project, and the projects queued behind it have no start.
//
// The order the game takes the running projects in each cycle is not saved. Where the stock cannot bind in any cycle the order cannot change the outcome and one run is the answer; where two projects want the same stock and together more than it holds, the run is repeated under every order of the projects involved (up to MAX_EXHAUSTIVE of them; beyond that under the orders that put each first and last) and the dates are given as the range over those runs.
//
// Arrivals are hypothetical stock the caller adds ({ resource, day, quantity, source }): an arrival is in the stock of the first cycle that ends on or after its day. Nothing here reads a save, ships anything or assumes any income.
import { UNPACED } from './search-run'
import { ZERO, add, addMultiple, additions, sumsExactly, subtract, multiply, divide, equal, less, greater, positive, negative, floor, round, minimum, negate, fromDouble, fromString, toDouble, toNumber, toInteger, ceilRatio, floorRatio } from './decimal'

export const FUEL = 'fuel'
export const BUILD_DECIMALS = 4
// The most projects whose every order is tried; with more, only the orders that put each first and last.
export const MAX_EXHAUSTIVE = 5
// How far ahead a run looks, in days.
export const HORIZON_DAYS = 36500
// A cycle's build under this many units is rounded to a fraction of itself too coarse to date a project by: a small error in the capacity or the cycle length moves the date by a large share of itself.
export const UNBOUNDED_BELOW = 0.0005

const SCALE = 10 ** BUILD_DECIMALS
// An arrival that falls on the end of a cycle by this many days of float noise is in that cycle.
const EPSILON = 1e-9
const SECONDS_PER_DAY = 86400
const SECONDS_PER_YEAR = fromDouble(31536000)
// The most runs a forecast makes: every order of up to MAX_EXHAUSTIVE projects, repeated while the set of projects in contention grows.
const MAX_RUNS = 1000
const HUNDRED = fromDouble(100)
const ONE = fromDouble(1)
// A build under this is rounded to nothing (a tie goes to the even digit, 0).
const HALF_STEP = fromString('0.00005')
// The stock of a run that has all it needs: more than any build of the horizon takes.
const PLENTY = fromString('1e22')

// Which of a category's queued projects start now that some of its share is free, in the continuous schedule: in queue order, each that fits in what the running and paused ones leave, none after the share is used up, skipping any that do not fit. `queue`: projects with a `Percentage`, in queue order; `used`: the percentage the projects out of the queue hold. Returns { started, waiting, used }.
export const admitQueued = (queue, used) => {
  const started = []
  const waiting = []
  let held = used
  let full = false

  queue.forEach((project) => {
    if (full || 100 - held + EPSILON < project.Percentage) {
      waiting.push(project)
    } else {
      started.push(project)
      held += project.Percentage
      full = 100 - held <= 0
    }
  })

  return { started, waiting, used: held }
}

// The queued projects the game starts when a project of their kind finishes, in queue order, as decimals: each whose share fits in what the others leave of the 100%, none after the share is used up.
const startable = (queue, held) => {
  const started = []
  let available = subtract(HUNDRED, held)

  for (const state of queue) {
    if (!less(available, state.share)) {
      started.push(state)
      available = subtract(available, state.share)

      if (!positive(available)) {
        break
      }
    }
  }

  return started
}

const permutations = (items) => (items.length <= 1 ? [items] : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])))

// The years an increment of `cycleDays` days covers, as the game makes them: the seconds over the seconds of a year as a decimal, taken through a double by the platform's own conversion (`toDouble`) and read back to 15 digits.
export const yearsOf = (cycleDays) => fromDouble(toDouble(divide(fromDouble(cycleDays * SECONDS_PER_DAY), SECONDS_PER_YEAR)))

// A project's figures as the decimals a cycle works on: what its share of the capacity buys in a cycle (`units`, the capacity times the years times the share, over the points a unit takes), the build that rounds to (`step`), what it needs of each mineral in the game's order and of the fuel.
const prepare = (project, capacities, years) => {
  const needs = Object.entries(project.needs || {}).filter(([, need]) => need > 0).map(([resource, need]) => [resource, fromDouble(need)])
  const share = fromDouble(project.Percentage)
  const capacity = capacities[project.category]
  const units = capacity > 0 && project.ProdPerUnit > 0 && project.Percentage > 0 ? divide(multiply(multiply(fromDouble(capacity), years), divide(share, HUNDRED)), fromDouble(project.ProdPerUnit)) : ZERO
  const fuel = needs.find(([resource]) => resource === FUEL)

  return {
    id: project.ID,
    category: project.category,
    share,
    costed: project.ProdPerUnit > 0,
    units,
    step: round(units, BUILD_DECIMALS),
    amount: fromDouble(project.Amount),
    partial: fromDouble(project.PartialCompletion || 0),
    needs,
    minerals: needs.filter(([resource]) => resource !== FUEL),
    fuel: fuel ? fuel[1] : null,
    source: project.source || null,
    queue: project.Queue,
    paused: Boolean(project.Paused),
  }
}

const stateOf = (prepared) => ({
  ...prepared,
  held: !(prepared.queue > 0),
  finished: false,
  startCycle: prepared.queue > 0 ? null : 0,
  finishCycle: null,
  built: ZERO,
  delivered: 0,
  firstBuild: null,
  firstCut: null,
  cutCycles: 0,
  lastBuild: null,
  lastCut: false,
  stall: null,
  fineRemainder: false,
  unresolved: false,
  behindUnresolved: false,
})

// Whether an amount has no digit finer than a build's.
const fourDecimals = (value) => value.s <= BUILD_DECIMALS

// One project's cycle, the game's own steps: the build is what its share buys, no more than it has left, cut to each mineral's stock in turn, rounded to 4 decimals, cut to the fuel (not rounded) and to the whole source installations; the stock is debited by what is built. Returns { built, cut, stall, finishing }.
const buildCycle = (state, left, unlimited) => {
  const finishing = !less(state.units, state.amount)
  let requested = greater(state.units, state.amount) ? state.amount : state.units
  let limit = null
  let cut = null

  if (!unlimited) {
    state.minerals.forEach(([resource, need]) => {
      const stock = left[resource] || ZERO

      if (less(stock, multiply(need, requested))) {
        cut = resource
        limit = resource
        requested = divide(stock, need)
      }
    })
  }

  requested = round(requested, BUILD_DECIMALS)

  if (!unlimited && state.fuel && positive(requested)) {
    const stock = left[FUEL] || ZERO

    if (less(stock, multiply(state.fuel, requested))) {
      cut = FUEL
      limit = FUEL
      requested = divide(stock, state.fuel)
    }
  }

  if (!unlimited && state.source && positive(requested)) {
    const available = left[state.source] || ZERO

    if (less(available, requested)) {
      requested = floor(available)
      limit = state.source
      cut = state.source
    }
  }

  if (!positive(requested)) {
    const reason = !positive(state.units) ? { reason: state.costed ? 'capacity' : 'cost', resource: null } : limit ? { reason: limit === state.source ? 'source' : 'stock', resource: limit } : finishing ? { reason: 'remainder', resource: null } : { reason: 'rounding', resource: null }

    return { built: ZERO, cut, stall: reason, finishing }
  }

  state.needs.forEach(([resource, need]) => {
    left[resource] = subtract(left[resource] || ZERO, multiply(need, requested))
  })

  return { built: requested, cut, stall: null, finishing }
}

// Adds the projects in contention this cycle to `contested`: any resource two or more of the projects want, in all more than the colony holds while it holds enough for some build, puts those projects in contention. What a project wants is the build it would make with no stock short, rounded as the game rounds it (a stock that covers the unrounded builds can still fall short of the rounded ones).
function* contend(building, left, contested, pace) {
  const wants = {}

  for (const [index, state] of building.entries()) {
    if (index > 0 && pace.expired()) {
      yield
    }

    const want = round(minimum(state.units, state.amount), BUILD_DECIMALS)

    if (positive(want)) {
      state.needs.forEach(([resource, need]) => (wants[resource] = wants[resource] || []).push({ state, quantity: multiply(need, want), least: resource === FUEL ? ZERO : multiply(need, HALF_STEP), whole: false }))

      if (state.source) {
        ;(wants[state.source] = wants[state.source] || []).push({ state, quantity: want, least: ONE, whole: true })
      }
    }
  }

  for (const [resource, list] of Object.entries(wants)) {
    const stock = left[resource] || ZERO
    let asked = ZERO

    for (const [index, entry] of list.entries()) {
      if (index > 0 && pace.expired()) {
        yield
      }

      asked = add(asked, entry.quantity)
    }

    if (list.length >= 2 && greater(asked, stock) && list.some((entry) => (entry.whole ? !less(stock, entry.least) : greater(stock, entry.least)))) {
      list.forEach((entry) => contested.add(entry.state.id))
    }
  }
}

// The stock the projects that built last cycle take in each of their cycles, by resource: one negative delta per project, what it needs of the resource times the build it repeats.
function* debitsOf(building, pace) {
  const debits = {}
  const running = building.filter((state) => positive(state.lastBuild))

  for (const [index, state] of running.entries()) {
    if (index > 0 && pace.expired()) {
      yield
    }

    state.needs.forEach(([resource, need]) => (debits[resource] = debits[resource] || []).push(negate(multiply(need, state.step))))
  }

  return debits
}

// How many cycles from `next` are the same as the one before them, so they can be taken in one step: every project that builds builds all its share buys, the same rounded build each cycle, is not cut, and is left with more than that build and than its share after it, so it neither finishes nor changes what it asks; the stock covers the draw of each of them; no arrival comes and nothing starts; and every quantity the cycles change (the stock, the amount left, what was built, the part of a unit kept) takes them as the game's type does, each addition exact, so the stretch is the same as the cycles one by one and not a stretch whose sum the type would round on the way. A project that built nothing last cycle builds nothing in them (the stock only falls). 0 when any project has not been run since the last change. In a run whose stock is not the colony's (`unlimited`) the stock is never read, so its rounding does not matter.
function* steadySpan(building, left, next, pending, limit, unlimited, pace) {
  const draw = {}
  const counts = {}
  let span = limit

  for (const [index, state] of building.entries()) {
    if (index > 0 && pace.expired()) {
      yield
    }

    if (state.lastBuild === null) {
      return 0
    }

    if (positive(state.lastBuild)) {
      const reach = greater(state.step, state.units) ? state.step : state.units

      if (state.lastCut || !positive(state.step) || !greater(state.amount, reach)) {
        return 0
      }

      span = Math.min(span, ceilRatio(subtract(state.amount, reach), state.step), additions(state.amount, [negate(state.step)]), additions(state.built, [state.step]), additions(state.partial, [state.step]))
      state.needs.forEach(([resource, need]) => (draw[resource] = add(draw[resource] || ZERO, multiply(need, state.step))))

      if (state.source) {
        draw[state.source] = add(draw[state.source] || ZERO, state.step)
        counts[state.source] = (counts[state.source] || 0) + 1
      }
    }
  }

  Object.entries(draw).forEach(([resource, amount]) => {
    const available = subtract(left[resource] || ZERO, fromDouble(counts[resource] || 0))

    span = Math.min(span, positive(available) ? floorRatio(available, amount) : 0)
  })

  if (!unlimited) {
    const owed = Object.entries(yield * debitsOf(building, pace))

    for (const [index, [resource, list]] of owed.entries()) {
      if (index > 0 && pace.expired()) {
        yield
      }

      span = Math.min(span, additions(left[resource] || ZERO, list))
    }

    // The game checks each mineral against what the project would build before rounding, so a cycle in which the stock the projects ahead left is under that request is cut even where the rounded build still fits.
    const ahead = {}
    const running = building.filter((state) => positive(state.lastBuild))

    for (const [index, state] of running.entries()) {
      if (index > 0 && pace.expired()) {
        yield
      }

      state.minerals.forEach(([resource, need]) => {
        const slack = subtract(subtract(left[resource] || ZERO, ahead[resource] || ZERO), multiply(need, state.units))

        span = Math.min(span, negative(slack) ? 0 : 1 + floorRatio(slack, draw[resource]))
      })
      state.needs.forEach(([resource, need]) => (ahead[resource] = add(ahead[resource] || ZERO, multiply(need, state.step))))
    }
  }

  if (pending.length) {
    span = Math.min(span, pending[0].cycle - next)
  }

  return Math.max(0, span)
}

// One run of the colony's cycles in one visiting order, a generator that yields (nothing) wherever the `pace` says its time is up: at the start of a cycle or of a stretch of cycles taken in one step, and between one project's turn and the next within a cycle and within the working out and the applying of a stretch (and between the resources of one, each of which adds up one entry per project), so the work between two yields is one project's turn, one resource's total, or the setup of a cycle or stretch, at most. The share the running and paused projects of a kind hold is kept as projects finish and queued ones start (a finish takes its share off, a start adds its own) where the shares of the kind add up exactly in any order (`sumsExactly`), so a finish costs the length of its kind's queue and not that of the colony; where they do not, the game's own sum, in the order of the projects, is made again (paced) when a finish has a queued project to admit. The queue of a kind is kept as its own list. `stock`: { [resource]: decimal }, `arrivals`: [{ resource, day, quantity (a decimal) }]. Returns { states, events, contested, cycles, left }.
function* simulate({ prepared, stock, arrivals, cycleDays, maxCycles, order, pace, stepwise = false, unlimited = false }) {
  const states = prepared.map(stateOf)
  const rank = Object.fromEntries(order.map((id, index) => [id, index]))
  const left = { ...stock }
  const members = {}
  const queues = {}
  const heldShare = {}

  states.forEach((state) => (members[state.category] = members[state.category] || []).push(state))
  Object.keys(members).forEach((category) => (queues[category] = []))
  states.filter((state) => !state.held).sort((a, b) => a.queue - b.queue).forEach((state) => queues[state.category].push(state))
  Object.entries(members).filter(([, list]) => sumsExactly(list.map((state) => state.share))).forEach(([category, list]) => (heldShare[category] = addMultiple(ZERO, list.filter((state) => state.held).map((state) => state.share), 1)))

  // The share the projects of a kind that are out of the queue and not finished hold, added up in the order of the projects as the game adds it (each addition rounded as the type rounds it).
  function* heldNow(category) {
    let total = ZERO

    for (const [index, member] of members[category].entries()) {
      if (index > 0 && pace.expired()) {
        yield
      }

      if (member.held && !member.finished) {
        total = add(total, member.share)
      }
    }

    return total
  }

  const pending = arrivals.map((arrival) => ({ ...arrival, cycle: Math.max(1, Math.ceil(arrival.day / cycleDays - EPSILON)) })).sort((a, b) => a.cycle - b.cycle)
  const contested = new Set()
  const events = []
  let cycle = 0

  if (unlimited) {
    states.forEach((state) => {
      state.needs.forEach(([resource]) => (left[resource] = PLENTY))

      if (state.source) {
        left[state.source] = PLENTY
      }
    })
  }

  states.filter((state) => state.held && !state.paused).forEach((state) => events.push({ cycle: 0, day: 0, id: state.id, type: 'start' }))

  while (cycle < maxCycles) {
    if (pace.expired()) {
      yield
    }

    const next = cycle + 1
    let arrived = false

    while (pending.length && pending[0].cycle <= next) {
      const arrival = pending.shift()

      left[arrival.resource] = add(left[arrival.resource] || ZERO, arrival.quantity)
      arrived = true
      events.push({ cycle: next, day: arrival.day, id: null, type: 'arrival', resource: arrival.resource, quantity: toNumber(arrival.quantity) })
    }

    if (arrived) {
      states.forEach((state) => {
        state.lastBuild = null
        state.stall = null
      })
    }

    const building = states.filter((state) => state.held && !state.finished && !state.unresolved && !state.paused).sort((a, b) => rank[a.id] - rank[b.id])

    if (!building.length) {
      break
    }

    if (building.every((state) => state.lastBuild !== null && !positive(state.lastBuild))) {
      if (!pending.length) {
        break
      }

      cycle = Math.min(maxCycles, pending[0].cycle - 1)
      continue
    }

    const span = stepwise ? 0 : yield * steadySpan(building, left, next, pending, maxCycles - cycle, unlimited, pace)

    if (span > 0) {
      const owed = Object.entries(yield * debitsOf(building, pace))

      for (const [index, [resource, list]] of owed.entries()) {
        if (index > 0 && pace.expired()) {
          yield
        }

        left[resource] = addMultiple(left[resource] || ZERO, list, span)
      }

      const running = building.filter((state) => positive(state.lastBuild))

      for (const [index, state] of running.entries()) {
        if (index > 0 && pace.expired()) {
          yield
        }

        const total = addMultiple(state.partial, [state.step], span)
        const delivered = floor(total)

        state.amount = addMultiple(state.amount, [negate(state.step)], span)
        state.built = addMultiple(state.built, [state.step], span)
        state.partial = subtract(total, delivered)
        state.delivered += toInteger(delivered)

        if (state.source) {
          left[state.source] = subtract(left[state.source] || ZERO, delivered)
        }
      }

      cycle += span
      continue
    }

    yield * contend(building, left, contested, pace)

    // The game starts a queued project the moment a project finishes, while the rest of the cycle's projects are still to be taken, so each finish frees its share for the queue before the next project is built.

    for (const [index, state] of building.entries()) {
      if (index > 0 && pace.expired()) {
        yield
      }

      const { built, cut, stall, finishing } = buildCycle(state, left, unlimited)

      if (finishing && !fourDecimals(state.amount)) {
        state.fineRemainder = true
      }

      state.lastBuild = built
      state.lastCut = cut !== null

      if (cut !== null) {
        state.cutCycles += 1

        if (!state.firstCut) {
          state.firstCut = { cycle: next, resource: cut }
          events.push({ cycle: next, day: next * cycleDays, id: state.id, type: 'cut', resource: cut })
        }
      }

      if (!positive(built)) {
        if (!state.stall) {
          events.push({ cycle: next, day: next * cycleDays, id: state.id, type: 'stall', reason: stall.reason, resource: stall.resource })
        }

        state.stall = stall

        // What is left of the project is under what a build can be (or past it): it can never build exactly what it has left, and what the game does with such a project is not known, so it neither finishes nor frees its share.
        if (stall.reason === 'remainder') {
          state.unresolved = true
        }

        continue
      }

      state.stall = null

      if (state.firstBuild === null) {
        state.firstBuild = built
      }

      state.built = add(state.built, built)

      const total = add(state.partial, built)
      const delivered = floor(total)

      state.partial = subtract(total, delivered)
      state.delivered += toInteger(delivered)

      if (state.source) {
        left[state.source] = subtract(left[state.source] || ZERO, delivered)
      }

      // The game finishes a project when the amount it built is exactly the amount it had left.
      if (equal(built, state.amount)) {
        state.finished = true
        state.fineRemainder = false
        state.finishCycle = next
        state.amount = ZERO
        events.push({ cycle: next, day: next * cycleDays, id: state.id, type: 'finish' })

        const queue = queues[state.category]
        let started = []

        if (heldShare[state.category] !== undefined) {
          heldShare[state.category] = subtract(heldShare[state.category], state.share)
          started = queue.length ? startable(queue, heldShare[state.category]) : []
        } else if (queue.length) {
          started = startable(queue, yield * heldNow(state.category))
        }

        if (started.length) {
          const promotedSet = new Set(started)

          queues[state.category] = queue.filter((other) => !promotedSet.has(other))

          started.forEach((promoted) => {
            promoted.held = true
            promoted.startCycle = next

            if (heldShare[state.category] !== undefined) {
              heldShare[state.category] = add(heldShare[state.category], promoted.share)
            }

            if (!promoted.paused) {
              events.push({ cycle: next, day: next * cycleDays, id: promoted.id, type: 'start' })
            }
          })
        }
      } else {
        state.amount = subtract(state.amount, built)
      }
    }

    cycle = next
  }

  // A queued project of a kind that holds a project whose completion is not known cannot be said to start or not.
  const blocked = new Set(states.filter((state) => state.unresolved).map((state) => state.category))

  states.filter((state) => !state.held && blocked.has(state.category)).forEach((state) => (state.behindUnresolved = true))

  return { states, events, contested, cycles: cycle, left }
}

const baseOrder = (projects) => projects.map((project) => project.ID).sort((a, b) => a - b)

// The visiting orders to try for the projects in contention: every order of them while there are at most MAX_EXHAUSTIVE (their slots in the base order shuffled among themselves), otherwise the base order, its reverse and each project first and last, made one at a time as they are asked for so that a colony of hundreds in contention does not build thousands of orders at once. Returns { orders (an iterable), exhaustive }.
const ordersFor = (base, members) => {
  const inContention = new Set(members)
  const slots = base.map((id, index) => (inContention.has(id) ? index : -1)).filter((index) => index >= 0)

  const place = (permutation) => {
    const order = [...base]

    slots.forEach((slot, index) => (order[slot] = permutation[index]))

    return order
  }

  if (members.length <= MAX_EXHAUSTIVE) {
    return { exhaustive: true, orders: permutations(members).map(place) }
  }

  function* sampled() {
    yield place(members)
    yield place([...members].reverse())

    for (const id of members) {
      const others = members.filter((other) => other !== id)

      yield place([id, ...others])
      yield place([...others, id])
    }
  }

  return { exhaustive: false, orders: sampled() }
}

const dayOf = (cycle, cycleDays) => (cycle === null ? null : cycle * cycleDays)

// Why a project that did not finish did not: paused, never reached the front of the queue, a stall (its reason from the last cycle), or still going when the horizon ended.
const unfinishedReason = (state) => {
  if (state.unresolved) {
    return { reason: 'remainder', resource: null }
  } else if (!state.held) {
    return state.behindUnresolved ? { reason: 'unresolved', resource: null } : { reason: 'queue', resource: null }
  } else if (state.paused) {
    return { reason: 'paused', resource: null }
  } else if (state.stall) {
    return state.stall
  } else if (!state.costed) {
    return { reason: 'cost', resource: null }
  }

  return { reason: 'horizon', resource: null }
}

// What the figures keep of one project over the runs, folded in as each run ends so that no run's states are held after it: in how many runs it finished and started, the first and last cycle of each, whether any run differs from the first, in how many it did not finish and was cut and between which cycles, and the least and most it built.
export const tallyOf = (reference) => ({
  runs: 0,
  finished: 0,
  finishLow: Infinity,
  finishHigh: -Infinity,
  finishDiffers: false,
  started: 0,
  startLow: Infinity,
  startHigh: -Infinity,
  startDiffers: false,
  unfinished: 0,
  cut: 0,
  cutLow: Infinity,
  cutHigh: -Infinity,
  fineRemainder: false,
  buildLow: reference.built,
  buildHigh: reference.built,
  buildDiffers: false,
})

// Adds one project's state at the end of a run to its tally; `reference` is the same project's state in the first run.
export const foldState = (tally, entry, reference) => {
  tally.runs += 1

  if (entry.finishCycle === null) {
    tally.unfinished += 1
  } else {
    tally.finished += 1
    tally.finishLow = Math.min(tally.finishLow, entry.finishCycle)
    tally.finishHigh = Math.max(tally.finishHigh, entry.finishCycle)
  }

  if (entry.startCycle !== null) {
    tally.started += 1
    tally.startLow = Math.min(tally.startLow, entry.startCycle)
    tally.startHigh = Math.max(tally.startHigh, entry.startCycle)
  }

  if (entry.firstCut) {
    tally.cut += 1
    tally.cutLow = Math.min(tally.cutLow, entry.firstCut.cycle)
    tally.cutHigh = Math.max(tally.cutHigh, entry.firstCut.cycle)
  }

  tally.finishDiffers = tally.finishDiffers || entry.finishCycle !== reference.finishCycle
  tally.startDiffers = tally.startDiffers || entry.startCycle !== reference.startCycle
  tally.fineRemainder = tally.fineRemainder || entry.fineRemainder
  tally.buildDiffers = tally.buildDiffers || !equal(entry.built, reference.built)

  if (less(entry.built, tally.buildLow)) {
    tally.buildLow = entry.built
  }

  if (greater(entry.built, tally.buildHigh)) {
    tally.buildHigh = entry.built
  }
}

const foldRun = (tallies, run, first) => run.states.forEach((entry, index) => foldState(tallies[index], entry, first.states[index]))

// The forecast of one colony. `projects`: [{ ID, Percentage, Amount, PartialCompletion, ProdPerUnit, Queue, Paused, category, needs: { [mineral]: tonnes a unit, fuel: units of fuel a unit }, source: the key of the stock of source installations a conversion draws on, or null }]; `capacities`: { [category]: build points a year at 100% }; `stock`: { [mineral]: tonnes, fuel, [source key]: installations }; `arrivals`: [{ resource, day, quantity, source }]; `cycleDays`: the days a cycle covers. `stepwise` takes every cycle one by one (the check that taking steady cycles in one step changes nothing). Returns null for a cycle that is not above 0 days, otherwise { cycleDays, projects: { [ID]: figures }, orders: { tried, kept (the runs whose states are still held when the figures are made: the first only, each other run is folded into the figures as it ends and let go), exhaustive, contested, dependent, buildDepends }, events, left }.
//
// The figures of a project, in days from now (null where it never happens): `start` (the day it enters the running set: 0 for a running project), `finish`, with `earliest` and `latest` over the orders tried (`latest` null when some order never finishes it) and `dependent` when the order moves its finish; `outcome` ('finishes', 'stalls', 'queued' for a queued one that never starts, 'paused', 'beyond' for one still going at the horizon, 'unresolved' for a queued one behind a project whose completion is not known) with its `stall` { reason, resource } and `stallOrders` ('all' or 'some'); `cut` { resource, day } for the first cycle the stock cut its build and `cutOrders`; `built` (units over the run), `delivered` (whole units delivered, the partial unit kept in `partial`) and `amountLeft`, each from the base order, with `builtRange` over the orders; `unitsPerCycle` (what its share buys in a cycle), `roundingError` (the largest share of that the 4-decimal rounding of a build moves it by) and `sensitive` (a cycle's build under UNBOUNDED_BELOW units, where a small error in the capacity or the cycle length moves the date by a large share of itself); `firstBuild` (the units built in its first building cycle); `fineRemainder` (in some order a part of a unit finer than a build is left at the end of the run, a project that finished exactly in the end having none, so the project cannot finish exactly).
export function* forecastColonySteps({ projects, capacities, stock, arrivals = [], cycleDays, horizonDays = HORIZON_DAYS, stepwise = false }, pace) {
  if (!(cycleDays > 0)) {
    return null
  }

  const maxCycles = Math.max(1, Math.ceil(horizonDays / cycleDays))
  const base = baseOrder(projects)
  const years = yearsOf(cycleDays)
  const prepared = []

  for (const [index, project] of projects.entries()) {
    if (index > 0 && pace.expired()) {
      yield
    }

    prepared.push(prepare(project, capacities, years))
  }

  const held = Object.fromEntries(Object.entries(stock).map(([resource, quantity]) => [resource, fromDouble(quantity)]))
  const entered = arrivals.map((arrival) => ({ resource: arrival.resource, day: arrival.day, quantity: fromDouble(arrival.quantity) }))
  const common = { prepared, stock: held, arrivals: entered, cycleDays, maxCycles, stepwise, pace }
  const first = yield * simulate({ ...common, order: base })
  const tallies = first.states.map((state) => tallyOf(state))
  const kept = [first]
  const contested = new Set(first.contested)
  let made = 1
  let exhaustive = true

  foldRun(tallies, first, first)

  if (contested.size >= 2) {
    const tried = new Set()
    let members = [...contested].sort((a, b) => a - b)

    for (let pass = 0; pass < projects.length && made < MAX_RUNS; pass++) {
      const plan = ordersFor(base, members)

      exhaustive = plan.exhaustive

      const baseKey = base.join(',')

      for (const order of plan.orders) {
        if (made >= MAX_RUNS) {
          break
        }

        const key = order.join(',')

        if (key === baseKey || tried.has(key)) {
          continue
        }

        tried.add(key)

        const result = yield * simulate({ ...common, order })

        foldRun(tallies, result, first)
        made += 1
        result.contested.forEach((id) => contested.add(id))
      }

      const grown = [...contested].sort((a, b) => a - b)

      if (grown.length === members.length || !exhaustive) {
        break
      }

      members = grown
    }
  }

  if (made >= MAX_RUNS) {
    exhaustive = false
  }

  const unlimited = yield * simulate({ ...common, arrivals: [], order: base, unlimited: true })
  const figures = {}

  for (const [index, state] of first.states.entries()) {
    if (index > 0 && pace.expired()) {
      yield
    }

    const tally = tallies[index]
    const suppliedState = unlimited.states[index]
    const unfinished = state.finishCycle === null ? unfinishedReason(state) : null
    const units = toNumber(state.units)

    figures[state.id] = {
      ID: state.id,
      start: dayOf(state.startCycle, cycleDays),
      finish: dayOf(state.finishCycle, cycleDays),
      earliest: tally.finished ? dayOf(tally.finishLow, cycleDays) : null,
      latest: tally.finished === tally.runs ? dayOf(tally.finishHigh, cycleDays) : null,
      dependent: tally.finishDiffers,
      startEarliest: tally.started ? dayOf(tally.startLow, cycleDays) : null,
      startLatest: tally.started === tally.runs && tally.started ? dayOf(tally.startHigh, cycleDays) : null,
      startDepends: tally.startDiffers,
      fineRemainder: tally.fineRemainder,
      outcome: state.finishCycle !== null ? 'finishes' : unfinished.reason === 'queue' ? 'queued' : unfinished.reason === 'paused' ? 'paused' : unfinished.reason === 'horizon' ? 'beyond' : unfinished.reason === 'unresolved' ? 'unresolved' : 'stalls',
      stall: unfinished,
      stallOrders: tally.unfinished === tally.runs ? 'all' : tally.unfinished ? 'some' : null,
      cut: state.firstCut ? { resource: state.firstCut.resource, day: dayOf(state.firstCut.cycle, cycleDays) } : null,
      cutOrders: tally.cut === tally.runs ? 'all' : tally.cut ? 'some' : null,
      cutRange: tally.cut ? [dayOf(tally.cutLow, cycleDays), dayOf(tally.cutHigh, cycleDays)] : null,
      built: toNumber(state.built),
      builtRange: [toNumber(tally.buildLow), toNumber(tally.buildHigh)],
      buildDepends: tally.buildDiffers,
      delivered: state.delivered,
      partial: toNumber(state.partial),
      amountLeft: toNumber(state.amount),
      unitsPerCycle: units,
      roundingError: units > 0 ? 1 / SCALE / 2 / units : null,
      sensitive: units > 0 && units < UNBOUNDED_BELOW,
      firstBuild: state.firstBuild === null ? null : toNumber(state.firstBuild),
      suppliedFinish: suppliedState ? dayOf(suppliedState.finishCycle, cycleDays) : null,
    }
  }

  return {
    cycleDays,
    projects: figures,
    orders: { tried: made, kept: kept.length, exhaustive, contested: [...contested].sort((a, b) => a - b), dependent: Object.values(figures).some((figure) => figure.dependent || figure.startDepends || figure.stallOrders === 'some'), buildDepends: Object.values(figures).some((figure) => figure.buildDepends) },
    events: first.events,
    left: Object.fromEntries(Object.entries(first.left).map(([resource, quantity]) => [resource, toNumber(quantity)])),
  }
}

// The forecast of a colony run to its end at once (the generator above with no time limit), for the callers that do not slice it: the same arguments, the same result.
export const forecastColony = (input) => {
  const steps = forecastColonySteps(input, UNPACED)
  let step = steps.next()

  while (!step.done) {
    step = steps.next()
  }

  return step.value
}
