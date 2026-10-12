<template>
  <v-card class="panel stop-list" data-summary="The places the route visits, in order, with the leg to the next stop. Add, change, remove or reorder them to plan the journey." elevation="1">
    <div class="panel-head">
      <span>Stops</span>
      <span class="stop-list__tools">
        <v-switch :input-value="cycle" label="Return to start" dense hide-details class="stop-list__cycle" :disabled="rows.length < 2" @change="(value) => $emit('update:cycle', Boolean(value))" />
        <place-picker label="Add a stop" :groups="groups" @need="(id) => $emit('need', id)" @pick="(place) => $emit('insert', rows.length, place)">
          <template #activator="{ on, attrs }">
            <v-btn small outlined v-bind="attrs" v-on="on"><v-icon small left>mdi-plus</v-icon>Add stop</v-btn>
          </template>
        </place-picker>
      </span>
    </div>
    <div v-if="!rows.length" class="stop-list__empty caption text--secondary">No stops yet. Add the places the route visits, or click a system on the map.</div>
    <ol v-else class="stop-list__items">
      <li v-for="row in rows" :key="`${row.index}:${row.key}`" class="stop" :class="{ 'stop--over': overIndex === row.index && dragIndex !== row.index, 'stop--dragging': dragIndex === row.index }" draggable="true" @dragstart="dragStart($event, row.index)" @dragover.prevent="overIndex = row.index" @drop.prevent="drop(row.index)" @dragend="dragEnd">
        <div class="stop__main">
          <v-icon small class="stop__handle" title="Drag to reorder">mdi-drag-vertical</v-icon>
          <span class="stop__number">{{ row.index + 1 }}</span>
          <v-icon small class="stop__icon">{{ row.place ? row.place.icon : 'mdi-help-circle-outline' }}</v-icon>
          <place-picker :label="`Change stop ${row.index + 1}`" :groups="groups" @need="(id) => $emit('need', id)" @pick="(place) => $emit('replace', row.index, place)">
            <template #activator="{ on, attrs }">
              <button type="button" class="stop__name" :aria-label="`Change stop ${row.index + 1}, ${titleOf(row)}`" title="Change this stop" v-bind="attrs" v-on="on">
                <span class="stop__title" :class="{ 'warning--text': row.status === 'missing' }">{{ titleOf(row) }}</span>
                <span class="stop__subtitle caption text--secondary">{{ subtitleOf(row) }}</span>
              </button>
            </template>
          </place-picker>
          <span class="stop__actions">
            <v-btn icon x-small :disabled="row.index === 0" :aria-label="`Move ${titleOf(row)} up`" title="Move up" data-action="up" :data-stop="row.index" @click="shift(row.index, -1)"><v-icon small>mdi-arrow-up</v-icon></v-btn>
            <v-btn icon x-small :disabled="row.index === rows.length - 1" :aria-label="`Move ${titleOf(row)} down`" title="Move down" data-action="down" :data-stop="row.index" @click="shift(row.index, 1)"><v-icon small>mdi-arrow-down</v-icon></v-btn>
            <place-picker :label="`Add a stop after ${titleOf(row)}`" :groups="groups" @need="(id) => $emit('need', id)" @pick="(place) => $emit('insert', row.index + 1, place)">
              <template #activator="{ on, attrs }">
                <v-btn icon x-small :aria-label="`Add a stop after ${titleOf(row)}`" title="Add a stop after this one" v-bind="attrs" v-on="on"><v-icon small>mdi-plus-circle-outline</v-icon></v-btn>
              </template>
            </place-picker>
            <v-btn icon x-small :aria-label="`Remove ${titleOf(row)}`" title="Remove" @click="$emit('remove', row.index)"><v-icon small>mdi-close</v-icon></v-btn>
          </span>
        </div>
        <div v-if="row.leg" class="stop__leg caption">
          <v-icon x-small>{{ row.leg.closing ? 'mdi-repeat' : 'mdi-arrow-down' }}</v-icon>
          <span v-if="row.leg.closing" class="stop__leg-to">Back to {{ row.leg.toName }}:</span>
          <span v-if="row.leg.summary" class="text-no-wrap">{{ row.leg.summary }}</span>
          <span v-else class="warning--text">No explored route{{ row.leg.note ? `: ${row.leg.note}` : '' }}</span>
        </div>
      </li>
    </ol>
    <div class="panel-foot caption text--secondary">
      <slot name="foot" />
    </div>
  </v-card>
