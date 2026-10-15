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

            <div class="subtitle-2 mt-4">Snoozed warnings</div>
            <v-switch v-model="showSnoozed" label="Show snoozed warnings" dense inset hide-details />
            <div class="caption text--secondary mt-1">A snoozed warning is kept out of the tiles and the lists until the game date chosen, or until it clears or changes materially. A permanent mute outranks a snooze, and a snooze belongs to one branch of the campaign.</div>

            <div class="subtitle-2 mt-4">Idle fleets</div>
            <v-switch :input-value="idleFleetsAtColonies" label="Include fleets parked at the colonies" dense inset hide-details @change="(value) => setOption('idleFleetsAtColonies', !!value)" />

            <div class="subtitle-2 mt-4">Maintenance supplies</div>
            <v-slider :value="maintenanceThreshold" min="10" max="100" :hint="`List ships under ${maintenanceThreshold}% maintenance`" thumb-label persistent-hint class="mt-6" @change="(value) => setOption('maintenanceThreshold', value)" />
            <v-autocomplete :value="maintenanceExclusions" :items="shipClasses" label="Excluded ship classes" item-text="ClassName" item-value="ShipClassID" multiple small-chips deletable-chips clearable dense outlined hide-details class="mt-4" @change="(value) => setOption('maintenanceExclusions', [...(value || [])])" />
            <v-btn v-if="!isMaintenanceDefault" small text class="mt-2" @click="resetMaintenance">Reset maintenance</v-btn>
          </v-card>
        </v-menu>
      </div>

      <div v-if="snoozeProblem" class="caption error--text mb-2">Snoozes are not available: {{ snoozeProblem }}</div>
      <div v-else-if="snoozes.dropped" class="caption text--secondary mb-2">{{ count(snoozes.dropped) }} stored {{ snoozes.dropped === 1 ? 'snooze is' : 'snoozes are' }} not valid and {{ snoozes.dropped === 1 ? 'is' : 'are' }} ignored.</div>

      <stat-tiles dense class="my-2" :tiles="tiles" @select="(tile) => selectSeverity(tile.key)" />

      <v-row v-if="panels.length">
        <v-col v-for="(stack, stackIndex) in columns" :key="stackIndex" cols="12" xl="6" class="panel-column">
          <v-card v-for="panel in stack" :key="panel.group.key" class="panel" :data-summary="panel.group.summary" elevation="1">
            <div class="panel-head">
              <div class="subtitle-2">{{ panel.group.title }} <span class="caption text--secondary">{{ panelCaption(panel) }}<provenance-mark rule="warnings.summary" /></span></div>
            </div>

            <section v-for="section in panel.sections" :key="section.check.key" class="check" :class="{ 'check--muted': section.checkMuted }">
              <div class="check-head">
                <v-icon small :color="section.severity.color" :title="section.severity.label" :aria-label="section.severity.label">{{ section.severity.icon }}</v-icon>
                <span class="check-title">{{ sectionTitle(section) }}</span><provenance-mark :rule="section.check.provenance" />
                <span v-if="section.newCount" class="new-label">{{ count(section.newCount) }} new</span>
                <v-spacer />
                <v-btn v-if="checkFilter !== section.check.key" icon x-small :style="{ color: 'inherit' }" :aria-label="`Show only ${checkLabel(section.check)}`" :title="`Show only ${checkLabel(section.check)}`" @click="checkFilter = section.check.key"><v-icon small>mdi-filter-outline</v-icon></v-btn>
                <v-btn icon x-small :style="{ color: 'inherit' }" :aria-label="`${section.checkMuted ? 'Unmute' : 'Mute'} ${checkLabel(section.check)}`" :title="`${section.checkMuted ? 'Unmute' : 'Mute'} ${checkLabel(section.check)}`" @click="toggleCheckMuted(section.check.key)"><v-icon small>{{ section.checkMuted ? 'mdi-bell-outline' : 'mdi-bell-off-outline' }}</v-icon></v-btn>
                <span v-if="section.checkSnooze" class="caption text--secondary">{{ snoozeText(section.checkSnooze) }}</span>
                <v-btn v-if="section.checkSnooze" icon x-small :style="{ color: 'inherit' }" :aria-label="`Cancel the snooze of ${checkLabel(section.check)}`" title="Cancel the snooze of the whole check" @click="cancelSnooze(section.checkSnooze)"><v-icon small>mdi-bell-ring-outline</v-icon></v-btn>
                <v-btn v-else-if="!section.failure && !section.checkMuted && section.rows.length" icon x-small :style="{ color: 'inherit' }" :aria-label="`Snooze ${checkLabel(section.check)}`" :title="`Snooze ${checkLabel(section.check)}`" @click="openSnooze(section.check, null)"><v-icon small>mdi-bell-sleep-outline</v-icon></v-btn>
              </div>

              <div v-if="section.failure" class="check-failure caption error--text">Could not be read: {{ section.failure }}. The check reads the save again when it changes.<span v-if="section.keptSnoozes"> {{ count(section.keptSnoozes) }} {{ section.keptSnoozes === 1 ? 'snooze is' : 'snoozes are' }} kept and not evaluated.</span></div>
              <v-simple-table v-else dense>
                <template #default>
                  <thead>
                    <tr>
                      <th v-for="column in section.check.columns" :key="column.key" :class="{ 'text-end': column.align === 'end' }">{{ column.text }}</th>
                      <th class="row-actions" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="row in listing(section)">
                      <tr v-if="row.separator" :key="row.id" class="row-separator">
                        <td :colspan="section.check.columns.length + 1" class="caption text--secondary"><template v-if="row.separator === 'snoozed'">{{ count(row.count) }} snoozed: out of the tiles until the snooze ends</template><template v-else>{{ count(row.count) }} not evaluated: a stored value the condition needs is missing<provenance-mark :rule="section.check.provenance" /></template></td>
                      </tr>
                      <tr v-else :key="row.id" :class="{ 'row-muted': !row.unevaluated && section.mutedIds.has(row.id), 'row-snoozed': section.snoozedIds.has(row.id) }">
                        <td v-for="(column, index) in section.check.columns" :key="column.key" :class="{ 'text-end': column.align === 'end' }">
                          <template v-if="index === 0">
                            <div class="row-name">
                              <span :class="cellTone(row, column)">{{ cellText(row, column) }}</span>
                              <provenance-mark v-if="cellResult(row, column)" :result="cellResult(row, column)" />
                              <provenance-mark v-if="row.unevaluated" :result="row.unevaluated" />
                              <span v-if="!row.unevaluated && isNew(section.check.key, row.id)" class="new-label">New</span>
                            </div>
                            <div v-if="row.caption" class="caption text--secondary">{{ row.caption }}</div>
                            <div v-if="row.unevaluated" class="caption text--secondary">{{ missingText(row) }}</div>
                            <div v-if="section.snoozedIds.has(row.id)" class="caption text--secondary">{{ snoozeText(snoozeOf(section, row)) }}</div>
                            <div v-for="note in rowNotes(section, row)" :key="note" class="caption text--secondary">{{ note }}</div>
                          </template>
                          <template v-else>
                            <span :class="cellTone(row, column)">{{ cellText(row, column) }}</span><provenance-mark v-if="cellResult(row, column)" :result="cellResult(row, column)" />
                          </template>
                        </td>
                        <td class="row-actions">
                          <page-link v-if="row.link" :to="row.link" :name="cellText(row, section.check.columns[0])" />
                          <v-btn v-if="!row.unevaluated" icon x-small :style="{ color: 'inherit' }" :aria-label="`${section.mutedIds.has(row.id) ? 'Unmute' : 'Mute'} ${cellText(row, section.check.columns[0])}`" :title="section.mutedIds.has(row.id) ? 'Unmute this warning' : 'Mute this warning'" @click="toggleRowMuted(section.check.key, row.id)"><v-icon small>{{ section.mutedIds.has(row.id) ? 'mdi-eye-outline' : 'mdi-eye-off-outline' }}</v-icon></v-btn>
                          <v-btn v-if="section.snoozedIds.has(row.id)" icon x-small :style="{ color: 'inherit' }" :aria-label="`Cancel the snooze of ${cellText(row, section.check.columns[0])}`" :title="snoozeOf(section, row).scope === 'check' ? 'Cancel the snooze of the whole check' : 'Cancel this snooze'" @click="cancelSnooze(snoozeOf(section, row))"><v-icon small>mdi-bell-ring-outline</v-icon></v-btn>
                          <v-btn v-else-if="!row.unevaluated && !section.mutedIds.has(row.id)" icon x-small :style="{ color: 'inherit' }" :aria-label="`Snooze ${cellText(row, section.check.columns[0])}`" title="Snooze this warning" @click="openSnooze(section.check, row)"><v-icon small>mdi-bell-sleep-outline</v-icon></v-btn>
                        </td>
                      </tr>
                    </template>
                  </tbody>
                </template>
              </v-simple-table>
              <div v-for="note in section.endedChecks" :key="note" class="check-failure caption text--secondary">{{ note }}</div>

              <div v-if="!section.failure && listedCount(section) > previewRows" class="check-more">
                <v-btn small text @click="toggleExpanded(section.check.key)">{{ expanded[section.check.key] ? 'Show fewer' : `Show all ${count(listedCount(section))}` }}</v-btn>
              </div>
              <div class="check-foot caption text--secondary">{{ section.check.rule }}</div>
            </section>
          </v-card>
        </v-col>
      </v-row>

      <v-card v-else class="panel pa-6 text-center" elevation="1">
        <template v-if="!anyFindings">
          <v-icon large color="success">mdi-check-circle-outline</v-icon>
          <div class="title mt-2">All clear</div>
          <div class="text--secondary">None of the {{ count(checkCount) }} checks found anything for this race.</div>
        </template>
        <template v-else-if="focusedCheck && !focusedHasFindings">
          <v-icon large color="success">mdi-check-circle-outline</v-icon>
          <div class="title mt-2">Nothing to report</div>
          <div class="text--secondary">The check for {{ checkLabel(focusedCheck) }} found nothing for this race.</div>
          <v-btn small text class="mt-2" @click="resetFilters">Show every check</v-btn>
        </template>
        <template v-else>
          <div class="title">No warnings match</div>
          <div class="text--secondary">
            Nothing fits the filters<span v-if="!showMuted && summary.mutedRows">, and {{ count(summary.mutedRows) }} muted {{ summary.mutedRows === 1 ? 'warning is' : 'warnings are' }} hidden</span><span v-if="!showSnoozed && summary.snoozedRows">, and {{ count(summary.snoozedRows) }} snoozed {{ summary.snoozedRows === 1 ? 'warning is' : 'warnings are' }} hidden</span>.
          </div>
          <div class="mt-2">
            <v-btn small text @click="resetFilters">Reset filters</v-btn>
            <v-btn v-if="!showMuted && summary.mutedRows" small text @click="showMuted = true">Show muted</v-btn>
            <v-btn v-if="!showSnoozed && summary.snoozedRows" small text @click="showSnoozed = true">Show snoozed</v-btn>
          </div>
        </template>
      </v-card>

      <v-dialog v-model="snoozeOpen" max-width="520">
        <v-card v-if="snoozing" class="pa-4">
          <div class="subtitle-1">{{ snoozing.target.row ? 'Snooze this warning' : 'Snooze this check' }}</div>
          <div class="caption text--secondary mb-2">{{ snoozing.target.row ? cellText(snoozing.target.row, snoozing.target.check.columns[0]) : `Every warning of the ${checkLabel(snoozing.target.check)} check` }}</div>
          <v-radio-group v-model="snoozing.kind" hide-details class="mt-0">
            <v-radio value="date" label="Until a game date" :disabled="!!dateRefusal" />
            <div v-if="snoozing.kind === 'date'" class="snooze-date">
              <v-text-field v-model="snoozing.dateText" label="Game date (YYYY-MM-DD)" dense outlined hide-details />
              <div class="mt-1">
                <v-btn v-for="preset in snoozePresets" :key="preset.days" x-small text @click="usePreset(preset.days)">{{ preset.label }}</v-btn>
              </div>
            </div>
            <div v-if="dateRefusal" class="caption text--secondary">{{ dateRefusal }}</div>
            <v-radio value="clear" :label="snoozing.target.row ? 'Until it clears' : 'Until the check lists nothing'" />
            <v-radio v-if="snoozing.target.check.material" value="material" :label="`Until it changes materially: ${snoozing.target.check.material}`" :disabled="!!materialRefusal" />
            <div v-if="materialRefusal" class="caption text--secondary">{{ materialRefusal }}</div>
          </v-radio-group>
          <v-text-field v-model="snoozing.reason" label="Reason (optional)" :counter="reasonLength" :maxlength="reasonLength" dense outlined hide-details="auto" class="mt-3" />
          <div class="caption text--secondary mt-2">A warning that leaves the check and comes back is a new warning and shows again. A snooze never hides a row that could not be evaluated.</div>
          <div v-if="snoozing.error" class="caption error--text mt-2">{{ snoozing.error }}</div>
          <v-card-actions class="px-0 pb-0">
            <v-spacer />
            <v-btn text @click="snoozing = null">Cancel</v-btn>
            <v-btn color="primary" text @click="submitSnooze">Snooze</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </template>
  </v-container>
