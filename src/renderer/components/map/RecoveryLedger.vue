<template>
  <v-card class="panel recovery-ledger" data-summary="The life pods and wrecks in the systems the race knows, each with a status." elevation="1">
    <div class="panel-head">
      <span>Recovery ledger</span>
      <v-chip v-if="view && scope && !view.error && !repositoryError" small data-recovery-count>{{ count(presentRows.length) }} in the save, {{ count(keptCount) }} with a status</v-chip>
    </div>
    <div v-if="!view" class="px-4 py-2" data-recovery-state>
      <load-state :failed="state.failed" :error="state.error" :loading="state.loading" @retry="$emit('retry')" />
    </div>
    <div v-else-if="view.error" class="px-4 py-2">
      <v-alert type="warning" outlined dense data-recovery-error>The statuses cannot be read here: {{ view.error.message }}</v-alert>
    </div>
    <div v-else-if="repositoryError" class="px-4 py-2">
      <v-alert type="info" outlined dense data-recovery-error>The scenario records are not available in this window, so statuses are not kept: {{ repositoryError }}</v-alert>
    </div>
    <div v-else-if="!scope" class="px-4 py-2 caption text--secondary" data-recovery-waiting>The campaign of this save is not settled yet, so statuses wait for it.</div>
    <template v-else>
      <div v-for="problem in view.problems" :key="problem.key" class="px-4 caption warning--text" data-recovery-problem>Not read: {{ kindNames[problem.key] }} ({{ problem.message }}). A status naming one is not checked.<v-btn x-small text color="primary" class="ml-2" data-recovery-problem-retry @click="$emit('retry')">Retry</v-btn></div>

      <div v-if="observable" class="px-4 pt-2" data-observe="control">
        <div v-if="canObserve" class="d-flex align-center flex-wrap">
          <v-switch :input-value="observeChoice" label="Observe life pods and wrecks" dense hide-details class="mt-0 mr-4" data-observe="switch" @change="$emit('observe', $event)" />
          <span class="caption text--secondary" data-observe="purpose">{{ purpose }} About {{ observationSize }} as stored for the objects now (an estimate).</span>
        </div>
        <div v-else class="caption text--secondary" data-observe="unavailable">Observing the life pods and wrecks is unavailable: the save lacks {{ observationGaps.join(', ') }}.</div>
        <div v-if="observeMessage" class="caption error--text" role="alert" data-observe="message">{{ observeMessage }}</div>
        <div v-if="observationNote" class="caption text--secondary" data-observe="record">{{ observationNote }}</div>
      </div>

      <div class="px-4 py-2 d-flex flex-wrap align-center recovery-ledger__filters" data-recovery-filters>
        <v-btn-toggle :value="place" mandatory dense class="mr-3" data-recovery-place @change="$emit('update:place', $event)">
          <v-btn v-for="option in placeOptions" :key="option.value" :value="option.value" small :data-place-option="option.value">{{ option.text }}</v-btn>
        </v-btn-toggle>
        <v-btn-toggle :value="owner" mandatory dense class="mr-3" data-recovery-owner @change="$emit('update:owner', $event)">
          <v-btn v-for="option in ownerOptions" :key="option.value" :value="option.value" small :data-owner-option="option.value">{{ option.text }}</v-btn>
        </v-btn-toggle>
        <v-btn-toggle :value="statusFilter" mandatory dense data-recovery-status-filter @change="$emit('update:statusFilter', $event)">
          <v-btn v-for="option in statusOptions" :key="option.value" :value="option.value" small :data-status-filter-option="option.value">{{ option.text }}</v-btn>
        </v-btn-toggle>
      </div>
      <v-alert v-if="message" :type="messageType" outlined dense class="mx-4" data-recovery-message>{{ message }}</v-alert>

      <v-data-table :headers="headers" :items="items" item-key="key" dense disable-sort :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }" no-data-text="No life pod or wreck matches the choices above in the systems the race knows." class="recovery-ledger__table" data-recovery-table>
        <template #[`item.label`]="{ item }">
          <div class="py-1" :data-recovery-row="item.key" :data-recovery-place="item.place" :data-recovery-own="String(item.own)">
            <div class="font-weight-medium text-no-wrap" data-recovery-label>{{ item.label }}</div>
            <div v-if="item.ambiguous" class="caption warning--text" data-recovery-ambiguous>Ambiguous: {{ count(item.copies) }} {{ identityText.ambiguous }}</div>
          </div>
        </template>
        <template #[`item.system`]="{ item }">
          <span class="text-no-wrap">
            <a class="recovery-ledger__system" :data-recovery-system="item.systemId" @click.prevent="$emit('show-system', item.systemId)">{{ item.systemName }}</a>
            <page-link v-if="item.routeLink" :to="item.routeLink" :name="item.label" />
          </span>
        </template>
        <template #[`item.status`]="{ item }">
          <v-btn-toggle :value="item.status" mandatory dense :data-recovery-status="item.key" :data-recovery-status-value="item.status" @change="(value) => choose(item, value)">
            <v-btn v-for="option in kept" :key="option.value" :value="option.value" x-small :disabled="busy" :title="option.hint" :data-status-option="option.value">{{ option.text }}</v-btn>
          </v-btn-toggle>
        </template>
        <template #[`item.observed`]="{ item }">
          <div v-if="item.observed" :data-observed="item.key" :data-observed-state="item.observed.state">
            <div class="font-weight-medium" data-observed-headline>{{ item.observed.headline }}</div>
            <div class="caption text--secondary" data-observed-summary>{{ item.observed.summary }}</div>
            <div v-for="(line, index) in item.observed.details" :key="index" class="caption text--secondary" data-observed-line>{{ line }}</div>
          </div>
        </template>
      </v-data-table>

      <div v-for="group in groups" :key="group.key" class="px-4 py-2" :data-recovery-group="group.key">
        <div class="subtitle-2">{{ group.title }} ({{ count(group.items.length) }})</div>
        <div class="caption text--secondary" data-recovery-group-text>{{ group.text }}</div>
        <div v-for="item in group.items" :key="item.key" class="recovery-ledger__entry py-1" :data-recovery-entry="item.key" :data-recovery-state="item.state" :data-recovery-entry-status="item.status">
          <div class="font-weight-medium" data-recovery-headline>{{ item.headline }}</div>
          <div class="caption" data-recovery-entry-label>{{ item.label }} in {{ item.systemName || 'a system' }}. Status: {{ statusText[item.status] }}.</div>
          <div class="caption text--secondary" data-recovery-entry-detail>{{ item.detail }}</div>
          <div v-if="item.holder" class="caption text--secondary" data-recovery-holder>The id now names: {{ item.holder }}.</div>
          <v-btn x-small text color="primary" :disabled="busy" data-recovery-remove @click="remove(item)">Remove the status</v-btn>
        </div>
      </div>
      <div v-if="view.notes.length" class="px-4 caption text--secondary" data-recovery-notes>{{ view.notes.length }} {{ view.notes.length === 1 ? 'status' : 'statuses' }} written by another version of the app or not valid {{ view.notes.length === 1 ? 'is' : 'are' }} not listed.</div>

      <div class="px-4 py-3 caption text--secondary" data-recovery-foot>
        Use it to keep track of what is worth a recovery. A status is the player's own note for this race on this branch: it gives the game no order and changes nothing in the save. The statuses are pending (none kept), acknowledged and a personal recovery. An object that is no longer in the save is listed as no longer observed, with its status as it was kept. The save does not say why it is gone, so no outcome is assumed, and the same ID and details seen again are the same object again. What a wreck holds and how long a pod's life support lasts are not shown; a field the race cannot see is shown as Unknown. {{ observationRule }}
      </div>
    </template>
  </v-card>
