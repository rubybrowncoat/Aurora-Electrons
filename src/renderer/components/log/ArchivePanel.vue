<template>
  <v-card class="panel archive" data-summary="The observed record of the race's game log on this branch." elevation="1">
    <div class="panel-head">
      <div class="subtitle-2">Event archive</div>
      <div class="list-source">
        <span class="caption text--secondary mr-2">List</span>
        <v-btn-toggle :value="source" mandatory dense color="primary" aria-label="Events listed from" @change="(value) => $emit('source', value)">
          <v-btn small value="save">This save</v-btn>
          <v-btn small value="archive" :disabled="!record">Archive</v-btn>
        </v-btn-toggle>
      </div>
    </div>

    <div v-if="status === 'unavailable'" class="pa-4 text--secondary" role="status">The archive is unavailable: {{ reason }}. Nothing is written to it until it can be read.</div>
    <div v-else-if="!record" class="pa-4 text--secondary">Nothing is recorded for this race on this branch yet. The open save is recorded when the app next reads it.</div>
    <div v-else class="archive-body">
      <div class="archive-tiles">
        <div class="archive-tile"><div class="caption text--secondary">Events kept</div><div class="archive-value">{{ count(kept) }} <span class="caption text--secondary">of {{ count(cap) }}</span></div><div class="caption text--secondary">About {{ size }} as stored (an estimate)</div><div v-if="hidden" class="caption text--secondary">{{ count(hidden) }} game-master-only {{ hidden === 1 ? 'event is' : 'events are' }} kept and not listed</div></div>
        <div class="archive-tile"><div class="caption text--secondary">Observed</div><div class="archive-value">{{ spans.length ? `${count(spans.length)} span${spans.length === 1 ? '' : 's'}` : 'Nothing' }}</div><div class="caption text--secondary">{{ observedNote }}</div></div>
        <div class="archive-tile"><div class="caption text--secondary">Conflicts</div><div class="archive-value">{{ count(shownConflicts.length) }}</div><div class="caption text--secondary">{{ shownConflicts.length ? 'Kept, never deleted' : 'No later save contradicted a kept event' }}</div><div v-if="hiddenConflicts" class="caption text--secondary">{{ count(hiddenConflicts) }} more concern game-master-only events and are not listed</div></div>
        <div v-if="cutTile" class="archive-tile"><div class="caption text--secondary">{{ cutTile.title }}</div><div class="archive-value">{{ cutTile.date }}</div><div class="caption text--secondary">{{ cutTile.detail }}</div></div>
      </div>

      <div class="archive-section">
        <div class="subtitle-2">Observed spans</div>
        <ul v-if="spans.length" class="archive-list">
          <li v-for="(span, index) in spans" :key="`span-${index}`">{{ date(span[0]) }} to {{ date(span[1]) }}</li>
        </ul>
        <div v-else class="text--secondary">No span was observed.</div>
      </div>

      <div class="archive-section">
        <div class="subtitle-2">Gaps</div>
        <ul v-if="gaps.length" class="archive-list">
          <li v-for="(gap, index) in gaps" :key="`gap-${index}`">{{ gap.from === null ? `Before ${date(gap.to)}` : `${date(gap.from)} to ${date(gap.to)}` }}: not observed <span class="text--secondary">(unknown, not zero events)</span></li>
        </ul>
        <div v-else class="text--secondary">No gap between the observed spans. Before the first span nothing is known.</div>
      </div>

      <div v-if="shownConflicts.length" class="archive-section">
        <div class="subtitle-2">Conflicts <span class="caption text--secondary">newest {{ conflicts.length }} of {{ count(shownConflicts.length) }}</span></div>
        <ul class="archive-list">
          <li v-for="(conflict, index) in conflicts" :key="`conflict-${index}`">{{ date(conflict.increment[1] + conflict.increment[2]) }}: {{ reasonText(conflict) }}<span v-if="conflict.group" class="archive-quote"> “{{ conflict.group[2] }}”</span></li>
        </ul>
      </div>

      <div v-if="failures.length" class="archive-section">
        <div class="subtitle-2">Failed captures <span class="caption text--secondary">newest {{ failures.length }} of {{ count(record.failures.length) }}</span></div>
        <ul class="archive-list">
          <li v-for="(failure, index) in failures" :key="`failure-${index}`">{{ date(failure.t) }}: the read failed, so nothing was observed <span class="text--secondary">({{ failure.reason }}, recorded {{ recorded(failure.at) }})</span></li>
        </ul>
      </div>

      <div class="archive-section">
        <div class="subtitle-2">Last captures</div>
        <ul v-if="captures.length" class="archive-list">
          <li v-for="capture in captures" :key="`capture-${capture.revision}`">{{ date(capture.t) }}: {{ count(capture.rows) }} events read, {{ count(capture.added) }} added, {{ count(capture.amended) }} amended <span class="text--secondary">(revision {{ capture.revision }}, recorded {{ recorded(capture.at) }})</span></li>
        </ul>
        <div v-else class="text--secondary">No capture added an event yet.</div>
      </div>
    </div>

    <div class="panel-foot caption text--secondary">
      The archive holds the events observed, the game dates observed and the stretches nobody observed, and the list can show it in place of the open save's log. Each branch keeps its own archive, seeded from its parent up to the fork and never merged afterwards. A save holds only a moving window of the log, so what falls outside the observed spans is unknown, and an empty stretch inside a span is an observed stretch without events. When the list shows the archive, the pinned and new marks follow the same rules, and a pin is still compared with the open save.
    </div>
  </v-card>
