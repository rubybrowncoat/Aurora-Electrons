<template>
  <v-card class="panel colonist-floor" data-summary="How many colonists each colony can give up while its installations stay staffed." elevation="1">
    <div class="panel-head">
      <span class="text-no-wrap">Colonist floor<provenance-mark rule="colonistFloor.removable" label /></span>
      <span v-if="!unread" class="caption text--secondary text-no-wrap">{{ headline }}<provenance-mark rule="colonistFloor.outcome" /></span>
    </div>
    <div v-if="unread" class="px-4 py-2" data-colonist-state>
      <load-state :failed="failed" :error="error" :loading="loading" @retry="$emit('retry')" />
    </div>
    <div v-if="!unread" class="px-4 pt-2">
      <v-row dense>
        <v-col cols="12" sm="6" md="3">
          <v-text-field v-model="batchText" label="Batch (M people)" hint="Blank: no outcome is worked out" persistent-hint dense outlined :error="batch.state === 'invalid'" :error-messages="batch.state === 'invalid' ? ['A number of at least 0'] : []" data-colonist-batch />
        </v-col>
      </v-row>
      <div v-for="text in sources.problems" :key="text" class="caption warning--text" data-colonist-problem>Not read: {{ text }}.</div>
    </div>
    <v-data-table v-if="!unread" :headers="headers" :items="items" item-key="key" :expanded.sync="expanded" show-expand single-expand :custom-sort="sortNullLast" :sort-by.sync="floorTable.sortBy" :sort-desc.sync="floorTable.sortDesc" :items-per-page.sync="floorTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" dense no-data-text="The race has no colony to list." class="colonist-floor-table" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
      <template #[`item.name`]="{ item }">
        <div class="py-1">
          <div class="font-weight-medium text-no-wrap">{{ item.name }}</div>
          <div v-if="item.place" class="caption text--secondary text-no-wrap">{{ item.place }}</div>
        </div>
      </template>
      <template #[`item.role`]="{ item }">
        <span class="text-no-wrap">
          <v-chip v-if="item.roleText" x-small label>{{ item.roleText }}</v-chip>
          <span v-else class="text--secondary">—</span>
          <provenance-mark :result="item.sourceResult" />
        </span>
      </template>
      <template #[`item.population`]="{ item }">
        <span class="text-no-wrap" :class="{ 'text--secondary': item.population === null }">{{ people(item.population) }}<provenance-mark :result="item.staffingResult" /></span>
      </template>
      <template #[`item.spare`]="{ item }">
        <span class="text-no-wrap" :class="{ 'error--text': item.shortToday }">{{ spareText(item) }}<provenance-mark :result="item.staffingResult" /></span>
      </template>
      <template #[`item.floorValue`]="{ item }">
        <div class="floor-field" @click.stop>
          <v-text-field :value="item.floorText" dense outlined hide-details single-line placeholder="None" :error="item.floorInvalid" data-colonist-floor @input="setFloor(item.key, $event)" />
        </div>
      </template>
      <template #[`item.minimum`]="{ item }">
        <span class="text-no-wrap" :class="{ 'text--secondary': item.minimum === null }">{{ item.alreadyShort ? 'Short today' : people(item.minimum) }}<provenance-mark :result="item.staffingResult" /></span>
      </template>
      <template #[`item.removable`]="{ item }">
        <span class="text-no-wrap" :class="{ 'text--secondary': item.removable === null }">{{ people(item.removable) }}<provenance-mark :result="item.removableResult" /></span>
      </template>
      <template #[`item.bindingText`]="{ item }">
        <span class="text-no-wrap">
          <v-chip v-if="item.bindingText" x-small label :color="item.bindingColor">{{ item.bindingText }}</v-chip>
          <span v-else class="text--secondary">—</span>
          <provenance-mark :result="item.removableResult" />
        </span>
      </template>
      <template #[`item.remaining`]="{ item }">
        <span class="text-no-wrap" :class="{ 'text--secondary': item.remaining === null, 'error--text': item.breaksFloor }">{{ people(item.remaining) }}<provenance-mark :result="item.outcomeResult" /></span>
      </template>
      <template #[`item.shortage`]="{ item }">
        <span class="text-no-wrap" :class="{ 'text--secondary': item.shortage === null, 'error--text': item.shortAfter }">{{ people(item.shortage) }}<provenance-mark :result="item.outcomeResult" /></span>
      </template>
      <template #[`item.pool`]="{ item }">
        <span class="text-no-wrap" :class="{ 'text--secondary': item.pool === null }">{{ people(item.pool) }}<provenance-mark :result="item.poolResult" /></span>
      </template>
      <template #expanded-item="{ headers: columns, item }">
        <td :colspan="columns.length" class="py-2">
          <v-row dense>
            <v-col cols="12" md="6">
              <div class="chart-title">Workers, today and after the batch<provenance-mark :result="item.outcomeResult" /></div>
              <v-simple-table dense>
                <thead>
                  <tr>
                    <th />
                    <th class="text-right">Today<provenance-mark :result="item.staffingResult" /></th>
                    <th class="text-right">After the batch<provenance-mark :result="item.outcomeResult" /></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="line in splitLines(item)" :key="line.label">
                    <td>{{ line.label }}</td>
                    <td class="text-right text-no-wrap">{{ people(line.today) }}</td>
                    <td class="text-right text-no-wrap" :class="{ 'error--text': line.error }">{{ people(line.after) }}</td>
                  </tr>
                </tbody>
              </v-simple-table>
              <div class="caption text--secondary mt-2">{{ limitNote(item) }}<provenance-mark :result="item.removableResult" /></div>
              <div v-if="item.supportNow !== null || item.infrastructureCap !== null" class="caption text--secondary mt-1" data-colonist-support>Infrastructure built supports {{ people(item.supportNow) }}<provenance-mark :result="item.supportResult" /><template v-if="item.infrastructureCap !== null && item.infrastructureCap !== item.supportNow">; with the deliveries on the way it supports {{ people(item.infrastructureCap) }}<provenance-mark :result="item.capResult" /></template>. The people left are {{ people(item.remaining) }}<span v-if="item.unsupportedAfter" class="error--text"> (more than the infrastructure built supports)</span>. Informational: fewer people never need more infrastructure.</div>
            </v-col>
            <v-col cols="12" md="6">
              <div class="chart-title">Emigrants and pickups<provenance-mark :result="item.poolResult" /></div>
              <v-simple-table dense>
                <tbody>
                  <tr>
                    <td>Pickup by shipping lines<provenance-mark :result="item.sourceResult" /></td>
                    <td class="text-right">{{ pickupText(item) }}</td>
                  </tr>
                  <tr>
                    <td>Emigrants held now<provenance-mark :result="item.poolResult" /></td>
                    <td class="text-right text-no-wrap">{{ people(item.pool) }}</td>
                  </tr>
                  <tr>
                    <td>Ceiling of the pool now</td>
                    <td class="text-right text-no-wrap">{{ people(item.ceiling) }}</td>
                  </tr>
                  <tr>
                    <td>Ceiling after the batch</td>
                    <td class="text-right text-no-wrap">{{ people(item.ceilingAfter) }}</td>
                  </tr>
                  <tr>
                    <td>Shipping lines could take now<provenance-mark :result="item.civilianResult" /></td>
                    <td class="text-right text-no-wrap">{{ people(item.civilianTakes) }}</td>
                  </tr>
                  <tr>
                    <td>Left for a fleet of the race</td>
                    <td class="text-right text-no-wrap">{{ people(item.civilianLeft) }}</td>
                  </tr>
                  <tr>
                    <td>Future shipping-line pickups<provenance-mark :result="item.futureResult" /></td>
                    <td class="text-right text--secondary">Unknown</td>
                  </tr>
                </tbody>
              </v-simple-table>
              <div class="caption text--secondary mt-2">{{ missingText(item.futureResult) }}</div>
            </v-col>
          </v-row>
          <v-row v-if="committedView" dense class="mt-2">
            <v-col cols="12">
              <div class="chart-title">With the queue<provenance-mark :result="item.committedResult" /></div>
              <div v-if="!item.committedSides" class="caption text--secondary">Unavailable, {{ missingText(item.committedResult) }}.</div>
              <v-simple-table v-else dense>
                <thead>
                  <tr>
                    <th />
                    <th class="text-right">Supported completions</th>
                    <th class="text-right">Every completion</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="line in queueLines(item)" :key="line.label">
                    <td>{{ line.label }}</td>
                    <td class="text-right text-no-wrap" :class="{ 'error--text': line.error }">{{ line.supported }}</td>
                    <td class="text-right text-no-wrap" :class="{ 'error--text': line.error }">{{ line.possible }}</td>
                  </tr>
                </tbody>
              </v-simple-table>
            </v-col>
          </v-row>
        </td>
      </template>
    </v-data-table>
    <div class="panel-foot caption text--secondary">
      Use it to choose a source colony for a colonist transport without starving its industry. Each row shows what remains if the batch leaves that colony alone: the services and agriculture the remaining people need come first and the rest can work, as in the Colonies panel. The staffing floor is the lowest population that still has the workers today's installations and shipyards need, so a colony already short can give nothing. The retained floor is entered per colony, a blank floor means no floor, not 0, and the smaller limit binds. People aboard Ark ships do not count as workers or population. With the queue counted, the workers needed come from the committed workforce at the horizon against today's people, with no growth credited. The emigrant pool limits only shipping-line pickups, and only from an imperial colony marked as a source and not kept for military use; the save's numbering suggests which colonies are sources without confirming it, and no future pickup is given because the ships that will call, the pool after loads already queued and the pressure at the next refresh are not known.
    </div>
  </v-card>
