<template>
  <v-card class="panel platform-paths" data-summary="The ways a mining platform class is produced for a quantity, a shipyard build or the colony industry's station project: the time, build points, minerals and labour of each path that can build it, the capacity each occupies, the minerals the colony lacks and the blocker for a class that cannot be built. Use it to compare the paths colony by colony." elevation="1">
    <div class="panel-head">
      <span>Platform production paths<provenance-mark rule="platformPaths.yard" label /></span>
      <span class="d-flex align-center flex-wrap controls">
        <v-autocomplete :value="chosenId" :items="classItems" item-text="text" item-value="id" label="Class" dense outlined hide-details clearable class="class-picker" @input="classId = $event" />
        <v-text-field v-model="quantity" label="Platforms" type="number" min="1" :max="maxPlatforms" step="1" dense outlined hide-details :error="platforms === null" class="quantity-field" />
      </span>
    </div>
    <div v-if="!classItems.length" class="panel-body caption text--secondary">The race has no ship class to produce.</div>
    <div v-else-if="!chosen" class="panel-body caption text--secondary">Pick a class to compare the paths that produce it. A class with mining modules is a mining platform.</div>
    <template v-else>
      <div class="px-4">
        <stat-tiles :tiles="tiles" compact />
      </div>
      <div class="px-4 pb-2">
        <div v-for="line in verdict" :key="line.text" class="verdict" :class="line.tone ? `${line.tone}--text` : ''">
          <v-icon small :color="line.tone" class="mr-1">{{ line.icon }}</v-icon>{{ line.text }}
        </div>
      </div>
      <div v-if="comparison.length" class="px-4 pb-2">
        <div class="caption font-weight-medium">Per colony, on the colony's rates and stock now<provenance-mark rule="platformPaths.industry" /></div>
        <div v-for="line in comparison" :key="line.populationId" class="caption">
          <span class="font-weight-medium">{{ line.colony || `Colony ${line.populationId}` }}</span>: {{ line.text }}
        </div>
      </div>
      <v-data-table :headers="headers" :items="rows" item-key="key" :custom-sort="sortNullLast" :sort-by.sync="table.sortBy" :sort-desc.sync="table.sortDesc" dense disable-pagination hide-default-footer no-data-text="No shipyard or colony can be shown for the class.">
        <template #[`item.where`]="{ item }">
          <div class="py-1">
            <div class="font-weight-medium text-no-wrap">{{ item.pathLabel }}</div>
            <div class="caption text--secondary">{{ item.where }}{{ item.colony ? ` · ${item.colony}` : '' }}</div>
          </div>
        </template>
        <template #[`item.rank`]="{ item }">
          <div class="py-1">
            <v-chip x-small label :color="item.view.color || undefined" class="text-no-wrap"><v-icon x-small left>{{ item.view.icon }}</v-icon>{{ item.view.label }}</v-chip>
            <div v-for="text in item.reasons" :key="text" class="caption text--secondary">{{ text }}</div>
            <div v-for="text in item.gaps" :key="text" class="caption warning--text">Not known: {{ text }}</div>
          </div>
        </template>
        <template #[`item.days`]="{ item }">
          <span v-if="item.days !== null" class="text-no-wrap">{{ duration(item.days) }}<provenance-mark :result="item.timeResult" /></span>
          <span v-else class="text--secondary text-no-wrap">—<provenance-mark :result="item.timeResult" /></span>
          <div v-if="item.timeNote" class="caption text--secondary">{{ item.timeNote }}</div>
        </template>
        <template #[`item.bp`]="{ item }">
          <span v-if="item.bp !== null" class="text-no-wrap">{{ count(item.bp, 0) }}<provenance-mark :result="recipe.result" /></span>
          <span v-else class="text--secondary">—</span>
        </template>
        <template #[`item.mineralTotal`]="{ item }">
          <div v-if="item.mineralTotal !== null" class="text-no-wrap">{{ count(item.mineralTotal, 0) }} t<provenance-mark :result="recipe.result" /></div>
          <div v-else class="text--secondary">—</div>
          <div v-if="item.shortText" class="caption" :class="item.shortText.startsWith('Short') ? 'warning--text' : 'text--secondary'">{{ item.shortText }}</div>
        </template>
        <template #[`item.labourMillions`]="{ item }">
          <span v-if="item.labourMillions !== null" class="text-no-wrap">{{ count(item.labourMillions, 3) }} M<provenance-mark :result="item.labour.result" /></span>
          <span v-else class="text--secondary text-no-wrap">—<provenance-mark :result="item.labour.result" /></span>
        </template>
        <template #[`item.occupancy`]="{ item }">
          <span class="caption">{{ item.occupancy }}</span>
        </template>
      </v-data-table>
    </template>
    <div class="panel-foot caption text--secondary">
      A class has two production paths. A shipyard builds one platform for each task, one task for each free slipway at a time, each at the yard's full rate for the class, and a task takes the colony's stored components of the class first, which lowers its build points and minerals. A colony's industry builds the finished class as a station project, which takes a share of the colony's construction capacity, uses no slipway and no stored component, and needs a spaceport and a class that is the race's own, not obsolete, without armour and without a prototype component. A component the race has not researched must be in the colony's own stock: a yard task uses it up, so the stock must hold it for every platform asked, and a station project only checks for one hull's worth, which it neither uses up nor credits. The component projects of the Production page are no third path: they only credit what a yard task takes. The occupied capacity counts: a yard with no free slipway and a colony whose projects out of the queue hold the whole capacity have no time, as the time left on the work now running is not counted, and a share the projects hold is not free. A path that makes no progress, a task whose build points the stored components cover wholly or a colony whose shipbuilding output is 0, has no time. A rate, a capacity or a stock the save does not give leaves the figure not known, never nought. The labour is the workers the capacity already holds, whether or not it builds, so a platform adds none, and a worker shortage lowers both paths through the colony's efficiency. The comparison is for one colony at its rates and stock today and names no path as cheaper or quicker in general; a colony short of minerals gets the rate-only order as a condition, if the missing minerals are obtained, and no verdict; the retool's own minerals are not counted.<provenance-mark rule="platformPaths.recipe" /><provenance-mark rule="platformPaths.stationClass" /><provenance-mark rule="platformPaths.spaceport" />
    </div>
  </v-card>
