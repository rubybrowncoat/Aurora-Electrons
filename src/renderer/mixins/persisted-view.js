// A page's view parameters (options, filters, toggles, search, view modes, each table's sort and rows per page) kept in electron-store, so they survive leaving the page and restarting the app.
//
// `persistedView(fields)` returns a mixin that declares each field as page data. A field is described by:
// - `key`, the electron-store key. App-scoped fields use it as is; race-scoped ones under `campaign.<campaignId>.race.<RaceID>.` (the store's `racePrefix`, which names the campaign the save belongs to and not its GameID, a counter that repeats between saves).
// - `default`, the value when nothing is stored or the stored value doesn't pass. Arrays and objects are copied.
// - `scope`, `'app'` (the default) for view preferences, `'race'` for values about the race's own things: its systems, colonies, fleets, alien races, a search over its data, thresholds and exclusions.
// - `normalise(stored)`, optional: the value to use for what is stored, such as a list without the entries no longer offered; undefined means the default.
// - `valid(value)`, optional: false means the default.
//
// Fields are restored as the page is created, and race-scoped ones again whenever the campaign or race changes. Before a race is picked, or while no campaign is settled (before the recorder has settled the open save, or while a new copy of it is read: `racePrefix` is null then), they hold what they show and nothing is saved: a change made meanwhile waits and is written once the same campaign settles again, and is dropped if another one does. Every change is saved, on the next tick, unless it equals what was last restored or saved. A link's focus that isn't a preference goes through `setUnsaved`, which shows it for this visit and leaves the stored value alone.
//
// Page index, expanded rows and open dialogs are not view parameters: they stay plain data. A pick a page is built around, such as the designs Designed Tech compares, is a field like any other.

const copy = (value) => (value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value)

const serialised = (value) => JSON.stringify(value === undefined ? null : value)

// Whether a value is one of a list of allowed values, for `valid`.
export const oneOf = (values) => (value) => values.includes(value)

// One v-data-table's sort and rows per page, as one stored object `{ sortBy, sortDesc, itemsPerPage }`. Bind them with `:sort-by.sync="<field>.sortBy" :sort-desc.sync="<field>.sortDesc" :items-per-page.sync="<field>.itemsPerPage"` and give the table the same `itemsPerPageOptions`; a stored size it doesn't offer brings back the defaults. A table without pages leaves out `itemsPerPage` and `itemsPerPageOptions`, and keeps only its sort.
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

// Every field declared so far, in the order declared: `{ key, scope, default, normalise, valid }` with `scope` 'app' or 'race'. A page's module declares its fields when it is loaded, which is on its first visit, so the list is complete only once every page and component module has been loaded; utilities/preferences.js takes it as the allowlist of what can be exported and imported.
const declared = []

export const declaredViews = () => declared.slice()

export default function persistedView (fields) {
  const names = Object.keys(fields)
  const raceNames = names.filter((name) => fields[name].scope === 'race')

  names.forEach((name) => {
    const { key, scope, normalise, valid } = fields[name]

    declared.push({ key, scope: scope === 'race' ? 'race' : 'app', default: fields[name].default, normalise, valid })
  })

  const racePrefix = (getters) => getters.racePrefix

  const watch = {
    persistedViewPrefix (prefix, previous) {
      if (!prefix) {
        // The copy of the save is being read again (or the recorder failed on it): the page keeps what it shows, and saves nothing until a campaign is settled.
        this.$_persistedViewHeld = previous || this.$_persistedViewHeld

        return
      }

      const held = this.$_persistedViewHeld
      const waiting = this.$_persistedViewWaiting

      this.$_persistedViewHeld = null
      this.$_persistedViewWaiting = {}

      raceNames.forEach((name) => {
        if (prefix === held && waiting[name] !== undefined) {
          this.$_persistedView[name] = waiting[name]
          this.$store.getters.config.set(this.persistedViewKey(name, prefix), JSON.parse(waiting[name]))
        } else if (prefix !== held) {
          this[name] = this.restoredView(name, prefix)
        }
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
      this.$_persistedViewWaiting = {}
      this.$_persistedViewHeld = null
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
        } else if (!key && fields[name].scope === 'race') {
          // No campaign is settled at the moment: nothing is written under a key that may name another campaign. The latest change waits for the one the page last held (and is dropped if another settles); a change back to the value last restored or saved leaves nothing waiting.
          if (text !== this.$_persistedView[name]) {
            this.$_persistedViewWaiting[name] = text
          } else {
            delete this.$_persistedViewWaiting[name]
          }
        }
      },
      setUnsaved (name, value) {
        this.$_persistedView[name] = serialised(value)
        this[name] = value
      },
    },
  }
}
