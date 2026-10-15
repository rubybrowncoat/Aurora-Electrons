<template>
  <v-card class="panel procurement-manifest" data-summary="What a batch of ship hulls still lacks of each component once the stock held at the colonies, the stock held back by claims and the component projects already queued are counted, with where the stock sits, what has to be moved to the build colony and an export of the lot." elevation="1">
    <div class="panel-head">
      <span>Procurement manifest<provenance-mark rule="production.procurementManifest" /></span>
      <span>
        <v-btn small text :disabled="!exportable" aria-label="Download the manifest as CSV" data-manifest-csv @click="downloadCsv"><v-icon small left>mdi-download</v-icon>CSV</v-btn>
        <v-btn small text :disabled="!exportable" aria-label="Copy the manifest as text" data-manifest-copy @click="copyText"><v-icon small left>mdi-content-copy</v-icon>Copy text</v-btn>
      </span>
    </div>
    <div v-if="!classes.length" class="pa-4 text--secondary">The race has no ship class to take components from.</div>
    <div v-else-if="!colonyItems.length" class="pa-4 text--secondary">The race has no colony the components could be needed at.</div>
    <template v-else>
      <div class="manifest-form">
        <div v-for="(plan, index) in plans" :key="plan.id" class="manifest-line">
          <v-autocomplete :value="planClass(plan)" :items="classItems" item-text="text" item-value="id" :label="`Ship class ${index + 1}`" dense outlined hide-details style="max-width: 300px" @input="setPlanClass(plan, $event)" />
          <v-text-field :value="plan.hulls" label="Hulls" type="number" min="1" step="1" dense outlined hide-details :error="invalidPlans.includes(plan.id)" style="max-width: 110px" @input="setHulls(plan, $event)" />
          <v-btn small icon :disabled="plans.length < 2" :aria-label="`Remove the plan of ${planClassName(plan)}`" @click="removePlan(plan)"><v-icon small>mdi-close</v-icon></v-btn>
        </div>
        <div class="manifest-line">
          <v-btn small text data-manifest-add @click="addPlan"><v-icon small left>mdi-plus</v-icon>Add a class</v-btn>
          <v-select :value="targetId" :items="colonyItems" item-text="text" item-value="id" label="Needed at" dense outlined hide-details style="max-width: 280px" @input="chosenTarget = $event" />
        </div>
      </div>
      <div v-if="manifest.invalid" class="px-4 pb-3 error--text" data-manifest-invalid>The manifest needs {{ manifest.invalid }}.</div>
      <template v-else>
        <div class="px-4">
          <stat-tiles :tiles="tiles" compact />
        </div>
        <div class="px-4 pb-2">
          <div v-for="text in manifest.problems" :key="text" class="caption warning--text">{{ text }}</div>
          <div v-if="manifest.unknown.length" class="caption warning--text" data-manifest-unknown>Not known, and so not counted as supply: {{ manifest.unknown.join('; ') }}.</div>
        </div>
        <v-data-table :headers="headers" :items="manifest.rows" item-key="componentId" dense hide-default-footer :items-per-page="-1" no-data-text="The classes mount no component." data-manifest-rows>
          <template #[`item.name`]="{ item }">
            <div class="py-1 text-no-wrap">{{ item.name }}</div>
            <div class="caption text--secondary text-no-wrap">ID {{ item.componentId }} · {{ routeText(item) }}</div>
          </template>
          <template #[`item.needed`]="{ item }">{{ figure(item.needed) }}</template>
          <template #[`item.local`]="{ item }">{{ figure(item.stock.local) }}<span v-if="item.stock.local === null" class="caption text--secondary" title="A stock row with no amount: the units in the other rows are known, the total is not"> ({{ figure(item.stock.known.local) }} known)</span></template>
          <template #[`item.remote`]="{ item }">{{ figure(item.stock.remote) }}<span v-if="item.stock.remote === null" class="caption text--secondary" title="A stock row with no amount: the units in the other rows are known, the total is not"> ({{ figure(item.stock.known.remote) }} known)</span></template>
          <template #[`item.reserved`]="{ item }">
            <span>{{ figure(item.reserved.proven) }}</span>
            <span v-if="item.reserved.unknown > 0" class="warning--text" :title="'Held back by a claim whose size is not known: the stock there beyond the proven reservations'"> + {{ figure(item.reserved.unknown) }} held</span>
          </template>
          <template #[`item.available`]="{ item }">{{ figure(item.available.local) }} here, {{ figure(item.available.remote) }} elsewhere</template>
          <template #[`item.queued`]="{ item }">
            <span>{{ figure(item.queued.local) }}<span v-if="item.queued.local === null" class="caption text--secondary"> ({{ figure(item.queued.known.local) }} known)</span> here, {{ figure(item.queued.remote) }}<span v-if="item.queued.remote === null" class="caption text--secondary"> ({{ figure(item.queued.known.remote) }} known)</span> elsewhere</span>
            <span v-if="item.queued.paused === null || item.queued.paused > 0" class="text--secondary"> · {{ figure(item.queued.paused) }}<span v-if="item.queued.paused === null" class="caption"> ({{ figure(item.queued.known.paused) }} known)</span> paused</span>
          </template>
          <template #[`item.used`]="{ item }">{{ item.needed === null ? 'not known' : `${figure(item.used.stockLocal + item.used.stockRemote)} stock, ${figure(item.used.queuedLocal + item.used.queuedRemote)} queued` }}</template>
          <template #[`item.net`]="{ item }">
            <span :class="item.net > 0 ? 'error--text' : ''">{{ item.netBasis === 'at most' ? 'at most ' : '' }}{{ figure(item.net) }}</span>
          </template>
        </v-data-table>
        <div class="px-4 pt-3 caption text--secondary">Transport to {{ manifest.target.name }}</div>
        <v-data-table :headers="moveHeaders" :items="moveRows" item-key="key" dense hide-default-footer :items-per-page="-1" no-data-text="Nothing has to be moved." data-manifest-moves>
          <template #[`item.units`]="{ item }">{{ figure(item.units) }}</template>
          <template #[`item.tons`]="{ item }">{{ figure(item.tons) }}</template>
          <template #[`item.stage`]="{ item }">{{ item.stage === 'queued' ? 'queued for manufacture there' : 'in stock' }}</template>
          <template #[`item.system`]="{ item }">{{ item.systemName || '—' }}<span v-if="item.sameSystem === true" class="text--secondary"> · the same system</span></template>
        </v-data-table>
        <div class="px-4 pt-3 caption text--secondary">Manufacturing locations</div>
        <v-data-table :headers="manufactureHeaders" :items="manufactureRows" item-key="key" dense hide-default-footer :items-per-page="-1" no-data-text="No component of the plans is queued for manufacture." data-manifest-manufacture>
          <template #[`item.system`]="{ item }">{{ item.systemName || '—' }}<span v-if="item.sameSystem === true" class="text--secondary"> · the same system</span></template>
          <template #[`item.state`]="{ item }">{{ item.state === 'paused' ? 'paused, not supply' : item.state === 'not known' ? 'pause not known, not supply' : 'queued' }}</template>
          <template #[`item.units`]="{ item }">{{ item.incomplete ? 'not known' : figure(item.units) }}<span v-if="item.incomplete && item.units !== null" class="caption text--secondary"> ({{ figure(item.units) }} known)</span></template>
          <template #[`item.used`]="{ item }">{{ item.state === 'queued' ? figure(item.used) : '—' }}</template>
          <template #[`item.unused`]="{ item }">{{ item.state === 'queued' ? figure(item.unused) : '—' }}</template>
        </v-data-table>
        <div class="px-4 pt-3 caption text--secondary">Claims on the stock<provenance-mark rule="production.procurementReservations" /></div>
        <div class="px-4 pb-2 caption" data-manifest-tasks>
          <div v-for="line in taskLines" :key="line.key" :class="line.tone">{{ line.text }}</div>
          <div v-if="!taskLines.length" class="text--secondary">No shipyard task is queued.</div>
        </div>
        <div class="px-4 pb-3">
          <div v-for="entry in entered" :key="entry.id" class="manifest-line">
            <v-select :value="entry.populationId" :items="colonyItems" item-text="text" item-value="id" label="Colony" dense outlined hide-details style="max-width: 240px" @input="setEntry(entry, 'populationId', $event)" />
            <v-select :value="entry.componentId" :items="componentItems" item-text="text" item-value="id" label="Component" dense outlined hide-details style="max-width: 260px" @input="setEntry(entry, 'componentId', $event)" />
            <v-text-field :value="entry.units" label="Units held back" type="number" min="0" step="1" dense outlined hide-details :error="!enteredValid(entry)" style="max-width: 150px" @input="setEntry(entry, 'units', $event)" />
            <v-btn small icon aria-label="Remove the claim" @click="removeEntry(entry)"><v-icon small>mdi-close</v-icon></v-btn>
          </div>
          <v-btn small text :disabled="!componentItems.length" data-manifest-hold @click="addEntry"><v-icon small left>mdi-plus</v-icon>Hold stock back</v-btn>
        </div>
      </template>
      <div v-if="message" class="px-4 pb-2 caption" data-manifest-message>{{ message }}</div>
    </template>
    <div class="panel-foot caption text--secondary">
      The classes are served in the order listed, and a unit of stock or of a queued project goes to one class only: each takes the stock at the colony it is needed at first, then the stock elsewhere (the colonies in the same system first), then the projects queued at the colony and then those elsewhere, so two classes that mount the same component divide what exists. What is short is the need left after that. A component built with the hull (armour, missile engines, prototypes, civilian-line and obsolete parts) has no component project, so its shortage is built with the hull and its stock is still used first. A shipyard task takes the stored components it uses when it is made, so the stock is already net of the tasks in the save; an automatic refit with Use Components on takes stock again for each ship it refits, how many is not stored, and a claim of that kind, a task of a type or class not known, a task list that could not be read and a hand entry that is not a number of 0 or more all hold back the whole stock of the component at the colony until it is known. A row the save leaves without an amount is not known, never none held. A shortage that rests on supply that is not known or not counted is an upper bound and reads "at most". A component the race has not researched (an alien one) is made by neither a project nor the shipyard: it has to be in stock before the hull is built, so what is short of it is listed as not available, never as work the hull covers. A component whose number a hull mounts is not stored leaves the totals that depend on it not known, with the known part beside them. A paused project is listed apart and is not supply. A project whose remaining amount or pause flag the save leaves without a value keeps its colony in the manufacturing locations with its units not known; it is not supply, and the queued total it belongs to is not known, with the known part beside it. The manufacturing locations list every colony with a queued or paused project of a component of the plans, with how much of its output the plans use, whether or not any of it has to be moved. A stock row with no amount makes the stock and what is available at that side not known, with the units of the known rows shown beside it. Cargo already on its way is not counted. The tons to move come from the component's size in the design data. The CSV has one record for each plan, component, transport and claim; an empty cell is not known, never 0.
    </div>
  </v-card>
