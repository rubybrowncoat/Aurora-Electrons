<template>
  <v-card :class="['resource-reserves', embedded ? 'resource-reserves--embedded' : 'panel']" :flat="embedded" :elevation="embedded ? 0 : 1" :data-summary="summary" data-reserve-panel>
    <div class="panel-head">
      <span>{{ title }}</span>
      <v-chip v-if="view" small :color="view.ledger.shortfalls.length ? 'warning' : undefined" :text-color="view.ledger.shortfalls.length ? 'white' : undefined" data-reserve-count><span data-reserve-value="shortfalls">{{ count(view.ledger.shortfalls.length) }}</span> {{ view.ledger.shortfalls.length === 1 ? 'shortfall' : 'shortfalls' }}<provenance-mark rule="reserveLedger.shortfall" /></v-chip>
    </div>
    <div v-if="!view" class="px-4 py-2" data-reserve-state>
      <load-state :failed="state.failed" :error="state.error" :loading="state.loading" @retry="retryReserves" />
      <v-alert v-if="!state.loading && !state.failed && repositoryError" type="info" outlined dense data-reserve-error>The scenario records are not available in this window, so reserves are not kept: {{ repositoryError }}</v-alert>
      <v-alert v-else-if="!state.loading && !state.failed && read.error" type="warning" outlined dense data-reserve-error>The reserve records cannot be read here: {{ read.error.message }}</v-alert>
      <div v-else-if="!state.loading && !state.failed && !scope" class="caption text--secondary" data-reserve-waiting>The campaign of this save is not settled yet, so reserves wait for it.</div>
    </div>
    <template v-else>
      <div class="px-4 py-2 resource-reserves__controls" data-reserve-controls>
        <v-btn-toggle v-model="ledgerDays" mandatory dense data-reserve-horizon>
          <v-btn v-for="option in horizons" :key="option.days" :value="option.days" small>{{ option.label }}</v-btn>
        </v-btn-toggle>
        <v-switch v-if="hasPlan" v-model="countPlan" label="Count the hauling plan" dense hide-details class="mt-0 ml-4" data-reserve-count-plan />
        <v-switch v-model="showAll" label="Show sources without a record" dense hide-details class="mt-0 ml-4" data-reserve-show-all />
      </div>
      <div class="px-4 pb-2" data-reserve-scenarios>
        <div class="caption text--secondary">Scenarios in the combined run{{ chosen.length ? '' : ': every scenario counts' }}</div>
        <v-chip-group v-if="scenarioNames.length" v-model="ledgerScenarios" multiple column>
          <v-chip v-for="name in scenarioNames" :key="name" :value="name" small filter outlined :data-reserve-scenario="name">{{ name }}</v-chip>
        </v-chip-group>
        <div v-else class="caption text--secondary" data-reserve-no-scenarios>No scenario is kept yet.</div>
      </div>

      <div v-if="view.ledger.shortfalls.length" class="px-4 pb-2" data-reserve-shortfalls>
        <div class="resource-reserves__title">Shortfalls<provenance-mark rule="reserveLedger.shortfall" /></div>
        <div v-for="shortfall in view.ledger.shortfalls" :key="`${shortfall.key}:${shortfall.withdrawal.id}`" class="resource-reserves__line" :data-reserve-shortfall="shortfall.withdrawal.id" :data-reserve-kind="shortfall.kind">
          <v-chip x-small color="warning" text-color="white" class="mr-1">Day <span data-reserve-value="day">{{ count(shortfall.step) }}</span></v-chip>
          <span class="font-weight-medium" data-reserve-name="resource">{{ resourceLabel(shortfall.resource) }}</span> at <span data-reserve-name="colony">{{ shortfall.sourceName }}</span>: <span data-reserve-name="label">{{ shortfall.withdrawal.label }}</span><template v-if="shortfall.withdrawal.scenario"> (<span data-reserve-name="scenario">{{ shortfall.withdrawal.scenario }}</span>)</template> wanted <span data-reserve-value="wanted">{{ figure(shortfall.wanted) }}</span> {{ unitOf(shortfall.resource) }} and got <span data-reserve-value="served">{{ figure(shortfall.served) }}</span> {{ unitOf(shortfall.resource) }}: <template v-if="shortfall.reason === 'reserve'">the stock held <span data-reserve-value="held">{{ figure(shortfall.held) }}</span> {{ unitOf(shortfall.resource) }}, of which the reserve of <span data-reserve-value="reserve">{{ figure(shortfall.reserve) }}</span> {{ unitOf(shortfall.resource) }} stays</template><template v-else>the stock held only <span data-reserve-value="held">{{ figure(shortfall.held) }}</span> {{ unitOf(shortfall.resource) }}</template>.<template v-if="shortfall.kind === 'competing'"> Alone it would <template v-if="shortfall.alone.short > 1e-9">still be short <span data-reserve-value="alone">{{ figure(shortfall.alone.short) }}</span> {{ unitOf(shortfall.resource) }}</template><template v-else>be covered</template>; {{ rivalsText(shortfall) }}.</template>
        </div>
      </div>
      <div v-else class="px-4 pb-2 caption text--secondary" data-reserve-no-shortfalls>No withdrawal of the combined scenario runs short within {{ horizonText }}.</div>

      <div v-if="view.ledger.unfed.length" class="px-4 pb-2 caption warning--text" data-reserve-unfed>
        <div v-for="item in view.ledger.unfed" :key="`${item.scenario}:${item.sourceId}:${item.resource}`">A line of the scenario {{ item.scenario }} names {{ resourceLabel(item.resource) }} at {{ sourceNameOf(item.sourceId) }}, which this save does not give a stock for here, so it is not run.</div>
      </div>

      <div class="px-4 py-2" data-reserve-form-bar>
        <v-btn v-if="!draft.open" small depressed color="primary" :disabled="busy" data-reserve-new @click="startNew">New record</v-btn>
      </div>

      <div v-if="draft.open" class="px-4 pb-3" data-reserve-form>
        <div class="resource-reserves__form">
          <v-autocomplete v-if="!draft.uuid" v-model="draft.colonyPick" :items="colonyChoices" item-text="text" item-value="id" return-object label="Colony" dense outlined clearable hide-details class="resource-reserves__colony" data-reserve-colony-pick />
          <div v-else class="resource-reserves__colony" data-reserve-colony-name>Colony: {{ draftEntry ? draftEntry.source.name : '' }}</div>
          <v-combobox v-if="!draft.uuid" v-model="draft.scenario" :items="scenarioNames" label="Scenario" :counter="scenarioLength" dense outlined hide-details class="resource-reserves__scenario" data-reserve-scenario-pick />
          <div v-else class="resource-reserves__scenario" data-reserve-scenario-name>Scenario: {{ draftEntry ? draftEntry.scenario : '' }}</div>
        </div>
        <div class="resource-reserves__title mt-3">Player reserve: what planned withdrawals leave in the stock. Blank is none set; 0 is a reserve of nothing.</div>
        <div class="resource-reserves__form">
          <v-text-field v-for="resource in resources" :key="resource.key" v-model="draft.reserves[resource.key]" :label="`${resource.label} (${resource.unit})`" dense outlined hide-details class="resource-reserves__reserve" :data-reserve-input="resource.key" />
        </div>
        <div class="resource-reserves__title mt-3">Timed withdrawals and refills: the day counts from now</div>
        <div v-for="(line, index) in draft.plans" :key="index" class="resource-reserves__form mb-2" :data-reserve-plan="index">
          <v-text-field v-model="line.label" label="Label" :counter="labelLength" dense outlined hide-details class="resource-reserves__label" />
          <v-select v-model="line.resource" :items="resourceItems" label="Resource" dense outlined hide-details class="resource-reserves__resource" />
          <v-select v-model="line.kind" :items="kindItems" label="Kind" dense outlined hide-details class="resource-reserves__kind" />
          <v-text-field v-model="line.amount" label="Amount" dense outlined hide-details class="resource-reserves__amount" />
          <v-text-field v-model="line.day" label="Day" dense outlined hide-details class="resource-reserves__amount" />
          <v-btn x-small text color="error" :disabled="busy" @click="draft.plans.splice(index, 1)">Remove</v-btn>
        </div>
        <v-btn x-small text color="primary" :disabled="busy || draft.plans.length >= planLimit" data-reserve-add-plan @click="addPlan">Add a line</v-btn>
        <v-text-field v-model="draft.note" label="Note" :counter="noteLength" dense outlined class="mt-3" data-reserve-note />
        <v-switch v-model="draft.campaignWide" label="Share with every branch of this campaign" dense hide-details class="mt-1" data-reserve-policy />
        <div class="resource-reserves__actions">
          <v-btn small depressed color="primary" :disabled="busy" data-reserve-save @click="save(false)">{{ draft.uuid ? 'Save changes' : 'Keep record' }}</v-btn>
          <v-btn small text :disabled="busy" data-reserve-cancel @click="cancel">Cancel</v-btn>
        </div>
        <v-alert v-if="conflict" type="warning" outlined dense class="mt-2" data-reserve-conflict>
          <div>This record was changed elsewhere after it was opened here. It now keeps {{ conflict.text }}.</div>
          <div class="mt-2">
            <v-btn small depressed color="warning" :disabled="busy" data-reserve-overwrite @click="save(true)">Write over it</v-btn>
            <v-btn small text class="ml-2" data-reserve-keep @click="cancel">Keep what is stored</v-btn>
          </div>
        </v-alert>
      </div>
      <v-alert v-if="message" :type="messageType" outlined dense class="mx-4" data-reserve-message>{{ message }}</v-alert>

      <v-data-table :headers="headers" :items="items" item-key="key" :expanded.sync="expanded" show-expand single-expand disable-sort :items-per-page="15" :footer-props="{ itemsPerPageOptions: [15, 30, -1] }" dense :no-data-text="emptyText" class="resource-reserves__table" data-reserve-table>
        <template #[`item.name`]="{ item }">
          <div class="py-1" :data-reserve-source="item.key">
            <div class="font-weight-medium text-no-wrap"><span data-reserve-name="colony">{{ item.sourceName }}</span><span class="text--secondary"> · <span data-reserve-name="resource">{{ resourceLabel(item.resource) }}</span></span></div>
            <div class="caption text--secondary text-no-wrap">{{ item.place || 'System not known' }}</div>
          </div>
        </template>
        <template #[`item.stock`]="{ item }">
          <span v-if="item.stock !== null" class="text-no-wrap" data-reserve-stock><span data-reserve-value="stock">{{ figure(item.stock) }}</span> {{ unitOf(item.resource) }}</span>
          <span v-else class="text--secondary" data-reserve-stock>not recorded</span>
        </template>
        <template #[`item.game`]="{ item }">
          <span v-if="!item.minimums.game.applies" class="text--secondary" data-reserve-game="none" :title="item.minimums.game.why">—</span>
          <v-chip v-else-if="item.minimums.game.value !== null" x-small label outlined color="primary" class="text-no-wrap" data-reserve-game="saved"><span data-reserve-value="game">{{ figure(item.minimums.game.value) }}</span> {{ unitOf(item.resource) }}</v-chip>
          <span v-else class="text--secondary" data-reserve-game="unknown" :title="item.minimums.game.why">not recorded</span>
          <provenance-mark rule="reserveLedger.gameMinimum" />
        </template>
        <template #[`item.class`]="{ item }">
          <span v-if="!item.minimums.class.applies" class="text--secondary" data-reserve-class="none" :title="item.minimums.class.why">n/a</span>
          <span v-else-if="item.minimums.class.value !== null" class="text-no-wrap" :data-reserve-class="item.minimums.class.unknown > 0 ? 'partial' : 'figure'"><span v-if="item.minimums.class.unknown > 0" class="caption text--secondary">at least </span><span data-reserve-value="class">{{ figure(item.minimums.class.value) }}</span> {{ unitOf(item.resource) }}<span v-if="item.minimums.class.className" class="caption text--secondary"> {{ item.minimums.class.className }}</span><span v-if="item.minimums.class.unknown > 0" class="caption text--secondary" :title="`${count(item.minimums.class.unknown)} more ${item.minimums.class.unknown === 1 ? 'class' : 'classes'} with ships record no minimum`"> (<span data-reserve-value="class-unknown">{{ count(item.minimums.class.unknown) }}</span> not recorded)</span></span>
          <span v-else class="text--secondary" data-reserve-class="unknown" :title="item.minimums.class.why">not recorded</span>
          <provenance-mark rule="reserveLedger.classMinimum" />
        </template>
        <template #[`item.player`]="{ item }">
          <span v-if="item.minimums.player.recorded" class="text-no-wrap" data-reserve-player="set"><span data-reserve-value="player">{{ figure(item.minimums.player.value) }}</span> {{ unitOf(item.resource) }}</span>
          <span v-else class="text--secondary" data-reserve-player="none">none set</span>
          <provenance-mark rule="reserveLedger.player" />
        </template>
        <template #[`item.lowest`]="{ item }">
          <span v-if="item.run.known" class="text-no-wrap" data-reserve-lowest><span data-reserve-value="lowest">{{ figure(item.run.lowest.level) }}</span> {{ unitOf(item.resource) }}<span class="caption text--secondary"><template v-if="item.run.lowest.step === 0"> {{ timingWords.now }}</template><template v-else> {{ timingWords.later }} <span data-reserve-value="lowest-day">{{ count(item.run.lowest.step) }}</span></template></span></span>
          <span v-else class="text--secondary" data-reserve-lowest>—</span>
        </template>
        <template #[`item.status`]="{ item }">
          <v-chip v-if="item.shortfalls.length" x-small color="warning" text-color="white" data-reserve-short-chip>{{ statusWords.short }} <span data-reserve-value="short-count">{{ count(item.shortfalls.length) }}</span>×</v-chip>
          <v-chip v-if="!item.run.known" x-small outlined data-reserve-unknown-chip>{{ statusWords.unknown }}</v-chip>
          <v-chip v-else-if="belowReserve(item)" x-small color="warning" text-color="white" data-reserve-below-chip>{{ statusWords.below }}</v-chip>
          <v-chip v-else-if="!item.shortfalls.length && item.active && item.run.untimed.length" x-small outlined data-reserve-untimed-chip>{{ statusWords.untimed }}</v-chip>
          <v-chip v-else-if="!item.shortfalls.length && item.active && item.unknownUse.length" x-small outlined data-reserve-use-chip>{{ statusWords.use }}</v-chip>
          <v-chip v-else-if="!item.shortfalls.length && item.active" x-small outlined data-reserve-ok-chip>{{ statusWords.covered }}</v-chip>
        </template>
        <template #expanded-item="{ headers: columns, item }">
          <td :colspan="columns.length" class="pa-3" :data-reserve-detail="item.key">
            <div class="resource-reserves__regions">
              <section class="resource-reserves__region" data-reserve-minimums>
                <div class="resource-reserves__title">Three minimums, kept apart</div>
                <div class="resource-reserves__line"><span class="text--secondary">Game minimum:</span> {{ gameText(item) }}</div>
                <div class="resource-reserves__line"><span class="text--secondary">Class minimum (reference figure):</span> {{ classText(item) }}</div>
                <div class="resource-reserves__line"><span class="text--secondary">Player reserve:</span> {{ playerText(item) }}</div>
              </section>
              <section class="resource-reserves__region" data-reserve-run>
                <div class="resource-reserves__title">Over {{ horizonText }}</div>
                <template v-if="item.run.known">
                  <div class="resource-reserves__line">Stock now <span data-reserve-value="start">{{ figure(item.run.start) }}</span> {{ unitOf(item.resource) }}, <span data-reserve-value="final">{{ figure(item.run.final) }}</span> {{ unitOf(item.resource) }} on day <span data-reserve-value="days">{{ count(item.run.days) }}</span>.</div>
                  <div class="resource-reserves__line">Made <span data-reserve-value="produced">{{ figure(item.run.produced) }}</span>, delivered <span data-reserve-value="arrived">{{ figure(item.run.arrived) }}</span>, taken <span data-reserve-value="taken">{{ figure(item.run.taken) }}</span><template v-if="item.run.used > 0">, used by production <span data-reserve-value="used">{{ figure(item.run.used) }}</span></template> {{ unitOf(item.resource) }}.</div>
                  <div v-if="item.production === null" class="caption text--secondary">What the source makes is not counted: it is not known here.</div>
                </template>
                <div v-else class="resource-reserves__line">{{ item.run.reason }}</div>
              </section>
              <section class="resource-reserves__region" data-reserve-timeline>
                <div class="resource-reserves__title">Deliveries and withdrawals by day</div>
                <div v-if="!item.run.known || !item.run.events.length" class="text--secondary">None counted.</div>
                <div v-for="(event, index) in (item.run.events || [])" :key="index" class="resource-reserves__line" :data-reserve-event="event.kind" :data-reserve-event-id="event.id">
                  <span class="text-no-wrap">Day <span data-reserve-value="day">{{ count(event.step) }}</span></span>: <span data-reserve-name="label">{{ event.label }}</span><template v-if="event.scenario"> (<span data-reserve-name="scenario">{{ event.scenario }}</span>)</template><template v-if="event.kind === 'arrival'"> brings <span data-reserve-value="amount">{{ figure(event.amount) }}</span> {{ unitOf(item.resource) }}; the stock is <span data-reserve-value="level">{{ figure(event.level) }}</span> {{ unitOf(item.resource) }}</template><template v-else> takes <span data-reserve-value="served">{{ figure(event.served) }}</span> of <span data-reserve-value="amount">{{ figure(event.amount) }}</span> {{ unitOf(item.resource) }}<template v-if="event.short > 0">, <span data-reserve-value="short">{{ figure(event.short) }}</span> {{ unitOf(item.resource) }} short</template>; the stock is <span data-reserve-value="level">{{ figure(event.level) }}</span> {{ unitOf(item.resource) }}</template>
                </div>
              </section>
            </div>
            <div v-for="note in notCounted(item)" :key="note.key" class="caption text--secondary mt-2" :data-reserve-not-counted="note.key">{{ note.text }}</div>
          </td>
        </template>
      </v-data-table>

      <div class="px-4 pt-3" data-reserve-records>
        <div class="resource-reserves__title">Records</div>
        <div v-if="!entries.length" class="caption text--secondary" data-reserve-no-records>No reserve is kept yet.</div>
        <div v-for="entry in entries" :key="entry.uuid" class="resource-reserves__line" :data-reserve-record="entry.uuid" :data-reserve-applied="entry.applied ? 'yes' : 'no'">
          <span class="font-weight-medium">{{ entry.source.name }}</span><span v-if="entry.source.nowNamed" class="text--secondary"> (now {{ entry.source.nowNamed }})</span>
          <span class="text--secondary"> · {{ entry.scenario }} · {{ linesText(entry) }} · {{ entry.policy === 'branch' ? 'this branch only' : 'every branch' }}<template v-if="entry.otherBranch">, made on another branch</template></span>
          <v-chip x-small outlined class="ml-1" :title="entry.source.verdict.reason" data-reserve-verdict>{{ verdictText(entry) }}</v-chip>
          <v-chip v-if="!entry.applied" x-small color="warning" text-color="white" class="ml-1" :title="entry.reason">{{ entry.ahead ? 'Made after this save' : 'Not applied' }}</v-chip>
          <div v-if="!entry.applied" class="caption" data-reserve-reason>{{ entry.reason }}</div>
          <div class="resource-reserves__actions">
            <v-btn x-small text :disabled="busy" data-reserve-edit @click="startEdit(entry)">Edit</v-btn>
            <v-btn v-if="entry.source.verdict.state === 'review' && !entry.ahead" x-small depressed color="warning" :disabled="busy || !entry.source.row" data-reserve-confirm @click="confirm(entry)">Confirm this colony</v-btn>
            <v-btn v-if="entry.ahead" x-small depressed color="warning" :disabled="busy" data-reserve-rebase @click="rebase(entry)">Use in this save</v-btn>
            <v-btn v-if="deleting !== entry.uuid" x-small text color="error" :disabled="busy" data-reserve-delete @click="deleting = entry.uuid">Delete</v-btn>
            <template v-else>
              <v-btn x-small depressed color="error" :disabled="busy" data-reserve-delete-confirm @click="remove(entry)">Delete it</v-btn>
              <v-btn x-small text data-reserve-delete-cancel @click="deleting = null">Keep</v-btn>
            </template>
          </div>
        </div>
      </div>

      <div v-for="note in read.notes" :key="note.uuid" class="px-4 caption text--secondary mt-1" data-reserve-unreadable>{{ note.reason }}</div>

      <div class="panel-foot caption text--secondary" data-reserve-limits>
        The game minimum is the reserve the save stores for a colony's mineral; a colony has none for fuel or maintenance supplies. The class minimum is what a ship class keeps back when it gives fuel or supplies, read as it is from the classes in service, and is no minimum of a colony's stock; when some classes record none it is shown as at least the figure. The player reserve is the player's own record: it is not in the save, and nothing in the game stops a ship or a mass driver from taking it. Each source's stock is spent once over the days: deliveries on a day arrive first, then the withdrawals in the order of the scenario names, then production; a withdrawal takes what the stock holds above the reserve and is not retried. The refineries draw on the colony's Sorium (1 t for 2,000 L of fuel) and the maintenance facilities on its Duranium, Uridium and Gallicite, the same stocks as the planned withdrawals and after them, so a mineral exported leaves less to make from; a colony whose production cannot be worked out is listed as not known on the minerals it would use. A day is a daily tick, so a delivery or withdrawal due on day 0 counts on day 1. A haul takes what its source gives on the day it leaves and delivers that on the day its time gives, never before it leaves, and a delivery on the day of departure is spent only after the source of the haul has given it; hauls that wait on each other in a cycle deliver a day later; the colony a haul delivers to is listed with it. A delivery with no time, one after the period, one whose haul leaves after the period and a withdrawal after the period are listed apart and not counted. A record is held to its colony only while the save shows it is that colony or the player confirmed it.
      </div>
    </template>
  </v-card>
