<template>
  <v-card class="panel fleet-stations" data-summary="The station and supply base noted for each fleet, set beside where the fleet is." elevation="1">
    <div class="panel-head">
      <span>Fleet stations and supply bases</span>
      <v-chip v-if="view && !view.error && !repositoryError && scope" small data-station-count>{{ count(notesCount) }} {{ notesCount === 1 ? 'note' : 'notes' }}<provenance-mark rule="fleetStation.notes" /></v-chip>
    </div>
    <div v-if="!view" class="px-4 py-2" data-station-state>
      <load-state :failed="state.failed" :error="state.error" :loading="state.loading" @retry="$emit('retry')" />
    </div>
    <div v-else-if="view.error" class="px-4 py-2">
      <v-alert type="warning" outlined dense data-station-error>The notes cannot be read here: {{ view.error.message }}</v-alert>
    </div>
    <div v-else-if="repositoryError" class="px-4 py-2">
      <v-alert type="info" outlined dense data-station-error>The scenario records are not available in this window, so notes are not kept: {{ repositoryError }}</v-alert>
    </div>
    <div v-else-if="!scope" class="px-4 py-2 caption text--secondary" data-station-waiting>The campaign of this save is not settled yet, so notes wait for it.</div>
    <template v-else>
      <div v-for="problem in view.problems" :key="problem.key" class="px-4 caption warning--text" data-station-problem>Not read: {{ problem.key }} ({{ problem.message }}). Notes naming one are not checked.<v-btn x-small text color="primary" class="ml-2" data-station-problem-retry @click="$emit('retry')">Retry</v-btn></div>

      <div class="px-4 py-2" data-station-form-bar>
        <v-btn v-if="!draft.open" small depressed color="primary" :disabled="busy" data-station-new @click="startNew">New note</v-btn>
      </div>

      <div v-if="draft.open" class="px-4 pb-3" data-station-form>
        <div class="fleet-stations__form">
          <v-autocomplete v-if="!draft.uuid" v-model="draft.fleetPick" :items="fleetChoices" item-text="text" item-value="id" return-object label="Fleet" dense outlined clearable hide-details class="fleet-stations__fleet" data-station-fleet-pick />
          <div v-else class="fleet-stations__fleet" data-station-fleet-name>Fleet: {{ draftFleetName }}</div>
          <v-select v-model="draft.stationMode" :items="stationModes" label="Station" dense outlined hide-details class="fleet-stations__mode" data-station-mode />
          <v-autocomplete v-if="draft.stationMode === 'body'" v-model="draft.stationSystem" :items="systems" item-text="name" item-value="id" label="System" dense outlined clearable hide-details class="fleet-stations__system" data-station-system-pick />
          <v-autocomplete v-if="draft.stationMode === 'body' || draft.stationMode === 'waypoint'" v-model="draft.stationPick" :items="stationChoicesList" item-text="text" item-value="id" return-object :label="draft.stationMode === 'body' ? 'Body' : 'Waypoint'" :disabled="draft.stationMode === 'body' && draft.stationSystem === null" :hint="pickerHint" persistent-hint dense outlined clearable class="fleet-stations__pick" data-station-pick />
          <v-btn v-if="pickerError" x-small text color="primary" :disabled="busy" data-station-picker-retry @click="loadPicker(draft.stationSystem)">Retry</v-btn>
          <v-select v-model="draft.baseMode" :items="baseModes" label="Supply base" dense outlined hide-details class="fleet-stations__mode" data-station-base-mode />
          <v-autocomplete v-if="draft.baseMode === 'colony'" v-model="draft.basePick" :items="baseChoicesList" item-text="text" item-value="id" return-object label="Colony" dense outlined clearable hide-details class="fleet-stations__pick" data-station-base-pick />
          <v-text-field v-model="draft.note" label="Note" :counter="noteLength" dense outlined class="fleet-stations__note" data-station-note />
          <v-switch v-model="draft.campaignWide" label="Share with every branch of this campaign" dense hide-details class="mt-1" data-station-policy />
        </div>
        <div class="fleet-stations__actions">
          <v-btn small depressed color="primary" :disabled="busy" data-station-save @click="save(false)">{{ draft.uuid ? 'Save changes' : 'Keep note' }}</v-btn>
          <v-btn small text :disabled="busy" data-station-cancel @click="cancel">Cancel</v-btn>
        </div>
        <v-alert v-if="conflict" type="warning" outlined dense class="mt-2" data-station-conflict>
          <div>This note was changed elsewhere after it was opened here. It now reads: {{ conflict.note || 'no text' }}.</div>
          <div class="mt-2">
            <v-btn small depressed color="warning" :disabled="busy" data-station-overwrite @click="save(true)">Write over it</v-btn>
            <v-btn small text class="ml-2" data-station-keep @click="cancel">Keep what is stored</v-btn>
          </div>
        </v-alert>
      </div>
      <v-alert v-if="message" :type="messageType" outlined dense class="mx-4" data-station-message>{{ message }}</v-alert>

      <div class="px-4 py-1">
        <v-switch v-model="showAll" label="Show fleets without a note" dense hide-details class="mt-0" data-station-show-all />
      </div>
      <v-data-table :headers="headers" :items="items" item-key="key" :expanded.sync="expanded" show-expand single-expand disable-sort :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }" dense no-data-text="No fleet has a note." class="fleet-stations__table" data-station-table>
        <template #[`item.name`]="{ item }">
          <div class="py-1" :data-station-fleet="item.key">
            <div class="font-weight-medium text-no-wrap">{{ item.fleet.name }}</div>
            <div class="caption text--secondary text-no-wrap">{{ placeText(item.place) }}</div>
          </div>
        </template>
        <template #[`item.station`]="{ item }">
          <span v-if="item.intent && item.intent.station" class="text-no-wrap" data-station-intent-name>{{ item.intent.station.name }}</span>
          <span v-else class="text--secondary">—</span>
        </template>
        <template #[`item.stationStatus`]="{ item }">
          <span v-if="item.location && item.location.station" class="text-no-wrap" :data-station-status="item.location.station.state">{{ comparisonText(item.location.station) }}<provenance-mark :result="item.location.station.result" /></span>
          <span v-else class="text--secondary">—</span>
        </template>
        <template #[`item.base`]="{ item }">
          <span v-if="item.intent && item.intent.base" class="text-no-wrap" data-station-intent-base>{{ item.intent.base.name }}</span>
          <span v-else class="text--secondary">—</span>
        </template>
        <template #[`item.baseStatus`]="{ item }">
          <span v-if="item.location && item.location.base" class="text-no-wrap" :data-station-base-status="item.location.base.state">{{ comparisonText(item.location.base) }}<provenance-mark :result="item.location.base.result" /></span>
          <span v-else class="text--secondary">—</span>
        </template>
        <template #[`item.flags`]="{ item }">
          <v-chip v-if="item.flags.stale.length" x-small color="warning" text-color="white" data-station-stale-chip>Stale</v-chip>
          <v-chip v-if="item.flags.review.length" x-small color="warning" text-color="white" data-station-review-chip>Needs review</v-chip>
          <v-chip v-if="item.flags.overlap" x-small color="warning" text-color="white" data-station-overlap-chip>Several notes</v-chip>
          <v-chip v-if="item.flags.off.length" x-small outlined data-station-off-chip>Off</v-chip>
        </template>
        <template #expanded-item="{ headers: columns, item }">
          <td :colspan="columns.length" class="pa-3">
            <div class="fleet-stations__regions">
              <section class="fleet-stations__region" data-station-intent>
                <div class="fleet-stations__title">Intended: the player's note, not a game order</div>
                <template v-if="item.intent">
                  <div v-for="target in intentViews(item.intent)" :key="target.role" class="fleet-stations__line" :data-station-role="target.role" :data-station-verdict="target.verdict.state">
                    <span class="text--secondary">{{ roleText(target.role) }}:</span>
                    <span class="font-weight-medium"> {{ target.name }}</span><span v-if="target.nowNamed" class="text--secondary"> (now {{ target.nowNamed }})</span>
                    <span v-if="target.systemName" class="text--secondary"> in {{ target.systemName }}</span>
                    <v-chip x-small class="ml-1" :color="verdictColor(target)" :text-color="verdictColor(target) ? 'white' : undefined" :title="target.verdict.reason">{{ verdictText(target) }}</v-chip>
                    <v-btn v-if="target.verdict.state === 'review' && target.role !== 'fleet'" x-small depressed color="warning" class="ml-1" :disabled="busy" data-station-confirm @click="confirm(item.entry, target.role)">Confirm this {{ target.label.toLowerCase() }}</v-btn>
                    <div v-if="target.verdict.state === 'review' && target.row" class="caption" data-station-holder>The {{ target.label.toLowerCase() }} that holds this ID is now named {{ target.row.name }}{{ resemblanceText(target.verdict.resemblance) }}. Nothing shows it is the one the note named.</div>
                  </div>
                  <div class="fleet-stations__line" data-station-note-text>Note: {{ item.intent.note || 'none' }}</div>
                  <div class="caption text--secondary">{{ item.entry.policy === 'branch' ? 'Kept for this branch only' : 'Kept for every branch of the campaign' }}<template v-if="item.entry.otherBranch">, made on another branch</template></div>
                  <div class="fleet-stations__actions">
                    <v-btn x-small text :disabled="busy" data-station-edit @click="startEdit(item.entry)">Edit</v-btn>
                    <v-btn v-if="deleting !== item.entry.uuid" x-small text color="error" :disabled="busy" data-station-delete @click="deleting = item.entry.uuid">Delete</v-btn>
                    <template v-else>
                      <v-btn x-small depressed color="error" :disabled="busy" data-station-delete-confirm @click="remove(item.entry)">Delete it</v-btn>
                      <v-btn x-small text data-station-delete-cancel @click="deleting = null">Keep</v-btn>
                    </template>
                  </div>
                </template>
                <div v-else class="text--secondary" data-station-no-note>No note for this fleet.</div>
              </section>

              <section class="fleet-stations__region" data-station-location>
                <div class="fleet-stations__title">Location now: from the save</div>
                <div class="fleet-stations__line">{{ placeText(item.place) }}</div>
                <template v-if="item.location">
                  <div v-for="role in ['station', 'base']" :key="role">
                    <div v-if="item.location[role]" class="fleet-stations__line" :data-station-compare="role">
                      <span class="text--secondary">{{ roleText(role) }}:</span> {{ comparisonText(item.location[role]) }}<provenance-mark :result="item.location[role].result" />
                      <template v-if="item.location[role].distance"> · {{ distanceText(item.location[role].distance.value) }}<provenance-mark :result="item.location[role].distance" /></template>
                      <div v-if="item.location[role].state === 'unknown'" class="caption">{{ item.location[role].reason }}</div>
                      <div v-if="item.location[role].movement === 'left-behind'" class="caption warning--text" data-station-not-followed>The fleet is at the body by position only: it does not move with the body, so it is left behind when the body moves.</div>
                      <div v-else-if="item.location[role].movement === 'fixed'" class="caption text--secondary" data-station-fixed>The station is a fixed point: the fleet stays there only while nothing moves it.</div>
                      <div v-else-if="item.location[role].movement === 'unknown'" class="caption text--secondary" data-station-movement-unknown>Whether the fleet moves with the station is not known: the orbit of the fleet or the body the station is tied to is not recorded.</div>
                    </div>
                  </div>
                </template>
                <div v-else class="caption text--secondary">Nothing is compared without a note.</div>
              </section>

              <section class="fleet-stations__region" data-station-orders>
                <div class="fleet-stations__title">Saved orders: what the game will do</div>
                <div v-if="!item.orders.list.length" class="text--secondary" data-station-no-orders>No move order is saved for this fleet.</div>
                <ol v-else class="fleet-stations__orders">
                  <li v-for="order in item.orders.list" :key="order.id" :data-station-order-arrived="order.arrived === true ? 'arrived' : 'under way'">{{ order.text || 'An order with no description' }}<span v-if="order.arrived"> (arrived; any work at the destination may still be running)</span></li>
                </ol>
                <div v-if="item.orders.destination === 'station'" class="caption" :data-station-heads="item.orders.destination">The last saved order names the station as its destination.{{ standoffText(item.orders.standoff) }}</div>
                <div v-else-if="item.orders.destination === 'other'" class="caption" :data-station-heads="item.orders.destination">The last saved order has another destination than the station.</div>
                <div v-else-if="item.orders.destination === 'unknown'" class="caption" :data-station-heads="item.orders.destination">The destination of the last saved order is not fully recorded, so it is not known whether it names the station.</div>
              </section>
            </div>

            <div v-if="checklistFor(item).length" class="fleet-stations__checklist" data-station-checklist>
              <div class="fleet-stations__title">To set in the game</div>
              <ol>
                <li v-for="step in checklistFor(item)" :key="step.key + (step.role || '')" :data-station-step="step.key">{{ stepText(step) }}</li>
              </ol>
              <div class="caption text--secondary">These are steps for the player to take in the game: this panel gives no order and writes nothing to the save.</div>
            </div>
          </td>
        </template>
      </v-data-table>

      <div v-if="view.review.length" class="px-4 pt-3" data-station-review>
        <div class="fleet-stations__title">Notes whose fleet ID is held by another fleet<provenance-mark rule="fleetStation.notes" /></div>
        <div v-for="entry in view.review" :key="entry.uuid" class="fleet-stations__line" :data-station-review-note="entry.uuid">
          <span class="font-weight-medium">{{ entry.intent.fleet.name }}</span><span class="text--secondary"> was the fleet the note named.</span>
          <span v-if="entry.intent.fleet.row"> The fleet that holds the ID now is named {{ entry.intent.fleet.row.name }}{{ resemblanceText(entry.intent.fleet.verdict.resemblance) }}. Nothing is compared with it until it is confirmed.</span>
          <div class="fleet-stations__actions">
            <v-btn x-small depressed color="warning" :disabled="busy || !entry.intent.fleet.row" data-station-attach @click="confirm(entry, 'fleet')">Attach to this fleet</v-btn>
            <v-btn v-if="deleting !== entry.uuid" x-small text color="error" :disabled="busy" data-station-delete @click="deleting = entry.uuid">Delete</v-btn>
            <template v-else>
              <v-btn x-small depressed color="error" :disabled="busy" data-station-delete-confirm @click="remove(entry)">Delete it</v-btn>
              <v-btn x-small text data-station-delete-cancel @click="deleting = null">Keep</v-btn>
            </template>
          </div>
        </div>
      </div>

      <div v-if="view.archived.length" class="px-4 pt-3" data-station-archived>
        <div class="fleet-stations__title">Archived notes of fleets that no longer exist<provenance-mark rule="fleetStation.notes" /></div>
        <div v-for="entry in view.archived" :key="entry.uuid" class="fleet-stations__line" :data-station-archived-note="entry.uuid">
          <span class="font-weight-medium">{{ entry.intent.fleet.name }}</span><span v-if="entry.intent.fleet.systemName" class="text--secondary"> last in {{ entry.intent.fleet.systemName }}</span>
          <span v-for="target in intentViews(entry.intent).filter((one) => one.role !== 'fleet')" :key="target.role" class="text--secondary"> · {{ roleText(target.role) }}: {{ target.name }}</span>
          <span v-if="entry.intent.note" class="text--secondary"> · {{ entry.intent.note }}</span>
          <div class="fleet-stations__actions">
            <v-btn v-if="deleting !== entry.uuid" x-small text color="error" :disabled="busy" data-station-delete @click="deleting = entry.uuid">Delete</v-btn>
            <template v-else>
              <v-btn x-small depressed color="error" :disabled="busy" data-station-delete-confirm @click="remove(entry)">Delete it</v-btn>
              <v-btn x-small text data-station-delete-cancel @click="deleting = null">Keep</v-btn>
            </template>
          </div>
        </div>
      </div>

      <div v-if="view.unchecked.length" class="px-4 pt-3" data-station-unchecked>
        <div class="fleet-stations__title">Notes that could not be checked against this save<provenance-mark rule="fleetStation.notes" /></div>
        <div v-for="entry in view.unchecked" :key="entry.uuid" class="fleet-stations__line caption" :data-station-unchecked-note="entry.uuid">{{ entry.intent.fleet.name }}: {{ entry.intent.fleet.verdict.reason }}</div>
      </div>

      <div v-if="view.ahead.length" class="px-4 pt-3" data-station-ahead>
        <div class="fleet-stations__title">Notes made after this save's game time<provenance-mark rule="fleetStation.notes" /></div>
        <div class="caption text--secondary">These notes were made when the game was further on, so none is compared with this save. Use one in this save to make it current.</div>
        <div v-for="entry in view.ahead" :key="entry.uuid" class="fleet-stations__line" :data-station-ahead-note="entry.uuid">
          <span class="font-weight-medium">{{ entry.intent.fleet.name }}</span>
          <span v-for="target in intentViews(entry.intent).filter((one) => one.role !== 'fleet')" :key="target.role" class="text--secondary"> · {{ roleText(target.role) }}: {{ target.name }}</span>
          <span v-if="entry.intent.note" class="text--secondary"> · {{ entry.intent.note }}</span>
          <div class="fleet-stations__actions">
            <v-btn x-small depressed color="warning" :disabled="busy" data-station-rebase @click="rebase(entry)">Use in this save</v-btn>
            <v-btn v-if="deleting !== entry.uuid" x-small text color="error" :disabled="busy" data-station-delete @click="deleting = entry.uuid">Delete</v-btn>
            <template v-else>
              <v-btn x-small depressed color="error" :disabled="busy" data-station-delete-confirm @click="remove(entry)">Delete it</v-btn>
              <v-btn x-small text data-station-delete-cancel @click="deleting = null">Keep</v-btn>
            </template>
          </div>
        </div>
      </div>

      <div v-if="view.overlapping.length" class="px-4 pt-3" data-station-overlapping>
        <div class="fleet-stations__title">Fleets with more than one note<provenance-mark rule="fleetStation.notes" /></div>
        <div class="caption text--secondary">A fleet has one note. None of these is applied until all but one is deleted.</div>
        <div v-for="entry in view.overlapping" :key="entry.uuid" class="fleet-stations__line" :data-station-overlapping-note="entry.uuid">
          <span class="font-weight-medium">{{ entry.intent.fleet.name }}</span>
          <span v-for="target in intentViews(entry.intent).filter((one) => one.role !== 'fleet')" :key="target.role" class="text--secondary"> · {{ roleText(target.role) }}: {{ target.name }}</span>
          <span v-if="entry.intent.note" class="text--secondary"> · {{ entry.intent.note }}</span>
          <span class="text--secondary"> · {{ entry.policy === 'branch' ? 'this branch only' : 'every branch' }}</span>
          <div class="fleet-stations__actions">
            <v-btn v-if="deleting !== entry.uuid" x-small text color="error" :disabled="busy" data-station-delete @click="deleting = entry.uuid">Delete</v-btn>
            <template v-else>
              <v-btn x-small depressed color="error" :disabled="busy" data-station-delete-confirm @click="remove(entry)">Delete it</v-btn>
              <v-btn x-small text data-station-delete-cancel @click="deleting = null">Keep</v-btn>
            </template>
          </div>
        </div>
      </div>

      <div v-for="note in view.notes" :key="note.uuid" class="px-4 caption text--secondary mt-1" data-station-unreadable>{{ note.reason }}</div>

      <div class="panel-foot caption text--secondary" data-station-limits>
        Use it to see which fleets are off station and what to set in the game. A note is the player's own: it is kept for this campaign, race and branch unless shared, and gives the game no order. The fleet a note names counts as that fleet only where the save shows it or the player confirmed it. An ID can be given again, so another fleet, waypoint or colony holding the ID is never compared and never takes the note. A fleet in the orbit of the station's body is on station whatever the body's coordinates. A fleet only at the same position is on station within the distance the game takes for one point, and is not followed when the body moves. A deleted station or base leaves the note stale, with the name it last had.
      </div>
    </template>
  </v-card>
