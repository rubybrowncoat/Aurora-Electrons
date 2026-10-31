<template>
  <v-card class="panel component-calculator" data-summary="Estimate the construction capacity share needed to build a ship class's manufactured components at a colony by a deadline." elevation="1">
    <div class="panel-head">
      <span>Component calculator<provenance-mark rule="production.componentPlan" /></span>
      <span class="d-flex align-center">
        <v-chip x-small label color="warning" class="mr-2" data-wip-chip>WIP</v-chip>
        <v-btn small text :disabled="!hasEdits" @click="resetStock">Reset stock</v-btn>
      </span>
    </div>
    <wip-notice title="The component calculator" panel />
    <div v-if="!classes.length" class="pa-4 text--secondary">The race has no ship class to take components from.</div>
    <div v-else-if="!colonies.length" class="pa-4 text--secondary">The race has no colony with construction capacity to build components.</div>
    <template v-else>
      <div class="calculator-form">
        <v-autocomplete :value="chosenClass" :items="classItems" item-text="text" item-value="id" label="Ship class" dense outlined hide-details style="max-width: 300px" @input="classId = $event" />
        <v-autocomplete :value="chosenColony" :items="colonies" item-text="name" item-value="id" label="Colony" dense outlined hide-details style="max-width: 240px" @input="populationId = $event" />
        <v-text-field v-model="hulls" label="Hulls" type="number" min="1" step="1" dense outlined hide-details :error="hullCount === null" style="max-width: 110px" />
        <v-text-field v-model="deadline" label="Deadline, days from now" type="number" min="1" dense outlined hide-details :error="deadlineDays === null" style="max-width: 200px" />
        <span class="caption text--secondary">{{ deadlineDate }}</span>
      </div>
      <div class="px-4">
        <stat-tiles :tiles="tiles" compact />
      </div>
      <div class="px-4 pb-2">
        <v-progress-linear v-if="computing" indeterminate height="2" class="mb-2" />
        <div v-for="line in verdict" :key="line.text" class="verdict" :class="line.tone ? `${line.tone}--text` : ''">
          <v-icon small :color="line.tone" class="mr-1">{{ line.icon }}</v-icon>{{ line.text }}<router-link v-if="line.mineral" :to="mineralLink(line.mineral)" class="ml-1">{{ line.mineral.name }} in the Mineral Breakdown</router-link>
        </div>
        <div v-for="text in effects" :key="text" class="caption text--secondary">{{ text }}</div>
      </div>
      <v-data-table :headers="headers" :items="rows" item-key="componentId" dense hide-default-footer :items-per-page="-1" no-data-text="The class mounts no component.">
        <template #[`item.name`]="{ item }">
          <div class="py-1 text-no-wrap">{{ item.name }}</div>
        </template>
        <template #[`item.perHull`]="{ item }">{{ figure(item.perHull) }}</template>
        <template #[`item.needed`]="{ item }">{{ figure(item.needed) }}</template>
        <template #[`item.used`]="{ item }">{{ figure(item.used) }}</template>
        <template #[`item.held`]="{ item }">
          <v-text-field :value="stockText(item)" type="number" min="0" step="1" dense single-line hide-details :placeholder="item.held === null ? 'not known' : ''" :error="item.held === null || invalidStock.includes(item.componentId)" :aria-label="`Stock of ${item.name}`" class="stock-field" @input="setStock(item.componentId, $event)" />
        </template>
        <template #[`item.units`]="{ item }">
          <span v-if="item.buildable === true">{{ count(item.units) }}</span>
          <span v-else class="text--secondary" :title="item.buildable === false ? item.why : item.missing.join('; ')">—</span>
        </template>
        <template #[`item.bp`]="{ item }">
          <span v-if="item.buildable === true">{{ count(item.bp) }}</span>
          <span v-else class="text--secondary">—</span>
        </template>
        <template #[`item.share`]="{ item }">
          <span v-if="item.share !== null">{{ count(item.share, 2) }}%</span>
          <span v-else class="text--secondary">—</span>
        </template>
        <template #[`item.note`]="{ item }">
          <span class="caption text--secondary">{{ item.note }}</span>
        </template>
      </v-data-table>
    </template>
    <div class="panel-foot caption text--secondary">
      Use it to test how a different stock or deadline changes the share of construction a colony needs. Stock held is used once across all the hulls together. The rest is built by one project for each component, which draws on the construction capacity and the shared minerals. A row the save leaves without an amount is not known. A figure typed over it is an assumption, dropped when the save is read again. The share needed is the least that finishes every project by the deadline in the production forecast. It is marked "at most" when sampled over a wide range and "at least" when above the whole capacity. Where the search is not settled, the panel says so instead of saying the colony cannot do it. Armour, missile engines, civilian-line components, prototypes and obsolete components are built with the hull, and a component the race has not researched cannot be built by a project. None of them is in the share. Stock at other colonies is not counted.
    </div>
  </v-card>
