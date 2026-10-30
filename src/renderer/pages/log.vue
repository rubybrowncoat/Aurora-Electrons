<template>
  <v-container fluid class="log-page">
    <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

    <template v-if="ready">
      <div class="toolbar">
        <v-text-field v-model="search" label="Search messages" prepend-inner-icon="mdi-magnify" clearable dense outlined hide-details class="tool tool--search" />
        <v-combobox :value="keywords" label="Keywords (any)" multiple chips small-chips deletable-chips dense outlined hide-details clearable :delimiters="[',']" append-icon="" class="tool tool--keywords" @change="setKeywords" />
        <v-autocomplete v-model="place" :items="placeOptions" label="System or colony" clearable dense outlined hide-details class="tool tool--place" />
        <log-type-filter class="tool tool--types" :groups="typeGroups" :selected="selectedTypes" :all="activeTypes === null" @change="setTypes" />
        <log-presets :presets="presets" :keywords="keywords" :type-count="activeTypes === null ? null : activeTypes.length" @apply="applyPreset" @save="savePreset" @rename="renamePreset" @remove="removePreset" />
        <v-menu offset-y left :close-on-content-click="false" max-width="340">
          <template #activator="{ on, attrs }">
            <v-btn outlined aria-label="Game Log options" v-bind="attrs" v-on="on"><v-icon small left>mdi-tune-variant</v-icon>Options<span v-if="activeOptionCount">&nbsp;({{ activeOptionCount }})</span></v-btn>
          </template>
          <v-card class="pa-4">
            <div class="subtitle-2">Events in the list</div>
            <v-checkbox v-model="collapseRepeats" label="Collapse daily repeats" dense hide-details />
            <div class="caption text--secondary mt-1">The same type on one game day folds into an expandable row. No message is removed.</div>
            <v-checkbox v-model="hideNonCustomized" label="Only custom-coloured events" dense hide-details />
            <div class="caption text--secondary mt-1">Types with a colour entry in this race's game settings, including black.</div>
            <template v-if="canArchive">
              <v-divider class="my-3" />
              <v-switch :input-value="archiveChoice" label="Keep an event archive" dense hide-details class="mt-0" @change="setArchive" />
              <div class="caption text--secondary mt-1">Records this race's events on this branch, so the ones a later save no longer holds stay readable. Up to {{ count(eventCap) }} events are kept, about {{ capSize }} as stored (an estimate). Switching it off keeps what was recorded.</div>
              <div v-if="archiveMessage" class="caption error--text mt-1" role="alert">{{ archiveMessage }}</div>
            </template>
            <v-btn small text class="mt-3" @click="resetFilters">Reset filters</v-btn>
          </v-card>
        </v-menu>
      </div>

      <stat-tiles dense class="my-2" :tiles="tiles" />

      <pinned-panel class="mb-3" :entries="pinEntries" :unavailable="pinUnavailable" :message="pinMessage" @open="(row) => detail = row" @note="changeNote" @unpin="unpin" />

      <archive-panel v-if="archiveChoice && canArchive && archive" class="mb-3" :status="archive.status" :reason="archive.reason || ''" :record="archiveRecord" :cap="eventCap" :start-year="Number(StartYear)" :source="archiveListed ? 'archive' : 'save'" @source="(value) => listSource = value" />

      <diagnostic-panel class="mb-3" :diagnosis="diagnosis" :pending="!diagnosisCurrent" :seconds="diagnosticWindow" :start-year="Number(StartYear)" @window="(value) => diagnosticWindow = value" />

      <v-card class="panel mb-3" data-summary="Track game-log event counts by month." elevation="1">
        <div class="panel-head">
          <div class="subtitle-2">Timeline</div>
          <div class="date-fields">
            <v-text-field v-model="dateFrom" type="date" label="From" dense outlined hide-details />
            <v-text-field v-model="dateTo" type="date" label="Through" dense outlined hide-details />
            <v-select :value="selectedMonth" :items="monthOptions" label="Month" clearable dense outlined hide-details @change="selectMonth" />
          </div>
        </div>
        <div v-if="timeline.length" class="px-3">
          <chart-canvas type="bar" :data="timelineChart" :options="timelineOptions" :height="130" label="Events per game month. Click a bar to filter to that month." />
        </div>
        <div v-else class="pa-4 text--secondary">No events to chart.</div>
        <div class="panel-foot caption text--secondary">
          Use it to find busy periods and narrow the list below to one month. Click a month to select it, or click it again to clear the dates. Counts follow the search, place, and types, before the date filter. Dates are game dates, and both ends are included.
          <span v-if="dateFrom && dateTo && dateFrom > dateTo" class="error--text">From is later than Through.</span>
        </div>
      </v-card>

      <v-card class="panel" data-summary="Review game-log events from newest to oldest." elevation="1">
        <div class="panel-head">
          <div class="subtitle-2">Events <span class="caption text--secondary">{{ count(filteredEvents.length) }} of {{ count(listEvents.length) }}</span><span v-if="archiveListed" class="caption text--secondary"> · from the archive</span></div>
          <div class="caption text--secondary">
            {{ collapseRepeats ? `${count(eventRows.length)} rows before expanding repeats` : 'Newest first' }}
            <span v-if="firstVisit"> · First visit</span>
          </div>
        </div>
        <window-virtual-scroll v-if="displayRows.length" ref="events" :items="displayRows" :item-height="84" :bench="4" class="events">
          <template #default="{ item: row }">
            <div v-if="row.divider" class="last-look"><v-icon small class="mr-2">mdi-history</v-icon>Last look<span class="ml-2 caption">{{ newCount ? 'Older events below' : 'No newer events in this view' }}</span></div>
            <v-list-item v-else :key="row.key" class="event-row" :class="{ 'event-row--child': row.child }" :style="eventStyle(row.event)" role="button" tabindex="0" :aria-expanded="row.group ? String(expandedGroups.includes(row.key)) : undefined" @click="openRow(row)" @keydown.space.self.prevent="openRow(row)">
              <v-list-item-content>
                <div class="event-heading">
                  <v-icon small class="mr-2" :style="{ color: 'inherit' }">{{ eventIcons[row.event.EventType] || 'mdi-text-box-outline' }}</v-icon>
                  <span class="event-type">{{ row.event.TypeName }}</span>
                  <span v-if="row.group" class="repeat-count">{{ count(row.events.length) }} events</span>
                  <span v-if="isNew(row.event)" class="new-label">New</span>
                  <span v-if="!row.group && isPinned(row.event)" class="new-label pinned-label">Pinned</span>
                  <span class="event-date">{{ row.group ? row.event.Day : row.event.DateTime }}</span>
                  <!-- Vuetify activates a row on Enter, even from a child link; keep link keys on the link. -->
                  <page-link v-if="row.event.KnownSystemID && (!row.group || row.sameSystem)" :to="systemLink(row.event)" :name="row.event.SystemName" />
                  <page-link v-if="row.event.SystemBodyID && (!row.group || row.sameColony)" :to="bodyLink(row.event)" :name="row.event.ColonyName" />
                  <span v-if="row.event.archived && row.event.ColonyName && (!row.group || row.sameColony)" class="event-place">{{ row.event.ColonyName }}</span>
                  <v-btn v-if="!row.group" icon x-small :style="{ color: 'inherit' }" :disabled="!canPin" :aria-pressed="String(isPinned(row.event))" :aria-label="isPinned(row.event) ? 'Unpin this event' : 'Pin this event'" :title="pinTitle(row.event)" @click.stop="togglePin(row.event)" @keydown.native.stop><v-icon small>{{ isPinned(row.event) ? 'mdi-pin' : 'mdi-pin-outline' }}</v-icon></v-btn>
                  <v-btn icon x-small :style="{ color: 'inherit' }" :aria-label="`Hide ${row.event.TypeName} events`" :title="`Hide ${row.event.TypeName} events`" @click.stop="hideType(row.event)" @keydown.native.stop><v-icon small>mdi-eye-off-outline</v-icon></v-btn>
                  <v-icon v-if="row.group" small :style="{ color: 'inherit' }">{{ expandedGroups.includes(row.key) ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
                </div>
                <div class="event-message">
                  <template v-if="row.group">{{ count(row.events.length) }} {{ row.event.TypeName.toLowerCase() }} messages on {{ row.event.Day }}. {{ expandedGroups.includes(row.key) ? 'Click to collapse.' : 'Click to expand.' }}</template>
                  <template v-else>{{ row.event.MessageText }}</template>
                </div>
              </v-list-item-content>
            </v-list-item>
          </template>
        </window-virtual-scroll>
        <div v-else class="pa-6 text--secondary">{{ listPending ? 'Reading the archive.' : listEvents.length ? 'No events match these filters.' : archiveListed ? 'The archive holds no events of this race.' : 'This race has no events in the save.' }}</div>
        <div class="panel-foot caption text--secondary">
          Rows keep this race's custom alert and text colours. Click a message to read it in full, expand a daily repeat to read each message, or pin an event to keep it in the Pinned panel. "New" compares the game time of an event with the end of the newest increment that the previous visit to this page saw on this branch. The first visit to a branch inherits what its parent saw up to the fork.
        </div>
      </v-card>
    </template>

    <v-dialog :value="!!detail" max-width="760" @input="(value) => { if (!value) detail = null }">
      <v-card v-if="detail" class="event-detail">
        <v-card-title class="event-detail-title">{{ detail.TypeName }}<v-spacer /><v-btn icon aria-label="Close event" @click="detail = null"><v-icon>mdi-close</v-icon></v-btn></v-card-title>
        <v-card-subtitle class="event-detail-meta">{{ detail.DateTime }}<span v-if="detail.SystemName"> · {{ detail.SystemName }}</span><span v-if="detail.ColonyName"> · {{ detail.ColonyName }}</span><span v-if="detail.archived"> · From the archive</span><span v-if="isPinned(detail)"> · Pinned</span></v-card-subtitle>
        <v-card-text class="event-detail-message" :style="eventStyle(detail)">{{ detail.MessageText }}</v-card-text>
        <v-card-text v-if="pinMessage" class="error--text py-2" role="alert">{{ pinMessage }}</v-card-text>
        <v-card-actions class="event-detail-actions">
          <v-btn v-if="detail.KnownSystemID" text :to="systemLink(detail)">Galaxy Map</v-btn>
          <v-btn v-if="detail.SystemBodyID" text :to="bodyLink(detail)">Colonization Planner</v-btn>
          <v-btn text @click="hideType(detail)">Hide event type</v-btn>
          <v-btn text :disabled="!canPin" @click="togglePin(detail)"><v-icon small left>{{ isPinned(detail) ? 'mdi-pin-off-outline' : 'mdi-pin-outline' }}</v-icon>{{ isPinned(detail) ? 'Unpin' : 'Pin' }}</v-btn>
          <v-spacer />
          <v-btn text @click="detail = null">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script>
import { mapGetters } from 'vuex'

import ArchivePanel from '../components/log/ArchivePanel.vue'
import DiagnosticPanel from '../components/log/DiagnosticPanel.vue'
import LogPresets from '../components/log/LogPresets.vue'
import LogTypeFilter from '../components/log/LogTypeFilter.vue'
import PinnedPanel from '../components/log/PinnedPanel.vue'
import ChartCanvas from '../components/charts/ChartCanvas.vue'
import { chartTheme } from '../components/charts/theme'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import StatTiles from '../components/page/StatTiles.vue'
import WindowVirtualScroll from '../components/page/WindowVirtualScroll.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView from '../mixins/persisted-view'
import { activeAppearance } from '../utilities/appearance'
import { eventColorToRGBA, gameTime } from '../utilities/aurora'
import { readRegistry } from '../utilities/campaign'
import { linkTo, queryId } from '../utilities/deep-links'
import { EVENT_ICONS } from '../utilities/event-icons'
import { eventCapOfSettings, eventEstimate, readLogWindow, rowCounts, rowFingerprint, saveArchiveChoice } from '../utilities/event-archive'
import { PIN_STATES, pinKey, pinOfRow, pinsOf, pinState, readPins, seededPins, withNote, withPin, withoutPin } from '../utilities/event-pins'
import { cleanKeywords, groupTypes, keywordTest, newPresetId, presetTypes, readPresets, withPreset, withRenamedPreset, withoutPreset } from '../utilities/event-triage'
import { bytesText, campaignStorage } from '../utilities/history'
import { branchLineage, gameDateText } from '../utilities/history-milestones'
import { tracked } from '../utilities/load-tracking'
import { archiveEvents, pinnableRow, playerPins, readArchiveFile, readArchiveNames } from '../utilities/log-archive-view'
import { DEFAULT_WINDOW, diagnose, readDiagnostic } from '../utilities/log-diagnostics'
import { isNewEvent, newestEnd, readLook, withLook } from '../utilities/log-visit'

const INPUT_LABELS = { logEvents: 'the game log' }

const NO_LOOK = Object.freeze({ key: null, t: null, settled: false })

export default {
  components: { ArchivePanel, ChartCanvas, DiagnosticPanel, LoadState, LogPresets, LogTypeFilter, PageLink, PinnedPanel, StatTiles, WindowVirtualScroll },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      search: { key: 'logSearch', default: '', scope: 'race', normalise: (stored) => stored || '' },
      place: { key: 'logPlace', default: null, scope: 'race', normalise: (stored) => stored || null },
      activeTypes: { key: 'logTypes', default: null, scope: 'race', normalise: (stored) => (Array.isArray(stored) ? stored : null) },
      keywords: { key: 'logKeywords', default: [], scope: 'race', normalise: (stored) => (Array.isArray(stored) ? cleanKeywords(stored) : undefined) },
      dateFrom: { key: 'logDateFrom', default: '', scope: 'race', normalise: (stored) => stored || '' },
      dateTo: { key: 'logDateTo', default: '', scope: 'race', normalise: (stored) => stored || '' },
      collapseRepeats: { key: 'logCollapseRepeats', default: true, normalise: (stored) => stored !== false },
      hideNonCustomized: { key: 'logOnlyCustomized', default: false, normalise: (stored) => !!stored },
      presets: { key: 'logPresets', default: [], normalise: readPresets },
    }),
  ],
  data() {
    return {
      // The previous visit to this branch: { key, t, settled }, `t` the game time events are compared with (null: a first visit). It is read once for a campaign, race and branch and stays fixed while the page is open.
      look: NO_LOOK,
      // The pins of the race: { key, store } with `store` null when what is stored cannot be read. Frozen, as one holds up to 500 pins.
      pinStore: Object.freeze({ key: null, store: null }),
      pinMessage: '',
      // The event archive: the choice, which list the page shows and the last refusal (what the branch's file holds for the race is the computed `archive`).
      archiveChoice: false,
      listSource: 'save',
      archiveMessage: '',
      // The short-interval checklist: what the open save, the archive and the game's tables said for the race and save open when it was read ({ key, database, inputs }, `inputs` null until read), the window chosen and the read in progress.
      diagnostic: Object.freeze({ key: null, database: null, inputs: null }),
      diagnosticWindow: DEFAULT_WINDOW,
      diagnosticRun: 0,
      settledContext: null,
      expandedGroups: [],
      detail: null,
      eventIcons: EVENT_ICONS,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'GameTime', 'RaceID', 'StartYear', 'racePrefix', 'campaignId']),

    contextKey() {
      return this.racePrefix
    },

    ready() {
      return !!this.database && !!this.contextKey && this.inputsLoaded
    },

    // The branch of the campaign the open save belongs to, or null while it is not settled.
    branchId() {
      const settled = this.$store.getters['history/campaign']

      return settled ? settled.branchId : null
    },

    // The save's own rows and the log's window, which the read attaches to them.
    logWindow() {
      return this.logEvents.logWindow
    },

    // The rows the page lists: the save's, or the archive's when the player chose it and the archive holds the race.
    archiveRecord() {
      return this.archive && this.archive.status === 'ok' ? this.archive.record : null
    },

    archiveListed() {
      return this.listSource === 'archive' && !!this.archiveRecord
    },

    listPending() {
      return this.archiveListed && !this.archiveNames
    },

    listEvents() {
      if (!this.archiveListed) {
        return this.logEvents
      }

      return this.archiveNames ? archiveEvents(this.archiveRecord, this.archiveNames, this.StartYear) : []
    },

    // The previous visit to this branch, as game time; null on a first visit.
    lastSeen() {
      return this.look.t
    },

    firstVisit() {
      return this.look.settled && this.look.t === null
    },

    // What the visit depends on: it is settled and written when the save, the campaign, the race, the branch or the newest increment of the save changes.
    visitState() {
      const logWindow = this.logWindow

      if (!this.ready || !this.branchId || logWindow === undefined) {
        return null
      }

      return `${this.contextKey}|${this.branchId}|${newestEnd(logWindow && logWindow.ledger)}`
    },

    keywordMatch() {
      return keywordTest(this.keywords)
    },

    // The Options' archive switch is for a player race of a settled campaign.
    canArchive() {
      return !!this.campaignId && !!this.branchId && !!this.RaceID && !this.$store.state.RaceNPR
    },

    eventCap() {
      return eventCapOfSettings(this.config)
    },

    capSize() {
      return bytesText(eventEstimate(this.eventCap))
    },

    // What changes the archive the page reads: the choice, the branch, the race, and the recorder having written (its pass is asked for at the switch).
    archiveKey() {
      return this.canArchive && this.archiveChoice ? `${this.campaignId}|${this.branchId}|${this.RaceID}|${this.$store.state.history.revision}` : null
    },

    // What the branch's file holds for the race, read when the choice, the branch, the race or the recorder's pass changes (`archiveKey`): { status: 'ok', record } (record null while the race has none), { status: 'unavailable', reason }, or null while the archive is off. It is derived, not copied by a watcher, so whatever reads it after the recorder wrote (the list, the panel, the checklist's read) meets the file as it is now and never the snapshot before.
    archive() {
      return this.archiveKey ? readArchiveFile(this.campaignId, this.branchId, this.RaceID) : null
    },

    // What the archive's record says of the observed time: the captures that added rows, the failed captures, the spans, the tip and the cut. A failed capture or a span adds no row and leaves `revision` alone, so the revision alone is no key.
    archiveSnapshot() {
      const record = this.archiveRecord

      return record ? JSON.stringify([record.revision, (record.failures || []).length, record.failures && record.failures.length ? record.failures[record.failures.length - 1].at : null, record.spans, record.tip || null, record.cut === undefined ? null : record.cut]) : ''
    },

    // What the checklist's read depends on: the race, the branch, the archive and what it holds, and the newest increment of the save. The save's own copy is compared apart (`diagnostic.database`).
    diagnosticKey() {
      if (!this.ready || this.logWindow === undefined) {
        return null
      }

      return [this.contextKey, this.branchId || '', this.archiveKey || 'off', this.archive ? this.archive.status : 'off', this.archiveSnapshot, newestEnd(this.logWindow && this.logWindow.ledger), this.GameTime].join('|')
    },

    // Whether the checklist held was read for the race and save open now: evidence of another race or save is never shown.
    diagnosisCurrent() {
      return this.diagnosticKey !== null && this.diagnostic.key === this.diagnosticKey && this.diagnostic.database === this.database && this.diagnostic.inputs !== null
    },

    diagnosis() {
      return this.diagnosisCurrent ? diagnose(this.diagnostic.inputs, this.diagnosticWindow) : null
    },

    pinsKey() {
      return this.racePrefix ? `${this.racePrefix}.logPins` : null
    },

    canPin() {
      return !!this.branchId && !!this.pinStore.store
    },

    pinUnavailable() {
      return this.pinsKey && !this.pinStore.store && this.pinStore.key === this.pinsKey ? 'what is stored for this race is not a pin store this version reads.' : ''
    },

    branchPins() {
      return this.pinStore.store && this.branchId ? pinsOf(this.pinStore.store, this.branchId) : []
    },

    pinKeys() {
      return new Set(this.branchPins.map(pinKey))
    },

    // The branch's pins with what the open save says of each: its rows with the pinned increments are counted once, and each pin is judged by its content, never by a row's place.
    pinEntries() {
      const pins = playerPins(this.branchPins)

      if (!pins.length) {
        return []
      }

      const increments = new Set(pins.map((pin) => pin.increment[0]))
      const rows = this.logEvents.filter((event) => increments.has(event.IncrementID))
      const counts = rowCounts(rows)
      const found = new Map()

      rows.forEach((row) => {
        const key = rowFingerprint(row)

        if (!found.has(key)) {
          found.set(key, row)
        }
      })

      return pins.map((pin) => {
        const state = pinState(pin, counts, this.logWindow || null)
        const [system, colony] = [pin.names.system || (pin.fields[3] > 0 ? `System ${pin.fields[3]}` : null), pin.names.colony || (pin.fields[4] > 0 ? `Colony ${pin.fields[4]}` : null)]

        return { pin, state, stateText: PIN_STATES[state], row: found.get(pinKey(pin)) || null, date: gameDateText(this.StartYear, pin.fields[0]), type: pin.names.type || `Event type ${pin.fields[1]}`, message: pin.fields[2] || '', places: [system, colony].filter(Boolean).join(' · ') }
      })
    },

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    activeOptionCount() {
      return Number(!this.collapseRepeats) + Number(this.hideNonCustomized)
    },

    placeOptions() {
      const places = new Map()

      this.listEvents.forEach((event) => {
        if (event.KnownSystemID) {
          places.set(`system-${event.KnownSystemID}`, { text: `System: ${event.SystemName}`, name: event.SystemName })
        }
        if (event.ColonyID) {
          places.set(`colony-${event.ColonyID}`, { text: `Colony: ${event.ColonyName}${event.SystemName ? ` (${event.SystemName})` : ''}`, name: event.ColonyName })
        }
      })

      return [...places].map(([value, { text, name }]) => ({ value, text, name })).sort((a, b) => a.text.localeCompare(b.text))
    },

    // The place filter as the query names it: a system or a colony, by the ID after its filter value's dash.
    linkQuery() {
      const [kind, id] = String(this.place || '').split('-')

      return linkTo.log({ system: kind === 'system' ? id : null, colony: kind === 'colony' ? id : null }).query
    },

    linkLabel() {
      const option = this.placeOptions.find((item) => item.value === this.place)

      return option && option.name
    },

    baseEvents() {
      const search = (this.search || '').trim().toLowerCase()

      return this.listEvents.filter((event) => (!search || event.searchText.includes(search)) && (!this.keywordMatch || this.keywordMatch(event.searchText)) && (!this.place || this.place === `system-${event.KnownSystemID}` || this.place === `colony-${event.ColonyID}`) && (!this.hideNonCustomized || event.Customized))
    },

    typeOptions() {
      const types = new Map()
      const counts = new Map()

      this.listEvents.forEach((event) => types.set(event.EventType, event.TypeName))
      this.baseEvents.filter(this.inDateRange).forEach((event) => counts.set(event.EventType, (counts.get(event.EventType) || 0) + 1))

      return [...types].map(([value, name]) => ({ value, text: `${name} (${this.count(counts.get(value) || 0)})` })).sort((a, b) => a.text.localeCompare(b.text))
    },

    typeGroups() {
      return groupTypes(this.typeOptions)
    },

    selectedTypes() {
      return this.activeTypes === null ? this.typeOptions.map((type) => type.value) : this.activeTypes
    },

    // The chart keeps the months outside the selected dates so a second click can clear them.
    timelineEvents() {
      const types = this.activeTypes === null ? null : new Set(this.activeTypes)

      return types ? this.baseEvents.filter((event) => types.has(event.EventType)) : this.baseEvents
    },

    filteredEvents() {
      return this.timelineEvents.filter(this.inDateRange)
    },

    newCount() {
      return this.filteredEvents.filter(this.isNew).length
    },

    tiles() {
      const types = new Map()
      const months = new Map()

      this.filteredEvents.forEach((event) => {
        types.set(event.EventType, (types.get(event.EventType) || 0) + 1)
        months.set(event.Month, (months.get(event.Month) || 0) + 1)
      })
      const busiest = (counts) => [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
      const type = busiest(types)
      const month = busiest(months)
      const typeName = type ? this.listEvents.find((event) => event.EventType === type[0]).TypeName : '—'

      return [
        { label: 'Events in range', value: this.count(this.filteredEvents.length), note: `of ${this.count(this.listEvents.length)} in this ${this.archiveListed ? 'archive' : "race's log"}` },
        { label: 'Busiest type', value: typeName, note: type ? `${this.count(type[1])} events in this view` : 'No events in this view' },
        { label: 'Busiest month', value: month ? month[0] : '—', note: month ? `${this.count(month[1])} events in this view` : 'No events in this view' },
        { label: 'New since last look', value: this.lastSeen === null ? '—' : this.count(this.newCount), note: this.lastSeen === null ? 'This visit starts the record' : 'Events in this view after the previous visit to this branch' },
      ]
    },

    timeline() {
      if (!this.listEvents.length) {
        return []
      }

      const counts = new Map()
      this.timelineEvents.forEach((event) => counts.set(event.Month, (counts.get(event.Month) || 0) + 1))
      let at = gameTime(this.StartYear, this.listEvents[this.listEvents.length - 1].Time).startOf('month')
      const end = this.listEvents[0].Month
      const months = []

      while (at.format('YYYY-MM') <= end) {
        const month = at.format('YYYY-MM')
        months.push({ month, count: counts.get(month) || 0, from: at.format('YYYY-MM-DD'), to: at.endOf('month').format('YYYY-MM-DD') })
        at = at.add(1, 'month')
      }

      return months
    },

    selectedMonth() {
      const selected = this.timeline.find((month) => month.from === this.dateFrom && month.to === this.dateTo)

      return selected ? selected.month : null
    },

    monthOptions() {
      return this.timeline.map((month) => ({ value: month.month, text: `${month.month} (${this.count(month.count)})` }))
    },

    timelineChart() {
      return {
        labels: this.timeline.map((month) => month.month),
        datasets: [{
          label: 'Events',
          data: this.timeline.map((month) => month.count),
          backgroundColor: this.timeline.map((month) => (!this.dateFrom || month.to >= this.dateFrom) && (!this.dateTo || month.from <= this.dateTo) ? this.theme.primary : this.theme.border),
          borderRadius: 3,
        }],
      }
    },

    timelineOptions() {
      return {
        onClick: (_event, elements) => {
          if (elements.length) {
            const month = this.timeline[elements[0].index].month
            this.selectMonth(month === this.selectedMonth ? null : month)
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, maxTicksLimit: 12 } },
          y: { beginAtZero: true, ticks: { precision: 0 } },
        },
      }
    },

    eventRows() {
      if (!this.collapseRepeats) {
        return this.filteredEvents.map((event) => ({ key: `event-${event.id}`, event }))
      }

      const groups = new Map()
      this.filteredEvents.forEach((event) => {
        // Split at last look too, so a daily repeat never hides the new/old boundary.
        const key = `${event.Day}-${event.EventType}-${this.isNew(event)}`
        if (!groups.has(key)) {
          groups.set(key, [])
        }
        groups.get(key).push(event)
      })

      return [...groups].map(([key, events]) => {
        const event = events[0]

        if (events.length === 1) {
          return { key: `event-${event.id}`, event }
        }

        return {
          key: `group-${key}`,
          group: true,
          event,
          events,
          sameSystem: events.every((item) => item.KnownSystemID === event.KnownSystemID),
          sameColony: events.every((item) => item.ColonyID === event.ColonyID),
        }
      })
    },

    displayRows() {
      const expanded = new Set(this.expandedGroups)
      const rows = []
      let divided = this.lastSeen === null

      this.eventRows.forEach((row) => {
        if (!divided && !this.isNew(row.event)) {
          rows.push({ key: 'last-look', divider: true })
          divided = true
        }
        rows.push(row)
        if (row.group && expanded.has(row.key)) {
          row.events.forEach((event) => rows.push({ key: `event-${event.id}`, event, child: true }))
        }
      })
      if (!divided && rows.length) {
        rows.push({ key: 'last-look', divider: true })
      }

      return rows
    },
  },
  watch: {
    contextKey: {
      immediate: true,
      handler(prefix) {
        // The same campaign settling again after a new copy of the save is read keeps the visit: the stored watermark was written by this visit and must not replace the one the page compares against.
        if (!prefix || prefix === this.settledContext) {
          return
        }

        this.settledContext = prefix
        this.expandedGroups = []
        this.detail = null
        this.pinMessage = ''
        this.archiveMessage = ''
        this.listSource = 'save'
        this.look = NO_LOOK
        this.archiveChoice = this.config.get(`${prefix}.logArchive`) === true
      },
    },
    visitState: {
      immediate: true,
      handler(state) {
        if (state) {
          this.visit()
        }
      },
    },
    // The pins are read for the race when it is picked, and seeded with the parent branch's once the branch is known.
    pinsKey: {
      immediate: true,
      handler() {
        this.loadPins()
      },
    },
    branchId() {
      this.seedPins()
    },
    // The checklist is read again, with nothing kept of the earlier scope, when the race, the save or what the archive holds changes.
    diagnosticKey: {
      immediate: true,
      handler() {
        this.loadDiagnostic()
      },
    },
    database() {
      this.loadDiagnostic()
    },
    // The list goes back to the save when the archive stops holding the race.
    archiveRecord(record) {
      if (!record && this.listSource === 'archive') {
        this.listSource = 'save'
      }
    },
    filteredEvents() {
      this.expandedGroups = []
      // The filtered events start from the top: when the page is scrolled past the list's start, it goes back to it, just under the app bar.
      this.$nextTick(() => {
        const list = this.$refs.events
        const { bar, top } = this.$vuetify.application
        const offset = list ? list.$el.getBoundingClientRect().top - bar - top : 0

        if (offset < 0) {
          window.scrollBy({ top: offset })
        }
      })
    },
  },
  methods: {
    applyLink(query) {
      const system = queryId(query.system)
      const colony = queryId(query.colony)

      this.place = system ? `system-${system}` : colony ? `colony-${colony}` : null
    },

    resetFilters() {
      this.search = ''
      this.keywords = []
      this.place = null
      this.activeTypes = null
      this.dateFrom = ''
      this.dateTo = ''
      this.collapseRepeats = true
      this.hideNonCustomized = false
    },

    setKeywords(keywords) {
      this.keywords = cleanKeywords(keywords)
    },

    applyPreset(preset) {
      this.keywords = [...preset.keywords]
      this.activeTypes = presetTypes(preset, this.typeOptions.map((type) => type.value))
    },

    savePreset(name) {
      this.presets = withPreset(this.presets, { name, keywords: this.keywords, types: this.activeTypes })
    },

    renamePreset({ id, name }) {
      this.presets = withRenamedPreset(this.presets, id, name)
    },

    removePreset(id) {
      this.presets = withoutPreset(this.presets, id)
    },

    setTypes(types) {
      this.activeTypes = types
    },

    hideType(event) {
      this.setTypes(this.selectedTypes.filter((type) => type !== event.EventType))
      this.detail = null
    },

    selectMonth(value) {
      const month = this.timeline.find((month) => month.month === value)
      this.dateFrom = month ? month.from : ''
      this.dateTo = month ? month.to : ''
    },

    inDateRange(event) {
      return (!this.dateFrom || event.Day >= this.dateFrom) && (!this.dateTo || event.Day <= this.dateTo)
    },

    isNew(event) {
      return isNewEvent(event, this.lastSeen)
    },

    // Settles what the previous visit to this branch was (once for the campaign, race and branch; it stays fixed while the page is open) and then records this save's newest increment for the next visit.
    visit() {
      const key = `${this.contextKey}|${this.branchId}`

      if (this.look.key !== key) {
        const stored = this.config.get(`${this.contextKey}.logLastSeen`, null)
        const logWindow = this.logWindow
        const { t } = readLook(stored, this.branchId, logWindow ? logWindow.ledger : null, this.lineage())

        this.look = Object.freeze({ key, t, settled: true })
      }

      this.markVisit()
    },

    // The stored value is this save's newest increment, not the highest ever seen, so an earlier save of the same branch counts from where it stands. An old number is replaced by the record.
    markVisit() {
      const t = newestEnd(this.logWindow && this.logWindow.ledger)
      const key = `${this.contextKey}.logLastSeen`
      const stored = this.config.get(key, null)

      if (t === null || (stored && typeof stored === 'object' && stored[this.branchId] && stored[this.branchId].t === t)) {
        return
      }

      this.config.set(key, withLook(stored, this.branchId, t))
    },

    // The registry's account of the branches of the open campaign, or null when it cannot be read.
    lineage() {
      try {
        return branchLineage(readRegistry(campaignStorage(this.config)).campaigns[this.campaignId])
      } catch (error) {
        return null
      }
    },

    // ---- Pins ----

    loadPins() {
      const key = this.pinsKey

      this.pinStore = Object.freeze({ key, store: key ? readPins(this.config.get(key)) : null })
      this.seedPins()
    },

    // A branch is given its parent's pins of the events that had happened by the fork, once. A race with no pin at all is seeded in memory and written with its first pin.
    seedPins() {
      const { key, store } = this.pinStore
      const branch = this.branchId

      if (!key || !store || !branch || store.seeded[branch]) {
        return
      }

      const lineage = this.lineage()
      const seeded = lineage ? seededPins(store, branch, lineage) : store

      if (seeded === store) {
        return
      }

      if (store.pins.length) {
        this.commitPins((current) => current)
      } else {
        this.pinStore = Object.freeze({ key, store: seeded })
      }
    },

    // The change made in one read-change-write of what is stored: it is read again here, seeded for the branch, and refused when it cannot be read, so an unreadable store is never overwritten. Returns the reason it was not made, or null.
    commitPins(change) {
      const key = this.pinsKey

      if (!key || !this.branchId) {
        return 'The campaign of the open save is not settled yet.'
      }

      const stored = readPins(this.config.get(key))

      if (!stored) {
        return 'The pins could not be read, so nothing was changed.'
      }

      const lineage = this.lineage()
      let next

      try {
        next = change(lineage ? seededPins(stored, this.branchId, lineage) : stored)
      } catch (error) {
        return error.message
      }

      if (next !== stored) {
        try {
          this.config.set(key, next)
        } catch (error) {
          return `The pins could not be written: ${error.message}`
        }
      }

      this.pinStore = Object.freeze({ key, store: next })

      return null
    },

    isPinned(event) {
      return this.pinKeys.size > 0 && this.pinKeys.has(rowFingerprint(event))
    },

    pinTitle(event) {
      return this.canPin ? (this.isPinned(event) ? 'Unpin this event' : 'Pin this event') : 'Pins are unavailable'
    },

    // The identity of an event's increment: the archive's row carries it, a row of the save is looked up in the window.
    incrementOf(event) {
      if (event.archived) {
        return event.increment
      }

      return (this.logWindow && this.logWindow.ledger.get(event.IncrementID)) || null
    },

    // How many identical events the event's group holds: the archive keeps the count, the save's rows of the increment are counted.
    groupCount(event) {
      if (event.archived) {
        return event.copies
      }

      const key = rowFingerprint(event)

      return this.logEvents.filter((row) => row.IncrementID === event.IncrementID && rowFingerprint(row) === key).length
    },

    togglePin(event) {
      this.pinMessage = ''

      if (!pinnableRow(event)) {
        this.pinMessage = 'A game-master-only event cannot be pinned.'

        return
      }

      const pin = this.pinStore.store && this.branchId ? pinOfRow(this.pinStore.store, this.branchId, event) : null
      const branch = this.branchId
      const increment = pin ? null : this.incrementOf(event)

      if (!pin && !increment) {
        this.pinMessage = 'The save does not name the increment of this event, so it cannot be pinned.'

        return
      }

      // A dialog outlives a refresh of the save: the group it shows may be gone from the rows held now, and a pin on it would hold no event.
      if (!pin && this.groupCount(event) < 1) {
        this.pinMessage = 'The open save no longer holds this event; it cannot be pinned.'

        return
      }

      const names = { type: event.TypeName, system: event.SystemName, colony: event.ColonyName }
      const failure = this.commitPins((store) => (pin ? withoutPin(store, branch, pin.id) : withPin(store, branch, event, { increment, count: this.groupCount(event), names, at: Date.now(), id: newPresetId() })))

      if (failure) {
        this.pinMessage = failure
      }
    },

    unpin(id) {
      this.pinMessage = this.commitPins((store) => withoutPin(store, this.branchId, id)) || ''
    },

    changeNote({ id, note }) {
      this.pinMessage = this.commitPins((store) => withNote(store, this.branchId, id, note)) || ''
    },

    // ---- Short-interval checklist ----

    async loadDiagnostic() {
      const key = this.diagnosticKey
      const database = this.database
      const run = ++this.diagnosticRun

      this.diagnostic = Object.freeze({ key, database, inputs: null })

      if (!key || !database) {
        return
      }

      const inputs = await readDiagnostic(database, { GameID: this.GameID, RaceID: this.RaceID, GameTime: this.GameTime, window: this.logWindow || null, archive: this.archiveRecord })

      if (run === this.diagnosticRun) {
        this.diagnostic = Object.freeze({ key, database, inputs })
      }
    },

    // ---- Event archive ----

    // The choice is kept per race and campaign; switching on asks the recorder for a pass on the open save, so what it holds is captured at once. Switching off keeps what was recorded.
    setArchive(on) {
      this.archiveMessage = ''

      try {
        saveArchiveChoice(this.config, this.campaignId, this.RaceID, !!on)
      } catch (error) {
        this.archiveMessage = `The choice could not be saved: ${error.message}`

        return
      }

      this.archiveChoice = !!on

      if (on) {
        this.$store.commit('history/capture')
      } else {
        this.listSource = 'save'
      }
    },

    openRow(row) {
      if (row.group) {
        this.expandedGroups = this.expandedGroups.includes(row.key) ? this.expandedGroups.filter((key) => key !== row.key) : [...this.expandedGroups, row.key]
      } else {
        this.detail = row.event
      }
    },

    eventStyle(event) {
      return {
        backgroundColor: event.AlertColour === null ? undefined : eventColorToRGBA(event.AlertColour),
        color: event.TextColour === null ? undefined : eventColorToRGBA(event.TextColour),
      }
    },

    systemLink(event) {
      return linkTo.map(event.KnownSystemID)
    },

    bodyLink(event) {
      return linkTo.planner({ bodies: [event] })
    },
  },
  asyncComputed: {
    logEvents: {
      get: tracked('logEvents', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        const startYear = this.StartYear
        const [rows] = await this.database.query(`select L.rowid as id, L.IncrementID, L.Time, L.EventType, L.MessageText, L.SystemID, L.PopulationID, L.Xcor, L.Ycor, L.IDType, L.SMOnly, coalesce(T.Description, 'Event type ' || L.EventType) as TypeName, C.EventTypeID is not null as Customized, C.AlertColour, C.TextColour, S.SystemID as KnownSystemID, S.Name as SystemName, P.PopulationID as ColonyID, P.PopName as ColonyName, B.SystemBodyID, B.Name as SystemBodyName, B.BodyClass, B.PlanetNumber, B.OrbitNumber, Star.Component from FCT_GameLog as L left join DIM_EventType as T on T.EventTypeID = L.EventType left join FCT_EventColour as C on C.EventTypeID = L.EventType and C.GameID = L.GameID and C.RaceID = L.RaceID left join FCT_Population as P on P.PopulationID = L.PopulationID and P.GameID = L.GameID and P.RaceID = L.RaceID left join FCT_RaceSysSurvey as S on S.SystemID = case when L.SystemID > 0 then L.SystemID else P.SystemID end and S.GameID = L.GameID and S.RaceID = L.RaceID left join FCT_SystemBody as B on B.SystemBodyID = P.SystemBodyID and B.GameID = L.GameID left join FCT_Star as Star on Star.StarID = B.StarID and Star.GameID = L.GameID where L.GameID = ${this.GameID} and L.RaceID = ${this.RaceID} and coalesce(L.SMOnly, 0) = 0 order by L.Time desc, L.IncrementID desc, L.rowid desc`)
        const dates = new Map()

        const events = rows.map((event) => {
          // Many events share an increment's timestamp. Format that game date once.
          if (!dates.has(event.Time)) {
            dates.set(event.Time, gameTime(startYear, event.Time).format('YYYY-MM-DD HH:mm:ss'))
          }
          const DateTime = dates.get(event.Time)

          return { ...event, DateTime, Day: DateTime.slice(0, 10), Month: DateTime.slice(0, 7), searchText: `${event.MessageText || ''} ${event.TypeName} ${event.SystemName || ''} ${event.ColonyName || ''}`.toLowerCase() }
        })

        // The log's window (the ledger of increments the log spans) goes with the rows, so pins are judged against the rows and the window of one read. A window that cannot be read leaves the pins unread, not the page.
        const logWindow = await readLogWindow(this.database, this.GameID).catch(() => null)

        // Not enumerable, so nothing walks the ledger's thousands of increments.
        Object.defineProperty(events, 'logWindow', { value: logWindow })

        return events
      }),
      default: [],
    },
    // What the archive's rows need named, read only while the list shows the archive.
    archiveNames: {
      async get() {
        if (!this.archiveListed || !this.database || !this.GameID || !this.RaceID) {
          return null
        }

        return readArchiveNames(this.database, this.GameID, this.RaceID, this.archiveRecord).catch(() => null)
      },
      default: null,
    },
  },
}
</script>