</template>

<script>
import LoadState from '../page/LoadState.vue'
import ProvenanceMark from '../page/ProvenanceMark.vue'
import persistedView, { tableView } from '../../mixins/persisted-view'
import { people } from '../../utilities/colonies'
import { assessColony, NO_COLONIST_SOURCES, parseAmount, presentSupportResult } from '../../utilities/colonist-floor'
import { sortNullLast } from '../../utilities/production'
import { valueOrNull } from '../../utilities/provenance'

const HEADERS = [
  { text: 'Colony', value: 'name' },
  { text: 'Role', value: 'role' },
  { text: 'Population', value: 'population', align: 'end' },
  { text: 'Workers spare', value: 'spare', align: 'end' },
  { text: 'Retained floor, M', value: 'floorValue', align: 'end', sortable: false },
  { text: 'Staffing floor', value: 'minimum', align: 'end' },
  { text: 'Can give', value: 'removable', align: 'end' },
  { text: 'Bound by', value: 'bindingText' },
  { text: 'Left', value: 'remaining', align: 'end' },
  { text: 'Workers short', value: 'shortage', align: 'end' },
  { text: 'Emigrants', value: 'pool', align: 'end' },
]

const PAGE_SIZES = [25, 50, -1]

const ROLE_TEXT = { destination: 'Destination', source: 'Source', stable: 'Stable' }

