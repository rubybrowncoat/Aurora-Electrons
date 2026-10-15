<template>
  <v-card class="panel pinned" data-summary="The events pinned on this branch of the campaign, kept as copies so that each stays readable after the save no longer holds it. Each shows whether the open save still holds it, a note of its own, and a way to unpin it." elevation="1">
    <div class="panel-head">
      <div class="subtitle-2">Pinned <span v-if="!unavailable" class="caption text--secondary">{{ count(entries.length) }} on this branch</span></div>
    </div>
    <div v-if="unavailable" class="pa-4 text--secondary" role="status">Pins are unavailable: {{ unavailable }} Nothing is written to them until they can be read.</div>
    <div v-else-if="!entries.length" class="pa-4 text--secondary">No events are pinned on this branch. Pin an event with the pin button on its row or in its full message.</div>
    <div v-else class="pin-list">
      <div v-for="entry in entries" :key="entry.pin.id" class="pin-entry">
        <div class="pin-heading">
          <v-icon small class="mr-1">mdi-pin</v-icon>
          <span class="pin-type">{{ entry.type }}</span>
          <span v-if="entry.pin.count > 1" class="pin-count">{{ count(entry.pin.count) }} identical events</span>
          <span class="pin-date">{{ entry.date }}</span>
        </div>
        <div class="pin-message">{{ entry.message }}</div>
        <div v-if="entry.places" class="caption text--secondary">{{ entry.places }}</div>
        <div class="pin-state" :class="{ 'pin-state--held': entry.state === 'held' }"><v-icon x-small class="mr-1">{{ entry.state === 'held' ? 'mdi-check-circle-outline' : 'mdi-help-circle-outline' }}</v-icon>{{ entry.stateText }}</div>
        <div class="pin-tools">
          <v-text-field :value="entry.pin.note" label="Note" dense outlined hide-details maxlength="500" class="pin-note" @change="(note) => $emit('note', { id: entry.pin.id, note })" />
          <v-btn v-if="entry.row" small text @click="$emit('open', entry.row)">Read in full</v-btn>
          <v-btn small text @click="$emit('unpin', entry.pin.id)"><v-icon small left>mdi-pin-off-outline</v-icon>Unpin</v-btn>
        </div>
      </div>
    </div>
    <div v-if="message" class="px-4 pb-2 error--text caption" role="alert">{{ message }}</div>
    <div class="panel-foot caption text--secondary">
      A pin finds its event by its content (the time, type, message and places), never by its place in the save, and holds a copy. One pin covers a group of identical events. A pin on this branch is shown only with this campaign and race, and a branch forked later starts with the pins of the events that had happened by the fork.
    </div>
  </v-card>
</template>

<script>
import countFormat from '../../mixins/count-format'

// The Pinned panel of the Game Log. `entries` are the branch's pins as the page worked them out ({ pin, state, stateText, row, date, type, message, places }, `row` the event in the open save to read in full, if any); `unavailable` is why the pins cannot be read, or ''; `message` the last refusal.
export default {
  mixins: [countFormat],
  props: {
    entries: { type: Array, required: true },
    unavailable: { type: String, default: '' },
    message: { type: String, default: '' },
  },
}
</script>

<style lang="scss" scoped>
.pinned {
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

  .pin-list {
    max-height: 420px;
    overflow-y: auto;
    border-top: 1px solid var(--ae-border);
  }

  .pin-entry {
    padding: 10px 16px;
    border-bottom: 1px solid var(--ae-border);
  }

  .pin-heading {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: calc(13px * var(--ae-font-scale));
  }

  .pin-type {
    font-weight: 500;
  }

  .pin-count {
    white-space: nowrap;
    font-size: calc(12px * var(--ae-font-scale));
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 0 4px;
  }

  .pin-date {
    margin-left: auto;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    font-size: calc(12px * var(--ae-font-scale));
  }

  .pin-message {
    margin-top: 3px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: calc(13px * var(--ae-font-scale));
  }

  .pin-state {
    margin-top: 4px;
    font-size: calc(12px * var(--ae-font-scale));
    color: var(--ae-muted);
  }

  .pin-state--held {
    color: inherit;
  }

  .pin-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    margin-top: 8px;
  }

  .pin-note {
    flex: 1 1 260px;
    min-width: 0;
  }
}
</style>