</template>

<script>
import LoadState from '../page/LoadState.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'
import { failureWords } from '../../utilities/provenance'
import { NOTE_LENGTH, checklistOf, confirmTarget, deleteStation, loadStationBodies, rebaseStation, saveStation, stationChoices } from '../../utilities/fleet-stations'

const ROLE_WORDS = { fleet: 'Fleet', station: 'Station', base: 'Supply base' }

const WHERE_WORDS = { 'other-system': 'in another system', 'other-orbit': 'orbiting another body', 'open-space': 'in open space' }

const VERDICT_WORDS = { evidence: 'Confirmed by the save', confirmed: 'Confirmed by the player', reused: 'Another object holds this ID', unwitnessed: 'Not shown to be the same' }

const blankDraft = () => ({ open: false, uuid: null, revision: null, fleetPick: null, stationMode: 'none', stationSystem: null, stationPick: null, baseMode: 'none', basePick: null, note: '', campaignWide: false, scopeKey: null })

// The intended station and supply base of each fleet as local notes (utilities/fleet-stations.js), with the fleet's location and its saved orders beside them as three separate regions. `view` is what the host's `stationView` gives; the reads behind it are the host's, each with its own loading, failure and Retry.
export default {
  name: 'FleetStations',
  components: { LoadState, ProvenanceMark },
  props: {
    // The reads' state `{ loading, failed, error }`, and what they gave once in (null until then).
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
    // The campaign, race and branch the notes are kept in, and what a pick is checked against.
    scope: {
      type: Object,
      default: null,
    },
    context: {
      type: Object,
      default: null,
    },
    database: {
      type: Object,
      default: null,
    },
    gameId: {
      type: Number,
      default: null,
    },
    raceId: {
      type: Number,
      default: null,
    },
  },
  data() {
    return {
      noteLength: NOTE_LENGTH,
      draft: blankDraft(),
      conflict: null,
      expanded: [],
      deleting: null,
      showAll: false,
      busy: false,
      message: '',
      messageType: 'info',
      // The bodies of the system the form picks a station from, read apart from the page's reads.
      pickerBodies: new Map(),
      pickerError: '',
      pickerLoading: false,
      pickerToken: 0,
    }
  },
  computed: {
    headers() {
      return [
        { text: 'Fleet', value: 'name' },
        { text: 'Intended station', value: 'station' },
        { text: 'Station status', value: 'stationStatus' },
        { text: 'Supply base', value: 'base' },
        { text: 'Base status', value: 'baseStatus' },
        { text: '', value: 'flags' },
      ]
    },

    systems() {
      return this.view ? this.view.systems : []
    },

    items() {
      return this.view ? this.view.rows.filter((row) => this.showAll || row.entry) : []
    },

    notesCount() {
      return this.allEntries.length
    },

    scopeKey() {
      return this.scope ? [this.scope.campaignId, this.scope.RaceID, this.scope.branchId].join('|') : ''
    },

    allEntries() {
      return this.view ? [...this.view.rows.map((row) => row.entry).filter(Boolean), ...this.view.review, ...this.view.archived, ...this.view.unchecked, ...this.view.ahead, ...this.view.overlapping] : []
    },

    stationModes() {
      return [...(this.draft.uuid ? [{ value: 'keep', text: 'Keep the current station' }] : []), { value: 'none', text: 'None' }, { value: 'body', text: 'A body' }, { value: 'waypoint', text: 'A waypoint' }]
    },

    baseModes() {
      return [...(this.draft.uuid ? [{ value: 'keep', text: 'Keep the current base' }] : []), { value: 'none', text: 'None' }, { value: 'colony', text: 'A colony' }]
    },

    // What a pick is made against: the objects of the page's reads with the bodies of the system picked from added.
    pickContext() {
      if (!this.context) {
        return null
      }

      return { ...this.context, objects: { ...this.context.objects, body: new Map([...(this.context.objects.body || new Map()), ...this.pickerBodies]) } }
    },

    fleetChoices() {
      const noted = new Set(this.allEntries.map((entry) => entry.intent.fleet.id))

      return this.pickContext ? stationChoices(this.pickContext.objects, 'fleet').filter((choice) => !noted.has(choice.id)) : []
    },

    stationChoicesList() {
      if (!this.pickContext) {
        return []
      }

      return this.draft.stationMode === 'body' ? stationChoices(this.pickContext.objects, 'body', { systemId: this.draft.stationSystem }) : this.draft.stationMode === 'waypoint' ? stationChoices(this.pickContext.objects, 'waypoint') : []
    },

    baseChoicesList() {
      return this.pickContext ? stationChoices(this.pickContext.objects, 'colony') : []
    },

    pickerHint() {
      return this.pickerError ? `The bodies could not be read: ${this.pickerError}` : this.pickerLoading ? 'Reading the bodies of the system' : ''
    },

    draftFleetName() {
      const entry = this.allEntries.find((one) => one.uuid === this.draft.uuid)

      return entry ? entry.intent.fleet.name : ''
    },
  },
  watch: {
    // Another campaign, race or branch: a draft of the form belonged to the last one.
    scopeKey() {
      if (this.draft.open) {
        this.resetDraft()
        this.say('The form was emptied: the campaign, race or branch shown changed.', 'info')
      } else {
        this.resetDraft()
      }
    },

    // Another save or race: the bodies read for the form belonged to the last one.
    database() {
      this.loadPicker(this.draft.stationSystem)
    },

    raceId() {
      this.loadPicker(this.draft.stationSystem)
    },

    'draft.stationSystem'(systemId) {
      this.draft.stationPick = null
      this.loadPicker(systemId)
    },

    'draft.stationMode'() {
      this.draft.stationPick = null
    },

    'draft.baseMode'() {
      this.draft.basePick = null
    },
  },
  methods: {
    count(value) {
      return String(value)
    },

    say(text, type = 'warning') {
      this.message = text
      this.messageType = type
    },

    resetDraft() {
      this.draft = blankDraft()
      this.conflict = null
      this.deleting = null
      this.message = ''
    },

    cancel() {
      this.resetDraft()
      this.$emit('changed')
    },

    startNew() {
      this.draft = { ...blankDraft(), open: true, scopeKey: this.scopeKey }
      this.conflict = null
      this.message = ''
    },

    startEdit(entry) {
      this.draft = { ...blankDraft(), open: true, uuid: entry.uuid, revision: entry.revision, stationMode: 'keep', baseMode: 'keep', note: entry.intent.note, campaignWide: entry.policy === 'campaign', scopeKey: this.scopeKey }
      this.conflict = null
      this.message = ''
    },

    async loadPicker(systemId) {
      const token = (this.pickerToken += 1)

      this.pickerBodies = new Map()
      this.pickerError = ''

      if (!Number.isInteger(systemId) || !this.database || !this.gameId || !this.raceId) {
        this.pickerLoading = false

        return
      }

      this.pickerLoading = true

      try {
        const bodies = await loadStationBodies(this.database, { GameID: this.gameId, RaceID: this.raceId, systemId })

        if (token === this.pickerToken) {
          this.pickerBodies = bodies
        }
      } catch (error) {
        if (token === this.pickerToken) {
          this.pickerError = failureWords(error)
        }
      } finally {
        if (token === this.pickerToken) {
          this.pickerLoading = false
        }
      }
    },

    // The pick of a role as the save takes it: undefined keeps what the note has, null clears it, `{ type, row }` sets it.
    pickOf(mode, pick) {
      return mode === 'keep' ? undefined : mode === 'none' ? null : { type: mode, row: pick.row }
    },

    // Keeps the form's note: a new one, or an edit over the revision the form was opened at. A stale edit is not written unless `overwrite` says so.
    async save(overwrite = false) {
      const draft = this.draft

      if (draft.scopeKey !== null && draft.scopeKey !== this.scopeKey) {
        this.resetDraft()
        this.say('The campaign, race or branch shown changed after this form was filled in, so nothing is saved. Fill it in again.')

        return
      }

      const stored = draft.uuid ? this.allEntries.find((entry) => entry.uuid === draft.uuid) : null

      if (draft.uuid && !stored) {
        this.say('This note is no longer kept, so the edit is not written. Cancel to start again.')

        return
      }

      if (!draft.uuid && !draft.fleetPick) {
        this.say('Pick the fleet the note is about.')

        return
      }

      if ((draft.stationMode === 'body' || draft.stationMode === 'waypoint') && !draft.stationPick) {
        this.say('Pick the station, or choose none.')

        return
      }

      if (draft.baseMode === 'colony' && !draft.basePick) {
        this.say('Pick the supply base, or choose none.')

        return
      }

      this.busy = true

      try {
        const outcome = await saveStation(this.repository, this.scope, { entry: stored ? { ...stored, revision: draft.revision } : null, fleet: stored ? undefined : { type: 'fleet', row: draft.fleetPick.row }, station: this.pickOf(draft.stationMode, draft.stationPick), base: this.pickOf(draft.baseMode, draft.basePick), note: draft.note, context: this.pickContext, policy: draft.campaignWide ? 'campaign' : 'branch', overwrite })

        this.$emit('changed')

        if (outcome.ok) {
          this.draft = blankDraft()
          this.conflict = null
          this.say(draft.uuid ? 'The note is saved.' : 'The note is kept.', 'success')
        } else if (outcome.code === 'revision-conflict') {
          this.conflict = { note: outcome.stored.note }
          this.message = ''
        } else {
          this.say(outcome.message)
        }
      } finally {
        this.busy = false
      }
    },

    // Confirms the object that holds the ID of one reference of a note, as the one the note named.
    async confirm(entry, role) {
      this.busy = true

      try {
        const outcome = await confirmTarget(this.repository, this.scope, { entry, role, context: this.pickContext })

        this.$emit('changed')

        if (outcome.ok) {
          this.say('The note is attached to the object that holds the ID now.', 'success')
        } else {
          this.say(outcome.code === 'revision-conflict' ? 'The note was changed elsewhere, so nothing is confirmed. It is listed as it is now.' : outcome.message)
        }
      } finally {
        this.busy = false
      }
    },

    // Makes a note made after this save's game time current, on the open branch.
    async rebase(entry) {
      this.busy = true

      try {
        const outcome = await rebaseStation(this.repository, this.scope, entry)

        this.$emit('changed')

        if (outcome.ok) {
          this.say('The note is now kept for this save.', 'success')
        } else {
          this.say(outcome.code === 'revision-conflict' ? 'The note was changed elsewhere, so it is not moved. It is listed as it is now.' : outcome.message)
        }
      } finally {
        this.busy = false
      }
    },

    async remove(entry) {
      this.busy = true

      try {
        const outcome = await deleteStation(this.repository, this.scope, entry)

        this.$emit('changed')
        this.deleting = null

        if (outcome.ok) {
          this.draft = this.draft.uuid === entry.uuid ? blankDraft() : this.draft
          this.say('The note is deleted.', 'success')
        } else {
          this.say(outcome.code === 'revision-conflict' ? 'The note was changed elsewhere, so it is not deleted. It is listed as it is now.' : outcome.message)
        }
      } finally {
        this.busy = false
      }
    },

    roleText(role) {
      return ROLE_WORDS[role] || role
    },

    intentViews(intent) {
      return [intent.fleet, intent.station, intent.base].filter(Boolean)
    },

    placeText(place) {
      const where = place.systemName ? `In ${place.systemName}` : 'System not known'

      return place.inOrbit === null ? where : place.inOrbit ? `${where}, orbiting ${place.orbitName || 'a body'}` : `${where}, not in orbit`
    },

    verdictText(view) {
      const state = view.verdict.state

      return state === 'held' || state === 'review' ? VERDICT_WORDS[view.verdict.basis] : state === 'gone' ? 'No longer in the save' : 'Not checked'
    },

    verdictColor(view) {
      return view.verdict.state === 'held' ? undefined : view.verdict.state === 'unread' ? 'grey' : 'warning'
    },

    resemblanceText(resemblance) {
      if (!resemblance) {
        return ''
      }

      const parts = [resemblance.sameName ? 'it has the same name' : 'it has another name', ...(resemblance.classesOverlap === null ? [] : [resemblance.classesOverlap ? 'it has ships of the same classes' : 'it has no ship of the same classes'])]

      return ` (${parts.join(', ')})`
    },

    comparisonText(comparison) {
      if (comparison.state === 'unknown') {
        return 'Not compared'
      }

      if (comparison.state === 'on') {
        return comparison.basis === 'orbit' ? 'On station: in orbit' : 'On station: at the same position'
      }

      return `Off station: ${WHERE_WORDS[comparison.where] || 'elsewhere'}`
    },

    distanceText(km) {
      return `${km.toLocaleString('en-US', { maximumFractionDigits: 1 })} km apart`
    },

    // What a minimum distance on the last saved order means for where the fleet stops.
    standoffText(standoff) {
      return standoff === 'set' ? ' A minimum distance is set, so the fleet stops short of it.' : standoff === 'unknown' ? ' The minimum distance is not recorded.' : ''
    },

    checklistFor(row) {
      return checklistOf(row)
    },

    stepText(step) {
      const role = step.role === 'base' ? 'supply base' : 'station'

      if (step.key === 'open') {
        return `Open the fleet ${step.fleet}${step.systemName ? ` in ${step.systemName}` : ''} in the game.`
      }

      if (step.key === 'repick') {
        return `Pick the ${role} again: ${step.target} is ${step.reason === 'gone' ? 'no longer in the save' : step.reason === 'review' ? 'not confirmed as the object the note named' : 'not checked'}. Confirm it in the list above, or edit the note.`
      }

      if (step.key === 'orbit') {
        return `Order the fleet into orbit of ${step.target}, so that it moves with the body.`
      }

      if (step.key === 'move') {
        return `Give the fleet a move order to ${step.target}${step.systemName ? ` in ${step.systemName}` : ''}.`
      }

      return `Move the fleet to the supply base ${step.target}${step.systemName ? ` in ${step.systemName}` : ''}.`
    },
  },
}
</script>