</template>

<script>
import ProvenanceMark from '../page/ProvenanceMark.vue'
import StatTiles from '../page/StatTiles.vue'
import countFormat from '../../mixins/count-format'
import persistedView, { tableView } from '../../mixins/persisted-view'
import { MINERALS } from '../../utilities/minerals'
import { MAX_PLATFORMS, comparePaths } from '../../utilities/platform-paths'
import { sortNullLast } from '../../utilities/production'

const HEADERS = [
  { text: 'Path', value: 'where' },
  { text: 'Status', value: 'rank' },
  { text: 'Time', value: 'days', align: 'end' },
  { text: 'Build points', value: 'bp', align: 'end' },
  { text: 'Minerals', value: 'mineralTotal', align: 'end' },
  { text: 'Labour held', value: 'labourMillions', align: 'end' },
  { text: 'Capacity', value: 'occupancy', sortable: false },
]

// What each state of a path reads as: a label, an icon, a colour, and `rank` for sorting (the paths that can start first, those not known last).
const STATE_VIEW = {
  capable: { label: 'Can build it', icon: 'mdi-check-circle', color: 'success', rank: 0 },
  busy: { label: 'Busy: no free capacity', icon: 'mdi-progress-clock', color: 'info', rank: 1 },
  retool: { label: 'Retool first', icon: 'mdi-wrench-outline', color: 'warning', rank: 2 },
  stalled: { label: 'Makes no progress', icon: 'mdi-timer-sand-empty', color: 'warning', rank: 3 },
  ineligible: { label: 'Cannot', icon: 'mdi-close-circle-outline', color: '', rank: 4 },
  unsupported: { label: 'Not covered', icon: 'mdi-minus-circle-outline', color: '', rank: 5 },
  unknown: { label: 'Not known', icon: 'mdi-help-circle-outline', color: 'warning', rank: null },
}

const PATH_LABELS = { yard: 'Shipyard build', industry: 'Industry station project' }

const QUICKER_TEXT = {
  yard: (yard, industry, duration) => `the shipyard (${yard.where}, ${duration(yard.days)}) is quicker than the industry (${duration(industry.days)})`,
  industry: (yard, industry, duration) => `the industry (${duration(industry.days)}) is quicker than the shipyard (${yard.where}, ${duration(yard.days)})`,
  same: (yard, industry, duration) => `the shipyard (${yard.where}) and the industry take the same time, ${duration(industry.days)}`,
}