</template>

<script>
import { mapGetters, mapState } from 'vuex'

import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView from '../mixins/persisted-view'
import { readRegistry } from '../utilities/campaign'
import { linkTo } from '../utilities/deep-links'
import { campaignStorage } from '../utilities/history'
import { branchLineage, gameDateText, gameSecondsOf } from '../utilities/history-milestones'
import { joinLabels, tracked } from '../utilities/load-tracking'
import { isKnownNumber } from '../utilities/math'
import { describeRule } from '../utilities/provenance'
import { CHECKS, GROUPS, IDLE_FLEETS_KEY, SEVERITIES, checkByKey, checkLabel, describeSignature, normalizeRows } from '../utilities/warnings'
import { ENDED, REASON_LENGTH, addRecord, emptyStore, endRecords, evaluate, forBranch, makeRecord, pruned, readStamps, readStore, seeded, untilText } from '../utilities/warnings/snoozes'

// Rows a check shows before "Show all".
const PREVIEW_ROWS = 10

const NO_IDS = new Set()

const NO_STATES = new Map()

// A read of a check that holds nothing: rows as `runCheck` returns them, with the game time and the options they were read under.
const EMPTY_READ = Object.freeze({ ok: false, rows: Object.freeze([]), GameTime: null, options: Object.freeze({}) })

