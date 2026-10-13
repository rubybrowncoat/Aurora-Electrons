// The Pareto comparison of designs: the sets that no other set beats on every axis the player chose, each axis read in the direction the player chose, with nothing summed into a score. Dominance is the usual one: set A beats set B when A is as good on every axis and better on at least one; two sets that are alike on every axis beat neither and stay side by side. Two figures count as alike when they fall in one cell of a fine grid (a billionth of the figure), as a sum of costs or a chain of divisions may differ in its last digits; dominance compares the cells exactly, so every pair of sets has one answer whatever order the sets are met in.
//
// An axis reads a figure of a set, or says it is not computed (null): a set with no fuel has no range or endurance, which is not 0. A set with a figure that is not computed on an axis takes no part in a comparison on that axis, so no unknown figure meets a number; the front counts those sets and names the first of them.
//
// `createFront(axes, { limit, name })` is the front the search keeps while it explores, over every set that meets the targets (not the best few the table lists): `offer(set)` for each, `result()` for the front as it stands. The front holds at most `limit` sets; one more that nothing beats is left out and named, and the front is then provisional (a kept set may be beaten by one left out). A front of a search that has not explored its whole domain is provisional too, and `describeFront` says why. Sets alike on every axis are kept under the first met: every one is named (`identities`, up to `IDENTITIES_KEPT` in all, and the front is then provisional for its `ties`), the first `ALTERNATIVES_KEPT` of each with the set itself for the page to describe (`alternativeCount` is exact).

export const FRONT_LIMIT = 2000
export const ALTERNATIVES_KEPT = 20
export const DISCARDS_KEPT = 20
export const IDENTITIES_KEPT = 20000

// Cells to a power of two: a figure is rounded to the nearest 1/2^30 of the power of two it lies in, a cell about a billionth of it wide.
const GRID = 30

// The figure on the grid. The grid is made of powers of two, so the rounding is exact and never moves a figure across another.
const snap = (value) => {
  if (value === 0) {
    return 0
  }

  const size = Math.abs(value)
  let exponent = Math.floor(Math.log2(size))

  if (2 ** exponent > size) {
    exponent--
  } else if (2 ** (exponent + 1) <= size) {
    exponent++
  }

  const step = 2 ** (exponent - GRID)

  return step > 0 ? Math.sign(value) * Math.round(size / step) * step : value
}

export const PARETO_GOALS = Object.freeze(['min', 'max'])

const GOAL_WORDS = Object.freeze({ min: 'least', max: 'most' })

const known = (value) => (Number.isFinite(value) ? value : null)

// Whether a set has engines that burn fuel and fuel aboard to burn: without either there is no range or endurance to compare.
const burns = (set) => set.power > 0 && set.burnFull > 0 && set.litres > 0

// The axes a propulsion set is compared on, in the order the page offers them. A set says its cost is not known with `costKnown: false` (an engine the save stores without a cost), which its `cost` of 0 does not. `goal` is the direction usually wanted. The payload is the hull the propulsion is for, which a search of one hull gives every set alike.
export const PARETO_AXES = Object.freeze({
  cost: Object.freeze({ label: 'BP', noun: 'BP', goal: 'min', read: (set) => (set.costKnown === false ? null : known(set.cost)) }),
  tons: Object.freeze({ label: 'Propulsion tonnage', noun: 'propulsion tonnage', goal: 'min', read: (set) => known(set.tons) }),
  speed: Object.freeze({ label: 'Speed', noun: 'speed', goal: 'max', read: (set) => (set.power > 0 && set.totalHS > 0 ? known(set.speed) : null) }),
  range: Object.freeze({ label: 'Range', noun: 'range', goal: 'max', read: (set) => (burns(set) ? known(set.rangeKm) : null) }),
  endurance: Object.freeze({ label: 'Endurance', noun: 'endurance', goal: 'max', read: (set) => (burns(set) && set.burnCruise > 0 ? known(set.enduranceHours) : null) }),
  payload: Object.freeze({ label: 'Payload', noun: 'payload', goal: 'max', read: (set) => (set.hullHS > 0 ? known(set.hullHS) : null) }),
})

// The axes as a frozen list of `{ key, goal }`, or an error in words for one that cannot be compared: none chosen, an axis that is not offered or chosen twice, a direction that is neither 'min' nor 'max'.
export const normaliseAxes = (axes) => {
  if (!Array.isArray(axes) || axes.length === 0) {
    throw new Error('Choose at least one axis to compare the sets on.')
  }

  const chosen = new Set()

  return Object.freeze(axes.map((axis) => {
    if (axis === null || typeof axis !== 'object' || !Object.prototype.hasOwnProperty.call(PARETO_AXES, axis.key)) {
      throw new Error(`"${axis && axis.key}" is not an axis the sets can be compared on.`)
    }

    if (!PARETO_GOALS.includes(axis.goal)) {
      throw new Error(`The goal of ${axis.key} must be 'min' or 'max'.`)
    }

    if (chosen.has(axis.key)) {
      throw new Error(`${axis.key} is chosen twice.`)
    }

    chosen.add(axis.key)

    return Object.freeze({ key: axis.key, goal: axis.goal })
  }))
}

