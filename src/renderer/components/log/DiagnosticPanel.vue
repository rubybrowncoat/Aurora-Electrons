<template>
  <v-card class="panel diagnostic" data-diagnostic data-summary="Fire and boarding events in the game log for a recent stretch of game time." elevation="1" :data-state="diagnosis ? diagnosis.state : null" :data-verdict="diagnosis ? diagnosis.verdict : null">
    <div class="panel-head">
      <div class="subtitle-2">Short-interval checklist<provenance-mark v-if="diagnosis" :result="diagnosis.results.events" label /></div>
      <v-select :value="seconds" :items="windows" item-text="text" item-value="seconds" label="Window" dense outlined hide-details class="diagnostic-window" data-diagnostic-window @change="(value) => $emit('window', value)" />
    </div>

    <div v-if="pending" class="pa-4 text--secondary" data-diagnostic-pending role="status">Reading the log for this race.</div>
    <div v-else-if="!diagnosis" class="pa-4 text--secondary" data-diagnostic-none role="status">No window can be placed: the open save gives no game time.</div>
    <div v-else class="diagnostic-body">
      <div class="diagnostic-window-line" data-window-line>
        <span data-window-range><span data-window-from>{{ date(diagnosis.window.from) }}</span> to <span data-window-to>{{ date(diagnosis.window.to) }}</span></span>
        <span class="diagnostic-state" :class="`diagnostic-state--${diagnosis.state}`" data-window-state>{{ stateText[diagnosis.state] }}</span>
      </div>
      <ul v-if="diagnosis.reasons.length" class="diagnostic-list" data-reasons>
        <li v-for="reason in diagnosis.reasons" :key="reason" :data-reason="reason">{{ reasonText[reason] }}</li>
      </ul>
      <div v-if="diagnosis.failed" class="caption text--secondary" data-read-failed>The read of the log failed: {{ diagnosis.failed }}</div>

      <div class="diagnostic-verdict" data-verdict-text>
        <span v-if="diagnosis.verdict === 'found'" data-verdict-shown="found"><span data-verdict-count>{{ count(diagnosis.observed) }}</span> <span data-verdict-words>{{ verdictText.found[diagnosis.observed === 1 ? 'one' : 'many'] }}</span></span>
        <span v-else-if="diagnosis.verdict === 'absent'" data-verdict-shown="absent"><span data-verdict-words>{{ verdictText.absent }}</span></span>
        <span v-else data-verdict-shown="unavailable"><span data-verdict-words>{{ verdictText.unavailable }}</span></span>
      </div>

      <div class="diagnostic-section">
        <div class="subtitle-2">Event types watched</div>
        <ul class="diagnostic-types">
          <li v-for="entry in diagnosis.types" :key="entry.type" :data-type="entry.type" :data-count="diagnosis.verdict === 'unavailable' ? null : entry.count">
            <v-icon small class="mr-1">{{ entry.icon }}</v-icon>
            <span class="diagnostic-name">{{ entry.name }}</span>
            <span class="diagnostic-chip">{{ groups[entry.group] }}</span>
            <span class="diagnostic-count"><span v-if="diagnosis.verdict === 'unavailable'" data-count-unknown>{{ countText.unknown }}</span><span v-else-if="entry.count"><span data-count-value>{{ count(entry.count) }}</span> observed, newest <span data-newest-date>{{ date(entry.newest) }}</span></span><span v-else data-count-none>{{ countText.none }}</span></span>
            <span v-if="entry.hidden" class="diagnostic-chip" data-hidden>{{ markText.hidden }}</span>
            <span v-if="entry.listed === false" class="diagnostic-chip" data-unlisted>{{ markText.unlisted }}</span>
          </li>
        </ul>
      </div>

      <div v-if="diagnosis.observations.length" class="diagnostic-section">
        <div class="subtitle-2">Observed events <span class="caption text--secondary">newest {{ count(shown.length) }} of {{ count(diagnosis.observations.length) }} groups</span></div>
        <ul class="diagnostic-events">
          <li v-for="observation in shown" :key="observation.key" data-observation :data-key="observation.key" :data-type="observation.type" :data-state="observation.state" :data-copies="observation.copies">
            <div class="diagnostic-event-head">
              <v-icon small class="mr-1">{{ iconOf(observation.type) }}</v-icon>
              <span class="diagnostic-name">{{ nameOf(observation.type) }}</span>
              <span v-if="observation.copies > 1" class="diagnostic-chip" data-event-copies><span data-copies-value>{{ count(observation.copies) }}</span> identical events</span>
              <span class="diagnostic-date" data-event-date>{{ date(observation.time) }}</span>
              <span class="diagnostic-source">Increment <span data-event-increment>{{ observation.increment[0] }}</span></span>
              <span class="diagnostic-state" :class="`diagnostic-state--${observation.state}`" data-event-state>{{ stateText[observation.state] }}</span>
            </div>
            <div class="diagnostic-message">{{ observation.message }}</div>
          </li>
        </ul>
      </div>

      <div class="diagnostic-section">
        <div class="subtitle-2">Inputs</div>
        <ul class="diagnostic-list" data-inputs>
          <li v-for="input in inputs" :key="input.id" :data-input="input.id" :data-status="input.result.status">
            <span class="diagnostic-name">{{ input.label }}</span><provenance-mark :result="input.result" label />
            <span v-if="input.result.inputs.missing.length" class="caption text--secondary"> Not read: {{ input.result.inputs.missing.join('; ') }}.</span>
          </li>
        </ul>
      </div>
    </div>

    <div class="diagnostic-section diagnostic-pointers" data-pointers>
      <div class="subtitle-2">Manual checks in the game</div>
      <ul class="diagnostic-list">
        <li v-for="entry in pointers" :key="entry.id" :data-pointer="entry.id">
          <span class="diagnostic-name" data-pointer-name>{{ entry.term }}</span>
          <span class="caption text--secondary" data-pointer-version> Reviewed {{ entry.reviewed }}</span>
          <div data-pointer-definition>{{ entry.definition }}</div>
        </li>
      </ul>
    </div>

    <div class="panel-foot caption text--secondary">
      The panel lists evidence and never names a cause: the events the game log holds, how far the log covers the window, and the checks the game itself offers for a stalled short interval. The window ends at the newest increment of the open save. A state of partial means the window meets a gap, an increment that may still change, or a failed read. The events listed are those observed, and others may exist. An event carries the state of its own increment. A cause of a stall stays unknown unless the player records one.
    </div>
  </v-card>