const DAY = 86400

// Rows a snooze of the whole check names in words before it says "and N more".
const HELD_ROWS = 5

const SNOOZE_PRESETS = [{ days: 7, label: '+7 days' }, { days: 30, label: '+30 days' }, { days: 365, label: '+1 year' }]

const SEVERITY_BY_KEY = Object.fromEntries(SEVERITIES.map((severity) => [severity.key, severity]))

// The name of a check's read: `idle-fleets` is `readIdleFleets`.
const readName = (check) => `read${check.key.replace(/(^|-)(\w)/g, (_match, _dash, letter) => letter.toUpperCase())}`

const INPUT_LABELS = {
  ...Object.fromEntries(CHECKS.map((check) => [readName(check), `the ${checkLabel(check)} check`])),
  shipClasses: 'the ship classes',
}

const checkReads = Object.fromEntries(CHECKS.map((check) => [readName(check), {
  get: tracked(readName(check), async function () {
    return this.runCheck(check)
  }),
  default: EMPTY_READ,
}]))

export default {
  components: { LoadState, PageLink, ProvenanceMark, StatTiles },
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
      showSnoozed: { key: 'warningsShowSnoozed', default: false, scope: 'race', normalise: (stored) => !!stored },
      idleFleetsAtColonies: { key: 'idleFleetsAtColonies', default: false, scope: 'race', normalise: (stored) => !!stored },
      maintenanceThreshold: { key: 'maintenanceThreshold', default: 100, scope: 'race' },
      maintenanceExclusions: { key: 'maintenanceExclusions', default: [], scope: 'race' },
    }),
  ],
  data() {
    return {
      muted: { checks: [], items: {} },
      snoozes: { store: emptyStore(), dropped: 0 },
      snoozeProblem: null,
      evaluations: {},
      endedNotes: {},
      snoozing: null,
      snoozePresets: SNOOZE_PRESETS,
      reasonLength: REASON_LENGTH,
      lastLook: null,
      settledContext: null,

      checkFilter: null,

      expanded: {},
      previewRows: PREVIEW_ROWS,
      checkCount: CHECKS.length,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'GameTime', 'StartYear', 'racePrefix', 'campaignId']),
    ...mapState(['RaceNPR']),

    contextKey() {
      return this.racePrefix
    },

    // Every read has settled: a read that failed still counts, as its check shows the failure in place of rows (a stale or empty read is never a clean zero).
    ready() {
      return !!this.database && !!this.contextKey && Object.keys(INPUT_LABELS).every((key) => this.loadErrors[key] !== undefined)
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

    // What the page shows as a link, so each filtering is a history entry: the focused check alone, as the severity and group filters don't apply to it, or else the severity and group filters. The search isn't part of it; it would step at every key.
    linkQuery() {
      return this.checkFilter ? linkTo.warnings({ check: this.checkFilter }).query : linkTo.warnings({ severity: this.filters.severity, group: this.filters.group }).query
    },

    linkLabel() {
      if (this.focusedCheck) {
        const label = checkLabel(this.focusedCheck)

        return label[0].toUpperCase() + label.slice(1)
      }

      const severity = SEVERITY_BY_KEY[this.filters.severity]
      const group = GROUPS.find(({ key }) => key === this.filters.group)

      return [severity && severity.label, group && group.title].filter(Boolean).join(' · ') || null
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
      return Number(this.showMuted) + Number(this.showSnoozed) + Number(this.idleFleetsAtColonies) + Number(!this.isMaintenanceDefault)
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

    // The branch of the campaign the open save belongs to, or null while it is not settled.
    branchId() {
      const settled = this.$store.getters['history/campaign']

      return settled ? settled.branchId : null
    },

    // The game time of the save in seconds, or null while it or the start year of the game is not known (the default 0 is unread, never a date).
    clockTime() {
      return this.StartYear > 0 && isKnownNumber(this.GameTime) ? Number(this.GameTime) : null
    },

    // Every read with its load state, and whether every read has settled: the snoozes are judged again whenever one is replaced, a retry that succeeds included (it keeps the failure's message until the retry settles, so `ready` never toggles for it), and when the last read settles, as a judgement made while one was in flight waits for it.
    inputsSeen() {
      return [this.ready, ...CHECKS.map((check) => [this[readName(check)], this.loadErrors[readName(check)]])]
    },

    // The snoozes of the open branch, by check.
    snoozeRecords() {
      const records = this.branchId ? forBranch(this.snoozes.store, this.branchId) : []

      return records.reduce((byCheck, record) => ({ ...byCheck, [record.check]: [...(byCheck[record.check] || []), record] }), {})
    },

    snoozeTotal() {
      return Object.values(this.snoozeRecords).reduce((sum, records) => sum + records.length, 0)
    },

    // What the snoozes say of each check's current read: only an evaluation of the read now shown counts, so one made on an earlier read never hides a row of this one.
    snoozeViews() {
      return Object.fromEntries(CHECKS.map((check) => {
        const evaluation = this.evaluations[check.key]

        return [check.key, evaluation && evaluation.read === this[readName(check)] ? evaluation.result : null]
      }))
    },

    snoozeOpen: {
      get() {
        return !!this.snoozing
      },
      set(value) {
        if (!value) {
          this.snoozing = null
        }
      },
    },

    dateRefusal() {
      return this.clockTime === null ? 'The game date of the save is not known, so a date cannot be chosen.' : null
    },

    // Why the open dialog cannot snooze until a material change, or null when it can.
    materialRefusal() {
      if (!this.snoozing || !this.snoozing.target.check.material) {
        return null
      }

      const made = this.makeSnooze('material', null)

      return made.ok ? null : made.error
    },

    // Every check with the rows its read returned, apart from the rows that could not be evaluated, and the message of a read that failed.
    checkStates() {
      return CHECKS.map((check) => {
        const failure = this.loadErrors[readName(check)] || null
        const read = failure ? EMPTY_READ : this[readName(check)]

        return { check, failure, rows: read.rows.filter((row) => !row.unevaluated), unevaluated: read.rows.filter((row) => row.unevaluated) }
      })
    },

    anyFindings() {
      return this.checkStates.some(({ rows, unevaluated, failure }) => rows.length || unevaluated.length || failure)
    },

    // What the tiles count: rows not muted, in checks not muted, by severity; the rows that could not be evaluated and the checks that could not be read are counted apart.
    summary() {
      const severities = Object.fromEntries(SEVERITIES.map((severity) => [severity.key, { rows: 0, checks: 0, unevaluated: 0, unevaluatedChecks: 0, failed: 0 }]))
      let mutedRows = 0
      let mutedChecks = 0
      let snoozedRows = 0

      this.checkStates.forEach(({ check, rows, unevaluated, failure }) => {
        const tally = severities[check.severity]

        if (failure) {
          tally.failed += 1

          return
        }

        if (this.mutedCheckSet.has(check.key)) {
          mutedChecks += 1
          mutedRows += rows.length

          return
        }

        const mutedIds = this.mutedSets[check.key] || NO_IDS
        const unmuted = rows.filter((row) => !mutedIds.has(row.id))
        const parked = this.snoozedIds(check, unmuted, mutedIds)
        const open = unmuted.length - parked.size

        mutedRows += rows.length - unmuted.length
        snoozedRows += parked.size

        if (open) {
          tally.rows += open
          tally.checks += 1
        }

        if (unevaluated.length) {
          tally.unevaluated += unevaluated.length
          tally.unevaluatedChecks += 1
        }
      })

      const total = (name) => Object.values(severities).reduce((sum, tally) => sum + tally[name], 0)

      return { severities, mutedRows, mutedChecks, snoozedRows, unevaluatedRows: total('unevaluated'), unevaluatedChecks: total('unevaluatedChecks'), failedChecks: total('failed') }
    },

    // The tiles' tooltip: the summary's rule, and how many rows could not be evaluated and checks could not be read.
    summaryTitle() {
      const { unevaluatedRows, unevaluatedChecks, failedChecks, snoozedRows } = this.summary
      const parts = [describeRule('warnings.summary')]

      if (snoozedRows) {
        parts.push(`${this.count(snoozedRows)} ${snoozedRows === 1 ? 'row is' : 'rows are'} snoozed`)
      }

      if (unevaluatedRows) {
        parts.push(`${this.count(unevaluatedRows)} ${unevaluatedRows === 1 ? 'row' : 'rows'} in ${this.count(unevaluatedChecks)} ${unevaluatedChecks === 1 ? 'check' : 'checks'} could not be evaluated`)
      }

      if (failedChecks) {
        parts.push(`${this.count(failedChecks)} ${failedChecks === 1 ? 'check' : 'checks'} could not be read`)
      }

      return parts.join('. ')
    },

    // The three severity tiles filter the checks to their severity, and a second click shows them all again; a tile is pressed while its severity is the filter and no single check is focused.
    tiles() {
      const tile = (severity, empty) => {
        const { rows, checks, unevaluated, failed } = this.summary.severities[severity.key]
        const active = this.checkFilter === null && this.filters.severity === severity.key
        const note = [rows ? `${this.count(checks)} ${checks === 1 ? 'check' : 'checks'}` : (unevaluated || failed ? '' : empty), unevaluated ? `${this.count(unevaluated)} not evaluated` : '', failed ? `${this.count(failed)} not read` : ''].filter(Boolean).join(', ')

        return {
          key: severity.key,
          label: severity.label,
          value: this.count(rows),
          title: this.summaryTitle,
          rule: 'warnings.summary',
          icon: severity.icon,
          iconColor: severity.color,
          note,
          selectable: true,
          active,
          selectTitle: active ? 'Show every severity' : `Show only ${severity.label}`,
        }
      }

      const { mutedRows, mutedChecks, snoozedRows } = this.summary

      return [
        tile(SEVERITIES[0], 'Nothing needs action'),
        tile(SEVERITIES[1], 'Nothing needs attention'),
        tile(SEVERITIES[2], 'Nothing to note'),
        {
          label: 'Muted',
          value: this.count(mutedRows),
          title: this.summaryTitle,
          rule: 'warnings.summary',
          icon: 'mdi-bell-off-outline',
          note: mutedChecks ? `Includes ${this.count(mutedChecks)} muted ${mutedChecks === 1 ? 'check' : 'checks'}` : 'Warnings muted',
        },
        {
          label: 'Snoozed',
          value: this.count(snoozedRows),
          title: this.summaryTitle,
          rule: 'warnings.summary',
          icon: 'mdi-bell-sleep-outline',
          note: this.snoozeTotal ? `${this.count(this.snoozeTotal)} ${this.snoozeTotal === 1 ? 'snooze' : 'snoozes'} on this branch` : 'Warnings snoozed',
        },
      ]
    },

    // Each check with the rows the filters leave. A check focused by link or button ignores the severity, group and search filters; muted rows and checks stay out unless shown. A check that could not be read stays in as long as the check is in scope.
    sections() {
      const search = (this.filters.search || '').trim().toLowerCase()
      const focused = this.checkFilter !== null

      return this.checkStates.map(({ check, rows, unevaluated, failure }) => {
        const checkMuted = this.mutedCheckSet.has(check.key)
        const mutedIds = this.mutedSets[check.key] || NO_IDS
        const inScope = focused ? check.key === this.checkFilter : (!this.filters.severity || check.severity === this.filters.severity) && (!this.filters.group || check.group === this.filters.group)
        const visible = inScope && (this.showMuted || !checkMuted)
        const matches = (row) => focused || !search || row.text.includes(search)
        const listed = visible ? rows.filter((row) => matches(row) && (this.showMuted || !mutedIds.has(row.id))) : []
        const parked = this.snoozedIds(check, rows, mutedIds)
        const shown = listed.filter((row) => !parked.has(row.id))
        const view = this.snoozeViews[check.key]
        const ended = this.endedNotes[check.key] || []

        return {
          check,
          rows: shown,
          snoozed: this.showSnoozed ? listed.filter((row) => parked.has(row.id)) : [],
          snoozedIds: parked,
          states: view ? view.rows : NO_STATES,
          checkSnooze: view && view.check && !checkMuted ? view.check : null,
          keptSnoozes: visible && failure ? (this.snoozeRecords[check.key] || []).length : 0,
          ended,
          endedChecks: visible ? ended.filter((note) => note.rowId === null).map((note) => note.text) : [],
          unevaluated: visible ? unevaluated.filter(matches) : [],
          failure: visible ? failure : null,
          checkMuted,
          mutedIds,
          severity: SEVERITY_BY_KEY[check.severity],
          newCount: shown.filter((row) => this.isNew(check.key, row.id)).length,
        }
      })
    },

    panels() {
      return GROUPS.map((group) => {
        const sections = this.sections.filter((section) => section.check.group === group.key && (section.rows.length || section.snoozed.length || section.unevaluated.length || section.failure))

        return {
          group,
          sections,
          total: sections.reduce((sum, section) => sum + section.rows.length, 0),
          warned: sections.filter((section) => section.rows.length).length,
          snoozed: sections.reduce((sum, section) => sum + section.snoozed.length, 0),
          unevaluated: sections.reduce((sum, section) => sum + section.unevaluated.length, 0),
          failed: sections.filter((section) => section.failure).length,
        }
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
        column.height += 1 + panel.sections.reduce((sum, section) => sum + 4 + this.listing(section).length, 0)
      })

      return columns.map(({ panels }) => panels)
    },

    focusedHasFindings() {
      const state = this.focusedCheck && this.checkStates.find(({ check }) => check === this.focusedCheck)

      return !!state && !!(state.rows.length || state.unevaluated.length || state.failure)
    },
  },
  watch: {
    contextKey: {
      immediate: true,
      handler(prefix) {
        // A campaign that goes unsettled while the save is read again and settles as the same one keeps what the page loaded: the stored last look was just written by this page's own visit, and must not replace the one this visit is compared against.
        if (!prefix || prefix === this.settledContext) {
          return
        }

        this.settledContext = prefix
        this.expanded = {}
        this.loadVisitState(prefix)
      },
    },
    // A read's load state settles just before the plugin assigns its rows, so the snapshot waits a tick for the last read's rows to land.
    ready(value) {
      if (value) {
        this.$nextTick(() => this.markVisit())
      }
    },
    inputsSeen() {
      this.$nextTick(() => this.evaluateSnoozes())
    },
  },
  created() {
    this.snoozeRun = 0
  },
  methods: {
    checkLabel,

    // A link's check focuses it and keeps the severity and group filters for when it is closed; without one, the severity and group come from the link, and one it leaves out is cleared.
    applyLink(query) {
      const value = (key) => (Array.isArray(query[key]) ? query[key][0] : query[key])
      const check = value('check')

      this.checkFilter = check && checkByKey[check] ? check : null

      if (!this.checkFilter) {
        const severity = value('severity')
        const group = value('group')

        this.filters = { ...this.filters, severity: SEVERITY_BY_KEY[severity] ? severity : null, group: GROUPS.some(({ key }) => key === group) ? group : null }
      }
    },

    // One check's rows. The context is built before the first await so the reads it makes are the read's dependencies: a check re-reads when the save, the race or an option it names changes.
    runCheck(check) {
      const { database, GameID, RaceID } = this

      if (!database || !GameID || !RaceID) {
        return Promise.resolve(EMPTY_READ)
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

      const GameTime = this.clockTime

      if (check.clock) {
        context.GameTime = this.GameTime
      }

      return check.read(context).then((rows) => Object.freeze({ ok: true, rows: normalizeRows(rows, check), GameTime, options: Object.freeze({ ...context.options }) }))
    },

    loadVisitState(prefix) {
      const stored = (name, fallback) => this.config.get(`${prefix}.${name}`, fallback)

      this.lastLook = stored('warningsLastLook', null)

      const snoozed = readStore(stored('warningsSnoozed', undefined))

      this.snoozeProblem = snoozed.ok ? null : snoozed.reason
      this.snoozes = snoozed.ok ? { store: snoozed.store, dropped: snoozed.dropped } : { store: emptyStore(), dropped: 0 }
      this.evaluations = {}
      this.endedNotes = {}

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

    // A severity tile's click: the checks of that severity, leaving a focused check, or every severity again when it is already the filter.
    selectSeverity(key) {
      const active = this.checkFilter === null && this.filters.severity === key

      this.filters = { ...this.filters, severity: active ? null : key }
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
      if (!this.contextKey) {
        return
      }

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

    // The ids of the rows a snooze holds out of the lists. Only a row that is neither muted nor in a muted check is held: a permanent mute outranks a snooze.
    snoozedIds(check, rows, mutedIds) {
      const view = this.snoozeViews[check.key]

      if (!view || this.mutedCheckSet.has(check.key)) {
        return NO_IDS
      }

      return new Set(rows.filter((row) => !mutedIds.has(row.id) && view.rows.has(row.id) && view.rows.get(row.id).state === 'snoozed').map((row) => row.id))
    },

    snoozeOf(section, row) {
      return section.states.get(row.id).record
    },

    // The notes under a row: what its snooze says of the row (kept and not applied, on another branch, ahead of the save...) and any snooze of it that ended on the last evaluation.
    rowNotes(section, row) {
      const state = section.states.get(row.id)

      return [...(state ? state.notes : []), ...section.ended.filter((note) => note.rowId === row.raw).map((note) => note.text)]
    },

    dateText(seconds) {
      return this.StartYear > 0 ? gameDateText(this.StartYear, seconds) : 'a date the save cannot name'
    },

    // A snooze in words: how long it holds, what a material one waits for and was set at, the branch it came from if it was copied, and its reason.
    snoozeText(record) {
      const parts = [`Snoozed ${untilText(record, this.dateText)}`]

      if (record.until.kind === 'material') {
        parts.push(this.materialText(record))
      }

      if (record.scope === 'check') {
        parts.push('the whole check')
      }

      if (record.from) {
        parts.push(`copied from branch ${record.from}`)
      }

      if (record.reason) {
        parts.push(record.reason)
      }

      return parts.join(' · ')
    },

    // The change a material snooze ends on and the condition it was set under, in the check's words (a snooze of the whole check names each row's).
    materialText(record) {
      const check = checkByKey[record.check]
      const state = this.checkStates.find((entry) => entry.check === check)
      const names = new Map((state ? state.rows : []).map((row) => [row.raw, this.cellText(row, check.columns[0])]))
      const held = record.scope === 'check' ? Object.entries(record.until.signatures) : [[record.rowId, record.until.signature]]
      const lines = held.slice(0, HELD_ROWS).map(([rowId, signature]) => `${record.scope === 'check' ? `${names.get(rowId) || rowId}: ` : ''}${describeSignature(check, signature)}`)

      return `ends on ${check.material}; held at ${lines.join('; ')}${held.length > HELD_ROWS ? ` and ${held.length - HELD_ROWS} more` : ''}`
    },

    // Writes the store of the race with `change` applied to what is stored now (never to a copy read earlier); a store that cannot be read is never written over. Returns null, or the reason nothing was written.
    commitSnoozes(change) {
      const key = this.contextKey && `${this.contextKey}.warningsSnoozed`

      if (!key) {
        return 'The campaign of the save is not settled, so snoozes cannot be kept.'
      }

      const stored = readStore(this.config.get(key))

      if (!stored.ok) {
        this.snoozeProblem = stored.reason

        return stored.reason
      }

      const next = pruned(change(stored.store), () => this.lineage())

      try {
        if (next !== stored.store) {
          this.config.set(key, next)
        }
      } catch (error) {
        return `The snoozes could not be written: ${error.message}`
      }

      this.snoozes = { store: next, dropped: next === stored.store ? stored.dropped : 0 }

      return null
    },

    // The registry's account of the branches of the open campaign, or null when it cannot be read.
    lineage() {
      try {
        return branchLineage(readRegistry(campaignStorage(this.config)).campaigns[this.campaignId])
      } catch (error) {
        return null
      }
    },

    // Evaluates the snoozes of the open branch against the reads that succeeded, then drops the ones that ended. A failed read, or an evaluation that the save, the branch or the read has moved past while the identity stamps were read, changes nothing.
    async evaluateSnoozes() {
      this.snoozeRun += 1

      const run = this.snoozeRun
      const key = this.contextKey
      const branch = this.branchId

      if (!this.ready || !key || !branch || this.commitSnoozes((store) => seeded(store, branch, this.lineage()))) {
        return
      }

      const generation = this.$store.state.freshness.generation
      const reads = CHECKS.map((check) => ({ check, name: readName(check), records: forBranch(this.snoozes.store, branch, check.key) })).filter(({ name, records }) => records.length && this.loadErrors[name] === null && this[name].ok).map((entry) => ({ ...entry, read: this[entry.name] }))

      if (!reads.length) {
        this.evaluations = {}

        return
      }

      const stamps = await Promise.all(reads.map(({ records }) => readStamps(this.database, this.GameID, records.filter((record) => record.scope === 'item' && record.stamp !== null).map((record) => record.rowId))))

      if (run !== this.snoozeRun || key !== this.contextKey || branch !== this.branchId || generation !== this.$store.state.freshness.generation || !reads.every(({ name, read }) => this[name] === read)) {
        return
      }

      const evaluations = {}
      const endings = []

      reads.forEach(({ check, read }, index) => {
        const result = evaluate(forBranch(this.snoozes.store, branch, check.key), read, stamps[index])

        evaluations[check.key] = Object.freeze({ read, result })
        result.ended.forEach(({ record, reason }) => endings.push({ check: check.key, record, reason, at: read.GameTime, text: `A snooze ended: ${ENDED[reason]}` }))
      })

      if (endings.length) {
        const failure = this.commitSnoozes((store) => endRecords(store, endings.map(({ record, reason, at }) => ({ id: record.id, at, reason }))))

        if (!failure) {
          const notes = { ...this.endedNotes }

          endings.forEach(({ check, record, text }) => {
            notes[check] = [...(notes[check] || []).filter((note) => note.id !== record.id), { id: record.id, rowId: record.rowId, text }]
          })

          this.endedNotes = notes
        }
      }

      this.evaluations = evaluations
    },

    // The record the open dialog would make for a kind of snooze, or why there is none.
    makeSnooze(kind, expiresAt) {
      const { target, reason } = this.snoozing
      const { check, row, read, stamps } = target

      return makeRecord({ check, scope: row ? 'item' : 'check', kind, row, expiresAt, reason, read, stamps, branch: this.branchId })
    },

    async openSnooze(check, row) {
      const read = this[readName(check)]
      const stamps = row ? await readStamps(this.database, this.GameID, [row.raw]) : new Map()

      if (this[readName(check)] !== read) {
        return
      }

      this.snoozing = { target: Object.freeze({ check, row, read, stamps }), kind: this.clockTime === null ? 'clear' : 'date', dateText: this.clockTime === null ? '' : gameDateText(this.StartYear, this.clockTime + 30 * DAY).slice(0, 10), reason: '', error: null }
    },

    usePreset(days) {
      if (this.clockTime !== null) {
        this.snoozing.dateText = gameDateText(this.StartYear, this.clockTime + days * DAY).slice(0, 10)
      }
    },

    submitSnooze() {
      const { kind, dateText, target } = this.snoozing
      const { check, read } = target

      if (this[readName(check)] !== read) {
        this.snoozing.error = 'The check was read again while this was open. Close it and try again.'

        return
      }

      let expiresAt = null

      if (kind === 'date') {
        const typed = this.StartYear > 0 ? gameSecondsOf(this.StartYear, dateText) : { ok: false, error: 'The game date of the save is not known.' }

        if (!typed.ok) {
          this.snoozing.error = typed.error

          return
        }

        expiresAt = typed.seconds
      }

      const made = this.makeSnooze(kind, expiresAt)

      if (!made.ok) {
        this.snoozing.error = made.error

        return
      }

      const failure = this.commitSnoozes((store) => addRecord(store, made.record))

      if (failure) {
        this.snoozing.error = failure

        return
      }

      this.snoozing = null
      this.evaluateSnoozes()
    },

    cancelSnooze(record) {
      if (!this.commitSnoozes((store) => endRecords(store, [{ id: record.id, at: this.clockTime, reason: 'cancelled' }]))) {
        this.evaluateSnoozes()
      }
    },

    toggleExpanded(key) {
      this.$set(this.expanded, key, !this.expanded[key])
    },

    // The rows a section lists, up to the preview unless expanded, with the rows that could not be evaluated after them under a separator.
    listing(section) {
      const limit = this.expanded[section.check.key] ? Infinity : PREVIEW_ROWS
      const rows = section.rows.slice(0, limit)
      const snoozed = section.snoozed.slice(0, Math.max(limit - rows.length, 0))
      const unevaluated = section.unevaluated.slice(0, Math.max(limit - rows.length - snoozed.length, 0))
      const parked = snoozed.length ? [{ separator: 'snoozed', id: `snoozed:${section.check.key}`, count: section.snoozed.length }, ...snoozed] : []
      const unread = unevaluated.length ? [{ separator: 'unevaluated', id: `separator:${section.check.key}`, count: section.unevaluated.length }, ...unevaluated] : []

      return [...rows, ...parked, ...unread]
    },

    listedCount(section) {
      return section.rows.length + section.snoozed.length + section.unevaluated.length
    },

    sectionTitle(section) {
      return section.failure ? `The ${checkLabel(section.check)} check` : section.check.title(section.rows.length, this.options)
    },

    panelCaption(panel) {
      return [`${this.count(panel.total)} ${panel.total === 1 ? 'warning' : 'warnings'} in ${this.count(panel.warned)} ${panel.warned === 1 ? 'check' : 'checks'}`, panel.snoozed ? `${this.count(panel.snoozed)} snoozed` : '', panel.unevaluated ? `${this.count(panel.unevaluated)} not evaluated` : '', panel.failed ? `${this.count(panel.failed)} not read` : ''].filter(Boolean).join(', ')
    },

    // What an unevaluated row lacks.
    missingText(row) {
      return `Missing ${joinLabels(row.unevaluated.inputs.missing)}`
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

      this.checkStates.forEach(({ check, rows, failure }) => {
        if (failure) {
          if (this.lastLook && this.lastLook[check.key]) {
            look[check.key] = this.lastLook[check.key]
          }

          return
        }

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

    // The unavailable result behind a cell's dash, if any.
    cellResult(row, column) {
      const cell = row.cells[column.key]

      return cell !== null && typeof cell === 'object' && cell.result ? cell.result : null
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

  .check-failure {
    padding: 4px 16px 12px;
  }

  .row-muted {
    opacity: 0.55;
  }

  .row-snoozed {
    opacity: 0.7;
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
    font-size: calc(12px * var(--ae-font-scale));
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
