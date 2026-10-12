<template>
  <v-container fluid class="warnings-page">
    <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

    <template v-if="ready">
      <div class="toolbar">
        <v-select v-model="filters.severity" :items="severityOptions" label="Severity" clearable dense outlined hide-details class="tool" />
        <v-select v-model="filters.group" :items="groupOptions" label="Group" clearable dense outlined hide-details class="tool" />
        <v-text-field v-model="filters.search" label="Search warnings" prepend-inner-icon="mdi-magnify" clearable dense outlined hide-details class="tool tool--search" />
        <v-chip v-if="focusedCheck" close @click:close="checkFilter = null">Only {{ checkLabel(focusedCheck) }}</v-chip>
        <v-menu offset-y left :close-on-content-click="false" min-width="360" max-width="400">
          <template #activator="{ on, attrs }">
            <v-btn outlined aria-label="Warnings options" v-bind="attrs" v-on="on"><v-icon small left>mdi-tune-variant</v-icon>Options<span v-if="activeOptionCount">&nbsp;({{ activeOptionCount }})</span></v-btn>
          </template>
          <v-card class="pa-4">
            <div class="subtitle-2">Muted warnings</div>
            <v-switch v-model="showMuted" label="Show muted warnings" dense inset hide-details />
            <div class="caption text--secondary mt-1">A muted warning, or a whole muted check, is kept out of the tiles and the lists. Show them here to unmute them.</div>
            <v-btn v-if="mutedTotal" small text class="mt-2" @click="unmuteAll">Unmute all ({{ count(mutedTotal) }})</v-btn>

            <div class="subtitle-2 mt-4">Idle fleets</div>
            <v-switch :input-value="idleFleetsAtColonies" label="Include fleets parked at my colonies" dense inset hide-details @change="(value) => setOption('idleFleetsAtColonies', !!value)" />

            <div class="subtitle-2 mt-4">Maintenance supplies</div>
            <v-slider :value="maintenanceThreshold" min="10" max="100" :hint="`List ships under ${maintenanceThreshold}% maintenance`" thumb-label persistent-hint class="mt-6" @change="(value) => setOption('maintenanceThreshold', value)" />
            <v-autocomplete :value="maintenanceExclusions" :items="shipClasses" label="Excluded ship classes" item-text="ClassName" item-value="ShipClassID" multiple small-chips deletable-chips clearable dense outlined hide-details class="mt-4" @change="(value) => setOption('maintenanceExclusions', [...(value || [])])" />
            <v-btn v-if="!isMaintenanceDefault" small text class="mt-2" @click="resetMaintenance">Reset maintenance</v-btn>
          </v-card>
        </v-menu>
      </div>

      <stat-tiles dense class="my-2" :tiles="tiles" />

      <v-row v-if="panels.length">
        <v-col v-for="(stack, stackIndex) in columns" :key="stackIndex" cols="12" xl="6" class="panel-column">
          <v-card v-for="panel in stack" :key="panel.group.key" class="panel" :data-summary="panel.group.summary" elevation="1">
            <div class="panel-head">
              <div class="subtitle-2">{{ panel.group.title }} <span class="caption text--secondary">{{ count(panel.total) }} {{ panel.total === 1 ? 'warning' : 'warnings' }} in {{ count(panel.sections.length) }} {{ panel.sections.length === 1 ? 'check' : 'checks' }}</span></div>
            </div>

            <section v-for="section in panel.sections" :key="section.check.key" class="check" :class="{ 'check--muted': section.checkMuted }">
              <div class="check-head">
                <v-icon small :color="section.severity.color" :title="section.severity.label" :aria-label="section.severity.label">{{ section.severity.icon }}</v-icon>
                <span class="check-title">{{ section.check.title(section.rows.length, options) }}</span>
                <span v-if="section.newCount" class="new-label">{{ count(section.newCount) }} new</span>
                <v-spacer />
                <v-btn v-if="checkFilter !== section.check.key" icon x-small :style="{ color: 'inherit' }" :aria-label="`Show only ${checkLabel(section.check)}`" :title="`Show only ${checkLabel(section.check)}`" @click="checkFilter = section.check.key"><v-icon small>mdi-filter-outline</v-icon></v-btn>
                <v-btn icon x-small :style="{ color: 'inherit' }" :aria-label="`${section.checkMuted ? 'Unmute' : 'Mute'} ${checkLabel(section.check)}`" :title="`${section.checkMuted ? 'Unmute' : 'Mute'} ${checkLabel(section.check)}`" @click="toggleCheckMuted(section.check.key)"><v-icon small>{{ section.checkMuted ? 'mdi-bell-outline' : 'mdi-bell-off-outline' }}</v-icon></v-btn>
              </div>

              <v-simple-table dense>
                <template #default>
                  <thead>
                    <tr>
                      <th v-for="column in section.check.columns" :key="column.key" :class="{ 'text-end': column.align === 'end' }">{{ column.text }}</th>
                      <th class="row-actions" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in visibleRows(section)" :key="row.id" :class="{ 'row-muted': section.mutedIds.has(row.id) }">
                      <td v-for="(column, index) in section.check.columns" :key="column.key" :class="{ 'text-end': column.align === 'end' }">
                        <template v-if="index === 0">
                          <div class="row-name">
                            <span :class="cellTone(row, column)">{{ cellText(row, column) }}</span>
                            <span v-if="isNew(section.check.key, row.id)" class="new-label">New</span>
                          </div>
                          <div v-if="row.caption" class="caption text--secondary">{{ row.caption }}</div>
                        </template>
                        <span v-else :class="cellTone(row, column)">{{ cellText(row, column) }}</span>
                      </td>
                      <td class="row-actions">
                        <page-link v-if="row.link" :to="row.link" :name="cellText(row, section.check.columns[0])" />
                        <v-btn icon x-small :style="{ color: 'inherit' }" :aria-label="`${section.mutedIds.has(row.id) ? 'Unmute' : 'Mute'} ${cellText(row, section.check.columns[0])}`" :title="section.mutedIds.has(row.id) ? 'Unmute this warning' : 'Mute this warning'" @click="toggleRowMuted(section.check.key, row.id)"><v-icon small>{{ section.mutedIds.has(row.id) ? 'mdi-eye-outline' : 'mdi-eye-off-outline' }}</v-icon></v-btn>
                      </td>
                    </tr>
                  </tbody>
                </template>
              </v-simple-table>

              <div v-if="section.rows.length > previewRows" class="check-more">
                <v-btn small text @click="toggleExpanded(section.check.key)">{{ expanded[section.check.key] ? 'Show fewer' : `Show all ${count(section.rows.length)}` }}</v-btn>
              </div>
              <div class="check-foot caption text--secondary">{{ section.check.rule }}</div>
            </section>
          </v-card>
        </v-col>
      </v-row>

      <v-card v-else class="panel pa-6 text-center" elevation="1">
        <template v-if="!anyRows">
          <v-icon large color="success">mdi-check-circle-outline</v-icon>
          <div class="title mt-2">All clear</div>
          <div class="text--secondary">None of the {{ count(checkCount) }} checks found anything for this race.</div>
        </template>
        <template v-else-if="focusedCheck && !focusedRows.length">
          <v-icon large color="success">mdi-check-circle-outline</v-icon>
          <div class="title mt-2">Nothing to report</div>
          <div class="text--secondary">The check for {{ checkLabel(focusedCheck) }} found nothing for this race.</div>
          <v-btn small text class="mt-2" @click="resetFilters">Show every check</v-btn>
        </template>
        <template v-else>
          <div class="title">No warnings match</div>
          <div class="text--secondary">
            Nothing fits the filters<span v-if="!showMuted && summary.mutedRows">, and {{ count(summary.mutedRows) }} muted {{ summary.mutedRows === 1 ? 'warning is' : 'warnings are' }} hidden</span>.
          </div>
          <div class="mt-2">
            <v-btn small text @click="resetFilters">Reset filters</v-btn>
            <v-btn v-if="!showMuted && summary.mutedRows" small text @click="showMuted = true">Show muted</v-btn>
          </div>
        </template>
      </v-card>
    </template>
  </v-container>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import StatTiles from '../components/page/StatTiles.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView from '../mixins/persisted-view'