</template>

<script>
import LoadState from '../page/LoadState.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'
import countFormat from '../../mixins/count-format'
import persistedView, { oneOf } from '../../mixins/persisted-view'
import productionModifiers from '../../mixins/production-modifiers'
import resourceReserves from '../../mixins/resource-reserves'
import { HORIZONS, RESOURCES, combinedLedger, resourceOf, resourcesOf } from '../../utilities/resource-ledger'
import { mineralFeeds, supplyFeeds } from '../../utilities/resource-feeds'
import { LABEL_LENGTH, NOTE_LENGTH, PLANS_PER_RECORD, PLAN_KINDS, SCENARIO_LENGTH, confirmSource, deleteReserve, entriesForLedger, noteChoices, rebaseReserve, saveReserve, scenarioNames } from '../../utilities/resource-reserves'

const SUMMARIES = {
  supplies: 'The fuel and the maintenance supplies each colony holds, set beside the minimum of the game, the minimum of the ship classes and the reserve the player keeps. Use it to see on which day a planned withdrawal would leave a colony short; the records are local and give the game no order.',
  minerals: 'The minerals each colony holds with the packets and hauls on their way, set beside the reserve the game stores, the minimum of the ship classes and the reserve the player keeps. Use it to see on which day a planned withdrawal would leave a colony short; the records are local and give the game no order.',
}