<style lang="scss" scoped>
.log-page {
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

  .tool--search,
  .tool--keywords,
  .tool--place {
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

  .panel {
    margin-top: 0;
  }

  .panel-head {
    gap: 8px 20px;
    padding: 10px 16px;
    font-size: inherit;
    line-height: inherit;
  }

  .panel-foot {
    padding: 8px 16px 12px;
    border-top: 1px solid var(--ae-border);
  }

  .date-fields {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    width: min(100%, 550px);

    > * {
      flex: 1 1 150px;
      min-width: 0;
    }
  }

  .events {
    border-top: 1px solid var(--ae-border);
  }

  .event-row {
    height: 84px;
    cursor: pointer;
    border-bottom: 1px solid var(--ae-border);

    &:focus-visible {
      outline: 2px solid var(--ae-primary);
      outline-offset: -2px;
    }
  }

  .event-row--child {
    padding-left: 36px;
  }

  .event-heading {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: calc(13px * var(--ae-font-scale));
  }

  // Vuetify gives every icon a focus wash (an ::after scaled to 130%) that only a link icon ever shows; the hide button has its own. On the icon at the row's end it reaches past the row, so the row's content overflows by two pixels.
  .event-heading .v-icon::after {
    display: none;
  }

  .event-type {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .event-date {
    margin-left: auto;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    font-size: calc(12px * var(--ae-font-scale));
  }

  .repeat-count,
  .pinned-label,
  .new-label {
    white-space: nowrap;
    font-size: calc(12px * var(--ae-font-scale));
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 0 4px;
  }

  .event-message {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    font-size: calc(13px * var(--ae-font-scale));
    line-height: calc(19px * var(--ae-font-scale));
    margin-top: 3px;
    color: inherit;
  }

  .last-look {
    display: flex;
    align-items: center;
    height: 84px;
    padding: 0 16px;
    color: var(--ae-muted);
    border-top: 1px solid var(--ae-border);
    border-bottom: 1px solid var(--ae-border);
  }
}

.event-detail {
  .event-detail-title {
    padding: 16px 24px 8px;
    word-break: normal;
  }

  .event-detail-meta {
    padding: 0 24px 16px;
    margin-top: 0;
  }

  .event-detail-message {
    padding: 16px 24px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .event-detail-actions {
    padding: 12px 16px;
    flex-wrap: wrap;
    gap: 4px;
  }
}
</style>