// A stored choice of axes without the entries that are not an axis offered or not 'min' or 'max', or undefined for a value that is not a choice.
export const normaliseChoice = (stored) => (stored === null || typeof stored !== 'object' || Array.isArray(stored) ? undefined : Object.fromEntries(Object.keys(PARETO_AXES).filter((key) => stored[key] === 'min' || stored[key] === 'max').map((key) => [key, stored[key]])))

// The axes of a page's choice (`{ key: 'min' | 'max' }`, a key left out or off is not chosen) as the list `normaliseAxes` takes, in the order the axes are offered.
export const axesOf = (choice) => Object.keys(PARETO_AXES).filter((key) => choice[key] === 'min' || choice[key] === 'max').map((key) => ({ key, goal: choice[key] }))

// The front of the sets offered, as the search keeps it. `name(set)` is the name a set is known by (its candidate id), called for a set that is kept, left out or alike another. `limit` is the most sets the front holds.
export const createFront = (axes, { limit = FRONT_LIMIT, identityLimit = IDENTITIES_KEPT, name = String } = {}) => {
  const specs = normaliseAxes(axes).map(({ key, goal }) => ({ key, goal, sign: goal === 'max' ? 1 : -1, read: PARETO_AXES[key].read }))
  const width = specs.length
  const members = []
  const vectors = new Float64Array(limit * width)
  const probe = new Float64Array(width)
  const doomed = []
  const unknown = { count: 0, byAxis: Object.fromEntries(specs.map(({ key }) => [key, 0])), names: [] }
  const overflow = { count: 0, names: [] }
  let scanned = 0
  let named = 0
  let unnamed = 0

  // How many members the last offer compared the set with, for the caller to count as work.
  const front = {
    axes: Object.freeze(specs.map(({ key, goal }) => Object.freeze({ key, goal }))),

    get scanned() {
      return scanned
    },

    // Compares `set` with the front: true when the front holds it afterwards (members it beats are gone), false when a member beats it, when it is alike a member (named under it), when one of its figures is not computed, or when the front is full.
    offer(set) {
      scanned = 0

      let missing = 0

      for (let axis = 0; axis < width; axis++) {
        const value = specs[axis].read(set)

        if (value === null) {
          unknown.byAxis[specs[axis].key]++
          missing++
        } else {
          probe[axis] = specs[axis].sign * snap(value)
        }
      }

      if (missing > 0) {
        unknown.count++

        if (unknown.names.length < DISCARDS_KEPT) {
          unknown.names.push(name(set))
        }

        return false
      }

      doomed.length = 0

      for (let at = 0, base = 0; at < members.length; at++, base += width) {
        let ahead = 0
        let behind = 0

        scanned++

        for (let axis = 0; axis < width && (ahead === 0 || behind === 0); axis++) {
          if (vectors[base + axis] > probe[axis]) {
            ahead++
          } else if (vectors[base + axis] < probe[axis]) {
            behind++
          }
        }

        if (behind === 0) {
          if (ahead === 0) {
            const member = members[at]

            member.alternativeCount++

            if (named >= identityLimit) {
              unnamed++
            } else {
              const label = name(set)

              named++
              member.identities.push(label)

              if (member.alternatives.length < ALTERNATIVES_KEPT) {
                member.alternatives.push(Object.freeze({ name: label, set }))
              }
            }
          }

          return false
        }

        if (ahead === 0) {
          doomed.push(at)
        }
      }

      if (doomed.length) {
        let kept = 0
        let next = 0

        for (let at = 0; at < members.length; at++) {
          if (doomed[next] === at) {
            // The sets alike a removed member go with it: the names it held and the sets it left unnamed no longer count against the front.
            named -= members[at].identities.length
            unnamed -= members[at].alternativeCount - members[at].identities.length
            next++
          } else {
            members[kept] = members[at]
            vectors.copyWithin(kept * width, at * width, (at + 1) * width)
            kept++
          }
        }

        members.length = kept
      }

      if (members.length >= limit) {
        overflow.count++

        if (overflow.names.length < DISCARDS_KEPT) {
          overflow.names.push(name(set))
        }

        return false
      }

      vectors.set(probe, members.length * width)
      members.push({ name: name(set), set, alternatives: [], identities: [], alternativeCount: 0 })

      return true
    },

    // The sets the front holds, the members and the sets alike them that it names.
    sets() {
      return members.flatMap((member) => [member.set, ...member.alternatives.map((alternative) => alternative.set)])
    },

    // The front as it stands, a copy: { axes, limit, status, reasons, source, members, unknown, overflow }. `explored` says the search it is for has explored its whole domain, `feasible` how many sets met the targets so far. Members come best first on the first axis, then the second (no two are alike on every axis); each has its `name`, `set`, the `identities` (the names of every set alike on every axis, up to the identity limit over the whole front), the `alternatives` among them (`{ name, set }`, the first `ALTERNATIVES_KEPT`) and their exact `alternativeCount`. `ties.unnamed` counts the sets alike that the identity limit left unnamed. `status` is 'complete' only for a front of a whole domain that neither the limit nor the identity limit cut, and 'provisional' with the `reasons` ('stopped', 'limit', 'ties') otherwise.
    result({ explored, feasible }) {
      const reasons = [...(explored ? [] : ['stopped']), ...(overflow.count ? ['limit'] : []), ...(unnamed ? ['ties'] : [])]

      const ordered = members.map((member, at) => ({ member, at })).sort((a, b) => {
        for (let axis = 0; axis < width; axis++) {
          const first = vectors[a.at * width + axis]
          const second = vectors[b.at * width + axis]

          if (first !== second) {
            return first > second ? -1 : 1
          }
        }

        return 0
      }).map(({ member }) => member)

      return Object.freeze({
        axes: front.axes,
        limit,
        status: reasons.length ? 'provisional' : 'complete',
        reasons: Object.freeze(reasons),
        source: Object.freeze({ kind: 'evaluated', feasible, compared: feasible - unknown.count }),
        members: Object.freeze(ordered.map((member) => Object.freeze({ name: member.name, set: member.set, alternatives: Object.freeze(member.alternatives.slice()), identities: Object.freeze(member.identities.slice()), alternativeCount: member.alternativeCount }))),
        unknown: Object.freeze({ count: unknown.count, byAxis: Object.freeze({ ...unknown.byAxis }), names: Object.freeze(unknown.names.slice()) }),
        overflow: Object.freeze({ count: overflow.count, names: Object.freeze(overflow.names.slice()) }),
        ties: Object.freeze({ unnamed, limit: identityLimit }),
      })
    },
  }

  return front
}