<style lang="scss">
.fleet-stations {
  .fleet-stations__form {
    align-items: flex-start;
    column-gap: 12px;
    display: flex;
    flex-wrap: wrap;
    row-gap: 12px;
  }

  .fleet-stations__fleet {
    flex: 1 1 280px;
    min-width: 0;
  }

  .fleet-stations__mode {
    flex: 0 1 220px;
  }

  .fleet-stations__system {
    flex: 0 1 240px;
  }

  .fleet-stations__pick {
    flex: 1 1 280px;
    min-width: 0;
  }

  .fleet-stations__note {
    flex: 1 1 300px;
  }

  .fleet-stations__regions {
    column-gap: 16px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    row-gap: 12px;
  }

  .fleet-stations__region {
    border: 1px solid rgba(128, 128, 128, 0.35);
    border-radius: 4px;
    padding: 8px 12px;
  }

  .fleet-stations__title {
    font-size: 0.8rem;
    font-weight: 500;
    margin-bottom: 4px;
    text-transform: uppercase;
  }

  .fleet-stations__line {
    margin-bottom: 4px;
  }

  .fleet-stations__orders {
    margin: 0;
    padding-left: 20px;
  }

  .fleet-stations__checklist {
    margin-top: 12px;
  }

  .fleet-stations__actions {
    margin-top: 4px;
  }
}
</style>
