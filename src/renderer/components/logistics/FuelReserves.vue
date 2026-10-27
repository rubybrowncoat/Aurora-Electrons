<template>
  <div class="fuel-reserves" data-fuel-reserves>
    <div class="px-4 pt-3 fuel-reserves__title">Local reserve records: a ship, or a ship class</div>
    <div v-if="!ready" class="px-4 py-2" data-fuel-state>
      <load-state :failed="state.failed" :error="state.error" :loading="state.loading" @retry="retryReserves" />
      <v-alert v-if="!state.loading && !state.failed && repositoryError" type="info" outlined dense data-fuel-error>The scenario records are not available in this window, so reserves are not kept: {{ repositoryError }}</v-alert>
      <v-alert v-else-if="!state.loading && !state.failed && read.error" type="warning" outlined dense data-fuel-error>The reserve records cannot be read here: {{ read.error.message }}</v-alert>
      <div v-else-if="!state.loading && !state.failed && !scope" class="caption text--secondary" data-fuel-waiting>The campaign of this save is not settled yet, so reserves wait for it.</div>
    </div>
    <template v-else>
      <div class="px-4 pb-2" data-fuel-scenarios>
        <div class="caption text--secondary">Scenarios in the table{{ chosen.length ? '' : ': every scenario counts' }}</div>
        <v-chip-group v-if="scenarioNames.length" v-model="ledgerScenarios" multiple column>
          <v-chip v-for="name in scenarioNames" :key="name" :value="name" small filter outlined :data-fuel-scenario="name">{{ name }}</v-chip>
        </v-chip-group>
        <div v-else class="caption text--secondary" data-fuel-no-scenarios>No scenario is kept yet.</div>
      </div>

      <div class="px-4 py-2" data-fuel-form-bar>
        <v-btn v-if="!draft.open" small depressed color="primary" :disabled="busy" data-fuel-new @click="startNew">New record</v-btn>
      </div>

      <div v-if="draft.open" class="px-4 pb-3" data-fuel-form>
        <div class="fuel-reserves__form">
          <v-btn-toggle v-if="!draft.uuid" v-model="draft.type" mandatory dense data-fuel-type>
            <v-btn v-for="option in typeItems" :key="option.value" :value="option.value" small :data-fuel-type-option="option.value">{{ option.text }}</v-btn>
          </v-btn-toggle>
          <v-autocomplete v-if="!draft.uuid" v-model="draft.pick" :items="choices" item-text="text" item-value="id" return-object :label="typeWords[draft.type]" dense outlined clearable hide-details class="fuel-reserves__pick" data-fuel-pick />
          <div v-else class="fuel-reserves__pick" data-fuel-name>{{ draftEntry ? `${typeWords[draftEntry.source.type]}: ${draftEntry.source.name}` : '' }}</div>
          <v-combobox v-if="!draft.uuid" v-model="draft.scenario" :items="scenarioNames" label="Scenario" :counter="scenarioLength" dense outlined hide-details class="fuel-reserves__scenario" data-fuel-scenario-pick />
          <div v-else class="fuel-reserves__scenario" data-fuel-scenario-name>Scenario: {{ draftEntry ? draftEntry.scenario : '' }}</div>
          <v-text-field v-model="draft.fuel" label="Fuel reserve (L)" dense outlined hide-details class="fuel-reserves__amount" data-fuel-input />
        </div>
        <div class="caption text--secondary mt-2">The fuel the ship keeps aboard when it gives fuel to another ship. A ship's own record holds over that of its class. Blank is none set; 0 is a reserve of nothing.</div>
        <v-text-field v-model="draft.note" label="Note" :counter="noteLength" dense outlined class="mt-3" data-fuel-note />
        <v-switch v-model="draft.campaignWide" label="Share with every branch of this campaign" dense hide-details class="mt-1" data-fuel-policy />
        <div class="fuel-reserves__actions">
          <v-btn small depressed color="primary" :disabled="busy" data-fuel-save @click="save(false)">{{ draft.uuid ? 'Save changes' : 'Keep record' }}</v-btn>
          <v-btn small text :disabled="busy" data-fuel-cancel @click="cancel">Cancel</v-btn>
        </div>
        <v-alert v-if="conflict" type="warning" outlined dense class="mt-2" data-fuel-conflict>
          <div>This record was changed elsewhere after it was opened here. It now keeps {{ conflict.text }}.</div>
          <div class="mt-2">
            <v-btn small depressed color="warning" :disabled="busy" data-fuel-overwrite @click="save(true)">Write over it</v-btn>
            <v-btn small text class="ml-2" data-fuel-keep @click="cancel">Keep what is stored</v-btn>
          </div>
        </v-alert>
      </div>
      <v-alert v-if="message" :type="messageType" outlined dense class="mx-4" data-fuel-message>{{ message }}</v-alert>

      <div class="px-4 pt-1" data-fuel-records>
        <div v-if="!entries.length" class="caption text--secondary" data-fuel-no-records>No reserve is kept for a ship or a ship class yet.</div>
        <div v-for="entry in entries" :key="entry.uuid" class="fuel-reserves__line" :data-fuel-record="entry.uuid" :data-fuel-applied="entry.applied ? 'yes' : 'no'">
          <v-chip x-small outlined class="mr-1" data-fuel-record-type>{{ typeWords[entry.source.type] }}</v-chip>
          <span class="font-weight-medium" data-fuel-record-name>{{ entry.source.name }}</span><span v-if="entry.source.nowNamed" class="text--secondary"> (now {{ entry.source.nowNamed }})</span>
          <span class="text--secondary"> · {{ entry.scenario }} · <span data-fuel-record-amount>{{ amountText(entry) }}</span> · {{ entry.policy === 'branch' ? 'this branch only' : 'every branch' }}<template v-if="entry.otherBranch">, made on another branch</template></span>
          <v-chip x-small outlined class="ml-1" :title="entry.source.verdict.reason" data-fuel-verdict>{{ verdictText(entry) }}</v-chip>
          <v-chip v-if="!entry.applied" x-small color="warning" text-color="white" class="ml-1" :title="entry.reason">{{ entry.ahead ? 'Made after this save' : 'Not applied' }}</v-chip>
          <div v-if="!entry.applied" class="caption" data-fuel-reason>{{ entry.reason }}</div>
          <div class="fuel-reserves__actions">
            <v-btn x-small text :disabled="busy" data-fuel-edit @click="startEdit(entry)">Edit</v-btn>
            <v-btn v-if="entry.source.verdict.state === 'review' && !entry.ahead" x-small depressed color="warning" :disabled="busy || !entry.source.row" data-fuel-confirm @click="confirm(entry)">Confirm this {{ nounWords[entry.source.type] }}</v-btn>
            <v-btn v-if="entry.ahead" x-small depressed color="warning" :disabled="busy" data-fuel-rebase @click="rebase(entry)">Use in this save</v-btn>
            <v-btn v-if="clearing !== entry.uuid" x-small text color="error" :disabled="busy" data-fuel-clear @click="clearing = entry.uuid">Clear</v-btn>
            <template v-else>
              <v-btn x-small depressed color="error" :disabled="busy" data-fuel-clear-confirm @click="clear(entry)">Clear it</v-btn>
              <v-btn x-small text data-fuel-clear-cancel @click="clearing = null">Keep</v-btn>
            </template>
          </div>
        </div>
      </div>

      <div v-for="note in read.notes" :key="note.uuid" class="px-4 caption text--secondary mt-1" data-fuel-unreadable>{{ note.reason }}</div>
    </template>
  </div>