</template>

<script>
import ProvenanceMark from '../page/ProvenanceMark.vue'
import StatTiles from '../page/StatTiles.vue'
import countFormat from '../../mixins/count-format'
import { TASK_TYPE, defaultTarget, manifestCsv, manifestText, reconcile } from '../../utilities/procurement-manifest'

const HEADERS = [
  { text: 'Component', value: 'name' },
  { text: 'Needed', value: 'needed', align: 'end' },
  { text: 'In stock here', value: 'local', align: 'end', sortable: false },
  { text: 'In stock elsewhere', value: 'remote', align: 'end', sortable: false },
  { text: 'Held back', value: 'reserved', align: 'end', sortable: false },
  { text: 'Available', value: 'available', align: 'end', sortable: false },
  { text: 'Queued', value: 'queued', align: 'end', sortable: false },
  { text: 'Used', value: 'used', align: 'end', sortable: false },
  { text: 'Net shortage', value: 'net', align: 'end' },
]

const MOVE_HEADERS = [
  { text: 'Component', value: 'componentName' },
  { text: 'From', value: 'colonyName' },
  { text: 'System', value: 'system', sortable: false },
  { text: 'Units', value: 'units', align: 'end' },
  { text: 'Tons', value: 'tons', align: 'end' },
  { text: 'Where', value: 'stage', sortable: false },
]