</template>

<script>
import PlacePicker from './PlacePicker.vue'

// The stops of a route, in order, to add to, change, remove and reorder, with the figures of the leg to the next stop under each. `rows` are { index, key, status ('ok', 'loading' or 'missing'), place, leg } where `leg` is { closing, toName, summary, note } or null. Emits `insert` (index, place), `replace` (index, place), `remove` (index), `move` (from, to), `need` (a place group the picker has to have read) and `update:cycle`. A row drags by its handle with the mouse; the arrow buttons move it from the keyboard.
export default {
  name: 'StopList',
  components: { PlacePicker },
  props: {
    rows: { type: Array, required: true },
    cycle: { type: Boolean, default: false },
    groups: { type: Array, required: true },
  },
  data() {
    return {
      dragIndex: null,
      overIndex: null,
      // The button to focus again once a stop has moved, so the keyboard keeps its place.
      pendingFocus: null,
    }
  },
  updated() {
    if (this.pendingFocus) {
      const { index, action } = this.pendingFocus
      const pick = (name) => this.$el.querySelector(`[data-stop="${index}"][data-action="${name}"]:not([disabled])`)
      const button = pick(action) || pick(action === 'up' ? 'down' : 'up')

      this.pendingFocus = null

      if (button) {
        button.focus()
      }
    }
  },
  methods: {
    titleOf(row) {
      return row.place ? row.place.name : row.status === 'loading' ? 'Reading the place…' : 'Not available'
    },

    subtitleOf(row) {
      return row.place ? row.place.subtitle : row.status === 'loading' ? row.key : `${row.key}: not in a system the race knows, or gone`
    },

    shift(index, direction) {
      this.pendingFocus = { index: index + direction, action: direction < 0 ? 'up' : 'down' }
      this.$emit('move', index, index + direction)
    },

    dragStart(event, index) {
      this.dragIndex = index
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(index))
    },

    drop(index) {
      const from = this.dragIndex

      this.dragEnd()

      if (from !== null && from !== index) {
        this.$emit('move', from, index)
      }
    },

    dragEnd() {
      this.dragIndex = null
      this.overIndex = null
    },
  },
}
</script>

<style lang="scss">
.stop-list {
  .stop-list__tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 16px;
  }

  .stop-list__cycle {
    margin: 0;
    padding: 0;
  }

  .stop-list__empty {
    padding: 0 24px 8px;
  }

  .stop-list__items {
    list-style: none;
    margin: 0;
    padding: 0 12px 4px;
  }

  .stop {
    border-top: 2px solid transparent;
    border-radius: 4px;
    padding: 2px 0;
  }

  .stop--over {
    border-top-color: var(--v-primary-base);
  }

  .stop--dragging {
    opacity: 0.45;
  }

  .stop__main {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
  }

  .stop__handle {
    flex: none;
    cursor: grab;
  }

  .stop__number {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid currentColor;
    text-align: center;
    font-size: 12px;
    line-height: 20px;
    font-variant-numeric: tabular-nums;
  }

  .stop__icon {
    flex: none;
  }

  .stop__name {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    text-align: left;
    line-height: 1.25;
    border-radius: 4px;
    padding: 2px 4px;
  }

  .stop__name:hover,
  .stop__name:focus-visible {
    background: rgba(128, 128, 128, 0.14);
  }

  .stop__title,
  .stop__subtitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stop__actions {
    flex: none;
    display: flex;
    align-items: center;
  }

  .stop__leg {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 6px;
    margin: 0 0 2px 54px;
    padding-left: 8px;
    border-left: 2px solid rgba(128, 128, 128, 0.35);
    font-variant-numeric: tabular-nums;
  }

  .stop__leg > .v-icon {
    align-self: center;
  }
}
</style>