import { linkTo } from '../utilities/deep-links'
import { tracked } from '../utilities/load-tracking'
import { CHECKS, GROUPS, IDLE_FLEETS_KEY, SEVERITIES, checkByKey, checkLabel, normalizeRows } from '../utilities/warnings'

// Rows a check shows before "Show all".
const PREVIEW_ROWS = 10

const NO_IDS = new Set()

const SEVERITY_BY_KEY = Object.fromEntries(SEVERITIES.map((severity) => [severity.key, severity]))

// The name of a check's read: `idle-fleets` is `readIdleFleets`.
const readName = (check) => `read${check.key.replace(/(^|-)(\w)/g, (_match, _dash, letter) => letter.toUpperCase())}`

const INPUT_LABELS = {
  ...Object.fromEntries(CHECKS.map((check) => [readName(check), `the ${checkLabel(check)} check`])),
  shipClasses: 'my ship classes',
}

const checkReads = Object.fromEntries(CHECKS.map((check) => [readName(check), {
  get: tracked(readName(check), async function () {
    return this.runCheck(check)
  }),
  default: [],
}]))

export default {
  components: { LoadState, PageLink, StatTiles },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      filters: {
        key: 'warningsFilters',
        default: { severity: null, group: null, search: '' },
        scope: 'race',
        normalise: (stored) => {
          const filters = stored || {}

          return {
            severity: SEVERITY_BY_KEY[filters.severity] ? filters.severity : null,
            group: GROUPS.some((group) => group.key === filters.group) ? filters.group : null,
            search: typeof filters.search === 'string' ? filters.search : '',
          }
        },
      },
      showMuted: { key: 'warningsShowMuted', default: false, scope: 'race', normalise: (stored) => !!stored },
      idleFleetsAtColonies: { key: 'idleFleetsAtColonies', default: false, scope: 'race', normalise: (stored) => !!stored },
      maintenanceThreshold: { key: 'maintenanceThreshold', default: 100, scope: 'race' },
      maintenanceExclusions: { key: 'maintenanceExclusions', default: [], scope: 'race' },
    }),
  ],
  data() {
    return {
      muted: { checks: [], items: {} },
      lastLook: null,

      checkFilter: null,

      expanded: {},
      previewRows: PREVIEW_ROWS,
      checkCount: CHECKS.length,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'GameTime']),
    ...mapState(['RaceNPR']),

    contextKey() {
      return this.GameID && this.RaceID ? `game.${this.GameID}.race.${this.RaceID}` : null
    },

    ready() {
      return !!this.database && !!this.contextKey && this.inputsLoaded
    },

    severityOptions() {
      return SEVERITIES.map((severity) => ({ value: severity.key, text: severity.label }))
    },

    groupOptions() {
      return GROUPS.map((group) => ({ value: group.key, text: group.title }))
    },

    // The check the page is open on, from a link or from the filter on a check's head.
    focusedCheck() {
      return this.checkFilter ? checkByKey[this.checkFilter] || null : null
    },

    linkQuery() {
      return linkTo.warnings(this.checkFilter).query
    },

    linkLabel() {
      const label = this.focusedCheck && checkLabel(this.focusedCheck)

      return label ? label[0].toUpperCase() + label.slice(1) : null
    },

    // The options the checks read.
    options() {
      return {
        idleFleetsAtColonies: this.idleFleetsAtColonies,
        maintenanceThreshold: this.maintenanceThreshold,
        maintenanceExclusions: this.maintenanceExclusions,
      }
    },

    isMaintenanceDefault() {
      return this.maintenanceThreshold === 100 && !this.maintenanceExclusions.length
    },

    activeOptionCount() {
      return Number(this.showMuted) + Number(this.idleFleetsAtColonies) + Number(!this.isMaintenanceDefault)
    },

    mutedTotal() {
      return this.muted.checks.length + Object.values(this.muted.items).reduce((sum, ids) => sum + ids.length, 0)
    },

    mutedCheckSet() {
      return new Set(this.muted.checks)
    },

    mutedSets() {
      return Object.fromEntries(Object.entries(this.muted.items).map(([key, ids]) => [key, new Set(ids)]))
    },

    lastLookSets() {
      return Object.fromEntries(Object.entries(this.lastLook || {}).map(([key, ids]) => [key, new Set(ids)]))
    },

    // Every check with the rows its read returned.
    checkStates() {
      return CHECKS.map((check) => ({ check, rows: this[readName(check)] }))
    },

    anyRows() {
      return this.checkStates.some(({ rows }) => rows.length)
    },

    // What the tiles count: rows not muted, in checks not muted, by severity.
    summary() {
      const severities = Object.fromEntries(SEVERITIES.map((severity) => [severity.key, { rows: 0, checks: 0 }]))
      let mutedRows = 0
      let mutedChecks = 0

      this.checkStates.forEach(({ check, rows }) => {
        if (this.mutedCheckSet.has(check.key)) {
          mutedChecks += 1
          mutedRows += rows.length

          return
        }

        const mutedIds = this.mutedSets[check.key] || NO_IDS
        const open = rows.filter((row) => !mutedIds.has(row.id)).length

        mutedRows += rows.length - open

        if (open) {
          severities[check.severity].rows += open
          severities[check.severity].checks += 1
        }
      })

      return { severities, mutedRows, mutedChecks }
    },

    tiles() {
      const tile = (severity, empty) => {
        const { rows, checks } = this.summary.severities[severity.key]

        return {
          label: severity.label,
          value: this.count(rows),
          icon: severity.icon,
          iconColor: severity.color,
          note: rows ? `${this.count(checks)} ${checks === 1 ? 'check' : 'checks'}` : empty,
        }
      }

      const { mutedRows, mutedChecks } = this.summary

      return [
        tile(SEVERITIES[0], 'Nothing needs action'),
        tile(SEVERITIES[1], 'Nothing needs attention'),
        tile(SEVERITIES[2], 'Nothing to note'),
        {
          label: 'Muted',
          value: this.count(mutedRows),
          icon: 'mdi-bell-off-outline',
          note: mutedChecks ? `Includes ${this.count(mutedChecks)} muted ${mutedChecks === 1 ? 'check' : 'checks'}` : 'Warnings I have muted',
        },
      ]
    },

    // Each check with the rows the filters leave. A check focused by link or button ignores the severity, group and search filters; muted rows and checks stay out unless shown.
    sections() {
      const search = (this.filters.search || '').trim().toLowerCase()
      const focused = this.checkFilter !== null

      return this.checkStates.map(({ check, rows }) => {
        const checkMuted = this.mutedCheckSet.has(check.key)
        const mutedIds = this.mutedSets[check.key] || NO_IDS
        const inScope = focused ? check.key === this.checkFilter : (!this.filters.severity || check.severity === this.filters.severity) && (!this.filters.group || check.group === this.filters.group)
        const shown = inScope && (this.showMuted || !checkMuted) ? rows.filter((row) => (focused || !search || row.text.includes(search)) && (this.showMuted || !mutedIds.has(row.id))) : []

        return {
          check,
          rows: shown,
          checkMuted,
          mutedIds,
          severity: SEVERITY_BY_KEY[check.severity],
          newCount: shown.filter((row) => this.isNew(check.key, row.id)).length,
        }
      })
    },

    panels() {
      return GROUPS.map((group) => {
        const sections = this.sections.filter((section) => section.check.group === group.key && section.rows.length)

        return { group, sections, total: sections.reduce((sum, section) => sum + section.rows.length, 0) }
      }).filter((panel) => panel.sections.length)
    },

    // The group panels in one column, or two from xl, each panel going to whichever column is shorter so far. A panel's height is reckoned in table rows: a check's head, column heads and foot, plus the rows it shows.
    columns() {
      if (!this.$vuetify.breakpoint.xl) {
        return [this.panels]
      }

      const columns = [{ panels: [], height: 0 }, { panels: [], height: 0 }]

      this.panels.forEach((panel) => {
        const column = columns[0].height <= columns[1].height ? columns[0] : columns[1]

        column.panels.push(panel)
        column.height += 1 + panel.sections.reduce((sum, section) => sum + 4 + this.visibleRows(section).length, 0)
      })

      return columns.map(({ panels }) => panels)
    },

    focusedRows() {
      const state = this.focusedCheck && this.checkStates.find(({ check }) => check === this.focusedCheck)

      return state ? state.rows : []
    },
  },
  watch: {
    contextKey: {
      immediate: true,
      handler(prefix) {
        this.expanded = {}

        if (prefix) {
          this.loadVisitState(prefix)
        }
      },
    },
    // A read's load state settles just before the plugin assigns its rows, so the snapshot waits a tick for the last read's rows to land.
    ready(value) {
      if (value) {
        this.$nextTick(this.markVisit)
      }
    },
  },
  methods: {
    checkLabel,

    applyLink(query) {
      const check = Array.isArray(query.check) ? query.check[0] : query.check

      this.checkFilter = check && checkByKey[check] ? check : null
    },

    // One check's rows. The context is built before the first await so the reads it makes are the read's dependencies: a check re-reads when the save, the race or an option it names changes.
    runCheck(check) {
      const { database, GameID, RaceID } = this

      if (!database || !GameID || !RaceID) {
        return Promise.resolve([])
      }

      const context = {
        database,
        GameID,
        RaceID,
        RaceNPR: this.RaceNPR,
        separator: this.separator,
        count: this.count,
        options: Object.fromEntries((check.options || []).map((name) => [name, this[name]])),
      }

      if (check.clock) {
        context.GameTime = this.GameTime
      }

      return check.read(context).then(normalizeRows)
    },

    loadVisitState(prefix) {
      const stored = (name, fallback) => this.config.get(`${prefix}.${name}`, fallback)

      this.lastLook = stored('warningsLastLook', null)

      const muted = stored('warningsMuted', {}) || {}
      const items = {}

      Object.entries(muted.items || {}).forEach(([key, ids]) => {
        if (Array.isArray(ids) && ids.length) {
          items[key] = [...ids]
        }
      })

      this.muted = { checks: Array.isArray(muted.checks) ? [...muted.checks] : [], items }

      // Fleets in a per-race `idleFleetExclusions` list join the idle fleets check's muted rows, and the list goes.
      const legacyKey = `${prefix}.idleFleetExclusions`
      const legacy = this.config.get(legacyKey)

      if (legacy !== undefined) {
        if (Array.isArray(legacy) && legacy.length) {
          items[IDLE_FLEETS_KEY] = [...new Set([...(items[IDLE_FLEETS_KEY] || []), ...legacy.map((id) => `fleet:${id}`)])]
        }

        this.saveMuted({ checks: this.muted.checks, items })
        this.config.delete(legacyKey)
      }
    },

    resetFilters() {
      this.filters = { severity: null, group: null, search: '' }
      this.checkFilter = null
    },

    setOption(name, value) {
      this[name] = value
    },

    resetMaintenance() {
      this.setOption('maintenanceThreshold', 100)
      this.setOption('maintenanceExclusions', [])
    },

    saveMuted({ checks, items }) {
      const kept = Object.fromEntries(Object.entries(items).filter(([, ids]) => ids.length))
      const next = { checks, items: kept }

      this.config.set(`${this.contextKey}.warningsMuted`, next)
      this.muted = next
    },

    toggleCheckMuted(key) {
      const checks = this.muted.checks.includes(key) ? this.muted.checks.filter((item) => item !== key) : [...this.muted.checks, key]

      this.saveMuted({ checks, items: this.muted.items })
    },

    toggleRowMuted(key, id) {
      const ids = this.muted.items[key] || []
      const next = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]

      this.saveMuted({ checks: this.muted.checks, items: { ...this.muted.items, [key]: next } })
    },

    unmuteAll() {
      this.saveMuted({ checks: [], items: {} })
    },

    toggleExpanded(key) {
      this.$set(this.expanded, key, !this.expanded[key])
    },

    visibleRows(section) {
      return this.expanded[section.check.key] ? section.rows : section.rows.slice(0, PREVIEW_ROWS)
    },

    // A row is new when it wasn't listed at the previous visit; the first visit has nothing to compare with.
    isNew(key, id) {
      return this.lastLook !== null && !(this.lastLookSets[key] && this.lastLookSets[key].has(id))
    },

    // Writes the rows listed now for the next visit; the previous visit's rows stay in memory for this one.
    markVisit() {
      if (!this.contextKey) {
        return
      }

      const look = {}

      this.checkStates.forEach(({ check, rows }) => {
        if (rows.length) {
          look[check.key] = rows.map((row) => row.id)
        }
      })

      this.config.set(`${this.contextKey}.warningsLastLook`, look)
    },

    cellText(row, column) {
      const cell = row.cells[column.key]
      const text = cell !== null && typeof cell === 'object' ? cell.text : cell

      return text === undefined || text === null ? '' : String(text)
    },

    cellTone(row, column) {
      const cell = row.cells[column.key]

      return cell !== null && typeof cell === 'object' && cell.tone ? `${cell.tone}--text` : ''
    },
  },
  asyncComputed: {
    ...checkReads,

    shipClasses: {
      get: tracked('shipClasses', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const [classes] = await this.database.query(`select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName from FCT_ShipClass where FCT_ShipClass.GameID = ${this.GameID} and FCT_ShipClass.RaceID = ${this.RaceID} and FCT_ShipClass.ClassShippingLineID = 0 order by FCT_ShipClass.ClassName`)

        return classes
      }),
      default: [],
    },
  },
}
</script>

