<template>
  <v-container fluid class="log-page">
    <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

    <template v-if="ready">
      <div class="toolbar">
        <v-text-field v-model="search" label="Search messages" prepend-inner-icon="mdi-magnify" clearable dense outlined hide-details class="tool tool--search" />
        <v-autocomplete v-model="place" :items="placeOptions" label="System or colony" clearable dense outlined hide-details class="tool tool--place" />
        <v-select :value="selectedTypes" :items="typeOptions" label="Event types" multiple dense outlined hide-details class="tool tool--types" @change="setTypes">
          <template #prepend-item>
            <v-list-item @click="setTypes(null)"><v-list-item-title>All types</v-list-item-title></v-list-item>
            <v-list-item @click="setTypes([])"><v-list-item-title>No types</v-list-item-title></v-list-item>
            <v-divider />
          </template>
          <template #selection="{ index }">
            <span v-if="index === 0" class="v-select__selection v-select__selection--comma">{{ activeTypes === null ? 'All types' : `${selectedTypes.length} types` }}</span>
          </template>
        </v-select>
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
            <v-btn small text class="mt-3" @click="resetFilters">Reset filters</v-btn>
          </v-card>
        </v-menu>
      </div>

      <stat-tiles dense class="my-2" :tiles="tiles" />

      <v-card class="panel mb-3" data-summary="How many events the game log holds for each month, to find busy periods and narrow the list below to one." elevation="1">
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
          Click a month to select it, or click it again to clear the dates. Counts follow the search, place, and types, before the date filter. Dates are game dates, and both ends are included.
          <span v-if="dateFrom && dateTo && dateFrom > dateTo" class="error--text">From is later than Through.</span>
        </div>
      </v-card>

      <v-card class="panel" data-summary="The events in the game log, newest first, to review what happened and read any message in full." elevation="1">
        <div class="panel-head">
          <div class="subtitle-2">Events <span class="caption text--secondary">{{ count(filteredEvents.length) }} of {{ count(logEvents.length) }}</span></div>
          <div class="caption text--secondary">
            {{ collapseRepeats ? `${count(eventRows.length)} rows before expanding repeats` : 'Newest first' }}
            <span v-if="lastSeen === null"> · First visit</span>
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
                  <span class="event-date">{{ row.group ? row.event.Day : row.event.DateTime }}</span>
                  <!-- Vuetify activates a row on Enter, even from a child link; keep link keys on the link. -->
                  <page-link v-if="row.event.KnownSystemID && (!row.group || row.sameSystem)" :to="systemLink(row.event)" :name="row.event.SystemName" />
                  <page-link v-if="row.event.SystemBodyID && (!row.group || row.sameColony)" :to="bodyLink(row.event)" :name="row.event.ColonyName" />
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
        <div v-else class="pa-6 text--secondary">{{ logEvents.length ? 'No events match these filters.' : 'This race has no events in the save.' }}</div>
        <div class="panel-foot caption text--secondary">
          Newest events first. Rows keep this race's custom alert and text colours. Click a message to read it in full; expand a daily repeat to read each message. "New" compares the game's increment with the previous visit to this page.
        </div>
      </v-card>
    </template>

    <v-dialog :value="!!detail" max-width="760" @input="(value) => { if (!value) detail = null }">
      <v-card v-if="detail" class="event-detail">
        <v-card-title class="event-detail-title">{{ detail.TypeName }}<v-spacer /><v-btn icon aria-label="Close event" @click="detail = null"><v-icon>mdi-close</v-icon></v-btn></v-card-title>
        <v-card-subtitle class="event-detail-meta">{{ detail.DateTime }}<span v-if="detail.SystemName"> · {{ detail.SystemName }}</span><span v-if="detail.ColonyName"> · {{ detail.ColonyName }}</span></v-card-subtitle>
        <v-card-text class="event-detail-message" :style="eventStyle(detail)">{{ detail.MessageText }}</v-card-text>
        <v-card-actions class="event-detail-actions">
          <v-btn v-if="detail.KnownSystemID" text :to="systemLink(detail)">Galaxy Map</v-btn>
          <v-btn v-if="detail.SystemBodyID" text :to="bodyLink(detail)">Colonization Planner</v-btn>
          <v-btn text @click="hideType(detail)">Hide event type</v-btn>
          <v-spacer />
          <v-btn text @click="detail = null">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script>