</template>

<script>
import countFormat from '../../mixins/count-format'
import LoadState from '../page/LoadState.vue'
import PageLink from '../page/PageLink.vue'
import { linkTo } from '../../utilities/deep-links'
import { bytesText, durationText } from '../../utilities/history'
import { gameDateText } from '../../utilities/history-milestones'
import { observationEstimate } from '../../utilities/observations'
import { lastCaptureLine, observationText } from '../../utilities/observation-view'
import { roundToDecimal } from '../../utilities/math'
import { ageOf, classTextOf, GROUP_TEXT, GROUPS, IDENTITY_TEXT, labelOf, placeKeyOf, removeStatus, setStatus, STATE_TEXT, STATUS_HINT, STATUS_ORDER, STATUS_TEXT } from '../../utilities/recovery-ledger'

const KIND_NAMES = { ownLifepod: 'the own life pods', lifepod: 'the life pods of other races', ownWreck: 'the own wrecks', wreck: 'the wrecks of other races' }

const LIKENESS = { lifepod: 'a life pod with this id in this place', wreck: 'a wreck with this id in this place' }

const messageOf = (error) => (error && error.message ? error.message : String(error))

// The life pods and the wrecks of the systems the race knows with the status the player keeps for each (utilities/recovery-ledger.js). `view` is what the host's `recoveryView` gives; the read behind it is the host's, with its own loading, failure and Retry. The statuses are written here, to the host's repository, and the host is told by `changed`.
export default {
  name: 'RecoveryLedger',
  components: { LoadState, PageLink },
  mixins: [countFormat],
  props: {
    // The read's state `{ loading, failed, error }`, and what it gave once in (null until then).
    state: {
      type: Object,
      required: true,
    },
    view: {
      type: Object,
      default: null,
    },
    repository: {
      type: Object,
      default: null,
    },
    repositoryError: {
      type: String,
      default: null,
    },
    // The campaign, race and branch the statuses are kept in, and what a status is checked against.
    scope: {
      type: Object,
      default: null,
    },
    context: {
      type: Object,
      default: null,
    },
    // The game time of the open save, for the age of an own pod, and the game's first year, for the dates of an observation.
    gameTime: {
      type: Number,
      default: null,
    },
    startYear: {
      type: Number,
      default: null,
    },
    // The choices of the filters, kept by the host.
    place: {
      type: String,
      default: 'all',
    },
    owner: {
      type: String,
      default: 'all',
    },
    statusFilter: {
      type: String,
      default: 'all',
    },
    // The observation: whether it is offered at all, whether the save can give it, the columns it lacks, whether it is on, why a choice failed and the account of the records.
    observable: {
      type: Boolean,
      default: false,
    },
    canObserve: {
      type: Boolean,
      default: false,
    },
    observationGaps: {
      type: Array,
      default: () => [],
    },
    observeChoice: {
      type: Boolean,
      default: false,
    },
    observeMessage: {
      type: String,
      default: '',
    },
    observationNote: {
      type: String,
      default: '',
    },
    purpose: {
      type: String,
      default: '',
    },
    observationRule: {
      type: String,
      default: '',
    },
  },
  data() {
    return {
      busy: false,
      message: '',
      messageType: 'info',
      kindNames: KIND_NAMES,
      identityText: IDENTITY_TEXT,
      statusText: STATUS_TEXT,
      placeOptions: [{ value: 'all', text: 'All' }, { value: 'lifepod', text: 'Life pods' }, { value: 'wreck', text: 'Wrecks' }],
      ownerOptions: [{ value: 'all', text: 'Own and foreign' }, { value: 'own', text: 'Own' }, { value: 'foreign', text: 'Foreign' }],
      statusOptions: [{ value: 'all', text: 'Any status' }, ...STATUS_ORDER.map((status) => ({ value: status, text: STATUS_TEXT[status] }))],
      kept: STATUS_ORDER.map((status) => ({ value: status, text: STATUS_TEXT[status], hint: STATUS_HINT[status] })),
    }
  },
  computed: {
    headers() {
      return [
        { text: 'Object', value: 'label' },
        { text: 'System', value: 'system' },
        { text: 'Class', value: 'classText' },
        { text: 'Count or size', value: 'size' },
        { text: 'Age', value: 'age' },
        { text: 'Status', value: 'status' },
        ...(this.observing ? [{ text: 'Observed', value: 'observed' }] : []),
      ]
    },

    // Whether the rows carry an observation: the record's account of each object is shown only while the race is observed.
    observing() {
      return this.canObserve && this.observeChoice
    },

    presentRows() {
      return this.view ? this.view.rows.filter((row) => row.group === GROUPS.PRESENT) : []
    },

    keptCount() {
      return this.view ? this.view.rows.filter((row) => row.entry).length : 0
    },

    observationSize() {
      return bytesText(observationEstimate({ objects: this.presentRows.length }))
    },

    // The objects of the save the choices above let through, as the table shows them.
    items() {
      return this.presentRows.filter((row) => (this.place === 'all' || row.place === this.place) && (this.owner === 'all' || (this.owner === 'own') === row.object.own) && (this.statusFilter === 'all' || row.status === this.statusFilter)).map((row) => this.itemOf(row))
    },

    // The statuses whose object is not the one now under the id, each in the list it belongs to.
    groups() {
      const rows = this.view ? this.view.rows : []
      const lists = [GROUPS.GONE, GROUPS.REVIEW, GROUPS.UNREAD, GROUPS.AHEAD]

      return lists.map((key) => ({ key, title: GROUP_TEXT[key], text: this.groupText(key), items: rows.filter((row) => row.group === key).map((row) => this.entryOf(row, key)) })).filter((group) => group.items.length)
    },
  },
  methods: {
    observedDate(seconds) {
      return this.startYear ? gameDateText(this.startYear, seconds).slice(0, 10) : `${roundToDecimal(seconds / 31536000, 2)} y elapsed`
    },

    groupText(key) {
      return key === GROUPS.GONE ? 'The open save holds no object under these ids. Nothing says why: the status stays as it was kept, and if the same object is seen again the status applies to it again.' : key === GROUPS.REVIEW ? 'Another object holds the id, or one with the kept details that nothing shows to be the same. A status is not applied to it until the status is removed.' : key === GROUPS.UNREAD ? 'The objects of these kinds could not be read from the open save, so the statuses are not compared with it.' : 'These statuses were kept at a later game time than the open save, so they are not applied to it.'
    },

    // The words for what the record says of an object: the shared account of the span with the latest capture that saw it, which the shared account leaves out.
    observedOf(row) {
      const words = { date: this.observedDate, duration: durationText }
      const text = observationText(row.observation, { ...words, likeness: LIKENESS[row.place] })
      const last = lastCaptureLine(row.observation, words)

      return { state: row.observation.state, ...text, details: last ? [...text.details, last] : text.details }
    },

    // One row of the table.
    itemOf(row) {
      const object = row.object
      const age = ageOf(object, this.gameTime)

      return {
        key: row.key,
        id: row.id,
        place: row.place,
        own: object.own,
        label: labelOf(object, this.count),
        systemId: object.systemId,
        systemName: object.systemName,
        routeLink: linkTo.routes({ to: placeKeyOf(object) }),
        classText: classTextOf(object) || 'Unknown',
        size: object.place === 'wreck' ? (object.tons === null ? 'Unknown' : `${this.count(object.tons)} tons`) : object.own ? (object.crew === null ? 'Unknown' : `${this.count(object.crew)} crew`) : 'Unknown',
        age: object.place === 'lifepod' ? (object.own ? (age === null ? 'Unknown' : this.span(age)) : 'Unknown') : '—',
        copies: object.copies,
        ambiguous: !object.own && object.copies > 1,
        status: row.status,
        entry: row.entry,
        object,
        observed: row.observation ? this.observedOf(row) : null,
      }
    },

    // One status that is not on an object of the save.
    entryOf(row, group) {
      const entry = row.entry
      const stamp = entry.observed ? `When the status was kept, the app had observed it up to ${this.observedDate(entry.observed.last)}.` : 'The app had not observed it when the status was kept.'
      const headline = group === GROUPS.GONE ? 'No longer observed' : group === GROUPS.REVIEW ? 'Needs review' : group === GROUPS.UNREAD ? 'Not checked' : 'Kept at a later game time'

      return {
        key: row.key,
        state: entry.state,
        status: entry.status,
        headline,
        label: entry.ref.label,
        systemName: entry.ref.systemName,
        detail: `${group === GROUPS.GONE ? STATE_TEXT.gone : group === GROUPS.AHEAD ? STATE_TEXT.ahead : STATE_TEXT[entry.state] || STATE_TEXT.unverified} ${group === GROUPS.GONE ? stamp : ''}`.trim(),
        holder: row.current ? labelOf(row.current, this.count) : '',
        entry,
      }
    },

    say(text, type = 'info') {
      this.message = text
      this.messageType = type
    },

    // The span the app has observed for an object now, kept with its status as what was last observed when it is gone.
    stampOf(item) {
      const found = item.observed && item.observed.state === 'observed' ? this.spanOfItem(item) : null

      return found ? { first: found.first, last: found.last } : null
    },

    spanOfItem(item) {
      const row = this.view.rows.find((one) => one.key === item.key)

      return row && row.observation ? row.observation.span : null
    },

    async choose(item, status) {
      if (status === item.status || this.busy) {
        return
      }

      this.busy = true
      this.message = ''

      try {
        const result = await setStatus(this.repository, this.scope, { row: item.object, status, entry: item.entry, observed: this.stampOf(item), context: this.context, count: this.count })

        if (!result.ok) {
          this.say(result.code === 'revision-conflict' ? 'The status was changed elsewhere after it was read here, so nothing was written. The list is read again.' : result.message, 'warning')
        }
      } catch (error) {
        this.say(messageOf(error), 'error')
      } finally {
        this.busy = false
        this.$emit('changed')
      }
    },

    async remove(item) {
      if (this.busy) {
        return
      }

      this.busy = true
      this.message = ''

      try {
        const result = await removeStatus(this.repository, this.scope, item.entry)

        if (!result.ok) {
          this.say(result.code === 'revision-conflict' ? 'The status was changed elsewhere after it was read here, so nothing was removed. The list is read again.' : result.message, 'warning')
        } else {
          this.say('The status was removed.', 'info')
        }
      } catch (error) {
        this.say(messageOf(error), 'error')
      } finally {
        this.busy = false
        this.$emit('changed')
      }
    },
  },
}
</script>

<style scoped>
.recovery-ledger__system {
  cursor: pointer;
  text-decoration: underline;
}

.recovery-ledger__entry + .recovery-ledger__entry {
  border-top: 1px solid rgba(128, 128, 128, 0.25);
}
</style>
