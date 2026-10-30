/*
  The routing of a Vuex `dispatch` or `commit`, for the checks that stand a function in for either (scripts/check-peeks.js, check-campaigns.js, check-economy-digest.js, check-capabilities.js and scripts/lib/capability-pages.js).

  A stand-in that ignores the name or the options of a call lets a wrong route pass as a right one: a namespaced module that dispatches `capabilities/preflight` without `{ root: true }` reaches an action that does not exist, and Vuex answers with undefined. `routes(table)` keeps the table of the calls the store answers, as `{ type, root }` entries: a local entry matches its name with no options, a root entry matches its name with exactly `{ root: true }`. The match is of the whole call: no prefix, no stripped namespace, no other option. `take(type, options)` records the call as `{ type, options, accepted }` and says whether the stand-in may apply it; one that is not accepted is not applied and is answered with undefined, and is never thrown. `rejected()` lists the recorded calls that were not accepted, for the check to assert by value that its run made none, and `forgive()` drops them once a check that made them on purpose has asserted them.
*/
const routes = (table) => {
  const calls = []
  const matches = (entry, type, options) => {
    if (entry.type !== type) {
      return false
    }

    return entry.root ? Boolean(options) && options.root === true && Object.keys(options).length === 1 : options === undefined || options === null
  }

  return {
    calls,
    take: (type, options) => {
      const accepted = table.some((entry) => matches(entry, type, options))

      calls.push({ type, options: options === undefined ? null : options, accepted })

      return accepted
    },
    rejected: () => calls.filter(({ accepted }) => !accepted),
    forgive: () => {
      for (let index = calls.length - 1; index >= 0; index--) {
        if (!calls[index].accepted) {
          calls.splice(index, 1)
        }
      }
    },
  }
}

module.exports = { routes }