import { mapGetters } from 'vuex'

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
import { eventColorToRGBA, gameTime } from '../utilities/aurora'
import { linkTo, queryId } from '../utilities/deep-links'
import { tracked } from '../utilities/load-tracking'

const INPUT_LABELS = { logEvents: 'the game log' }

export default {
  components: { ChartCanvas, LoadState, PageLink, StatTiles, WindowVirtualScroll },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    persistedView({
      search: { key: 'logSearch', default: '', scope: 'race', normalise: (stored) => stored || '' },
      place: { key: 'logPlace', default: null, scope: 'race', normalise: (stored) => stored || null },
      activeTypes: { key: 'logTypes', default: null, scope: 'race', normalise: (stored) => (Array.isArray(stored) ? stored : null) },
      dateFrom: { key: 'logDateFrom', default: '', scope: 'race', normalise: (stored) => stored || '' },
      dateTo: { key: 'logDateTo', default: '', scope: 'race', normalise: (stored) => stored || '' },
      collapseRepeats: { key: 'logCollapseRepeats', default: true, normalise: (stored) => stored !== false },
      hideNonCustomized: { key: 'logOnlyCustomized', default: false, normalise: (stored) => !!stored },
    }),
  ],
  data() {
    return {
      lastSeen: null,
      expandedGroups: [],
      detail: null,
      eventIcons: {
        0: 'mdi-help-circle-outline', // No Event Type
        1: 'mdi-factory', // Production
        2: 'mdi-ferry', // Ship Construction
        3: 'mdi-wrench', // Ship Repair
        4: 'mdi-swap-horizontal', // Ship Refit
        7: 'mdi-delete', // Ship Scrapped
        9: 'mdi-shield-account', // Unit Trained
        10: 'mdi-account-cog', // Commander Update
        11: 'mdi-shield', // Shield Recharge
        12: 'mdi-crosshairs', // Targeting
        14: 'mdi-crosshairs-question', // Targeting Problem
        15: 'mdi-rocket', // Missile Launch
        16: 'mdi-ammunition', // Out of Ammo
        17: 'mdi-rocket-outline', // No Missile Assigned
        18: 'mdi-timer-sand', // Weapon Reloading
        19: 'mdi-bullseye-arrow', // Chance To Hit
        20: 'mdi-bullseye', // Target Hit
        21: 'mdi-crosshairs-off', // Target Missed
        22: 'mdi-flash-outline', // Weapon Recharging
        25: 'mdi-check-circle', // System Intact
        26: 'mdi-bomb', // Secondary Explosion
        27: 'mdi-sail-boat-sink', // Ship Destroyed
        28: 'mdi-file-document-alert', // Damage Report
        35: 'mdi-account-star', // Team Skill
        37: 'mdi-radar', // System Surveyed
        41: 'mdi-clipboard-text', // Orders Assigned
        42: 'mdi-clipboard-alert', // Orders Not Possible
        43: 'mdi-diamond-stone', // Minerals Located
        44: 'mdi-domain', // Ruins Located
        45: 'mdi-clipboard-check', // Orders Completed
        46: 'mdi-gas-station-off', // Insufficient Fuel
        52: 'mdi-eye-off', // Target Lost
        53: 'mdi-rocket-launch-outline', // Missiles Lost
        54: 'mdi-transit-transfer', // Transit Failure
        55: 'mdi-message-processing', // Communication
        57: 'mdi-domain', // Ruins Exploited
        58: 'mdi-cog-off', // No Spare Parts
        59: 'mdi-wrench-check', // Successful Repair
        60: 'mdi-flask', // Research Completed
        63: 'mdi-flask-empty-remove', // Inactive Lab
        64: 'mdi-alert-decagram', // Mineral Shortage
        65: 'mdi-fuel', // Low Fuel
        66: 'mdi-diamond-outline', // Mineral Exhausted
        71: 'mdi-gas-station-off-outline', // Fuel Exhausted
        75: 'mdi-shield-sword', // Ground Combat Update
        76: 'mdi-weather-windy', // Gas Removed
        77: 'mdi-leaf', // Terraforming Report
        80: 'mdi-barrel', // Harvester Capacity
        81: 'mdi-snowflake-melt', // Ice Sheet Melted
        82: 'mdi-emoticon-happy-outline', // Morale Increase
        83: 'mdi-archive-arrow-down-outline', // Pickup Failed
        87: 'mdi-bridge', // Jump Gate Underway
        88: 'mdi-flask-plus', // Research Started
        90: 'mdi-account-arrow-up', // Commander Promoted
        91: 'mdi-ray-start-end', // Conditional Order
        92: 'mdi-timer-off', // Life Pod Expired
        93: 'mdi-magnify-scan', // Search and Rescue
        97: 'mdi-chip', // System Damaged
        98: 'mdi-account-plus', // New Naval Officer
        99: 'mdi-heart-pulse', // Commander Health
        100: 'mdi-mine', // Mine Restored
        101: 'mdi-factory', // Factory Restored
        106: 'mdi-account-search', // Intelligence Update
        107: 'mdi-email', // Fleet Message
        108: 'mdi-robot-dead', // Wreck Salvaged
        111: 'mdi-cog-outline', // Components Scrapped
        115: 'mdi-home-city', // Pop Status Change
        116: 'mdi-vector-polyline-remove', // Insufficient JGC
        117: 'mdi-dots-horizontal', // Message Continued
        119: 'mdi-timer-outline', // Fire Delay
        122: 'mdi-cog-stop', // Overhaul Complete
        125: 'mdi-crane', // Shipyard Modified
        127: 'mdi-download-network', // Tech Downloaded
        128: 'mdi-magnify-scan', // Tech Data Scanned
        129: 'mdi-account-tie', // Command Assignment
        133: 'mdi-office-building', // Civilian Construction
        135: 'mdi-gas-station-off', // Fuel Shortage
        138: 'mdi-vector-link', // Jump Point Detected
        139: 'mdi-domain', // Civilian Activity
        140: 'mdi-block-helper', // Illegal Order
        141: 'mdi-diamond-stone', // New Mineral Deposit
        142: 'mdi-trending-up', // Accessibility Increase
        143: 'mdi-radar', // Geo Survey Complete
        145: 'mdi-tools', // No Freighter Overhaul
        146: 'mdi-wrench-cog', // Maintenance Problem
        147: 'mdi-alien', // New Alien Race
        148: 'mdi-emoticon-angry-outline', // Unrest Increasing
        149: 'mdi-emoticon-happy-outline', // Unrest Decreasing
        155: 'mdi-emoticon-happy-outline', // Morale Increase
        157: 'mdi-incognito', // Successful Espionage
        169: 'mdi-tune', // Increment Adjustment
        173: 'mdi-hand-coin', // Reparations
        174: 'mdi-sack', // Planet Looted
        177: 'mdi-alert-octagram', // Overkill
        178: 'mdi-handshake', // Ship Surrender
        179: 'mdi-earth', // Breathable Atmosphere
        180: 'mdi-handshake-outline', // Diplomacy
        181: 'mdi-target-account', // New Hostile Contact
        182: 'mdi-account-question', // New Neutral Contact
        183: 'mdi-account', // New Friendly Contact
        184: 'mdi-account-multiple', // New Allied Contact
        186: 'mdi-ferry', // Wreck Contact
        187: 'mdi-package-variant-closed', // Mineral Packet Contact
        191: 'mdi-ferry', // Civilian Contact
        195: 'mdi-earth-plus', // New System Discovered
        200: 'mdi-flare', // Missile Self-destruct
        201: 'mdi-timer-minus', // Overhaul Clock Reduced
        203: 'mdi-thermometer-off', // Thermal Contact Lost
        204: 'mdi-access-point-off', // GPD Contact Lost
        206: 'mdi-target-account', // Hostile Contact Update
        207: 'mdi-account-question', // Neutral Contact Update
        208: 'mdi-account', // Friendly Contact Update
        209: 'mdi-account-multiple', // Allied Contact Update
        210: 'mdi-ferry', // Civilian Contact Update
        211: 'mdi-mine', // Civilian Mining Colony
        212: 'mdi-ferry', // New Shipping Line
        215: 'mdi-star-circle', // Outstanding New Officer
        216: 'mdi-star', // Exceptional New Officer
        217: 'mdi-star-outline', // Promising New Officer
        218: 'mdi-file-chart', // Geological Survey Data
        219: 'mdi-arm-flex', // Boarding Attempt
        220: 'mdi-sword-cross', // Boarding Combat
        221: 'mdi-account-remove', // Crew Losses
        224: 'mdi-cog', // Wreck Components
        227: 'mdi-car-arrow-right', // Ramming Attempt
        228: 'mdi-cash-remove', // Empire in Debt
        229: 'mdi-flask-minus', // Overallocation of Labs
        232: 'mdi-radar', // New Alien Class
        233: 'mdi-rocket', // New Alien Ship
        235: 'mdi-account-star', // Crew Grade Increase
        237: 'mdi-shield-off', // Shield Deactivation
        238: 'mdi-file-document', // Tech Data Learned
        245: 'mdi-magnet', // Tractor(s) Released
        252: 'mdi-emoticon-sad-outline', // Crew Morale Falling
        253: 'mdi-beach', // Shore Leave Complete
        254: 'mdi-air-humidifier-off', // Life Support Failure
        255: 'mdi-gas-station-off', // Probe Out of Fuel
        256: 'mdi-account-tie', // New Administrator
        257: 'mdi-account', // New Scientist
        258: 'mdi-handcuffs', // POWs Rescued
        260: 'mdi-alpha-a-box', // Ancient Construct
        265: 'mdi-clock-outline', // Time Check
        266: 'mdi-truck-fast-outline', // Invalid Unload System
        276: 'mdi-progress-close', // Conversion Halted
        277: 'mdi-lifebuoy', // Lifepods Launched
        278: 'mdi-run-fast', // Crew Escape
        279: 'mdi-account-group-outline', // Insufficient Population
        280: 'mdi-star-four-points', // Commander Experience
        281: 'mdi-trash-can', // Replacement Unit Disbanded
        282: 'mdi-restore-alert', // Recovery Failure
        283: 'mdi-account-group', // Ship Overcrowded
        284: 'mdi-terrain', // Change to Dominant Terrain
        285: 'mdi-crosshairs', // New Combat Contact
        286: 'mdi-account-cog', // Admin Command Update
        287: 'mdi-book-off', // Training Task Abandoned
        288: 'mdi-home-search', // Ground Survey Potential
        289: 'mdi-account-tie', // Senior Officer Required
        290: 'mdi-school', // Maximum Fleet Training
        291: 'mdi-account-plus', // New Ground Force Officer
        292: 'mdi-account-cancel', // Retirement
        293: 'mdi-earth', // New Alien Population
        294: 'mdi-beaker-alert', // Acid Burn
        295: 'mdi-ship-wheel', // Intact Ship Salvaged
        296: 'mdi-medal', // Medal Awarded
        297: 'mdi-sword-cross', // Boarding Underway
        298: 'mdi-account-group', // New Alien Ground Unit
        299: 'mdi-lightbulb-on', // Breakthrough Achieved
        300: 'mdi-crosshairs', // Ground Attack Summary
        301: 'mdi-file-document-multiple', // Element Loss Summary
        302: 'mdi-file-document-multiple', // Attack vs GUC Summary
        303: 'mdi-shield-home', // Ground Defence Summary
        304: 'mdi-file-document', // Element vs GUC Report
        305: 'mdi-file-document', // Ship vs GUC Report
        306: 'mdi-file-document-multiple', // GUC vs GUC Summary
        307: 'mdi-file-document-multiple', // Formation Attack Summary
        308: 'mdi-file-document-multiple', // Formation Loss Summary
        309: 'mdi-file-document-multiple', // Orbital vs GUC Summary
        310: 'mdi-swap-horizontal', // Orbital Support Reassigned
        311: 'mdi-swap-horizontal', // Ground Support Reassigned
        312: 'mdi-domain', // Installations Salvaged
        313: 'mdi-target-variant', // Target Out of Range
        314: 'mdi-eye', // Ground Combat Intelligence
        315: 'mdi-translate', // Alien Communication
        316: 'mdi-snowflake', // Ice Sheet Frozen
        317: 'mdi-progress-close', // Shipyard Task Abandoned
        318: 'mdi-book-off', // Training not Possible
        319: 'mdi-airplane', // Fighter Construction
        320: 'mdi-factory', // Production Started
        321: 'mdi-timer-alert', // Deployment Time Exceeded
        322: 'mdi-account-off', // Commander Unassigned
        323: 'mdi-school', // Formation Training Task
        324: 'mdi-nuke', // Planet Destroyed
        325: 'mdi-account-reactivate', // Commander Restored
        326: 'mdi-bomb-off', // Incorrect Ordnance
        327: 'mdi-swap-vertical', // Fleet Transfer
        328: 'mdi-domain-off', // Installation Scrapped
        329: 'mdi-shield-off', // Ground Units Scrapped
        330: 'mdi-shield-sun-outline', // Orbital Support Summary
        331: 'mdi-shield-sun', // Energy Point Defence
        332: 'mdi-shield-home-outline', // STO Point Defence
        333: 'mdi-shield-airplane-outline', // AMM Point Defence
        334: 'mdi-ship-wheel', // Ship Combat - Energy
        335: 'mdi-rocket', // Ship Combat - Missile
        336: 'mdi-shield-home', // STO Combat
        337: 'mdi-bullseye', // Missile vs Ship
        338: 'mdi-crosshairs', // Attacked by STO
        339: 'mdi-flash', // Attacked By Energy Weapons
        340: 'mdi-rocket', // Attacked By Missiles
        341: 'mdi-shield', // Attacked By AA Fire
        342: 'mdi-sword-cross', // Boarding Damage
        343: 'mdi-beaker-alert', // Acid Damage
        344: 'mdi-home-alert', // Collaterall Damage
        345: 'mdi-file-document-alert', // Damage Summary
        346: 'mdi-shield-airplane', // Fighter Point Defence
        347: 'mdi-airplane', // Fighter Combat - Energy
        348: 'mdi-airplane', // Fighter Combat - Missile
        349: 'mdi-shield-check', // Fleet PD Summary
        350: 'mdi-ferry', // Civilian Ship Scrapped
        351: 'mdi-hammer-wrench', // Damage Control
        352: 'mdi-bomb', // Bombardment Summary
        353: 'mdi-timer-sand-paused', // Transit Delay
        354: 'mdi-shield-home', // Population PD Summary
        355: 'mdi-dots-horizontal', // (unused)
        356: 'mdi-ferry', // New Wreck Detected
        357: 'mdi-robot-dead', // Alien Salvage
        358: 'mdi-test-tube', // Test Data
        359: 'mdi-archive-arrow-down', // Ground Unit Unloaded
        360: 'mdi-warehouse', // Stockpile Warning
        361: 'mdi-cog-off', // Maintenance Failure
        362: 'mdi-account-question', // Neutral Contact Update - AC
        363: 'mdi-account', // Friendly Contact Update - AC
        364: 'mdi-account-multiple', // Allied Contact Update - AC
        365: 'mdi-car-arrow-right', // Successful Ramming Attack
        366: 'mdi-car-arrow-left', // Ship Rammed
        367: 'mdi-account-search', // Interrogation Update
      },
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'StartYear']),

    contextKey() {
      return this.GameID && this.RaceID ? `game.${this.GameID}.race.${this.RaceID}` : null
    },

    ready() {
      return !!this.database && !!this.contextKey && this.inputsLoaded
    },

    theme() {
      return chartTheme(this.$vuetify.theme.dark)
    },

    activeOptionCount() {
      return Number(!this.collapseRepeats) + Number(this.hideNonCustomized)
    },

    placeOptions() {
      const places = new Map()

      this.logEvents.forEach((event) => {
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

      return this.logEvents.filter((event) => (!search || event.searchText.includes(search)) && (!this.place || this.place === `system-${event.KnownSystemID}` || this.place === `colony-${event.ColonyID}`) && (!this.hideNonCustomized || event.Customized))
    },

    typeOptions() {
      const types = new Map()
      const counts = new Map()

      this.logEvents.forEach((event) => types.set(event.EventType, event.TypeName))
      this.baseEvents.filter(this.inDateRange).forEach((event) => counts.set(event.EventType, (counts.get(event.EventType) || 0) + 1))

      return [...types].map(([value, name]) => ({ value, text: `${name} (${this.count(counts.get(value) || 0)})` })).sort((a, b) => a.text.localeCompare(b.text))
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

    latestIncrement() {
      return this.logEvents.reduce((latest, event) => Math.max(latest, event.IncrementID), 0)
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
      const typeName = type ? this.logEvents.find((event) => event.EventType === type[0]).TypeName : '—'

      return [
        { label: 'Events in range', value: this.count(this.filteredEvents.length), note: `of ${this.count(this.logEvents.length)} in this race's log` },
        { label: 'Busiest type', value: typeName, note: type ? `${this.count(type[1])} events in this view` : 'No events in this view' },
        { label: 'Busiest month', value: month ? month[0] : '—', note: month ? `${this.count(month[1])} events in this view` : 'No events in this view' },
        { label: 'New since last look', value: this.lastSeen === null ? '—' : this.count(this.newCount), note: this.lastSeen === null ? 'This visit starts the record' : 'Events in this view after the previous visit' },
      ]
    },

    timeline() {
      if (!this.logEvents.length) {
        return []
      }

      const counts = new Map()
      this.timelineEvents.forEach((event) => counts.set(event.Month, (counts.get(event.Month) || 0) + 1))
      let at = gameTime(this.StartYear, this.logEvents[this.logEvents.length - 1].Time).startOf('month')
      const end = this.logEvents[0].Month
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
        this.expandedGroups = []
        this.detail = null
        if (!prefix) {
          return
        }
        this.lastSeen = this.config.get(`${prefix}.logLastSeen`, null)
      },
    },
    ready(value) {
      if (value) {
        this.markVisit()
      }
    },
    latestIncrement() {
      if (this.ready) {
        this.markVisit()
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
      this.place = null
      this.activeTypes = null
      this.dateFrom = ''
      this.dateTo = ''
      this.collapseRepeats = true
      this.hideNonCustomized = false
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
      return this.lastSeen !== null && event.IncrementID > this.lastSeen
    },

    markVisit() {
      // Keep the previous visit fixed on screen; only the next visit reads the new watermark. It is this save's latest event, not the highest ever seen, so an earlier save of the same game starts counting from where it stands.
      this.config.set(`${this.contextKey}.logLastSeen`, this.latestIncrement)
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
        const [rows] = await this.database.query(`select L.rowid as id, L.IncrementID, L.Time, L.EventType, L.MessageText, coalesce(T.Description, 'Event type ' || L.EventType) as TypeName, C.EventTypeID is not null as Customized, C.AlertColour, C.TextColour, S.SystemID as KnownSystemID, S.Name as SystemName, P.PopulationID as ColonyID, P.PopName as ColonyName, B.SystemBodyID, B.Name as SystemBodyName, B.BodyClass, B.PlanetNumber, B.OrbitNumber, Star.Component from FCT_GameLog as L left join DIM_EventType as T on T.EventTypeID = L.EventType left join FCT_EventColour as C on C.EventTypeID = L.EventType and C.GameID = L.GameID and C.RaceID = L.RaceID left join FCT_Population as P on P.PopulationID = L.PopulationID and P.GameID = L.GameID and P.RaceID = L.RaceID left join FCT_RaceSysSurvey as S on S.SystemID = case when L.SystemID > 0 then L.SystemID else P.SystemID end and S.GameID = L.GameID and S.RaceID = L.RaceID left join FCT_SystemBody as B on B.SystemBodyID = P.SystemBodyID and B.GameID = L.GameID left join FCT_Star as Star on Star.StarID = B.StarID and Star.GameID = L.GameID where L.GameID = ${this.GameID} and L.RaceID = ${this.RaceID} order by L.Time desc, L.IncrementID desc, L.rowid desc`)
        const dates = new Map()

        return rows.map((event) => {
          // Many events share an increment's timestamp. Format that game date once.
          if (!dates.has(event.Time)) {
            dates.set(event.Time, gameTime(startYear, event.Time).format('YYYY-MM-DD HH:mm:ss'))
          }
          const DateTime = dates.get(event.Time)

          return { ...event, DateTime, Day: DateTime.slice(0, 10), Month: DateTime.slice(0, 7), searchText: `${event.MessageText || ''} ${event.TypeName} ${event.SystemName || ''} ${event.ColonyName || ''}`.toLowerCase() }
        })
      }),
      default: [],
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
    font-size: 13px;
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
    font-size: 12px;
  }

  .repeat-count,
  .new-label {
    white-space: nowrap;
    font-size: 12px;
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 0 4px;
  }

  .event-message {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    font-size: 13px;
    line-height: 19px;
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