</template>

<script>
import { mapGetters } from 'vuex'

import ProvenanceMark from '../page/ProvenanceMark.vue'
import StatTiles from '../page/StatTiles.vue'
import WipNotice from '../page/WipNotice.vue'
import countFormat from '../../mixins/count-format'
import { gameTime } from '../../utilities/aurora'
import { planRun, requirements, stockWith } from '../../utilities/component-calc'
import { linkTo } from '../../utilities/deep-links'
import { MINERALS } from '../../utilities/minerals'
import { isAvailable } from '../../utilities/provenance'
import { RESPONSIVENESS, RUN_STATUS, TERMINATION, createRun, createRunSlot } from '../../utilities/search-run'

const SECONDS_PER_DAY = 86400

const HEADERS = [
  { text: 'Component', value: 'name' },
  { text: 'Per hull', value: 'perHull', align: 'end' },
  { text: 'Needed', value: 'needed', align: 'end' },
  { text: 'In stock', value: 'held', align: 'end', sortable: false },
  { text: 'Used', value: 'used', align: 'end' },
  { text: 'To build', value: 'units', align: 'end' },
  { text: 'Build points', value: 'bp', align: 'end' },
  { text: 'Share', value: 'share', align: 'end' },
  { text: 'Note', value: 'note', sortable: false },
]

// A new task as soon as the browser has had its turn, which still comes in a hidden window.
const nextTask = () => new Promise((resolve) => {
  const channel = new MessageChannel()

  channel.port1.onmessage = () => resolve()
  channel.port2.postMessage(null)
})

// The whole number a text holds, null for anything else or for less than 1.
const wholeNumber = (text) => {
  const value = typeof text === 'string' && text.trim() === '' ? NaN : Number(text)

  return Number.isInteger(value) && value >= 1 ? value : null
}