const MANUFACTURE_HEADERS = [
  { text: 'Component', value: 'componentName' },
  { text: 'Made at', value: 'colonyName' },
  { text: 'System', value: 'system', sortable: false },
  { text: 'State', value: 'state', sortable: false },
  { text: 'Units', value: 'units', align: 'end' },
  { text: 'Used by the plans', value: 'used', align: 'end' },
  { text: 'Not used', value: 'unused', align: 'end' },
]

const TASK_NAMES = Object.freeze({ [TASK_TYPE.CONSTRUCTION]: 'Construction', [TASK_TYPE.REPAIR]: 'Repair', [TASK_TYPE.REFIT]: 'Refit', [TASK_TYPE.SCRAP]: 'Scrap', [TASK_TYPE.AUTO_REFIT]: 'Automatic refit' })

// The whole number a text holds, null for anything else or for less than 1.
const wholeNumber = (text) => {
  const value = typeof text === 'string' && text.trim() === '' ? NaN : Number(text)

  return Number.isInteger(value) && value >= 1 ? value : null
}

// The number a text holds, null for a blank or anything else: an amount left blank is not known, never 0.
const numberOf = (text) => {
  const value = typeof text === 'string' && text.trim() === '' ? NaN : Number(text)

  return Number.isFinite(value) ? value : null
}

