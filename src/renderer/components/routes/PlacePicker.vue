<template>
  <v-menu v-model="open" offset-y :close-on-content-click="false" min-width="460" max-width="460">
    <template #activator="{ on, attrs }">
      <slot name="activator" :on="on" :attrs="attrs" />
    </template>
    <v-card class="place-picker">
      <div class="place-picker__search">
        <v-text-field ref="search" v-model="query" :label="label" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable autocomplete="off" role="combobox" aria-expanded="true" :aria-controls="`${uid}-list`" :aria-activedescendant="activeId" @keydown.down.prevent.stop="step(1)" @keydown.up.prevent.stop="step(-1)" @keydown.enter.prevent.stop="choose" />
      </div>
      <div class="place-picker__groups" role="group" aria-label="Show only">
        <v-chip v-for="group in shownGroups" :key="group.id" small label :outlined="groupId !== group.id" :color="groupId === group.id ? 'primary' : null" :aria-pressed="String(groupId === group.id)" @click="groupId = groupId === group.id ? null : group.id">
          <v-icon x-small left>{{ group.icon }}</v-icon>{{ group.title }}<span class="place-picker__count">{{ countOf(group) }}</span>
        </v-chip>
      </div>
      <div :id="`${uid}-list`" :key="openings" ref="list" class="place-picker__list" role="listbox" :aria-label="label" @scroll.passive="scrolled">
        <div class="place-picker__space" :style="{ height: `${rows.length * rowHeight}px` }">
          <div v-for="entry in visible" :id="`${uid}-row-${entry.index}`" :key="entry.index" class="place-picker__row" :class="{ 'place-picker__row--header': entry.row.type === 'header', 'place-picker__row--note': entry.row.type === 'note', 'place-picker__row--active': entry.index === activeIndex }" :style="{ top: `${entry.index * rowHeight}px`, height: `${rowHeight}px` }" :role="isSelectable(entry.row) ? 'option' : 'presentation'" :aria-selected="isSelectable(entry.row) ? String(entry.index === activeIndex) : null" @click="activate(entry.row)" @mousemove="hover(entry.index)">
            <template v-if="entry.row.type === 'place'">
              <v-icon small class="place-picker__icon">{{ entry.row.place.icon }}</v-icon>
              <div class="place-picker__text">
                <div class="place-picker__name">{{ entry.row.place.name }}</div>
                <div class="place-picker__subtitle caption text--secondary">{{ entry.row.place.subtitle }}</div>
              </div>
            </template>
            <template v-else-if="entry.row.type === 'header'">
              <v-icon x-small class="place-picker__icon">{{ entry.row.icon }}</v-icon>{{ entry.row.text }}
            </template>
            <template v-else-if="entry.row.type === 'more'">
              <v-icon x-small class="place-picker__icon">mdi-chevron-down</v-icon>{{ entry.row.text }}
            </template>
            <template v-else>{{ entry.row.text }}</template>
          </div>
        </div>
      </div>
    </v-card>
  </v-menu>
</template>

<script>
import debounce from 'lodash/debounce'

const ROW_HEIGHT = 44
const LIST_HEIGHT = 308
// Rows drawn past each edge of the list.
const BENCH = 4
// A group of more places than this isn't listed until the search has at least MIN_TERM characters, and with every type shown it gets ALL_LIMIT places before "Show all".
const SEARCH_FIRST = 300
const MIN_TERM = 2
const ALL_LIMIT = 5
// The most places one type lists.
const ROW_LIMIT = 300

let instances = 0