export default {
  name: 'ComponentCalculator',
  components: { ProvenanceMark, StatTiles, WipNotice },
  mixins: [countFormat],
  props: {
    // What the page read: { classes, parts, stock, minerals } as `sourcesOf` shapes them.
    sources: { type: Object, required: true },
    // The colonies that can build components: [{ id, name, capacities, modifiers }].
    colonies: { type: Array, required: true },
    // The industrial projects of every colony, as the page reads them.
    industry: { type: Array, required: true },
    // The stock entered by hand on the page, which the forecast counts.
    arrivals: { type: Array, required: true },
    npr: { type: Boolean, default: false },
  },
  data() {
    return {
      classId: null,
      populationId: null,
      hulls: '1',
      deadline: '365',
      edits: {},
      planState: Object.freeze({ key: null, plan: null, error: null }),
      headers: HEADERS,
    }
  },
  computed: {
    ...mapGetters(['StartYear', 'GameTime', 'RaceID']),

    classes() {
      return this.sources.classes
    },

    classItems() {
      return this.classes.map((shipClass) => ({ id: shipClass.id, text: shipClass.obsolete ? `${shipClass.name} (obsolete)` : shipClass.name }))
    },

    // The class and colony the form names, or the first class not obsolete and the colony with the most construction capacity until one is chosen.
    chosenClass() {
      const found = this.classes.find((shipClass) => shipClass.id === this.classId)

      return (found || this.classes.find((shipClass) => !shipClass.obsolete) || this.classes[0] || { id: null }).id
    },

    chosenColony() {
      const found = this.colonies.find((colony) => colony.id === this.populationId)
      const capacity = (colony) => (isAvailable(colony.capacities.construction) ? colony.capacities.construction.value : -1)

      return (found || this.colonies.reduce((best, colony) => (!best || capacity(colony) > capacity(best) ? colony : best), null) || { id: null }).id
    },

    parts() {
      return this.sources.parts[this.chosenClass] || []
    },

    colonyEdits() {
      return this.edits[this.chosenColony] || {}
    },

    hasEdits() {
      return Object.keys(this.colonyEdits).length > 0
    },

    // The colony's stock of each component with what was typed over it.
    stockState() {
      return stockWith(this.sources.stock[this.chosenColony] || {}, this.colonyEdits)
    },

    invalidStock() {
      return this.stockState.invalid
    },

    hullCount() {
      return wholeNumber(this.hulls)
    },

    deadlineDays() {
      const days = typeof this.deadline === 'string' && this.deadline.trim() === '' ? NaN : Number(this.deadline)

      return Number.isFinite(days) && days > 0 ? days : null
    },

    deadlineDate() {
      return this.deadlineDays === null ? '' : this.dateIn(this.deadlineDays)
    },

    // The class's components against the hulls and the stock: local, nothing is read again.
    needs() {
      return requirements({ parts: this.parts, hulls: this.hullCount, stock: this.stockState.stock })
    },

    // What the calculation is given, null while the form names no colony or class.
    runInput() {
      const colony = this.colonies.find((candidate) => candidate.id === this.chosenColony)

      if (!colony || this.chosenClass === null) {
        return null
      }

      return {
        parts: this.parts,
        hulls: this.hullCount,
        stock: this.stockState.stock,
        deadline: this.deadlineDays,
        colony: {
          populationId: colony.id,
          projects: this.industry.filter((project) => project.PopulationID === colony.id),
          capacities: colony.capacities,
          modifiers: colony.modifiers,
          arrivals: this.arrivals.filter((arrival) => arrival.PopulationID === colony.id),
          npr: this.npr,
          minerals: this.sources.minerals[colony.id] || null,
        },
      }
    },

    runKey() {
      return this.runInput && !this.needs.invalid ? JSON.stringify(this.runInput) : null
    },

    // The plan of the input the form holds now: null while it is being worked out.
    plan() {
      return this.runKey !== null && this.planState.key === this.runKey ? this.planState.plan : null
    },

    computing() {
      return this.runKey !== null && this.planState.key !== this.runKey
    },

    rows() {
      const shares = Object.fromEntries(((this.plan && this.plan.allocation) || []).map((entry) => [entry.componentId, entry.share]))

      return [...(this.needs.rows || [])].sort((a, b) => (b.bp || 0) - (a.bp || 0) || (b.needed || 0) * (b.cost || 0) - (a.needed || 0) * (a.cost || 0)).map((row) => ({
        ...row,
        share: shares[row.componentId] === undefined ? null : shares[row.componentId],
        note: row.buildable === false ? row.why : row.buildable === null ? `not known: ${row.missing.join('; ')}` : row.surplus > 0 ? `${this.count(row.surplus, 2)} spare` : '',
      }))
    },

    tiles() {
      const needs = this.needs
      const plan = this.plan

      if (needs.invalid) {
        return [{ label: 'Components to build', value: '—', note: `Needs ${needs.invalid}` }]
      }

      const known = !needs.unknown
      const free = plan && plan.available !== null ? plan.available : null

      return [
        { label: 'Components to build', value: known ? `${this.count(needs.units)} units` : '—', note: known ? `${this.count(needs.bp)} BP · the stock covers ${this.count(needs.stockBP)} of ${this.count(needs.neededBP)} BP` : `Not known: ${needs.unknown.join('; ')}` },
        { label: 'Share needed', value: plan && plan.required !== null ? `${this.sharePrefix(plan)}${this.count(plan.required, 2)}%` : this.computing ? '…' : '—', note: plan && plan.status === 'covered' ? 'The stock covers every component a project would build' : plan && plan.unreachable ? (plan.settled ? 'Not reachable at any share of the capacity' : 'Not settled: no share tried reaches it; minerals are contested') : plan && plan.requiredKind === 'found' ? 'Found by search; minerals are contested, so a smaller share may do it' : plan && plan.floorShare !== null ? `No schedule needs less than ${this.count(plan.floorShare, 2)}% of ${this.count(plan.capacity)} BP a year` : 'Capacity or deadline not known' },
        { label: 'Share free', value: free !== null ? `${this.count(free, 2)}%` : '—', note: plan && plan.held !== null ? `${this.count(plan.held, 2)}% held by projects out of the queue, paused ones included` : 'Not known' },
        { label: 'Finish', value: plan && plan.finish && plan.finish.latest !== null ? this.dateIn(plan.finish.latest) : plan && plan.status === 'covered' ? 'Now' : '—', note: plan && plan.finish ? this.finishNote(plan) : 'Forecast not made' },
      ]
    },

    // The lines under the tiles: whether the deadline can be met, and why not.
    verdict() {
      const plan = this.plan

      if (this.needs.invalid) {
        return [{ icon: 'mdi-help-circle-outline', text: `Not known: enter ${this.needs.invalid}.` }]
      }

      if (this.deadlineDays === null) {
        return [{ icon: 'mdi-help-circle-outline', text: 'Not known: enter a deadline of one day or more.' }]
      }

      if (!plan) {
        return this.computing ? [{ icon: 'mdi-progress-clock', text: 'The colony\'s production cycles are being run forward with the batch added.' }] : []
      }

      if (plan.status === 'covered') {
        return [{ icon: 'mdi-check-circle-outline', tone: 'success', text: 'The stock holds every component a project would build: no share is needed.' }]
      }

      if (plan.status === 'unknown') {
        return [{ icon: 'mdi-help-circle-outline', text: `Not known: missing ${plan.gaps.join('; ')}.` }]
      }

      if (plan.status === 'feasible') {
        const lines = [{ icon: 'mdi-check-circle-outline', tone: 'success', text: `The colony can do it: ${plan.allocation.length} component ${plan.allocation.length === 1 ? 'project' : 'projects'} at ${this.count(plan.required, 2)}% of its construction capacity finish ${this.finishWords(plan)}, with ${this.count(plan.available - plan.required, 2)}% still free.` }]

        if (plan.contested && plan.requiredKind === 'found') {
          lines.push({ icon: 'mdi-information-outline', text: 'Found by a search of the shares: the colony\'s minerals are contested, so a larger share can miss a deadline a smaller one meets, and a smaller share than this may do it.' })
        } else if (plan.contested) {
          lines.push({ icon: 'mdi-information-outline', text: 'The colony\'s minerals are contested, so every share from the floor up was tried in the forecast: no smaller share does it.' })
        }

        return lines
      }

      const lines = []
      const mineral = plan.stalled ? MINERALS.find((candidate) => candidate.name === plan.stalled.name) : null
      const shareShort = plan.required !== null && plan.shortfall !== null
      const projects = this.needs.rows.filter((row) => row.units > 0).length
      const grid = shareShort && Math.floor(plan.available * 100 + 1e-6) < projects
      const share = `${this.count(plan.required, 2)}%`

      if (plan.status === 'searchLimited') {
        lines.push({ icon: 'mdi-help-circle-outline', tone: 'warning', text: `Not settled: no share tried within the ${this.count(plan.available, 2)}% that is free finished the batch by the deadline. The colony's minerals are contested and the range of shares is too wide to try each, so a share that was not tried may do it.` })

        if (plan.required !== null) {
          lines.push({ icon: 'mdi-information-outline', text: `The smallest share found that does it is ${this.count(plan.required, 2)}% of the construction capacity, which needs the other projects out of the queue to hold less: ${this.releaseText(plan)}. That release is for this share only; a smaller share that was not tried may need less of it, or none.` })
        } else {
          lines.push({ icon: 'mdi-information-outline', text: 'No share tried up to the whole capacity did it either.' })
        }
      } else if (shareShort) {
        const needs = plan.requiredKind === 'found' ? `the deadline is met at ${share} of its construction capacity (found by a search of the shares: the colony's minerals are contested, so a smaller share may do it)` : `the deadline needs ${plan.requiredKind === 'floor' ? 'at least ' : ''}${share} of its construction capacity`

        lines.push({ icon: 'mdi-alert-circle-outline', tone: 'error', text: `The colony cannot do it: ${needs} (${this.count(plan.capacity)} BP a year) and ${this.count(plan.available, 2)}% is free, short by ${this.count(plan.shortfall.share, 2)} percentage points, ${this.count(plan.shortfall.bpPerYear)} BP a year. Its other projects out of the queue would have to hold that much less.${grid ? ` ${projects} component projects hold at least 0.01% each, which the free share does not cover.` : ''}` })

        if (plan.release.length) {
          lines.push({ icon: 'mdi-swap-vertical', text: `Run with the other projects releasing that share, paused ones first and then the others, the newest first: ${this.releaseText(plan)}.` })
        }
      } else if (!plan.stalled) {
        lines.push({ icon: 'mdi-alert-circle-outline', tone: 'error', text: plan.settled ? `The colony cannot do it at any share: ${plan.why.join('; ')}.` : `No share tried does it: ${plan.why.join('; ')}, with the other projects out of the queue released, paused ones first and then the others, the newest first. The colony's minerals are contested, so a share between those tried may.` })
      }

      if (plan.stalled) {
        lines.push({ icon: 'mdi-alert-circle-outline', tone: 'error', text: `${plan.status === 'searchLimited' ? 'In the runs tried, the' : shareShort ? 'Besides, the' : !plan.settled ? 'No share tried does it: the' : 'The colony cannot do it at any share: the'} colony's stock of ${plan.stalled.name} runs out before ${plan.stalled.componentName} is built. That is a shortage of minerals, not of components.`, mineral })
      }

      if (plan.finish && plan.finish.latest !== null && plan.available > 0) {
        lines.push({ icon: 'mdi-calendar-alert', tone: 'warning', text: `At the ${this.count(plan.available, 2)}% that is free the batch finishes ${this.finishWords(plan)}, ${this.count(plan.finish.latest - this.deadlineDays, 1)} days after the deadline.` })
      } else if (plan.available <= 0) {
        lines.push({ icon: 'mdi-calendar-alert', tone: 'warning', text: 'No share is free: the colony\'s projects out of the queue hold all of it.' })
      }

      return lines
    },

    // The colony's own projects the batch would move, as lines of text.
    effects() {
      const plan = this.plan

      if (!plan || !plan.displaced || !plan.displaced.length) {
        return []
      }

      const when = (days) => (days === null ? 'never' : this.dateIn(days))

      return plan.displaced.map((entry) => `Starting the batch moves ${entry.name} from ${when(entry.before)} to ${when(entry.after)}.`)
    },
  },
  watch: {
    // Another race or another read of the save starts with the stock the save holds.
    RaceID() {
      this.edits = {}
      this.classId = null
      this.populationId = null
    },

    sources() {
      this.edits = {}
    },

    // The calculation is run again whenever anything it is made from changes.
    runKey: {
      immediate: true,
      handler() {
        this.start()
      },
    },
  },
  beforeDestroy() {
    if (this.slot) {
      this.slot.invalidate(TERMINATION.CLOSED)
    }
  },
  methods: {
    // A count of components: whole where it is whole, to two places where a hull mounts a fraction of one.
    figure(value) {
      return this.count(value, Number.isInteger(value) ? 0 : 2)
    },

    dateIn(days) {
      return gameTime(this.StartYear, this.GameTime + days * SECONDS_PER_DAY).format('YYYY-MM-DD')
    },

    mineralLink(mineral) {
      return linkTo.minerals({ mineral: mineral.id })
    },

    // The latest finish is the batch's in the worst order tried; the earliest is only a bound, the latest of the projects' own earliest dates, since the forecast does not give the batch's finish in any one order.
    finishNote(plan) {
      const { earliest, latest, sampled } = plan.finish

      if (latest === null) {
        return 'Not finished in some orders of the colony\'s projects'
      }

      return `In ${this.duration(latest)}${sampled ? ', the latest of the orders tried' : ''}${earliest !== null && earliest < latest ? `; no order finishes it before ${this.duration(earliest)}` : ''}`
    },

    finishWords(plan) {
      const { earliest, latest, sampled } = plan.finish

      return latest === null ? 'later than the forecast reaches' : `on ${this.dateIn(latest)}, in ${this.duration(latest)}${sampled ? ' (the latest of the orders tried)' : ''}${earliest !== null && earliest < latest ? ` (no order finishes it before ${this.duration(earliest)})` : ''}`
    },

    // How the share needed reads: nothing before an exact least, "at most" before a share the search found (a smaller one may exist), "at least" before a floor.
    sharePrefix(plan) {
      return plan.requiredKind === 'found' ? '≤ ' : plan.requiredKind === 'floor' ? '≥ ' : ''
    },

    // The other projects' release a share above the free one assumes, as text: each project with its share before and after.
    releaseText(plan) {
      return plan.release.map((entry) => `${entry.name}${entry.paused ? ' (paused)' : ''} from ${this.count(entry.from, 2)}% to ${this.count(entry.to, 2)}%`).join(', ')
    },

    // What the stock cell shows: the figure typed over the colony's stock, or the stock itself.
    stockText(row) {
      return Object.prototype.hasOwnProperty.call(this.colonyEdits, row.componentId) ? this.colonyEdits[row.componentId] : row.held === null ? '' : String(row.held)
    },

    // A figure typed in the stock cell; the cell emptied or set back to the save's own figure drops the edit.
    setStock(componentId, text) {
      const saved = (this.sources.stock[this.chosenColony] || {})[componentId]
      const base = saved === undefined ? '0' : saved === null ? null : String(saved)
      const colony = { ...this.colonyEdits }

      if (text === base) {
        delete colony[componentId]
      } else {
        colony[componentId] = text
      }

      this.edits = { ...this.edits, [this.chosenColony]: colony }
    },

    resetStock() {
      this.edits = { ...this.edits, [this.chosenColony]: {} }
    },

    // The slot that keeps the one run whose result is shown; made on first use, not reactive (it holds live generators).
    runSlot() {
      if (!this.slot) {
        this.slot = createRunSlot()
      }

      return this.slot
    },

    // Ends the run going, if any, and starts the calculation of the input as it is now.
    start() {
      const slot = this.runSlot()
      const input = this.runInput
      const key = this.runKey

      slot.invalidate(TERMINATION.INPUT_CHANGED)

      if (key === null) {
        return Promise.resolve()
      }

      return this.drive(slot.start(createRun({ kind: 'component-plan', input, domain: { signature: 'component-batch', total: 1 }, search: (pace) => planRun(input, pace) })), key)
    },

    // Runs a calculation a slice at a time with a turn for the browser between slices, then keeps its outcome with the key of the input it was for.
    async drive(run, key) {
      const slot = this.runSlot()

      try {
        while (run.running) {
          run.advance(RESPONSIVENESS.sliceMs)

          if (run.running) {
            await nextTask()
          }

          if (!slot.isCurrent(run)) {
            return
          }
        }

        const outcome = slot.publish(run)

        if (outcome) {
          this.planState = Object.freeze({ key, plan: outcome.result && outcome.status === RUN_STATUS.COMPLETE ? outcome.result.plan : null, error: outcome.error || null })
        }
      } catch (error) {
        if (slot.isCurrent(run)) {
          this.planState = Object.freeze({ key, plan: null, error: error.message })
        }
      }
    },
  },
}
</script>

<style lang="scss">
.component-calculator {
  .calculator-form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
  }

  .verdict {
    display: flex;
    align-items: center;
    margin: 2px 0;
  }

  .stock-field {
    width: 88px;
    margin-left: auto;
    padding-top: 0;
    margin-top: 0;

    input {
      text-align: right;
    }
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
