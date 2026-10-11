// A page's view parameters (options, filters, toggles, search, view modes, each table's sort and rows per page) kept
// in electron-store, so they survive leaving the page and restarting the app.
//
// `persistedView(fields)` returns a mixin that declares each field as page data. A field is described by:
// - `key`, the electron-store key. App-scoped fields use it as is; race-scoped ones under
//   `game.<GameID>.race.<RaceID>.`.
// - `default`, the value when nothing is stored or the stored value doesn't pass. Arrays and objects are copied.
// - `scope`, `'app'` (the default) for view preferences, `'race'` for values about the race's own things: its
//   systems, colonies, fleets, alien races, a search over its data, thresholds and exclusions.
// - `normalise(stored)`, optional: the value to use for what is stored, such as a list without the entries no longer
//   offered; undefined means the default.
// - `valid(value)`, optional: false means the default.
//
// Fields are restored as the page is created, and race-scoped ones again whenever the game or race changes (before a
// race is picked they hold their defaults). Every change is saved, on the next tick, unless it equals what was last
// restored or saved. A link's focus that isn't a preference goes through `setUnsaved`, which shows it for this visit
// and leaves the stored value alone.
//
// Page index, expanded and selected rows and open dialogs are not view parameters: they stay plain data.

const copy = (value) => (value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value)

const serialised = (value) => JSON.stringify(value === undefined ? null : value)

// Whether a value is one of a list of allowed values, for `valid`.
export const oneOf = (values) => (value) => values.includes(value)

// One v-data-table's sort and rows per page, as one stored object `{ sortBy, sortDesc, itemsPerPage }`. Bind them with
// `:sort-by.sync="<field>.sortBy" :sort-desc.sync="<field>.sortDesc" :items-per-page.sync="<field>.itemsPerPage"` and
// give the table the same `itemsPerPageOptions`; a stored size it doesn't offer brings back the defaults. A table
// without pages leaves out `itemsPerPage` and `itemsPerPageOptions`, and keeps only its sort.
export const tableView = (key, { sortBy = [], sortDesc = false, itemsPerPage, itemsPerPageOptions }) => {
  const paged = Array.isArray(itemsPerPageOptions)

  return {
    key,
    default: paged ? { sortBy, sortDesc, itemsPerPage } : { sortBy, sortDesc },
    normalise (stored) {
      if (stored === null || typeof stored !== 'object' || (paged && !itemsPerPageOptions.includes(stored.itemsPerPage))) {
        return undefined
      }

      const sort = { sortBy: stored.sortBy ?? [], sortDesc: stored.sortDesc ?? false }

      return paged ? { ...sort, itemsPerPage: stored.itemsPerPage } : sort
    },
  }
}

export default function persistedView (fields) {
  const names = Object.keys(fields)
  const raceNames = names.filter((name) => fields[name].scope === 'race')

  const racePrefix = (getters) => (getters.GameID && getters.RaceID ? `game.${getters.GameID}.race.${getters.RaceID}` : null)

  const watch = {
    persistedViewPrefix (prefix) {
      raceNames.forEach((name) => {
        this[name] = this.restoredView(name, prefix)
      })
    },
  }

  names.forEach((name) => {
    watch[name] = {
      deep: true,
      handler (value) {
        this.saveView(name, value)
      },
    }
  })

  return {
    beforeCreate () {
      this.$_persistedView = {}
    },
    data () {
      const prefix = racePrefix(this.$store.getters)

      return Object.fromEntries(names.map((name) => [name, this.restoredView(name, prefix)]))
    },
    computed: {
      persistedViewPrefix () {
        return racePrefix(this.$store.getters)
      },
    },
    watch,
    methods: {
      persistedViewKey (name, prefix) {
        const { key, scope } = fields[name]

        if (scope !== 'race') {
          return key
        }

        return prefix ? `${prefix}.${key}` : null
      },
      restoredView (name, prefix) {
        const field = fields[name]
        const key = this.persistedViewKey(name, prefix)
        const stored = key ? this.$store.getters.config.get(key) : undefined
        let value = stored === undefined ? undefined : field.normalise ? field.normalise(stored) : stored

        if (value === undefined || (field.valid && !field.valid(value))) {
          value = copy(field.default)
        }

        this.$_persistedView[name] = serialised(value)

        return value
      },
      saveView (name, value) {
        const key = this.persistedViewKey(name, this.persistedViewPrefix)
        const text = serialised(value)

        if (key && text !== this.$_persistedView[name]) {
          this.$_persistedView[name] = text
          this.$store.getters.config.set(key, JSON.parse(text))
        }
      },
      setUnsaved (name, value) {
        this.$_persistedView[name] = serialised(value)
        this[name] = value
      },
    },
  }
}
