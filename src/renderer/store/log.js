const defaultLogFilters = () => ({
  hideNonCustomized: false,
  activeTypes: null,
})

const normalizeTypeIDs = (typeIDs) => {
  if (!Array.isArray(typeIDs)) {
    return []
  }

  return typeIDs
    .map((typeID) => Number(typeID))
    .filter((typeID) => Number.isInteger(typeID))
}

export const state = () => {
  return {
    filtersByContext: {},
  }
}

export const mutations = {
  setHideNonCustomized (state, { contextKey, value }) {
    if (!contextKey) {
      return
    }

    if (!state.filtersByContext[contextKey]) {
      state.filtersByContext[contextKey] = defaultLogFilters()
    }

    state.filtersByContext[contextKey].hideNonCustomized = !!value
  },
  setActiveTypes (state, { contextKey, value }) {
    if (!contextKey) {
      return
    }

    if (!state.filtersByContext[contextKey]) {
      state.filtersByContext[contextKey] = defaultLogFilters()
    }

    state.filtersByContext[contextKey].activeTypes = normalizeTypeIDs(value)
  },
}