// Why a path has no time, for the line of a colony's comparison: `what` names the path.
const withoutTime = (row, what) => {
  const reasons = row.reasons.length ? `: ${row.reasons.join('; ')}` : ''

  if (row.state === 'ineligible') {
    return `the ${what} route is closed${reasons}`
  }

  if (row.state === 'stalled') {
    return `the ${what} makes no progress${reasons}`
  }

  if (row.state === 'busy') {
    return `the ${what} has no free capacity${reasons}`
  }

  return `the ${what}'s time is not known${row.missing.length ? `: ${row.missing.join('; ')}` : ''}`
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// The whole number a text of digits holds, from 1 to the most platforms a comparison takes; null for anything else, a number written with an exponent included.
const wholeNumber = (text) => {
  const value = typeof text === 'string' && /^\s*\d{1,6}\s*$/.test(text) ? Number(text) : NaN

  return Number.isInteger(value) && value >= 1 && value <= MAX_PLATFORMS ? value : null
}

export default {
  name: 'PlatformPaths',
  components: { ProvenanceMark, StatTiles },
  mixins: [
    countFormat,
    persistedView({
      classId: { key: 'shipyardsPlatformClass', default: null, scope: 'race', normalise: (stored) => (Number.isSafeInteger(stored) && stored > 0 ? stored : null) },
      quantity: { key: 'shipyardsPlatformQuantity', default: '1', valid: (value) => typeof value === 'string' && value.length <= 6 },
      table: tableView('shipyardsPlatformTable', { sortBy: ['rank'], sortDesc: false }),
    }),
  ],
  props: {
    // The race's classes as loadRefitClasses reads them.
    classes: { type: Array, required: true },
    // What loadPlatformSources reads of each class: { [ShipClassID]: { noArmour, miningModules } }.
    extras: { type: Object, required: true },
    // The components by id, as loadRefitClasses reads them.
    components: { type: Object, required: true },
    // The shipyards, as loadYards reads them.
    yards: { type: Array, required: true },
    // The colonies: { [PopulationID]: { name, modifiers, capacity, projects, stock, minerals, spaceports, factories, installationUnknown } }.
    colonies: { type: Object, required: true },
    // The eligibility context the Shipyards page builds, and the save's formula version.
    context: { type: Object, required: true },
    version: { type: String, default: null },
    // Which components of the race's classes the race has researched: { [ComponentID]: 1, 0 or null }, null when not read.
    researched: { type: Object, default: null },
  },
  data() {
    return { headers: HEADERS, maxPlatforms: MAX_PLATFORMS }
  },
  computed: {
    classItems() {
      const { extras } = this

      return this.classes.map((shipClass) => {
        const mining = extras[shipClass.id] && extras[shipClass.id].miningModules > 0

        return { id: shipClass.id, text: `${shipClass.name}${mining ? ' · mining platform' : ''}`, mining: Boolean(mining) }
      }).sort((a, b) => Number(b.mining) - Number(a.mining) || a.text.localeCompare(b.text))
    },
    chosen() {
      return this.classes.find((shipClass) => shipClass.id === this.classId) || null
    },
    chosenId() {
      return this.chosen ? this.chosen.id : null
    },
    platforms() {
      return wholeNumber(this.quantity)
    },
    paths() {
      const { chosen } = this

      if (!chosen) {
        return null
      }

      const extra = this.extras[chosen.id] || {}
      const noArmour = typeof extra.noArmour === 'boolean' ? extra.noArmour : null

      return comparePaths({ shipClass: chosen, noArmour, components: this.components, researched: this.researched, quantity: this.platforms, yards: this.yards, colonies: this.colonies, context: this.context, version: this.version })
    },
    recipe() {
      return this.paths.recipe
    },
    comparison() {
      return this.paths.comparison.map((line) => ({ populationId: line.populationId, colony: line.colony, text: this.comparisonText(line) }))
    },
    rows() {
      return this.paths.rows.map((row) => {
        const view = STATE_VIEW[row.state]
        const mineralTotal = row.minerals ? MINERALS.reduce((total, { name }) => total + row.minerals[name], 0) : null

        return {
          ...row,
          view,
          rank: view.rank,
          pathLabel: PATH_LABELS[row.path],
          reasons: row.reasons,
          gaps: row.missing,
          mineralTotal,
          shortText: this.shortText(row),
          labourMillions: isNumber(row.labour.millions) ? row.labour.millions : null,
          timeNote: this.timeNote(row),
          occupancy: this.occupancy(row),
        }
      })
    },
    tiles() {
      const { paths, platforms, rows } = this
      const { recipe, station } = paths
      const able = rows.filter((row) => row.state === 'capable').length
      const unknown = rows.filter((row) => row.state === 'unknown').length
      const verdict = station.state === 'capable' ? 'Buildable as a station' : station.state === 'ineligible' ? 'Not buildable as a station' : 'Not known'
      const total = recipe.minerals ? MINERALS.reduce((sum, { name }) => sum + recipe.minerals[name], 0) : null

      return [
        { label: 'Industry route', value: verdict, note: station.blockers[0] || station.missing[0] || 'Armourless, the race\'s own and not obsolete', rule: 'platformPaths.stationClass' },
        { label: 'Build points each', value: this.count(recipe.bp, 0), note: platforms === null ? 'No quantity entered' : `For ${this.count(platforms, 0)} platforms: ${this.count(isNumber(recipe.bp) ? recipe.bp * platforms : null, 0)}`, result: recipe.result },
        { label: 'Minerals each', value: total === null ? '—' : `${this.count(total, 0)} t`, note: platforms === null ? 'No quantity entered' : `For ${this.count(platforms, 0)} platforms: ${total === null ? '—' : `${this.count(total * platforms, 0)} t`}, before any stored components`, result: recipe.result },
        { label: 'Paths that can build it', value: platforms === null ? '—' : String(able), note: `Of ${rows.length} paths${unknown ? `; ${unknown} not known, not counted` : ''}`, rule: 'platformPaths.yard' },
      ]
    },
    verdict() {
      const { paths } = this
      const lines = []

      if (paths.invalid) {
        lines.push({ tone: 'warning', icon: 'mdi-alert-circle-outline', text: `Enter ${paths.invalid} as a whole number from 1 to ${MAX_PLATFORMS}.` })
      }

      paths.station.blockers.forEach((text) => lines.push({ tone: 'warning', icon: 'mdi-close-circle-outline', text: `The industry route is closed: ${text}.` }))
      paths.station.missing.forEach((text) => lines.push({ tone: 'warning', icon: 'mdi-help-circle-outline', text: `Not known: ${text}.` }))

      if (paths.recipe.missing.length) {
        lines.push({ tone: 'warning', icon: 'mdi-help-circle-outline', text: `The recipe is not complete: ${paths.recipe.missing.join('; ')}.` })
      }

      return lines
    },
  },
  methods: {
    sortNullLast,
    shortNames(row) {
      const names = MINERALS.filter(({ name }) => row.short && row.short[name] > 0)

      return names.map(({ name }) => `${name} ${this.count(row.short[name], 0)}`).join(', ')
    },
    shortText(row) {
      if (row.minerals === null) {
        return ''
      }

      if (row.short === null) {
        return 'Stock not known'
      }

      const names = this.shortNames(row)

      return names ? `Short: ${names}` : 'Stock covers it'
    },
    comparisonText({ yards, yard, industry, supply, quicker, rateQuicker }) {
      if (yard === null || industry.days === null) {
        const reasons = [...(yard === null ? yards.map((row) => withoutTime(row, `shipyard ${row.where}`)) : []), ...(industry.days === null ? [withoutTime(industry, 'industry')] : [])]

        return `no comparison: ${reasons.join('; ')}`
      }

      if (quicker !== null) {
        return QUICKER_TEXT[quicker](yard, industry, this.duration)
      }

      const short = [['shipyard', yard], ['industry', industry]].filter(([, row]) => this.shortNames(row)).map(([name, row]) => `${name}: ${this.shortNames(row)}`)
      const condition = supply === 'short' ? `if the missing minerals are obtained (${short.join('; ')})` : 'if the minerals are held, which the stock does not show'

      return `no verdict on the colony's stock; on the rates alone ${QUICKER_TEXT[rateQuicker](yard, industry, this.duration)}, ${condition}`
    },
    timeNote(row) {
      const notes = []

      if (row.retoolDays) {
        notes.push(`includes a retool of ${this.duration(row.retoolDays)}`)
      }

      if (row.days !== null && row.firstDays !== null && row.firstDays < row.days - 1e-9) {
        notes.push(`first platform after ${this.duration(row.firstDays)}`)
      }

      return notes.join('; ')
    },
    occupancy(row) {
      if (row.path === 'yard') {
        const slipways = row.slipways

        return slipways && isNumber(slipways.total) ? `${this.count(slipways.free, 0)} of ${this.count(slipways.total, 0)} slipways free` : 'Slipways not known'
      }

      if (row.share === null) {
        return 'Share not known'
      }

      return row.share > 0 ? `Takes ${this.count(row.share, 2)}% of the construction capacity` : 'No free share of the construction capacity'
    },
  },
}
</script>

<style lang="scss">
.platform-paths {
  .controls {
    gap: 12px;
  }

  .class-picker {
    min-width: 220px;
    max-width: 320px;
  }

  .quantity-field {
    max-width: 110px;
  }
}
</style>