</template>

<script>
import countFormat from '../../mixins/count-format'
import { eventEstimate, gapsOf, recordEvents } from '../../utilities/event-archive'
import { bytesText } from '../../utilities/history'
import { gameDateText } from '../../utilities/history-milestones'
import { gameMasterCount, playerConflicts } from '../../utilities/log-archive-view'
import { failureWords } from '../../utilities/provenance'

const REASONS = {
  ledger: 'the save names another increment with this number (another timeline)',
  more: 'the save holds more identical events than were kept',
  fewer: 'the save holds fewer identical events than were kept',
  missing: 'the save covers the time and no longer holds a kept event',
}

const SHOWN = 20

// The Event archive panel of the Game Log (utilities/event-archive.js): what the branch's archive holds for the race. `status` is 'ok' or 'unavailable' (with `reason`), `record` the race's record or null, `cap` the events kept at most, `source` which list the page shows ('save' or 'archive').
export default {
  mixins: [countFormat],
  props: {
    status: { type: String, required: true },
    reason: { type: String, default: '' },
    record: { type: Object, default: null },
    cap: { type: Number, required: true },
    startYear: { type: Number, required: true },
    source: { type: String, required: true },
  },
  computed: {
    kept() {
      return this.record ? recordEvents(this.record) : 0
    },

    size() {
      return bytesText(eventEstimate(this.kept))
    },

    spans() {
      return this.record ? this.record.spans : []
    },

    gaps() {
      return gapsOf(this.record).filter((gap) => gap.from !== null)
    },

    observedNote() {
      return this.spans.length ? `${this.date(this.spans[0][0])} to ${this.date(this.spans[this.spans.length - 1][1])}` : 'No span yet'
    },

    // The tile for the date the record is complete from: the cap and a clear both cut it, so the words name neither. Null when nothing was cut.
    cutTile() {
      return !this.record || this.record.cut === undefined ? null : { title: 'Complete from', date: this.date(this.record.cut), detail: 'Events before this date are no longer kept' }
    },

    conflicts() {
      return this.shownConflicts.slice(-SHOWN).reverse()
    },

    // Events the player never sees: the archive keeps them, the list, the timeline and the counts leave them out.
    hidden() {
      return gameMasterCount(this.record)
    },

    // The conflicts that quote no game-master-only event: the list and every count of them are these, and the others are only counted aside.
    shownConflicts() {
      return playerConflicts(this.record)
    },

    hiddenConflicts() {
      return this.record ? this.record.conflicts.length - this.shownConflicts.length : 0
    },

    failures() {
      return this.record && Array.isArray(this.record.failures) ? this.record.failures.slice(-SHOWN).reverse().map((failure) => ({ ...failure, reason: failureWords(failure.reason) })) : []
    },

    captures() {
      return this.record ? this.record.captures.slice(-5).reverse() : []
    },
  },
  methods: {
    date(seconds) {
      return gameDateText(this.startYear, seconds).slice(0, 10)
    },

    recorded(at) {
      return Number.isFinite(at) ? new Date(at).toLocaleString() : 'at an unknown time'
    },

    reasonText(conflict) {
      const text = REASONS[conflict.reason] || conflict.reason

      return conflict.group ? `${text} (kept ${conflict.stored}, read ${conflict.read})` : text
    },
  },
}
</script>

<style lang="scss" scoped>
.archive {
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

  .list-source {
    display: flex;
    align-items: center;
  }

  .archive-body {
    border-top: 1px solid var(--ae-border);
    padding: 12px 16px;
  }

  .archive-tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 12px;
  }

  .archive-tile {
    padding: 8px 12px;
    border: 1px solid var(--ae-border);
    border-radius: 4px;
  }

  .archive-value {
    font-size: calc(18px * var(--ae-font-scale));
    font-variant-numeric: tabular-nums;
  }

  .archive-section {
    margin-top: 14px;
  }

  .archive-list {
    margin: 4px 0 0;
    padding-left: 20px;
    max-height: 180px;
    overflow-y: auto;
    font-size: calc(13px * var(--ae-font-scale));
    font-variant-numeric: tabular-nums;
  }

  .archive-quote {
    overflow-wrap: anywhere;
  }
}
</style>