let serial = 0

export default {
  name: 'ProcurementManifest',
  components: { ProvenanceMark, StatTiles },
  mixins: [countFormat],
  props: {
    // What the page read for the Component calculator: { classes, parts, stock, minerals } as `sourcesOf` shapes them.
    sources: { type: Object, required: true },
    // What the page read for the manifest: { colonies, tasks, projects, components, read } (`loadProcurementSources`).
    procurement: { type: Object, required: true },
  },
  data() {
    return {
      plans: [{ id: ++serial, classId: null, hulls: '1' }],
      chosenTarget: null,
      entered: [],
      message: '',
      headers: HEADERS,
      moveHeaders: MOVE_HEADERS,
      manufactureHeaders: MANUFACTURE_HEADERS,
    }
  },
  computed: {
    classes() {
      return this.sources.classes
    },

    classItems() {
      return this.classes.map((shipClass) => ({ id: shipClass.id, text: shipClass.obsolete ? `${shipClass.name} (obsolete)` : shipClass.name }))
    },

    colonyList() {
      return Object.values(this.procurement.colonies).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    },

    colonyItems() {
      return this.colonyList.map((colony) => ({ id: colony.id, text: colony.systemName ? `${colony.name} (${colony.systemName})` : colony.name }))
    },

    // The plans with their class as chosen, or the first class until one is.
    planList() {
      return this.plans.map((plan) => {
        const classId = this.planClass(plan)
        const shipClass = this.classes.find((entry) => entry.id === classId)

        return { id: plan.id, classId, className: shipClass ? shipClass.name : `Class #${classId}`, hulls: wholeNumber(plan.hulls) }
      })
    },

    invalidPlans() {
      return this.planList.filter((plan) => plan.hulls === null).map((plan) => plan.id)
    },

    // The colony the components are needed at: the one chosen, else the one with a shipyard that holds the most of what the plans need.
    targetId() {
      if (this.chosenTarget !== null && this.procurement.colonies[this.chosenTarget]) {
        return this.chosenTarget
      }

      const best = defaultTarget({ plans: this.planList, parts: this.sources.parts, stock: this.sources.stock, colonies: this.procurement.colonies })

      return best ? best.id : null
    },

    componentItems() {
      const seen = new Map()

      this.planList.forEach((plan) => (this.sources.parts[plan.classId] || []).forEach((part) => seen.set(part.componentId, part.name)))

      return [...seen].map(([id, name]) => ({ id, text: name }))
    },

    manifest() {
      const { read } = this.procurement

      return reconcile({
        plans: this.planList,
        parts: this.sources.parts,
        stock: this.sources.stock,
        colonies: this.procurement.colonies,
        targetId: this.targetId,
        projects: this.procurement.projects,
        projectsRead: read.projects,
        tasks: this.procurement.tasks,
        tasksRead: read.tasks,
        entered: this.entered.map((entry) => ({ populationId: entry.populationId, componentId: entry.componentId, units: numberOf(entry.units) })),
        components: this.procurement.components,
      })
    },

    moveRows() {
      return this.manifest.moves.map((move) => ({ ...move, key: `${move.componentId}-${move.populationId}-${move.stage}` }))
    },

    manufactureRows() {
      return this.manifest.manufacture.map((entry) => ({ ...entry, key: `${entry.componentId}-${entry.populationId}-${entry.state}` }))
    },

    exportable() {
      return !this.manifest.invalid
    },

    tiles() {
      const { totals, rows, target } = this.manifest
      const short = rows.filter((row) => row.net === null || row.net > 0)

      return [
        { label: 'Components short', value: `${short.length} of ${rows.length}`, note: `Needed at ${target.name}`, rule: 'production.procurementManifest' },
        { label: 'Net shortage', value: this.figure(totals.net), note: totals.net === null ? `${this.figure(totals.netKnown)} short among the components whose need is known` : this.shortageNote(totals), rule: 'production.procurementManifest' },
        { label: 'To move', value: totals.units === null ? 'Not known' : `${this.figure(totals.units)} units`, note: totals.units === null ? `${this.figure(totals.unitsKnown)} units, ${this.figure(totals.tonsKnown)} t for the components whose need is known` : totals.tons === null ? 'Tons not known' : `${this.figure(totals.tons)} t`, rule: 'production.procurementManifest' },
        { label: 'Not fully known', value: String(totals.unknownRows), note: totals.unknownRows ? 'Components whose shortage is an upper bound or not known' : 'Every shortage is exact', rule: 'production.procurementReservations' },
      ]
    },

    taskLines() {
      const lines = this.manifest.tasks.map((task) => {
        const colony = this.procurement.colonies[task.populationId]
        const credited = task.credited === null || task.credited <= 0 ? '' : `, ${this.figure(task.credited)} BP credited from stock`

        return { key: `task-${task.taskId}`, tone: task.state === 'successors' || task.state === 'unknown' ? 'warning--text' : 'text--secondary', text: `${TASK_NAMES[task.typeId] || `Task type ${task.typeId}`} #${task.taskId} at ${colony ? colony.name : `colony #${task.populationId}`}: ${task.reason}${credited}` }
      })

      this.manifest.claims.filter((claim) => claim.source !== 'task').forEach((claim, index) => lines.push({ key: `claim-${index}`, tone: claim.proof === 'proven' ? '' : 'warning--text', text: claim.reason }))

      return lines
    },
  },
  methods: {
    figure(value) {
      return this.count(value, Number.isInteger(value) ? 0 : 2)
    },

    routeText(row) {
      return row.route === 'project' ? 'component project' : row.route === 'hull' ? 'built with the hull' : row.route === 'stock' ? 'stock required, not researched by the race' : 'route not known'
    },

    shortageNote(totals) {
      const parts = [[totals.netProject, 'to build as projects'], [totals.netHull, 'with the hull'], [totals.netStock, 'not available (stock required)'], [totals.netRouteUnknown, 'by a route not known']].filter(([value]) => value === null || value > 0)

      return parts.length ? parts.map(([value, text]) => `${this.figure(value)} ${text}`).join(', ') : 'Nothing is short'
    },

    planClass(plan) {
      return plan.classId !== null && this.classes.some((shipClass) => shipClass.id === plan.classId) ? plan.classId : this.classes.length ? this.classes[0].id : null
    },

    planClassName(plan) {
      const shipClass = this.classes.find((entry) => entry.id === this.planClass(plan))

      return shipClass ? shipClass.name : 'the class'
    },

    setPlanClass(plan, classId) {
      plan.classId = classId
    },

    setHulls(plan, text) {
      plan.hulls = text
    },

    addPlan() {
      this.plans.push({ id: ++serial, classId: null, hulls: '1' })
    },

    removePlan(plan) {
      this.plans = this.plans.filter((entry) => entry.id !== plan.id)
    },

    enteredValid(entry) {
      const value = numberOf(entry.units)

      return value !== null && value >= 0
    },

    addEntry() {
      this.entered.push({ id: ++serial, populationId: this.targetId, componentId: this.componentItems.length ? this.componentItems[0].id : null, units: '' })
    },

    setEntry(entry, field, value) {
      entry[field] = value
    },

    removeEntry(entry) {
      this.entered = this.entered.filter((candidate) => candidate.id !== entry.id)
    },

    downloadCsv() {
      const link = document.createElement('a')

      link.href = URL.createObjectURL(new Blob([manifestCsv(this.manifest)], { type: 'text/csv' }))
      link.download = 'procurement-manifest.csv'
      link.click()
      URL.revokeObjectURL(link.href)
    },

    async copyText() {
      try {
        await navigator.clipboard.writeText(manifestText(this.manifest, { count: (value) => this.figure(value) }))
        this.message = 'The text was copied.'
      } catch (error) {
        this.message = `The text could not be copied (${error && error.message ? error.message : 'the clipboard is not available'}).`
      }
    },
  },
}
</script>

<style lang="scss">
.procurement-manifest {
  .manifest-form {
    padding: 12px 16px;
  }

  .manifest-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