const BINDING = {
  floor: { text: 'Floor', color: 'info' },
  staffing: { text: 'Staffing', color: 'warning' },
  both: { text: 'Floor and staffing', color: 'warning' },
  none: { text: 'None', color: '' },
}

const textOnly = (stored) => (typeof stored === 'string' ? stored : undefined)

const floorsOf = (stored) => {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return undefined
  }

  return Object.fromEntries(Object.entries(stored).filter(([key, value]) => /^\d+$/.test(key) && typeof value === 'string' && value.trim() !== ''))
}

export default {
  name: 'ColonistFloor',
  components: { LoadState, ProvenanceMark },
  mixins: [
    persistedView({
      batchText: { key: 'colonistFloorBatch', default: '', scope: 'race', normalise: textOnly },
      floors: { key: 'colonistFloorFloors', default: {}, scope: 'race', normalise: floorsOf },
      floorTable: tableView('colonistFloorTable', { sortBy: ['name'], sortDesc: false, itemsPerPage: PAGE_SIZES[0], itemsPerPageOptions: PAGE_SIZES }),
    }),
  ],
  props: {
    // The Colony Outlook's rows: each with PopulationID, name, place, Population, infrastructureCap, committedResult (null unless the queue is counted) and r, the row's results (workersNow, cost).
    colonies: { type: Array, required: true },
    // What `loadColonistSources` reads.
    sources: { type: Object, default: () => NO_COLONIST_SOURCES },
    // Whether the Outlook counts the queue in the workers needed.
    committedView: { type: Boolean, default: false },
    // True while the read behind the figures (`sources`) is in flight, and the words that name it with its message when it failed; the panel shows no figures from a read that is in flight or failed, never stale ones.
    loading: { type: Boolean, default: false },
    failed: { type: String, default: '' },
    error: { type: String, default: '' },
  },
  data() {
    return { headers: HEADERS, expanded: [], pageSizes: PAGE_SIZES }
  },
  computed: {
    unread() {
      return this.loading || !!this.failed
    },
    batch() {
      return parseAmount(this.batchText)
    },
    assessed() {
      return this.colonies.map((colony) => ({ colony, a: { ...assessColony({ populationId: colony.PopulationID, workers: colony.r.workersNow, cost: colony.r.cost, committed: this.committedView ? colony.committedResult : null, sources: this.sources, floor: this.floors[colony.PopulationID], batch: this.batchText }), support: presentSupportResult({ colony, rate: colony.r.rate }) } }))
    },
    items() {
      return this.assessed.map(({ colony, a }) => {
        const staffing = valueOrNull(a.staffing)
        const removable = valueOrNull(a.removable)
        const outcome = valueOrNull(a.outcome)
        const source = valueOrNull(a.source)
        const pool = valueOrNull(a.pool)
        const civilian = valueOrNull(a.civilian)
        const committed = valueOrNull(a.committed)
        const binding = removable ? BINDING[removable.binding] : null
        const floorText = this.floors[colony.PopulationID]
        const supportValue = valueOrNull(a.support)
        const supportNow = Number.isFinite(supportValue) ? supportValue : null

        return {
          key: colony.PopulationID,
          name: colony.name,
          place: colony.place,
          infrastructureCap: Number.isFinite(colony.infrastructureCap) ? colony.infrastructureCap : null,
          capResult: colony.r.cap,
          supportNow,
          supportResult: a.support,
          unsupportedAfter: outcome !== null && supportNow !== null && outcome.remaining > supportNow + 1e-9,
          roleText: source ? ROLE_TEXT[source.role] || null : null,
          role: source ? source.role : null,
          source,
          sourceResult: a.source,
          population: staffing ? staffing.population : null,
          staffing,
          staffingResult: a.staffing,
          spare: staffing ? staffing.free : null,
          shortToday: staffing ? staffing.short : false,
          floorText: floorText === undefined ? '' : floorText,
          floorValue: a.floor.value,
          floorInvalid: a.floor.state === 'invalid',
          minimum: staffing ? staffing.minimum : null,
          alreadyShort: staffing ? staffing.minimum === null : false,
          removable: removable ? removable.limit : null,
          removableData: removable,
          removableResult: a.removable,
          bindingText: binding ? binding.text : null,
          bindingColor: binding ? binding.color : '',
          outcome,
          outcomeResult: a.outcome,
          remaining: outcome ? outcome.remaining : null,
          breaksFloor: outcome ? outcome.breaks.includes('floor') : false,
          shortage: outcome ? outcome.shortage : null,
          shortAfter: outcome ? outcome.short : false,
          pool: pool ? pool.stored : null,
          ceiling: pool ? pool.ceiling : null,
          ceilingAfter: pool ? pool.ceilingAfter : null,
          poolResult: a.pool,
          civilianTakes: civilian ? civilian.takes : null,
          civilianLeft: civilian ? civilian.left : null,
          civilianResult: a.civilian,
          futureResult: a.future,
          committedResult: a.committed,
          committedSides: committed,
        }
      })
    },
    // The counts behind the headline: `state` is 'blank' (no batch entered), 'invalid' or 'counted'; then `over` of the `known` colonies cannot give the batch, `smaller` colonies are smaller than the batch and `unknown` are not known.
    headlineState() {
      if (this.batch.state !== 'ok') {
        return { state: this.batch.state, over: 0, known: 0, smaller: 0, unknown: 0 }
      }

      const known = this.items.filter((item) => item.removable !== null && item.outcome)
      const over = known.filter((item) => this.batch.value > item.removable + 1e-9).length
      const smaller = this.items.filter((item) => item.population !== null && this.batch.value > item.population + 1e-9).length

      return { state: 'counted', over, known: known.length, smaller, unknown: this.items.length - known.length - smaller }
    },
    headline() {
      const { state, over, known, smaller, unknown } = this.headlineState

      if (state === 'blank') {
        return 'No batch entered'
      } else if (state === 'invalid') {
        return 'The batch is not a number'
      }

      const extra = [...(smaller ? [`${smaller} smaller than the batch`] : []), ...(unknown ? [`${unknown} not known`] : [])]

      return `${over} of ${known} colonies over the limit${extra.length ? `, ${extra.join(', ')}` : ''}`
    },
  },
  methods: {
    sortNullLast,
    people,
    setFloor(id, text) {
      const rest = { ...this.floors }

      delete rest[id]

      this.floors = typeof text === 'string' && text.trim() !== '' ? { ...rest, [id]: text } : rest
    },
    spareText(item) {
      if (item.spare === null) {
        return '—'
      }

      return item.shortToday ? `short ${people(-item.spare)}` : people(Math.max(0, item.spare))
    },
    splitLines(item) {
      const today = item.staffing
      const after = item.outcome

      return [
        { label: 'Population', today: today ? today.population : null, after: after ? after.remaining : null },
        { label: 'Services', today: today ? today.service : null, after: after ? after.service : null },
        { label: 'Agriculture and environment', today: today ? today.agriculture : null, after: after ? after.agriculture : null },
        { label: 'Workers available', today: today ? today.workers : null, after: after ? after.workers : null },
        { label: 'Workers needed', today: today ? today.required : null, after: after ? after.required : null },
        { label: 'Workers spare', today: today ? Math.max(0, today.free) : null, after: after ? after.spare : null },
        { label: 'Workers short', today: today ? Math.max(0, -today.free) : null, after: after ? after.shortage : null, error: Boolean(after && after.short) },
      ]
    },
    // What stops the removal, in words.
    limitNote(item) {
      const data = item.removableData

      if (!data) {
        return `The limit is unavailable, ${this.missingText(item.removableResult)}.`
      } else if (data.alreadyShort) {
        return 'The colony is short of workers today, so no removal is counted as spare and the limit is 0. The result of the batch is still worked out.'
      }

      const parts = [`Staffing allows ${people(data.staffingLimit)}`, data.floorLimit === null ? 'no retained floor is set' : `the retained floor allows ${people(data.floorLimit)}`]

      return `${parts.join(', ')}.${item.outcome && item.outcome.breaks.length ? ` The batch breaks ${item.outcome.breaks.join(' and ')}.` : ''}`
    },
    pickupText(item) {
      const source = item.source

      if (!source) {
        return 'Unknown'
      }

      return source.eligible ? 'May load colonists' : `No: ${source.reasons.join('; ')}`
    },
    queueLines(item) {
      const sides = item.committedSides
      const both = (pick, format = (value) => people(value)) => ({ supported: format(pick(sides.supported)), possible: format(pick(sides.possible)) })
      const outcomeOf = (side) => side.outcome

      return [
        { label: 'Workers needed', ...both((side) => side.required) },
        { label: 'Staffing floor', ...both((side) => (side.alreadyShort ? null : side.minimum)) },
        { label: 'Can give', ...both((side) => side.limit) },
        { label: 'Bound by', ...both((side) => side.binding, (value) => BINDING[value].text) },
        { label: 'Workers short after the batch', ...both((side) => (outcomeOf(side) ? outcomeOf(side).shortage : null)), error: [sides.supported, sides.possible].some((side) => outcomeOf(side) && outcomeOf(side).short) },
      ]
    },
    missingText(result) {
      return result && result.inputs.missing.length ? `missing ${[...new Set(result.inputs.missing)].join(', ')}` : 'not known'
    },
  },
}
</script>

<style lang="scss" scoped>
.floor-field {
  width: 7em;
  margin-left: auto;
}
</style>