const joined = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`)

// The axes of a front in words: 'least propulsion tonnage and most speed'.
export const describeAxes = (axes) => joined(axes.map(({ key, goal }) => `${GOAL_WORDS[goal]} ${PARETO_AXES[key].noun}`))

// What a front says and does not say, for the page: which sets it compared, whether a set beats these only if the search went on, and which sets took no part for want of a figure.
export const describeFront = (front, format = String) => {
  const { source, unknown, overflow } = front
  const sentences = []

  if (!front.reasons.includes('stopped') && !front.reasons.includes('limit')) {
    sentences.push(`Efficient among every set that meets the targets: no other set beats any of the ${format(front.members.length)}, aiming for ${describeAxes(front.axes)}.`)
  } else {
    sentences.push('Provisional: these are the sets none of the sets compared so far beats, not yet the efficient sets of every set that meets the targets.')
  }

  if (front.reasons.includes('stopped')) {
    sentences.push('The search stopped before it explored the whole domain, so a set it did not reach may beat these.')
  }

  if (front.reasons.includes('limit')) {
    sentences.push(`The comparison holds at most ${format(front.limit)} sets; ${format(overflow.count)} more that none of them beat were left out, so a set shown may be beaten by one left out.`)
  }

  if (front.reasons.includes('ties')) {
    sentences.push(`${format(front.ties.unnamed)} sets with the same figures as a set shown are counted but not named: the comparison names at most ${format(front.ties.limit)}.`)
  }

  sentences.push(`${format(source.compared)} of the ${format(source.feasible)} sets that meet the targets were compared.`)

  if (unknown.count > 0) {
    const missing = joined(front.axes.filter(({ key }) => unknown.byAxis[key] > 0).map(({ key }) => PARETO_AXES[key].noun))

    sentences.push(`${format(unknown.count)} had no ${missing} to compare and took no part.`)
  }

  return sentences.join(' ')
}

// Why a front that holds no set holds none, for the empty table: nothing met the targets (or the search stopped before one was found), or every set that met them lacks a figure on an axis.
export const describeEmpty = (front, format = String) => {
  const { source, unknown } = front
  const stopped = front.reasons.includes('stopped')

  if (source.feasible === 0) {
    return stopped ? 'The search stopped before it found a set that meets the targets.' : 'No set meets the targets.'
  }

  if (source.compared === 0) {
    const missing = joined(front.axes.filter(({ key }) => unknown.byAxis[key] > 0).map(({ key }) => PARETO_AXES[key].noun))

    return `None of the ${format(source.feasible)} sets that meet the targets has ${missing} to compare.`
  }

  return stopped ? 'The search stopped before it kept a set that nothing beats.' : 'The comparison kept no set.'
}