</template>

<script>
import LoadState from '../page/LoadState.vue'
import countFormat from '../../mixins/count-format'
import persistedView from '../../mixins/persisted-view'
import resourceReserves from '../../mixins/resource-reserves'
import { FUEL_RESOURCE, NOTE_LENGTH, SCENARIO_LENGTH, confirmSource, deleteReserve, fuelReserves, noteChoices, rebaseReserve, saveReserve, scenarioNames } from '../../utilities/resource-reserves'

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const numberOf = (text) => (String(text === undefined || text === null ? '' : text).trim() === '' ? null : Number(text))

const TYPE_WORDS = { ship: 'Ship', class: 'Ship class' }

const NOUN_WORDS = { ship: 'ship', class: 'ship class' }

const VERDICT_WORDS = { evidence: 'Confirmed by the save', confirmed: 'Confirmed by the player', reused: 'Another object holds this ID', unwitnessed: 'Not shown to be the same' }

const SAVE_WORDS = { saved: 'The record is saved.', kept: 'The record is kept.' }

const blankDraft = () => ({ open: false, uuid: null, revision: null, type: 'ship', pick: null, scenario: '', fuel: '', note: '', campaignWide: false, scopeKey: null })

// The fuel reserves of ships and ship classes, kept as scenario records (utilities/resource-reserves.js) and shown under the tanker table of the Logistics page, which draws each ship's local reserve from what this panel reports: `reserves` is `{ ready, table }` of the records that apply in the scenarios chosen, with `ready` false while the records or the objects they name are not read.
export default {
  name: 'FuelReserves',
  components: { LoadState },
  mixins: [
    countFormat,
    resourceReserves,
    persistedView({
      ledgerScenarios: { key: 'reserveLedgerScenarios', default: [], scope: 'race', normalise: (stored) => (Array.isArray(stored) ? stored.filter((name) => typeof name === 'string') : undefined) },
    }),
  ],
  data() {
    return {
      typeWords: TYPE_WORDS,
      nounWords: NOUN_WORDS,
      typeItems: Object.entries(TYPE_WORDS).map(([value, text]) => ({ value, text })),
      scenarioLength: SCENARIO_LENGTH,
      noteLength: NOTE_LENGTH,
      draft: blankDraft(),
      conflict: null,
      clearing: null,
      busy: false,
      message: '',
      messageType: 'info',
    }
  },
  computed: {
    // The kind of reserve the shared reads are made for.
    kind() {
      return 'fuel'
    },

    state() {
      return this.reserveState
    },

    repositoryError() {
      return this.reserveRepositoryError
    },

    scope() {
      return this.reserveScope
    },

    read() {
      return this.reserveRead
    },

    repository() {
      return this.reserveRepository
    },

    scopeKey() {
      return this.scope ? [this.scope.campaignId, this.scope.RaceID, this.scope.branchId].join('|') : ''
    },

    // Whether the records and the objects they name are read, so that the table drawn from them is the player's.
    ready() {
      return !this.state.loading && !this.state.failed && !this.repositoryError && !this.read.error && Boolean(this.scope)
    },

    // The records of ships and ship classes: the records of colonies are the Reserves panel's own.
    entries() {
      return this.read.entries.filter((entry) => entry.source.type === 'ship' || entry.source.type === 'class')
    },

    // The scenarios any record names, a colony's included: the names are shared.
    scenarioNames() {
      return scenarioNames(this.read.entries)
    },

    // The scenarios picked that a record still names.
    chosen() {
      return this.ledgerScenarios.filter((name) => this.scenarioNames.includes(name))
    },

    // What the page draws the reserves from.
    reserves() {
      return { ready: this.ready, table: fuelReserves(this.entries, this.chosen) }
    },

    choices() {
      return this.reserveContext ? noteChoices(this.reserveContext.objects, this.draft.type) : []
    },

    draftEntry() {
      return this.entries.find((entry) => entry.uuid === this.draft.uuid) || null
    },
  },
  watch: {
    reserves: {
      immediate: true,
      handler(value) {
        this.$emit('reserves', value)
      },
    },

    // Another kind of source: the one picked was of the last.
    'draft.type'() {
      this.draft.pick = null
    },

    // Another campaign, race or branch: a draft of the form belonged to the last one.
    scopeKey() {
      if (this.draft.open) {
        this.resetDraft()
        this.say('The form was emptied: the campaign, race or branch shown changed.', 'info')
      } else {
        this.resetDraft()
      }
    },
  },
  methods: {
    say(text, type = 'warning') {
      this.message = text
      this.messageType = type
    },

    resetDraft() {
      this.draft = blankDraft()
      this.conflict = null
      this.clearing = null
      this.message = ''
    },

    cancel() {
      this.resetDraft()
      this.reservesChanged()
    },

    startNew() {
      this.draft = { ...blankDraft(), open: true, scopeKey: this.scopeKey }
      this.conflict = null
      this.message = ''
    },

    startEdit(entry) {
      this.draft = { ...blankDraft(), open: true, uuid: entry.uuid, revision: entry.revision, fuel: hasOwn(entry.reserves, FUEL_RESOURCE) ? String(entry.reserves[FUEL_RESOURCE]) : '', note: entry.note, campaignWide: entry.policy === 'campaign', scopeKey: this.scopeKey }
      this.conflict = null
      this.message = ''
    },

    // Keeps the form's record: a new one, or an edit over the revision the form was opened at. A stale edit is not written unless `overwrite` says so.
    async save(overwrite = false) {
      const draft = this.draft

      if (draft.scopeKey !== null && draft.scopeKey !== this.scopeKey) {
        this.resetDraft()
        this.say('The campaign, race or branch shown changed after this form was filled in, so nothing is saved. Fill it in again.')

        return
      }

      const stored = draft.uuid ? this.entries.find((entry) => entry.uuid === draft.uuid) : null

      if (draft.uuid && !stored) {
        this.say('This record is no longer kept, so the edit is not written. Cancel to start again.')

        return
      }

      if (!draft.uuid && !draft.pick) {
        this.say(`Pick the ${NOUN_WORDS[draft.type]} the record is about.`)

        return
      }

      const fuel = numberOf(draft.fuel)

      if (fuel === null) {
        this.say('Enter the fuel reserve in litres. To keep none, clear the record.')

        return
      }

      this.busy = true

      try {
        const outcome = await saveReserve(this.repository, this.scope, { entry: stored ? { ...stored, revision: draft.revision } : null, source: stored ? undefined : { type: draft.type, row: draft.pick.row }, scenario: stored ? undefined : draft.scenario, resources: [FUEL_RESOURCE], reserves: { [FUEL_RESOURCE]: fuel }, plans: [], note: draft.note, context: this.reserveContext, policy: draft.campaignWide ? 'campaign' : 'branch', overwrite })

        this.reservesChanged()

        if (outcome.ok) {
          this.draft = blankDraft()
          this.conflict = null
          this.say(draft.uuid ? SAVE_WORDS.saved : SAVE_WORDS.kept, 'success')
        } else if (outcome.code === 'revision-conflict') {
          this.conflict = { text: this.storedText(outcome.stored) }
          this.message = ''
        } else {
          this.say(outcome.message)
        }
      } finally {
        this.busy = false
      }
    },

    storedText(payload) {
      return hasOwn(payload.reserves, FUEL_RESOURCE) ? `a fuel reserve of ${this.count(payload.reserves[FUEL_RESOURCE])} L` : 'no fuel reserve'
    },

    amountText(entry) {
      return hasOwn(entry.reserves, FUEL_RESOURCE) ? `${this.count(entry.reserves[FUEL_RESOURCE])} L` : 'no fuel reserve'
    },

    verdictText(entry) {
      const verdict = entry.source.verdict

      return verdict.state === 'held' || verdict.state === 'review' ? VERDICT_WORDS[verdict.basis] : verdict.state === 'gone' ? 'No longer in the save' : 'Not checked'
    },

    // Confirms the object that holds the ID of a record's source as the one the record was made for.
    async confirm(entry) {
      this.busy = true

      try {
        const outcome = await confirmSource(this.repository, this.scope, { entry, context: this.reserveContext })

        this.reservesChanged()

        if (outcome.ok) {
          this.say(`The record is attached to the ${NOUN_WORDS[entry.source.type]} that holds the ID now.`, 'success')
        } else {
          this.say(outcome.code === 'revision-conflict' ? 'The record was changed elsewhere, so nothing is confirmed. It is listed as it is now.' : outcome.message)
        }
      } finally {
        this.busy = false
      }
    },

    // Makes a record made after this save's game time current, on the open branch.
    async rebase(entry) {
      this.busy = true

      try {
        const outcome = await rebaseReserve(this.repository, this.scope, entry)

        this.reservesChanged()

        if (outcome.ok) {
          this.say('The record is now kept for this save.', 'success')
        } else {
          this.say(outcome.code === 'revision-conflict' ? 'The record was changed elsewhere, so it is not moved. It is listed as it is now.' : outcome.message)
        }
      } finally {
        this.busy = false
      }
    },

    // Clears the reserve: the record is deleted, so the ship reads as none set again.
    async clear(entry) {
      this.busy = true

      try {
        const outcome = await deleteReserve(this.repository, this.scope, entry)

        this.reservesChanged()
        this.clearing = null

        if (outcome.ok) {
          this.draft = this.draft.uuid === entry.uuid ? blankDraft() : this.draft
          this.say('The reserve is cleared.', 'success')
        } else {
          this.say(outcome.code === 'revision-conflict' ? 'The record was changed elsewhere, so it is not cleared. It is listed as it is now.' : outcome.message)
        }
      } finally {
        this.busy = false
      }
    },
  },
}
</script>

<style lang="scss">
.fuel-reserves {
  border-top: 1px solid var(--ae-border);

  .fuel-reserves__title {
    font-size: 0.8rem;
    font-weight: 500;
    margin-bottom: 4px;
    text-transform: uppercase;
  }

  .fuel-reserves__form {
    align-items: flex-start;
    column-gap: 12px;
    display: flex;
    flex-wrap: wrap;
    row-gap: 12px;
  }

  .fuel-reserves__pick {
    flex: 1 1 280px;
    min-width: 0;
  }

  .fuel-reserves__scenario {
    flex: 1 1 220px;
    min-width: 0;
  }

  .fuel-reserves__amount {
    flex: 0 1 200px;
  }

  .fuel-reserves__line {
    margin-bottom: 4px;
  }

  .fuel-reserves__actions {
    margin-top: 4px;
  }
}
</style>