// A menu to pick one place from the places of every type, grouped by type with a search. `groups` are [{ id, title, icon, count, places }] in listing order: `places` is the group's places ({ key, name, subtitle, icon, text }, frozen arrays are kept as they are), or null for a group that isn't read yet, which makes the picker emit `need` with its id once it has to list it (a type picked, or a search). Big groups list nothing until there is something to search for, and the list draws only the rows in view, so it stays quick with hundreds of thousands of places. Emits `pick` with the chosen place.
export default {
  name: 'PlacePicker',
  props: {
    groups: { type: Array, required: true },
    label: { type: String, default: 'Search places' },
  },
  data() {
    instances += 1

    return {
      uid: `place-picker-${instances}`,
      open: false,
      query: '',
      term: '',
      groupId: null,
      activeIndex: -1,
      scrollTop: 0,
      // Counts the times the picker was opened: each opening gets a new list element, as one kept hidden shows its old scroll position again when the menu reopens.
      openings: 0,
      rowHeight: ROW_HEIGHT,
    }
  },
  computed: {
    shownGroups() {
      return this.groups.filter((group) => group.count > 0)
    },

    tokens() {
      return this.term.toLowerCase().split(/\s+/).filter(Boolean)
    },

    searching() {
      return this.term.trim().length >= MIN_TERM
    },

    rows() {
      const rows = this.groupId ? this.groupRows(this.shownGroups.find((group) => group.id === this.groupId)) : this.shownGroups.flatMap((group) => this.overviewRows(group))

      return rows.length ? rows : [{ type: 'note', text: 'Nothing matches' }]
    },

    // The groups the list has to show that aren't read yet: the type picked, or every one while there is a search.
    needed() {
      if (!this.open) {
        return []
      }

      if (this.groupId) {
        const group = this.shownGroups.find((candidate) => candidate.id === this.groupId)

        return group && !group.places ? [group.id] : []
      }

      return this.searching ? this.shownGroups.filter((group) => !group.places).map((group) => group.id) : []
    },

    visible() {
      const first = Math.max(0, Math.floor(this.scrollTop / ROW_HEIGHT) - BENCH)
      const last = Math.min(this.rows.length, Math.ceil((this.scrollTop + LIST_HEIGHT) / ROW_HEIGHT) + BENCH)

      return this.rows.slice(first, last).map((row, offset) => ({ row, index: first + offset }))
    },

    activeId() {
      return this.activeIndex >= 0 ? `${this.uid}-row-${this.activeIndex}` : null
    },
  },
  watch: {
    open(open) {
      if (open) {
        this.query = ''
        this.term = ''
        this.groupId = null
        this.openings += 1
        this.scrollTop = 0
        this.$nextTick(() => {
          this.activeIndex = this.firstSelectable()
          this.focusSearch(10)
        })
      }
    },
    query() {
      this.applyTerm()
    },
    groupId() {
      this.reset()
    },
    rows() {
      this.activeIndex = this.firstSelectable()
    },
    // What the search or the type picked has to list is read when it isn't yet.
    needed: {
      immediate: true,
      handler(ids) {
        ids.forEach((id) => this.$emit('need', id))
      },
    },
  },
  created() {
    this.applyTerm = debounce(() => {
      this.term = this.query || ''
      this.reset()
    }, 120)
  },
  beforeDestroy() {
    this.applyTerm.cancel()
  },
  methods: {
    // The menu draws its content a moment after it opens, and moves focus itself as it does, so the search field takes it once it is there.
    focusSearch(tries) {
      const field = this.$refs.search
      const input = field && field.$refs.input

      if (input && document.activeElement !== input) {
        field.focus()
      }

      if (this.open && tries > 0 && (!input || document.activeElement !== input)) {
        setTimeout(() => this.focusSearch(tries - 1), 40)
      }
    },

    countOf(group) {
      return group.places ? group.places.length.toLocaleString() : group.count.toLocaleString()
    },

    // The places of a group that match the search, as [places, total].
    matching(group) {
      if (!group.places) {
        return [[], 0]
      }

      const { tokens } = this
      const found = []
      let total = 0

      if (!tokens.length) {
        return [group.places, group.places.length]
      }

      for (let index = 0; index < group.places.length; index += 1) {
        const candidate = group.places[index]

        if (tokens.every((token) => candidate.text.includes(token))) {
          total += 1

          if (found.length < ROW_LIMIT) {
            found.push(candidate)
          }
        }
      }

      return [found, total]
    },

    // A type picked: all its places that match, or what to do when there are too many to list yet.
    groupRows(group) {
      if (!group) {
        return []
      }

      if (!group.places) {
        return [{ type: 'note', text: `Reading the ${group.title.toLowerCase()}…` }]
      }

      if (group.places.length > SEARCH_FIRST && !this.searching) {
        return [{ type: 'note', text: `${group.places.length.toLocaleString()} ${group.title.toLowerCase()}: type to search them` }]
      }

      const [found, total] = this.matching(group)
      const rows = found.slice(0, ROW_LIMIT).map((place) => ({ type: 'place', place }))

      if (total > rows.length) {
        rows.push({ type: 'note', text: `${total.toLocaleString()} match: showing ${rows.length}` })
      }

      return rows
    },

    // Every type shown: each type's first places under its heading, and a row that opens the type for the rest.
    overviewRows(group) {
      if (!group.places) {
        return [{ type: 'header', icon: group.icon, text: group.title }, { type: 'note', text: this.searching ? `Reading the ${group.title.toLowerCase()}…` : `${group.count.toLocaleString()}: type to search them` }]
      }

      const big = group.places.length > SEARCH_FIRST

      if (big && !this.searching) {
        return [{ type: 'header', icon: group.icon, text: group.title }, { type: 'note', text: `${group.places.length.toLocaleString()}: type to search them` }]
      }

      const [found, total] = this.matching(group)

      if (!total) {
        return []
      }

      const rows = [{ type: 'header', icon: group.icon, text: `${group.title}${this.tokens.length ? `: ${total.toLocaleString()} ${total === 1 ? 'match' : 'matches'}` : ''}` }, ...found.slice(0, ALL_LIMIT).map((place) => ({ type: 'place', place }))]

      if (total > ALL_LIMIT) {
        rows.push({ type: 'more', group: group.id, text: `Show all ${total.toLocaleString()}` })
      }

      return rows
    },

    isSelectable(row) {
      return row.type === 'place' || row.type === 'more'
    },

    firstSelectable() {
      return this.rows.findIndex((row) => this.isSelectable(row))
    },

    reset() {
      this.scrollTop = 0

      if (this.$refs.list) {
        this.$refs.list.scrollTop = 0
      }
    },

    scrolled(event) {
      this.scrollTop = event.target.scrollTop
    },

    hover(index) {
      if (index !== this.activeIndex && this.isSelectable(this.rows[index])) {
        this.activeIndex = index
      }
    },

    step(direction) {
      let index = this.activeIndex

      for (let tries = 0; tries < this.rows.length; tries += 1) {
        index = (index + direction + this.rows.length) % this.rows.length

        if (this.isSelectable(this.rows[index])) {
          this.activeIndex = index
          this.scrollIntoView(index)

          return
        }
      }
    },

    scrollIntoView(index) {
      const list = this.$refs.list
      const top = index * ROW_HEIGHT

      if (top < list.scrollTop) {
        list.scrollTop = top
      } else if (top + ROW_HEIGHT > list.scrollTop + LIST_HEIGHT) {
        list.scrollTop = top + ROW_HEIGHT - LIST_HEIGHT
      }
    },

    choose() {
      if (this.rows[this.activeIndex]) {
        this.activate(this.rows[this.activeIndex])
      }
    },

    activate(row) {
      if (row.type === 'place') {
        this.open = false
        this.$emit('pick', row.place)
      } else if (row.type === 'more') {
        this.groupId = row.group
      }
    },
  },
}
</script>

<style lang="scss">
.place-picker {
  .place-picker__search {
    padding: 12px 12px 8px;
  }

  .place-picker__groups {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 0 12px 8px;
  }

  .place-picker__count {
    margin-left: 6px;
    opacity: 0.7;
  }

  .place-picker__list {
    height: 308px;
    overflow-y: auto;
    border-top: thin solid rgba(128, 128, 128, 0.3);
  }

  .place-picker__space {
    position: relative;
  }

  .place-picker__row {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    padding: 0 12px;
    cursor: pointer;
  }

  .place-picker__row--active {
    background: rgba(128, 128, 128, 0.18);
  }

  .place-picker__row--header {
    cursor: default;
    font-size: calc(12px * var(--ae-font-scale));
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.75;
  }

  .place-picker__row--note {
    cursor: default;
    font-size: calc(13px * var(--ae-font-scale));
    opacity: 0.75;
  }

  .place-picker__icon {
    flex: none;
    margin-right: 12px;
  }

  .place-picker__text {
    min-width: 0;
    line-height: 1.25;
  }

  .place-picker__name,
  .place-picker__subtitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
