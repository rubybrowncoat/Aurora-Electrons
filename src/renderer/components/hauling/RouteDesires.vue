<template>
  <v-card class="panel route-desires" data-summary="The routes the player wants between two colonies, kept as local records apart from the observed routes and set against them: whether a capable fleet runs each, and what its capacity covers. A record gives the game no order." elevation="1" data-route-desires>
    <div class="panel-head">
      <span>Desired routes</span>
      <v-chip v-if="read && !read.error && !repositoryError && scope" small data-desire-count><span data-desire-count-number>{{ rows.length }}</span> {{ rows.length === 1 ? 'route' : 'routes' }}</v-chip>
    </div>
    <div v-if="state.loading || state.failed" class="px-4 py-2" data-desire-state>
      <load-state :failed="state.failed" :error="state.error" :loading="state.loading" @retry="$emit('retry')" />
    </div>
    <div v-else-if="read.error" class="px-4 py-2">
      <v-alert type="warning" outlined dense data-desire-error>The desired routes cannot be read here: {{ read.error.message }}</v-alert>
    </div>
    <div v-else-if="repositoryError" class="px-4 py-2">
      <v-alert type="info" outlined dense data-desire-error>The scenario records are not available in this window, so desired routes are not kept: {{ repositoryError }}</v-alert>
    </div>
    <div v-else-if="!scope" class="px-4 py-2 caption text--secondary" data-desire-waiting>The campaign of this save is not settled yet, so desired routes wait for it.</div>
    <template v-else>
      <div class="px-4 py-2">
        <v-btn v-if="!draft.open" small depressed color="primary" :disabled="busy" data-desire-new @click="startNew">New desired route</v-btn>
      </div>

      <div v-if="draft.open" class="px-4 pb-3" data-desire-form>
        <div class="route-desires__form">
          <v-text-field v-model="draft.name" label="Name" :counter="nameLength" dense outlined class="route-desires__name" data-desire-name />
          <v-autocomplete v-if="!draft.uuid" v-model="draft.fromPick" :items="choices" item-text="text" item-value="id" return-object label="From colony" dense outlined clearable hide-details class="route-desires__pick" data-desire-from />
          <v-autocomplete v-if="!draft.uuid" v-model="draft.toPick" :items="choices" item-text="text" item-value="id" return-object label="To colony" dense outlined clearable hide-details class="route-desires__pick" data-desire-to />
          <div v-else class="route-desires__pick" data-desire-ends>{{ draft.endsText }}</div>
          <v-select v-model="draft.cargo" :items="cargoItems" label="Cargo" dense outlined hide-details class="route-desires__cargo" data-desire-cargo />
          <v-text-field v-model="draft.yearly" type="number" min="0" label="Yearly demand (optional)" dense outlined hide-details class="route-desires__yearly" data-desire-yearly />
          <v-text-field v-model="draft.note" label="Note" :counter="noteLength" dense outlined class="route-desires__note" data-desire-note />
          <v-switch v-model="draft.campaignWide" label="Share with every branch of this campaign" dense hide-details class="mt-1" data-desire-policy />
        </div>
        <div class="route-desires__actions">
          <v-btn small depressed color="primary" :disabled="busy" data-desire-save @click="save(false)">{{ draft.uuid ? 'Save changes' : 'Keep route' }}</v-btn>
          <v-btn small text :disabled="busy" data-desire-cancel @click="cancel">Cancel</v-btn>
        </div>
        <v-alert v-if="conflict" type="warning" outlined dense class="mt-2" data-desire-conflict>
          <div>This route was changed elsewhere after it was opened here. It now reads: {{ conflict.name }}.</div>
          <div class="mt-2">
            <v-btn small depressed color="warning" :disabled="busy" data-desire-overwrite @click="save(true)">Write over it</v-btn>
            <v-btn small text :disabled="busy" data-desire-conflict-cancel @click="cancel">Discard edit</v-btn>
          </div>
        </v-alert>
      </div>
      <v-alert v-if="message" :type="messageType" outlined dense class="mx-4" data-desire-message>{{ message }}</v-alert>

      <v-data-table :headers="headers" :items="rows" item-key="key" disable-sort :items-per-page.sync="desiresTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" dense no-data-text="No desired route is kept." class="route-desires__table" data-desire-table>
        <template #[`item.nameText`]="{ item }">
          <div class="py-1" :data-desire-row="item.key">
            <div class="font-weight-medium" data-desire-name-text>{{ item.entry.name }}</div>
            <div class="caption text--secondary"><span data-desire-from-text>{{ endText(item.entry.from) }}</span> → <span data-desire-to-text>{{ endText(item.entry.to) }}</span> · <span data-desire-cargo-text>{{ cargoText(item.entry.cargo) }}</span></div>
            <div v-if="item.entry.note" class="caption text--secondary" data-desire-note-text>{{ item.entry.note }}</div>
            <div v-if="item.entry.stale" class="caption warning--text" data-desire-stale>A colony of this record is no longer the one that was linked: the record is kept as it was and not matched to any other colony.</div>
          </div>
        </template>
        <template #[`item.stateText`]="{ item }">
          <div :data-desire-state-value="item.cover.state">
            <span class="text-no-wrap" data-desire-state-text>{{ coverageText(item.cover.state) }}</span>
            <div v-if="item.cover.reason" class="caption text--secondary">{{ item.cover.reason }}</div>
            <div v-if="item.cover.fleets.length" class="caption text--secondary">{{ item.cover.fleets.length }} capable {{ item.cover.fleets.length === 1 ? 'fleet' : 'fleets' }} on {{ item.cover.groups.length }} {{ item.cover.groups.length === 1 ? 'route' : 'routes' }}</div>
          </div>
        </template>
        <template #[`item.capacityText`]="{ item }">
          <div data-desire-capacity>
            <div v-if="item.cover.capacity !== null"><span data-desire-delivered>{{ number(item.cover.capacity) }}</span> <span data-desire-delivered-unit>{{ unit(item.entry.cargo) }}</span> a year delivered</div>
            <div v-else class="text--secondary">—</div>
            <div v-if="item.entry.yearly" class="caption text--secondary">Demand <span data-desire-demand>{{ number(item.entry.yearly) }}</span> <span data-desire-demand-unit>{{ unit(item.entry.cargo) }}</span> a year<template v-if="item.cover.gap !== null"> · short by <span data-desire-gap>{{ number(item.cover.gap) }}</span> <span data-desire-gap-unit>{{ unit(item.entry.cargo) }}</span></template></div>
          </div>
        </template>
        <template #[`item.actions`]="{ item }">
          <v-btn x-small text :disabled="busy" data-desire-edit @click="startEdit(item.entry)">Edit</v-btn>
          <v-btn v-if="deleting !== item.entry.uuid" x-small text color="error" :disabled="busy" data-desire-delete @click="deleting = item.entry.uuid">Delete</v-btn>
          <template v-else>
            <v-btn x-small depressed color="error" :disabled="busy" data-desire-delete-confirm @click="remove(item.entry)">Delete it</v-btn>
            <v-btn x-small text data-desire-delete-cancel @click="deleting = null">Keep</v-btn>
          </template>
        </template>
      </v-data-table>
      <div v-for="note in read.notes" :key="note.uuid" class="px-4 py-1 caption text--secondary" data-desire-note-unlisted>{{ note.reason }}</div>
      <div class="panel-foot caption text--secondary">A desired route is the player's own record: it is never derived from stock, reserves or production, and it changes nothing in the observed routes. Capacity counts what the capable fleets of the observed routes that carry the cargo between the two colonies deliver to the second colony; an unknown cycle is shown as not known, never as uncovered.</div>
    </template>
  </v-card>
