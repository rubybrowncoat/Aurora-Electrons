import { blockedBonuses, preflight } from '../utilities/capabilities'
import { isRetired } from '../utilities/retired'

// What the copy of the save now open supports (utilities/capabilities.js), checked once per copy. Every check belongs to the freshness generation it ran on (store/freshness.js): the copy the root store's `renew` opened, so a result is never shown for a copy that has since been replaced, and a retry runs on the copy now open. A check only selects from the save.

// The check of each copy of the save, so that every page asking for it shares the one that is running or done.
const checks = new WeakMap()

export const state = () => {
  return {
    // The freshness generation the latest check ran on; null until there is one.
    generation: null,
    // 'waiting' (no check yet), 'checking', 'ok' or 'failed'.
    outcome: 'waiting',
    // The `evaluate` result of the latest check that succeeded; it is kept while a later check of the same copy runs or fails, and dropped when a newer copy is opened.
    result: null,
    // The freshness generation `result` belongs to; null while there is no result.
    resultGeneration: null,
    // Why the latest check failed, null otherwise.
    message: null,
    // When the latest check started, then when it ended.
    at: null,
  }
}

export const getters = {
  // The state of the check as it applies to the copy now open: 'waiting' while the latest check is for an earlier copy.
  status (state, _getters, rootState) {
    return state.generation === rootState.freshness.generation ? state.outcome : 'waiting'
  },
  // The result for the copy now open, or null while none is known for it. A retry that is running or has failed leaves the result of the same copy in place; a result of an earlier copy is never returned.
  result (state, _getters, rootState) {
    return state.resultGeneration === rootState.freshness.generation ? state.result : null
  },
  // The lookup rows' gates of the result ({ bonuses, components }), or null while no result is known: a null is an assessment that has not been made, which no page reads as every row confirmed.
  gates (_state, getters) {
    return getters.result ? getters.result.gates : null
  },
  // The report of a route ({ status, missing, degraded, groups, ... }), or null while the result is not known, so a page is never held back for a check that has not answered.
  report: (_state, getters) => (route) => (getters.result && getters.result.reports[route]) || null,
  // Which Aurora line the copy now open is of (utilities/capabilities.js `lineResult`: { status, reason, line, missing }), or null while no result is known for it: bound to the copy like `result`, so a save that replaced the one refused is never read as refused, and one that is refused is never read as accepted.
  line (_state, getters) {
    return getters.result ? getters.result.line || null : null
  },
  // Whether the copy now open is known to be refused: true only for a result of this copy whose line is refused. While the check is running or has failed (no result) nothing is refused, as a page is never held back for a check that has not answered.
  refused (_state, getters) {
    return getters.line !== null && getters.line.status === 'refused'
  },
  // The bonus IDs whose row in the save does not read as the planners expect, as a Set: every ID the planners read while no result is known.
  blockedBonuses (_state, getters) {
    return blockedBonuses(getters.gates)
  },
}

export const mutations = {
  started (state, { generation, at }) {
    state.generation = generation
    state.outcome = 'checking'

    if (state.resultGeneration !== generation) {
      state.result = null
      state.resultGeneration = null
    }

    state.message = null
    state.at = at
  },
  settled (state, { result, at }) {
    state.outcome = 'ok'
    state.result = result
    state.resultGeneration = state.generation
    state.at = at
  },
  failed (state, { message, at }) {
    state.outcome = 'failed'
    state.message = message
    state.at = at
  },
}

const run = ({ commit, rootState }, { force }) => {
  const { database } = rootState
  const { generation } = rootState.freshness

  if (!database) {
    return Promise.resolve(null)
  } else if (!force && checks.has(database)) {
    return checks.get(database)
  }

  commit('started', { generation, at: Date.now() })

  let check = null

  // Only the latest check of the copy that is still the current one is taken: a retry supersedes the check it was started over, and a newer copy supersedes both.
  const settle = (mutation, payload) => {
    if (checks.get(database) === check && generation === rootState.freshness.generation && database === rootState.database) {
      commit(mutation, { ...payload, at: Date.now() })
    }
  }

  check = preflight(database).then((result) => {
    settle('settled', { result })

    return result
  }, (error) => {
    // A read that was refused because the copy it ran on has been replaced is not a failure of the check; only the failure of the check that is still current is reported.
    if (!isRetired(error) && checks.get(database) === check && generation === rootState.freshness.generation && database === rootState.database) {
      console.error('The capability preflight failed', error)
    }

    settle('failed', { message: String((error && error.message) || error).split(/\r?\n/)[0] })

    return null
  })

  checks.set(database, check)

  return check
}

export const actions = {
  // Check the copy of the save now open, once: pages that need the answer before they read share it. Never rejects; resolves to the result, or null when the check failed or no save is open.
  preflight (context) {
    return run(context, { force: false })
  },
  // Check the copy now open again, after a failed check or to see a save altered since. Runs on the current generation, whatever the earlier check was on.
  retry (context) {
    return run(context, { force: true })
  },
}
