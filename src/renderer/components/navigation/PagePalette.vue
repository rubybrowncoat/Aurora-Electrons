<template>
  <v-dialog :value="value" max-width="620" content-class="page-palette" @input="$emit('input', $event)">
    <v-card>
      <v-text-field ref="query" v-model="query" solo flat hide-details prepend-inner-icon="mdi-magnify" placeholder="Go to page" autocomplete="off" class="pt-1" @keydown="onKeydown" />
      <v-divider />

      <div ref="list" class="page-palette__list">
        <template v-for="(row, key) in rows">
          <div v-if="row.group" :key="`group-${row.group}`" class="page-palette__group">{{ row.group }}</div>
          <div
            v-else
            :key="`${row.page.route}-${key}`"
            class="page-palette__row"
            :class="{ 'page-palette__row--selected': row.index === selected }"
            :style="row.style"
            @click="$emit('go', row.page.route)"
            @mouseenter="selected = row.index"
          >
            <div class="page-palette__icon">
              <v-icon size="18">{{ row.page.icon }}</v-icon>
            </div>
            <div>
              <div class="page-palette__name">{{ row.page.title }}</div>
              <div class="page-palette__blurb">{{ row.page.blurb }}</div>
            </div>
            <div class="page-palette__section">{{ row.section }}</div>
          </div>
        </template>
        <div v-if="!rows.length" class="page-palette__empty">No page matches “{{ query }}”.</div>
        <div v-if="locked" class="page-palette__locked"><v-icon x-small>mdi-lock-outline</v-icon> Pick a game and an empire to open the other pages.</div>
      </div>

      <div class="page-palette__foot">
        <span><kbd>↑</kbd> <kbd>↓</kbd> choose</span>
        <span><kbd>Enter</kbd> open</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
    </v-card>
  </v-dialog>
</template>

<script>
import { mapGetters } from 'vuex'

import { sectionById } from '../../utilities/navigation'
import { sectionStyle } from './section-style'

const RECENT_COUNT = 4

// A substring hit in the title, tab, section or keywords ranks by how early it starts; failing that, the query's letters in order within the title.
const score = (page, query) => {
  const haystack = [page.title, page.tab, page.section ? sectionById[page.section].title : '', page.keywords || ''].join(' ').toLowerCase()
  const at = haystack.indexOf(query)

  if (at >= 0) {
    return 1000 - at
  }

  let matched = 0

  for (const letter of page.title.toLowerCase()) {
    if (letter === query[matched]) {
      matched++
    }
  }

  return matched === query.length ? 10 : -1
}

export default {
  props: {
    value: {
      type: Boolean,
      required: true,
    },
    // The pages the palette can open: not hidden, not disabled.
    pages: {
      type: Array,
      required: true,
    },
    // No race is picked yet, so most pages are left out.
    locked: {
      type: Boolean,
      default: false,
    },
  },
  data () {
    return {
      query: '',
      selected: 0,
    }
  },
  computed: {
    ...mapGetters('navigation', [
      'recents',
    ]),

    matches () {
      const query = this.query.trim().toLowerCase()

      if (query) {
        return this.pages.map((page) => ({ page, score: score(page, query) })).filter((match) => match.score >= 0).sort((a, b) => b.score - a.score).map(({ page }) => page)
      }

      return null
    },
    // Display rows with group headings, each page row numbered for the keyboard selection.
    rows () {
      const describe = (page, index) => ({ page, index, style: sectionStyle(this.$vuetify.theme.dark, sectionById[page.section]), section: page.section ? sectionById[page.section].title : '' })

      if (this.matches) {
        return this.matches.map(describe)
      }

      const recent = this.recents.map((path) => this.pages.find(({ route }) => route === path)).filter(Boolean).slice(0, RECENT_COUNT)
      const rest = this.pages.filter((page) => !recent.includes(page))
      const rows = recent.length ? [{ group: 'Recent' }] : []

      return [...rows, ...recent.map(describe), { group: 'All pages' }, ...rest.map((page, index) => describe(page, recent.length + index))]
    },
    selectable () {
      return this.rows.filter(({ page }) => page)
    },
  },
  watch: {
    value (open) {
      if (open) {
        this.query = ''
        // The dialog moves focus to itself once it has rendered, so wait it out.
        setTimeout(() => this.$refs.query && this.$refs.query.focus(), 60)
      }
    },
    query () {
      this.selected = 0
    },
    selected () {
      this.$nextTick(() => {
        const row = this.$refs.list && this.$refs.list.querySelector('.page-palette__row--selected')

        if (row) {
          row.scrollIntoView({ block: 'nearest' })
        }
      })
    },
  },
  methods: {
    onKeydown (event) {
      const count = this.selectable.length

      if (!count) {
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        this.selected = (this.selected + 1) % count
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        this.selected = (this.selected - 1 + count) % count
      } else if (event.key === 'Enter') {
        this.$emit('go', this.selectable[this.selected].page.route)
      }
    },
  },
}
</script>

<style lang="scss">
.page-palette {
  align-self: flex-start;
  margin-top: 12vh !important;
}
</style>

<style lang="scss" scoped>
.page-palette__list {
  max-height: 52vh;
  overflow-y: auto;
  padding-block: 4px;
}

.page-palette__group {
  padding: 10px 16px 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--ae-muted);
}

.page-palette__row {
  display: grid;
  grid-template-columns: 32px 1fr auto;
  gap: 0 12px;
  align-items: center;
  padding: 8px 16px;
  cursor: pointer;
}

.page-palette__row--selected {
  background: var(--ae-hover);
}

.page-palette__icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--sc-tint);

  .v-icon {
    color: var(--sc) !important;
  }
}

.page-palette__name {
  font-size: 14px;
}

.page-palette__blurb {
  font-size: 12px;
  color: var(--ae-muted);
}

.page-palette__section {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--sc);
}

.page-palette__locked {
  padding: 10px 16px 4px;
  font-size: 12px;
  color: var(--ae-muted);
}

.page-palette__empty {
  padding: 10px 16px 4px;
  color: var(--ae-muted);
}

.page-palette__foot {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 10px 16px;
  border-top: 1px solid var(--ae-border);
  font-size: 12px;
  color: var(--ae-muted);
}
</style>