</template>

<script>
import LoadState from '../page/LoadState.vue'
import persistedView, { tableView } from '../../mixins/persisted-view'
import { roundToDecimal, separatedNumber } from '../../utilities/math'
import { CARGO_KINDS, CARGO_UNITS, COVERAGE, DESIRE_CARGO, DESIRE_NAME_LENGTH, DESIRE_NOTE_LENGTH } from '../../utilities/route-signatures'

const PAGE_SIZES = [10, 25, -1]

const blankDraft = () => ({ open: false, uuid: null, revision: null, name: '', fromPick: null, toPick: null, cargo: 'minerals', yearly: '', note: '', campaignWide: false, endsText: '' })

const NO_COVER = Object.freeze({ state: 'unknown', reason: 'the saved orders are not read', groups: [], fleets: [], capacity: null, gap: null })

// The desired routes of the player as local records (utilities/route-desires.js), each set against the observed routes. `read` is what the host's `desireRead` gives, `covers` the host's desires with their coverage (`coverDesires`); the read behind them is the host's, with its own loading, failure and Retry.
export default {
  name: 'RouteDesires',
  components: { LoadState },
  mixins: [
    persistedView({
      desiresTable: tableView('haulingRouteDesiresTable', { itemsPerPage: 10, itemsPerPageOptions: PAGE_SIZES }),
    }),
  ],
  props: {
    state: {
      type: Object,
      required: true,
    },
    read: {
      type: Object,
      default: null,
    },
    covers: {
      type: Array,
      default: () => [],
    },
    repository: {
      type: Object,
      default: null,
    },
    repositoryError: {
      type: String,
      default: null,
    },
    scope: {
      type: Object,
      default: null,
    },
    context: {
      type: Object,
      default: null,
    },
    // The colonies a route can run between, as `colonyChoices` gives them.
    choices: {
      type: Array,
      default: () => [],
    },
    separator: {
      type: String,
      default: '',
    },
  },
  data() {
    return {
      pageSizes: PAGE_SIZES,
      nameLength: DESIRE_NAME_LENGTH,
      noteLength: DESIRE_NOTE_LENGTH,
      draft: blankDraft(),
      conflict: null,
      deleting: null,
      busy: false,
      message: '',
      messageType: 'info',
    }
  },
  computed: {
    headers() {
      return [
        { text: 'Desired route', value: 'nameText' },
        { text: 'Coverage', value: 'stateText' },
        { text: 'Capacity', value: 'capacityText' },
        { text: '', value: 'actions' },
      ]
    },

    cargoItems() {
      return DESIRE_CARGO.map((value) => ({ value, text: CARGO_KINDS[value] }))
    },

    rows() {
      const byId = new Map(this.covers.map((cover) => [cover.id, cover]))

      return this.read ? this.read.entries.map((entry) => ({ key: entry.uuid, entry, cover: byId.get(entry.uuid) || NO_COVER })) : []
    },
  },
  methods: {
    number(value) {
      return separatedNumber(roundToDecimal(value, 0), this.separator)
    },

    unit(cargo) {
      return CARGO_UNITS[cargo]
    },

    coverageText(state) {
      return COVERAGE[state]
    },

    cargoText(cargo) {
      return CARGO_KINDS[cargo]
    },

    endText(end) {
      return `${end.nowNamed || end.name}${end.systemName ? ` (${end.systemName})` : ''}`
    },

    startNew() {
      this.message = ''
      this.conflict = null
      this.draft = { ...blankDraft(), open: true }
    },

    startEdit(entry) {
      this.message = ''
      this.conflict = null
      this.draft = { ...blankDraft(), open: true, uuid: entry.uuid, revision: entry.revision, name: entry.name, cargo: entry.cargo, yearly: entry.yearly === null ? '' : String(entry.yearly), note: entry.note, campaignWide: entry.policy === 'campaign', endsText: `${this.endText(entry.from)} → ${this.endText(entry.to)} (the colonies are fixed once a route is kept)` }
    },

    cancel() {
      this.conflict = null
      this.draft = blankDraft()
    },

    async save(overwrite) {
      this.busy = true
      this.message = ''

      try {
        const { draft } = this
        const entry = draft.uuid ? this.read.entries.find((candidate) => candidate.uuid === draft.uuid) : null

        if (draft.uuid && !entry) {
          this.message = 'This route is no longer kept: it was removed elsewhere.'
          this.messageType = 'warning'

          return
        }

        const yearly = draft.yearly === '' || draft.yearly === null ? null : Number(draft.yearly)
        const { saveDesire } = await import('../../utilities/route-desires')
        const result = await saveDesire(this.repository, this.scope, { entry: entry ? { ...entry, revision: draft.revision } : null, name: draft.name, cargo: draft.cargo, yearly: Number.isNaN(yearly) ? draft.yearly : yearly, note: draft.note, from: draft.fromPick ? { row: draft.fromPick.row } : undefined, to: draft.toPick ? { row: draft.toPick.row } : undefined, context: this.context, policy: draft.campaignWide ? 'campaign' : 'branch', overwrite })

        if (result.ok) {
          this.cancel()
          this.$emit('changed')
        } else if (result.code === 'revision-conflict') {
          this.conflict = result.stored
        } else {
          this.message = result.message
          this.messageType = 'warning'
        }
      } finally {
        this.busy = false
      }
    },

    async remove(entry) {
      this.busy = true
      this.deleting = null

      try {
        const { deleteDesire } = await import('../../utilities/route-desires')
        const result = await deleteDesire(this.repository, this.scope, entry)

        if (result.ok) {
          this.$emit('changed')
        } else {
          this.message = result.message
          this.messageType = 'warning'
        }
      } finally {
        this.busy = false
      }
    },
  },
}
</script>

<style lang="scss">
.route-desires {
  .route-desires__form {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-start;
  }

  .route-desires__name,
  .route-desires__note {
    flex: 1 1 260px;
  }

  .route-desires__pick {
    flex: 1 1 220px;
  }

  .route-desires__cargo,
  .route-desires__yearly {
    flex: 0 1 180px;
  }

  .route-desires__actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
}
</style>