const TITLES = { supplies: 'Reserves and timed ledger: fuel and maintenance supplies', minerals: 'Reserves and timed ledger: minerals' }

const HORIZON_WORDS = { 91: 'three months', 183: 'six months', 365: 'a year', 730: 'two years' }

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const numberOf = (text) => (String(text === undefined || text === null ? '' : text).trim() === '' ? null : Number(text))

const VERDICT_WORDS = { evidence: 'Confirmed by the save', confirmed: 'Confirmed by the player', reused: 'Another object holds this ID', unwitnessed: 'Not shown to be the same' }

// The words of the status chip of a row of the table, one for each state a row can be in.
const STATUS_WORDS = { short: 'Short', unknown: 'Stock not known', below: 'Below the reserve now', untimed: 'Not assessed, untimed', use: 'Use by production not known', covered: 'Covered' }

// The words of the lowest balance's timing: the balance is the stock now, or the stock on a day, the number of which follows the word.
const TIMING_WORDS = { now: 'now', later: 'on day' }

const blankDraft = () => ({ open: false, uuid: null, revision: null, colonyPick: null, scenario: '', reserves: {}, plans: [], note: '', campaignWide: false, scopeKey: null })

// Local reserves and the timed resource ledger of one group of resources: `kind` 'supplies' (fuel and maintenance supplies) or 'minerals'. The panel reads its own saves, classes, packets and, for minerals, the colonies' supplies and production rates (the Hauling page reads neither), and keeps its records in the scenario repository (utilities/resource-reserves.js); the host passes the colonies it has read and, for minerals, the Hauling plan with the days of its hauls. The feeds of the other group run beside the ones shown, as support, so that the production of supplies and the plans on the minerals it draws on spend one stock.
export default {
  name: 'ResourceReserves',
  components: { LoadState, ProvenanceMark },
  mixins: [
    countFormat,
    resourceReserves,
    productionModifiers,
    persistedView({
      ledgerDays: { key: 'reserveLedgerHorizon', default: 365, valid: oneOf(HORIZONS.map((option) => option.days)) },
      ledgerScenarios: { key: 'reserveLedgerScenarios', default: [], scope: 'race', normalise: (stored) => (Array.isArray(stored) ? stored.filter((name) => typeof name === 'string') : undefined) },
      countPlan: { key: 'reserveLedgerCountPlan', default: true, valid: (value) => typeof value === 'boolean' },
      showAll: { key: 'reserveLedgerShowAll', default: false, valid: (value) => typeof value === 'boolean' },
    }),
  ],
  props: {
    kind: {
      type: String,
      required: true,
      validator: (value) => ['supplies', 'minerals'].includes(value),
    },
    // The colonies the host read, with the stock columns of the group.
    colonies: {
      type: Array,
      required: true,
    },
    // The host's name for where a colony is; the system the colony records say is used for one it leaves out.
    place: {
      type: Function,
      default: null,
    },
    // The colony's overall production modifier or null (supplies).
    modifierOf: {
      type: Function,
      default: null,
    },
    // The Hauling plan of the host (`planHauls`' result) and the days of its hauls (`timeHauls`), for minerals.
    plan: {
      type: Object,
      default: null,
    },
    timed: {
      type: Array,
      default: null,
    },
    // Set inside another panel: no panel chrome of its own.
    embedded: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      horizons: HORIZONS,
      statusWords: STATUS_WORDS,
      timingWords: TIMING_WORDS,
      scenarioLength: SCENARIO_LENGTH,
      labelLength: LABEL_LENGTH,
      noteLength: NOTE_LENGTH,
      planLimit: PLANS_PER_RECORD,
      kindItems: Object.entries(PLAN_KINDS).map(([value, text]) => ({ value, text })),
      draft: blankDraft(),
      conflict: null,
      expanded: [],
      deleting: null,
      busy: false,
      message: '',
      messageType: 'info',
    }
  },
  computed: {
    summary() {
      return SUMMARIES[this.kind]
    },

    title() {
      return TITLES[this.kind]
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

    scopeKey() {
      return this.scope ? [this.scope.campaignId, this.scope.RaceID, this.scope.branchId].join('|') : ''
    },

    resources() {
      return RESOURCES.filter((resource) => resource.group === this.kind)
    },

    resourceKeys() {
      return resourcesOf(this.kind)
    },

    resourceItems() {
      return this.resources.map((resource) => ({ value: resource.key, text: resource.label }))
    },

    headers() {
      return [
        { text: 'Source', value: 'name' },
        { text: 'Stock', value: 'stock' },
        { text: 'Game minimum', value: 'game' },
        { text: 'Class minimum (reference)', value: 'class' },
        { text: 'Player reserve', value: 'player' },
        { text: 'Lowest', value: 'lowest' },
        { text: '', value: 'status' },
      ]
    },

    // Where each colony is, from the host or else from the colony records.
    colonyPlaces() {
      const colonies = this.reserveObjectsBundle ? this.reserveObjectsBundle.objects.colony : new Map()

      return (colony) => {
        const own = this.place ? this.place(colony) : ''

        if (own) {
          return own
        }

        const row = colonies.get(colony.PopulationID)

        return row ? row.systemName : ''
      }
    },

    feeds() {
      if (this.state.loading || this.state.failed) {
        return []
      }

      const classes = this.reserveClassesBundle ? this.reserveClassesBundle.classes : null

      const minerals = mineralFeeds({ colonies: this.colonies, place: this.colonyPlaces, plan: this.plan, timed: this.timed, packets: this.reservePacketsBundle ? this.reservePacketsBundle.packets : null, classes })
      const supplies = supplyFeeds({ colonies: this.kind === 'supplies' ? this.colonies : this.reserveSupplyBundle.colonies, modifierOf: this.modifierOf || this.productionModifierOf, place: this.colonyPlaces, classes })
      const apart = (list) => list.map((feed) => ({ ...feed, support: true }))

      return this.kind === 'supplies' ? [...supplies, ...apart(minerals)] : [...minerals, ...apart(supplies)]
    },

    hasPlan() {
      return this.kind === 'minerals' && this.feeds.some((feed) => feed.withdrawals.length > 0)
    },

    entries() {
      return this.read.entries
    },

    scenarioNames() {
      return scenarioNames(this.entries)
    },

    // The scenarios picked that a record still names.
    chosen() {
      return this.ledgerScenarios.filter((name) => this.scenarioNames.includes(name))
    },

    repository() {
      return this.reserveRepository
    },

    horizonText() {
      return HORIZON_WORDS[this.ledgerDays] || `${this.ledgerDays} days`
    },

    // The ledger of the combined scenario, or null while the panel shows no figure.
    view() {
      if (this.state.loading || this.state.failed || this.repositoryError || this.read.error || !this.scope) {
        return null
      }

      return { ledger: combinedLedger({ feeds: this.feeds, entries: entriesForLedger(this.entries), scenarios: this.chosen, days: this.ledgerDays, countPlan: this.countPlan, resources: this.resourceKeys }) }
    },

    // The sources the table lists: those that run short first, then those a record or a plan touches, then the rest, each in the order the feeds give.
    items() {
      if (!this.view) {
        return []
      }

      const rank = (row) => (row.shortfalls.length ? 0 : row.active ? 1 : 2)

      return this.view.ledger.rows.filter((row) => this.showAll || row.active || row.shortfalls.length > 0).map((row, index) => ({ row, index })).sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).map(({ row }) => row)
    },

    emptyText() {
      return this.showAll ? 'No colony is read.' : 'No source has a record or a plan. Keep a record, or show every source.'
    },

    colonyChoices() {
      return this.reserveContext ? noteChoices(this.reserveContext.objects, 'colony') : []
    },

    draftEntry() {
      return this.entries.find((entry) => entry.uuid === this.draft.uuid) || null
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
  },
  methods: {
    // A figure at the precision it has: whole numbers as they are, others to one decimal.
    figure(value) {
      return this.count(value, Number.isInteger(value) ? 0 : 1)
    },

    // The colony's overall production modifier, from the panel's own read, or null while the save does not give it.
    productionModifierOf(populationId) {
      const modifiers = this.populationProductionModifiers[populationId]

      return modifiers && typeof modifiers.OverallProductionModifier === 'number' && Number.isFinite(modifiers.OverallProductionModifier) ? modifiers.OverallProductionModifier : null
    },

    unitOf(key) {
      const resource = resourceOf(key)

      return resource ? resource.unit : ''
    },

    resourceLabel(key) {
      const resource = resourceOf(key)

      return resource ? resource.label : key
    },

    sourceNameOf(sourceId) {
      const colony = this.colonies.find((one) => one.PopulationID === sourceId)

      return colony ? colony.PopName : `colony ${sourceId}`
    },

    belowReserve(item) {
      return item.minimums.player.recorded && item.stock !== null && item.stock < item.minimums.player.value
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
      this.reservesChanged()
    },

    startNew() {
      this.draft = { ...blankDraft(), open: true, reserves: Object.fromEntries(this.resourceKeys.map((key) => [key, ''])), scopeKey: this.scopeKey }
      this.conflict = null
      this.message = ''
    },

    startEdit(entry) {
      const reserves = Object.fromEntries(this.resourceKeys.map((key) => [key, hasOwn(entry.reserves, key) ? String(entry.reserves[key]) : '']))
      const plans = entry.plans.filter((plan) => this.resourceKeys.includes(plan.resource)).map((plan) => ({ id: plan.id, label: plan.label, resource: plan.resource, kind: plan.kind, amount: String(plan.amount), day: String(plan.day) }))

      this.draft = { ...blankDraft(), open: true, uuid: entry.uuid, revision: entry.revision, reserves, plans, note: entry.note, campaignWide: entry.policy === 'campaign', scopeKey: this.scopeKey }
      this.conflict = null
      this.message = ''
    },

    addPlan() {
      this.draft.plans.push({ id: null, label: '', resource: this.resourceKeys[0], kind: 'withdraw', amount: '', day: '0' })
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

      if (!draft.uuid && !draft.colonyPick) {
        this.say('Pick the colony the record is about.')

        return
      }

      const reserves = Object.fromEntries(this.resourceKeys.map((key) => [key, numberOf(draft.reserves[key])]))
      const plans = draft.plans.map((plan) => ({ id: plan.id || undefined, label: plan.label, resource: plan.resource, kind: plan.kind, amount: numberOf(plan.amount), day: numberOf(plan.day) }))

      this.busy = true

      try {
        const outcome = await saveReserve(this.repository, this.scope, { entry: stored ? { ...stored, revision: draft.revision } : null, source: stored ? undefined : { type: 'colony', row: draft.colonyPick.row }, scenario: stored ? undefined : draft.scenario, resources: this.resourceKeys, reserves, plans, note: draft.note, context: this.reserveContext, policy: draft.campaignWide ? 'campaign' : 'branch', overwrite })

        this.reservesChanged()

        if (outcome.ok) {
          this.draft = blankDraft()
          this.conflict = null
          this.say(draft.uuid ? 'The record is saved.' : 'The record is kept.', 'success')
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
      const reserves = Object.keys(payload.reserves).length
      const plans = payload.plans.length

      return `${reserves} ${reserves === 1 ? 'reserve' : 'reserves'} and ${plans} timed ${plans === 1 ? 'line' : 'lines'}`
    },

    // Confirms the colony that holds the ID of a record's source as the one the record was made for.
    async confirm(entry) {
      this.busy = true

      try {
        const outcome = await confirmSource(this.repository, this.scope, { entry, context: this.reserveContext })

        this.reservesChanged()

        if (outcome.ok) {
          this.say('The record is attached to the colony that holds the ID now.', 'success')
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

    async remove(entry) {
      this.busy = true

      try {
        const outcome = await deleteReserve(this.repository, this.scope, entry)

        this.reservesChanged()
        this.deleting = null

        if (outcome.ok) {
          this.draft = this.draft.uuid === entry.uuid ? blankDraft() : this.draft
          this.say('The record is deleted.', 'success')
        } else {
          this.say(outcome.code === 'revision-conflict' ? 'The record was changed elsewhere, so it is not deleted. It is listed as it is now.' : outcome.message)
        }
      } finally {
        this.busy = false
      }
    },

    gameText(item) {
      const game = item.minimums.game

      return !game.applies ? `none: ${game.why}` : game.value === null ? 'not recorded in the save' : `${this.figure(game.value)} ${this.unitOf(item.resource)}, saved for the colony`
    },

    classText(item) {
      const shipClass = item.minimums.class

      if (!shipClass.applies) {
        return shipClass.why
      }

      return shipClass.value === null ? shipClass.why : `${shipClass.unknown > 0 ? 'at least ' : ''}${this.figure(shipClass.value)} ${this.unitOf(item.resource)}${shipClass.className ? ` (class ${shipClass.className})` : ''}, the most of the ${this.count(shipClass.classes)} ${shipClass.classes === 1 ? 'class' : 'classes'} with ships that ${shipClass.classes === 1 ? 'records' : 'record'} one${shipClass.unknown > 0 ? `; ${this.count(shipClass.unknown)} more ${shipClass.unknown === 1 ? 'class' : 'classes'} with ships ${shipClass.unknown === 1 ? 'records' : 'record'} none, so the most of all of them is not known` : ''}`
    },

    playerText(item) {
      const player = item.minimums.player

      return player.recorded ? `${this.figure(player.value)} ${this.unitOf(item.resource)}${player.by.length > 1 ? ` (the largest of ${player.by.filter((one) => one.value !== null).map((one) => `${one.scenario} ${this.figure(one.value)}`).join(', ')})` : ''}` : 'none set, which the ledger takes as 0'
    },

    // Which scenarios took the stock first or keep a larger reserve, as one sentence.
    rivalsText(shortfall) {
      const rivals = [...(shortfall.rivals.drew.length ? [`${shortfall.rivals.drew.join(', ')} took stock first, from the same source or from the source of a haul to it`] : []), ...(shortfall.rivals.reserved.length ? [`${shortfall.rivals.reserved.join(', ')} keeps a larger reserve`] : [])]

      return rivals.join(' and ') || 'another scenario competes for the stock'
    },

    // What the run leaves out of its figures, one line each.
    notCounted(item) {
      const run = item.run

      if (!run.known) {
        return []
      }

      const unit = this.unitOf(item.resource)
      const list = (items) => items.map((one) => `${one.label} ${this.figure(one.amount)} ${unit}`).join(', ')

      return [
        ...(run.untimed.length ? [{ key: 'untimed', text: `Not counted, no time known: ${run.untimed.map((one) => `${one.label} ${this.figure(one.amount)} ${unit}${one.why ? ` (${one.why})` : ''}`).join(', ')}.` }] : []),
        ...(run.late.length ? [{ key: 'late', text: `Not counted, after the period: ${run.late.map((one) => `${one.label} ${this.figure(one.amount)} ${unit} on day ${this.count(Math.ceil(one.day))}`).join(', ')}.` }] : []),
        ...(run.beyond.length ? [{ key: 'beyond', text: `Not counted, withdrawal after the period: ${list(run.beyond)}.` }] : []),
        ...(run.skipped.length ? [{ key: 'skipped', text: `Not counted, not valid: ${run.skipped.map((one) => `${one.label} (${one.why})`).join(', ')}.` }] : []),
        ...(item.cut.length ? [{ key: 'cut', text: `Delivered less than planned: ${item.cut.map((one) => `${one.label} ${this.figure(one.given)} of ${this.figure(one.planned)} ${unit} (${one.why})`).join(', ')}.` }] : []),
        ...(item.unknownUse.length ? [{ key: 'use', text: `Not counted, not known: what ${item.unknownUse.map((one) => `${this.resourceLabel(one.resource)} at ${one.sourceName}`).join(' and ')} would take from this stock, since its production cannot be worked out here.` }] : []),
      ]
    },

    linesText(entry) {
      const reserves = this.resourceKeys.filter((key) => hasOwn(entry.reserves, key)).map((key) => `${this.resourceLabel(key)} ${this.figure(entry.reserves[key])} ${this.unitOf(key)}`)
      const plans = entry.plans.filter((plan) => this.resourceKeys.includes(plan.resource)).length

      if (!reserves.length && !plans) {
        return 'no line here'
      }

      return [...(reserves.length ? [`reserve ${reserves.join(', ')}`] : []), ...(plans ? [`${this.count(plans)} timed ${plans === 1 ? 'line' : 'lines'}`] : [])].join(', ')
    },

    verdictText(entry) {
      const verdict = entry.source.verdict

      return verdict.state === 'held' || verdict.state === 'review' ? VERDICT_WORDS[verdict.basis] : verdict.state === 'gone' ? 'No longer in the save' : 'Not checked'
    },
  },
}
</script>

<style lang="scss">
.resource-reserves {
  .resource-reserves__controls {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    row-gap: 8px;
  }

  .resource-reserves__form {
    align-items: flex-start;
    column-gap: 12px;
    display: flex;
    flex-wrap: wrap;
    row-gap: 12px;
  }

  .resource-reserves__colony {
    flex: 1 1 280px;
    min-width: 0;
  }

  .resource-reserves__scenario {
    flex: 1 1 220px;
    min-width: 0;
  }

  .resource-reserves__label {
    flex: 1 1 200px;
    min-width: 0;
  }

  .resource-reserves__resource {
    flex: 0 1 200px;
  }

  .resource-reserves__kind {
    flex: 0 1 140px;
  }

  .resource-reserves__amount {
    flex: 0 1 140px;
  }

  .resource-reserves__reserve {
    flex: 0 1 220px;
  }

  .resource-reserves__regions {
    column-gap: 16px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    row-gap: 12px;
  }

  .resource-reserves__region {
    border: 1px solid rgba(128, 128, 128, 0.35);
    border-radius: 4px;
    padding: 8px 12px;
  }

  .resource-reserves__title {
    font-size: 0.8rem;
    font-weight: 500;
    margin-bottom: 4px;
    text-transform: uppercase;
  }

  .resource-reserves__line {
    margin-bottom: 4px;
  }

  .resource-reserves__actions {
    margin-top: 4px;
  }
}

.resource-reserves--embedded {
  border-top: 1px solid var(--ae-border);
  margin-top: 8px;
}
</style>