<style lang="scss" scoped>
.warnings-page {
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }

  .tool {
    min-width: 160px;
    flex: 1 1 180px;
  }

  .tool--search {
    flex-basis: 240px;
  }

  ::v-deep .stat-tile {
    padding: 12px;
    height: auto;
  }

  ::v-deep .stat-value {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  .panel-column {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .panel {
    margin-top: 0;
  }

  .panel-head {
    gap: 8px 20px;
    padding: 10px 16px;
    font-size: inherit;
    line-height: inherit;
  }

  .check {
    border-top: 1px solid var(--ae-border);
  }

  .check--muted {
    opacity: 0.55;
  }

  .check-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px 4px;
  }

  .check-title {
    font-weight: 500;
  }

  .check-more {
    padding: 0 16px 4px;
  }

  .check-foot {
    padding: 4px 16px 12px;
  }

  .row-muted {
    opacity: 0.55;
  }

  .row-name {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .row-actions {
    width: 1%;
    white-space: nowrap;
    text-align: right;
  }

  .new-label {
    white-space: nowrap;
    font-size: 12px;
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 0 4px;
  }

  ::v-deep td {
    vertical-align: top;
    padding-top: 6px !important;
    padding-bottom: 6px !important;
    height: auto !important;
  }

  ::v-deep td .caption {
    line-height: 1.3;
  }
}
</style>