</template>

<script>
import ProvenanceMark from '../page/ProvenanceMark.vue'
import countFormat from '../../mixins/count-format'
import { COUNT_TEXT, GROUPS, LISTED, MARK_TEXT, POINTER_TERMS, REASON_TEXT, STATE_TEXT, VERDICT_TEXT, WATCHED, WINDOWS } from '../../utilities/log-diagnostics'
import { termById } from '../../utilities/glossary'
import { gameDateText } from '../../utilities/history-milestones'

const INPUT_LABELS = { events: 'Race game log', hidden: 'Event types hidden in the game', types: 'Event table of the save', fleet: 'Ships, fleets and boarding parties' }

// The Short-interval checklist of the Game Log (utilities/log-diagnostics.js): `diagnosis` is the checklist for the open save's race, or null when none can be placed; `pending` is true while it has not been read for the race and save now open; `seconds` is the window chosen. It emits `window` with the seconds picked.
export default {
  components: { ProvenanceMark },
  mixins: [countFormat],
  props: {
    diagnosis: { type: Object, default: null },
    pending: { type: Boolean, default: false },
    seconds: { type: Number, required: true },
    startYear: { type: Number, required: true },
  },
  data() {
    return { windows: WINDOWS, groups: GROUPS, stateText: STATE_TEXT, reasonText: REASON_TEXT, verdictText: VERDICT_TEXT, countText: COUNT_TEXT, markText: MARK_TEXT }
  },
  computed: {
    shown() {
      return this.diagnosis ? this.diagnosis.observations.slice(0, LISTED) : []
    },

    inputs() {
      return this.diagnosis ? Object.keys(INPUT_LABELS).map((id) => ({ id, label: INPUT_LABELS[id], result: this.diagnosis.results[id] })) : []
    },

    pointers() {
      return POINTER_TERMS.map((id) => termById[id]).filter(Boolean)
    },
  },
  methods: {
    date(seconds) {
      return gameDateText(this.startYear, seconds)
    },

    nameOf(type) {
      const entry = WATCHED.find((item) => item.type === type)

      return entry ? entry.name : `Event type ${type}`
    },

    iconOf(type) {
      const entry = WATCHED.find((item) => item.type === type)

      return entry ? entry.icon : 'mdi-text-box-outline'
    },
  },
}
</script>

<style lang="scss" scoped>
.diagnostic {
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

  .diagnostic-window {
    max-width: 220px;
    flex: 0 1 220px;
  }

  .diagnostic-body {
    border-top: 1px solid var(--ae-border);
    padding: 12px 16px;
  }

  .diagnostic-window-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    font-variant-numeric: tabular-nums;
  }

  .diagnostic-state {
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 0 6px;
    font-size: calc(12px * var(--ae-font-scale));
    white-space: nowrap;
  }

  .diagnostic-verdict {
    margin-top: 10px;
  }

  .diagnostic-section {
    margin-top: 14px;
  }

  .diagnostic-pointers {
    margin: 0;
    padding: 12px 16px;
    border-top: 1px solid var(--ae-border);
  }

  .diagnostic-list,
  .diagnostic-types,
  .diagnostic-events {
    margin: 4px 0 0;
    padding-left: 20px;
    font-size: calc(13px * var(--ae-font-scale));
  }

  .diagnostic-types {
    list-style: none;
    padding-left: 0;
  }

  .diagnostic-types li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 8px;
    padding: 2px 0;
  }

  .diagnostic-events {
    max-height: 360px;
    overflow-y: auto;
    list-style: none;
    padding-left: 0;
  }

  .diagnostic-events li {
    padding: 6px 0;
    border-bottom: 1px solid var(--ae-border);
  }

  .diagnostic-event-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 8px;
  }

  .diagnostic-name {
    font-weight: 500;
  }

  .diagnostic-chip {
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 0 6px;
    font-size: calc(12px * var(--ae-font-scale));
    white-space: nowrap;
  }

  .diagnostic-date,
  .diagnostic-source {
    font-variant-numeric: tabular-nums;
  }

  .diagnostic-message {
    overflow-wrap: anywhere;
  }
}
</style>
