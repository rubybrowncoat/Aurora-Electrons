<template>
  <div>
    <v-container fluid class="shipyards-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <stat-tiles :tiles="tiles" />

        <v-card class="panel" data-summary="Every refit between the race's ship classes, one direction at a time: its time, its cost against each class and how many yards can take it or be retooled for it. Use it to find upgrades worth refitting and to avoid needless tooling changes." elevation="1">
          <div class="panel-head">
            <span>Refit matrix<provenance-mark rule="refit.cost" label /></span>
            <span class="d-flex align-center flex-wrap controls">
              <v-btn-toggle v-model="view" mandatory dense>
                <v-btn v-for="option in viewOptions" :key="option.value" :value="option.value" small>{{ option.label }}</v-btn>
              </v-btn-toggle>
              <v-switch v-model="sizeWindow" label="Within 20% of the size" dense hide-details class="mt-0" />
              <v-switch v-model="shipsOnly" label="Classes with ships" dense hide-details class="mt-0" />
              <v-switch v-model="hideObsolete" label="Hide obsolete" dense hide-details class="mt-0" />
              <v-text-field v-model="search" label="Search" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable class="search-field" />
            </span>
          </div>
          <div class="panel-body">
            <div v-if="matrix.tooLarge" class="caption text--secondary">The filters leave {{ count(matrix.pairs) }} pairs, more than the matrix draws at once ({{ count(matrixLimit) }}). {{ narrowHint }}</div>
            <div v-else-if="!matrix.rows.length || !matrix.columns.length" class="caption text--secondary">No class matches the filters.</div>
            <div v-else class="matrix-scroll">
              <table class="refit-matrix" aria-label="Refit time and cost from each class (rows) to each class (columns)">
                <thead>
                  <tr>
                    <th class="corner" scope="col">From ↓ · To →</th>
                    <th v-for="target in matrix.columns" :key="target.id" scope="col" class="column-head" :class="{ 'is-selected': target.id === toId }" :title="target.name">
                      <span class="class-name">{{ target.name }}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in matrix.rows" :key="row.source.id">
                    <th scope="row" class="row-head" :class="{ 'is-selected': row.source.id === fromId }">
                      <span class="d-flex align-center">
                        <span class="flex-grow-1 class-name" :title="row.source.name">{{ row.source.name }}<span class="caption text--secondary d-block">{{ shipsText(row.source.id) }}</span></span>
                        <page-link :to="linkTo.propulsion({ class: row.source.id })" :name="row.source.name" />
                      </span>
                    </th>
                    <td v-for="cell in row.cells" :key="cell.target.id" class="matrix-cell" :class="{ 'is-same': cell.state === 'same', 'is-selected': row.source.id === fromId && cell.target.id === toId }">
                      <span v-if="cell.state === 'outside'" class="text--secondary" title="Outside the size window: clear the filter to price it, or pick the two classes above.">·</span>
                      <button v-else-if="cell.state === 'priced'" type="button" class="cell-button" :title="cellTitle(row.source, cell)" :aria-label="cellTitle(row.source, cell)" @click="selectPair(row.source, cell.target)">
                        <span class="cell-time">
                          <template v-if="cell.days !== null">{{ duration(cell.days) }}</template>
                          <template v-else-if="cell.info.none">No yard</template>
                          <template v-else>—<provenance-mark :result="cell.time" /></template>
                        </span>
                        <span class="cell-share">S {{ percent(cell.shareSource) }} · T {{ percent(cell.shareTarget) }}</span>
                        <span class="cell-yards">
                          <v-icon v-if="cell.noRetool.ok === true" x-small color="success">mdi-check</v-icon>
                          <v-icon x-small>mdi-wrench-outline</v-icon>{{ yardsText(cell.info.refitYards, cell.info.unknownYards) }}
                          <v-icon x-small>mdi-tools</v-icon>{{ yardsText(cell.info.retoolYards, cell.info.unknownRetools) }}
                        </span>
                      </button>
                      <span v-else-if="cell.state === 'unpriced'" class="cell-button cell-unpriced" :title="describeResult(cell.refit.total)">—<provenance-mark :result="cell.refit.total" /></span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="panel-foot caption text--secondary">
            A cell is a refit of a ship of the row's class into the column's class; the opposite cell is a separate figure. Its time is at the quickest yard that takes the column's class, one slipway working; a dash means a yard's eligibility or rate is not known, so the quickest is not known either. S and T are the refit's cost as a share of the source (row) class's cost and of the target (column) class's cost. The wrench is the number of yards that take the target class for a refit or a build; the tools are the yards that can be retooled for it; a ≥ marks a count that has yards not known either way. A check mark: a yard tooled for the source builds or refits to the target without retooling. Components the target drops earn no credit. With the size window on, a class with no partner inside the window leaves the matrix.
          </div>
        </v-card>

        <v-card class="panel" data-summary="One refit in full: what it costs by part, its minerals, the components that change and the ships that would take it. Use it to see why a refit is dear and whether the reverse refit is cheaper." elevation="1">
          <div class="panel-head">
            <span>Selected refit<provenance-mark rule="refit.minerals" label /></span>
            <span class="d-flex align-center flex-wrap controls">
              <v-autocomplete v-model="fromId" :items="classOptions" item-text="name" item-value="id" label="From class" dense outlined hide-details clearable class="class-picker" />
              <v-btn icon small title="Swap the two classes" aria-label="Swap the two classes" :disabled="!fromId && !toId" @click="swapPair"><v-icon>mdi-swap-horizontal</v-icon></v-btn>
              <v-autocomplete v-model="toId" :items="classOptions" item-text="name" item-value="id" label="To class" dense outlined hide-details clearable class="class-picker" />
            </span>
          </div>
          <div v-if="!detail" class="panel-body caption text--secondary">{{ pairHint }}</div>
          <div v-else class="panel-body">
            <div class="d-flex align-center flex-wrap pair-title">
              <span class="font-weight-medium">{{ pair.from.name }}</span>
              <page-link :to="linkTo.propulsion({ class: pair.from.id })" :name="pair.from.name" />
              <v-icon small class="mx-1">mdi-arrow-right</v-icon>
              <span class="font-weight-medium">{{ pair.to.name }}</span>
              <page-link :to="linkTo.propulsion({ class: pair.to.id })" :name="pair.to.name" />
            </div>
            <v-row dense>
              <v-col cols="12" md="5">
                <v-simple-table dense class="breakdown">
                  <tbody>
                    <tr v-for="line in detail.lines" :key="line.label" :class="{ 'font-weight-medium': line.strong }">
                      <td>{{ line.label }}</td>
                      <td class="text-right">{{ count(figureOf(line.result), 1) }} BP<provenance-mark :result="line.result" /></td>
                    </tr>
                    <tr>
                      <td>Share of the source class's cost ({{ pair.from.name }}, {{ count(pair.from.cost, 1) }} BP)</td>
                      <td class="text-right">{{ percent(detail.shareSource) }}<provenance-mark :result="detail.shareSource" /></td>
                    </tr>
                    <tr>
                      <td>Share of the target class's cost ({{ pair.to.name }}, {{ count(pair.to.cost, 1) }} BP)</td>
                      <td class="text-right">{{ percent(detail.shareTarget) }}<provenance-mark :result="detail.shareTarget" /></td>
                    </tr>
                    <tr>
                      <td>Time{{ detail.yard ? ` at ${detail.yard.name}, the quickest yard` : '' }}</td>
                      <td class="text-right">
                        <template v-if="detail.days !== null">{{ duration(detail.days) }}</template>
                        <template v-else-if="detail.info.none">No yard takes the target class</template>
                        <template v-else>—</template>
                        <provenance-mark v-if="!detail.info.none" :result="detail.time" />
                      </td>
                    </tr>
                    <tr>
                      <td>The reverse refit ({{ pair.to.name }} to {{ pair.from.name }})</td>
                      <td class="text-right">{{ count(figureOf(detail.reverse.total), 1) }} BP<provenance-mark :result="detail.reverse.total" /></td>
                    </tr>
                    <tr>
                      <td>Ships of the source class · of the target class</td>
                      <td class="text-right">{{ count(shipCountOf(pair.from.id)) }} · {{ count(shipCountOf(pair.to.id)) }}</td>
                    </tr>
                    <tr>
                      <td>Running refits of this pair</td>
                      <td class="text-right">{{ count(runningOfPair) }}</td>
                    </tr>
                  </tbody>
                </v-simple-table>
                <div class="mt-3">
                  <div class="caption text--secondary">Minerals<provenance-mark :result="detail.minerals" /></div>
                  <div v-if="mineralChips.length" class="d-flex flex-wrap chips">
                    <v-chip v-for="chip in mineralChips" :key="chip.name" small label>{{ chip.name }} {{ count(chip.amount, 1) }}</v-chip>
                  </div>
                  <div v-else-if="isAvailable(detail.minerals)" class="caption text--secondary">No minerals: nothing is added.</div>
                  <div v-else class="caption text--secondary">—</div>
                </div>
              </v-col>
              <v-col cols="12" md="7">
                <v-simple-table dense>
                  <thead>
                    <tr>
                      <th>Component</th>
                      <th class="text-right">In {{ pair.from.name }}</th>
                      <th class="text-right">In {{ pair.to.name }}</th>
                      <th class="text-right">Change</th>
                      <th class="text-right">Cost each (BP)</th>
                      <th class="text-right">Added (BP)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="change in detail.changes" :key="change.id" :class="{ 'text--secondary': change.added === 0 }">
                      <td>{{ change.name }}</td>
                      <td class="text-right">{{ count(change.from, 2) }}</td>
                      <td class="text-right">{{ count(change.to, 2) }}</td>
                      <td class="text-right">{{ change.unknown.length ? '—' : change.added > 0 ? `+${count(change.added, 2)}` : `−${count(change.removed, 2)} (no credit)` }}</td>
                      <td class="text-right">{{ count(change.cost, 1) }}</td>
                      <td class="text-right">
                        <template v-if="change.addedBP === null">—<provenance-mark :result="detail.total" /></template>
                        <template v-else>{{ count(change.addedBP, 1) }}</template>
                      </td>
                    </tr>
                    <tr v-if="!detail.changes.length">
                      <td colspan="6" class="text--secondary">The two classes mount the same components.</td>
                    </tr>
                  </tbody>
                </v-simple-table>
              </v-col>
            </v-row>
          </div>
          <div class="panel-foot caption text--secondary">
            The cost is the added components' cost times 1.2 plus the size change (the difference in size over the source class's size). Percentages name their denominator: the source class is what the ship is worth as it stands, the target class what a new one costs. A removed component refunds nothing, so the minerals count the added parts only, each count at one decimal.<provenance-mark rule="refit.cost" />
          </div>
        </v-card>

        <v-card class="panel" data-summary="The race's shipyards against the selected refit: which can take the target class, how long the refit takes at each, and what retooling each to the target costs from its own tooled class. Use it to pick a yard and to see whether it needs retooling." elevation="1">
          <div class="panel-head">
            <span>Yards for the selected refit<provenance-mark rule="refit.retool" label /></span>
          </div>
          <div v-if="!detail" class="panel-body caption text--secondary">{{ pairHint }}</div>
          <v-data-table v-else :headers="yardHeaders" :items="yardRows" item-key="id" :custom-sort="sortNullLast" :sort-by.sync="yardsTable.sortBy" :sort-desc.sync="yardsTable.sortDesc" disable-pagination hide-default-footer>
            <template #[`item.name`]="{ item }">
              <div class="py-2 d-flex align-center">
                <div class="flex-grow-1">
                  <div class="font-weight-medium">{{ item.name }}</div>
                  <div class="caption text--secondary">{{ item.colony || '—' }}</div>
                </div>
                <page-link v-if="item.populationId" :to="linkTo.production(item.populationId)" :name="item.colony || ''" />
              </div>
            </template>
            <template #[`item.slipways`]="{ item }">{{ count(item.slipways) }}</template>
            <template #[`item.capacity`]="{ item }">{{ count(item.capacity) }}</template>
            <template #[`item.tooledName`]="{ item }">
              <span v-if="item.tooled === undefined" class="text-no-wrap">—<provenance-mark :result="item.tooledGap" /></span>
              <span v-else-if="item.tooled === null" class="text--secondary">None</span>
              <span v-else>{{ item.tooledName }}</span>
            </template>
            <template #[`item.takesSort`]="{ item }">
              <span class="text-no-wrap">
                <v-icon small :color="item.takes.color">{{ item.takes.icon }}</v-icon>
                {{ item.takes.label }}
              </span>
              <div v-if="item.takes.note" class="caption text--secondary">{{ item.takes.note }}</div>
            </template>
            <template #[`item.refitDays`]="{ item }">
              <span v-if="item.takes.status !== 'ok'" class="text--secondary">—</span>
              <span v-else class="text-no-wrap">{{ item.refitDays === null ? '—' : duration(item.refitDays) }}<provenance-mark :result="item.refitTime" /></span>
            </template>
            <template #[`item.retoolCost`]="{ item }">
              <span v-if="item.retool.state === 'priced'" class="text-no-wrap">{{ count(item.retool.cost, 1) }} BP · {{ item.retool.days === null ? '—' : duration(item.retool.days) }}<provenance-mark :result="item.retool.costResult" /><provenance-mark :result="item.retool.timeResult" /></span>
              <span v-else-if="item.retool.state === 'unknown'" class="text-no-wrap">—<provenance-mark :result="item.retool.gap" /></span>
              <span v-else>{{ item.retool.label }}</span>
              <div v-if="item.retool.note" class="caption text--secondary">{{ item.retool.note }}</div>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            A retool costs the lesser of the refit from the yard's own tooled class to the target and the target's cost, times 0.5 plus 0.25 per slipway, times the race's shipyard operations, and is shared among the slipways. A yard with no tooled class, or one tooled for a class whose refit costs nothing, is retooled at once. A yard tooled for a class within 20% of the target's size whose refit costs at most a fifth of that class's needs no retool. Repair yards are not covered.<provenance-mark rule="refit.noRetool" />
          </div>
        </v-card>

        <v-card v-if="runningRows.length" class="panel" data-summary="Refits and retools the yards are working on now, each with the cost the save stores beside the cost the rules give. Use it to check the rules against the game and to see when the work ends." elevation="1">
          <div class="panel-head">
            <span>Running refits and retools<provenance-mark rule="production.shipFinish" label /></span>
          </div>
          <v-data-table :headers="runningHeaders" :items="runningRows" item-key="key" :custom-sort="sortNullLast" :sort-by.sync="runningTable.sortBy" :sort-desc.sync="runningTable.sortDesc" disable-pagination hide-default-footer>
            <template #[`item.name`]="{ item }">
              <div class="py-2">
                <div class="font-weight-medium">{{ item.name }}</div>
                <div class="caption text--secondary">{{ item.kind }}{{ item.yardName ? ` · ${item.yardName}` : '' }}</div>
              </div>
            </template>
            <template #[`item.sourceName`]="{ item }">
              <span class="d-flex align-center">
                {{ item.sourceName }}
                <page-link v-if="item.sourceId" :to="linkTo.propulsion({ class: item.sourceId })" :name="item.sourceName" />
              </span>
            </template>
            <template #[`item.targetName`]="{ item }">
              <span class="d-flex align-center">
                {{ item.targetName }}
                <page-link v-if="item.targetId" :to="linkTo.propulsion({ class: item.targetId })" :name="item.targetName" />
                <v-btn v-if="item.sourceId && item.targetId" icon x-small title="Show this refit above" aria-label="Show this refit above" @click="selectPairById(item.sourceId, item.targetId)"><v-icon small>mdi-eye-outline</v-icon></v-btn>
              </span>
            </template>
            <template #[`item.stored`]="{ item }">{{ count(item.stored, 1) }}</template>
            <template #[`item.expected`]="{ item }">
              <span v-if="item.expected !== null">{{ count(item.expected, 1) }}</span>
              <span v-else class="text-no-wrap">—<provenance-mark :result="item.expectedResult" /></span>
            </template>
            <template #[`item.agree`]="{ item }">
              <span v-if="item.matches === true" class="text-no-wrap"><v-icon small color="success">mdi-check-circle</v-icon> Agrees</span>
              <span v-else-if="item.matches === false" class="text-no-wrap"><v-icon small color="warning">mdi-alert-circle-outline</v-icon> Differs by {{ count(Math.abs(item.expected - item.stored), 2) }}</span>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #[`item.done`]="{ item }">{{ item.done === null ? '—' : `${count(item.done, 0)}%` }}</template>
            <template #[`item.daysSort`]="{ item }">
              <span v-if="item.statusLabel" class="text--secondary">{{ item.statusLabel }}</span>
              <span v-else-if="item.days !== null" class="text-no-wrap">{{ duration(item.days) }}<provenance-mark :result="item.finish" /></span>
              <span v-else class="text--secondary text-no-wrap">—<provenance-mark :result="item.finish" /></span>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            The time left is the one the Production Recap shows: the stored cost not yet done over the colony's shipyard rate for the task. A retool's cost is the rules' figure from the yard's tooled class to the class it is retooled to.<provenance-mark rule="refit.retool" />
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import countFormat from '../mixins/count-format'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import productionModifiers from '../mixins/production-modifiers'
import { linkTo, queryId } from '../utilities/deep-links'
import { tracked } from '../utilities/load-tracking'
import { UNKNOWN_TEXT } from '../utilities/math'
import { MINERALS } from '../utilities/minerals'
import { finishDays, flagOf, shipRate, shipyardFinish, shipyardUpgradeRate, sortNullLast } from '../utilities/production'
import { describeResult, isAvailable, unavailable, valueOrNull } from '../utilities/provenance'
import { REFIT_TASK_TYPES, SHIPYARD_TYPE, checkRefitTask, checkRetoolTask, costShare, inBand, loadRefitClasses, loadRefitTasks, loadRetoolTasks, loadShipCounts, loadYards, noRetoolCheck, refitCost, refitRate, refitTime, refitTotal, retoolCost, retoolTime, yardAccepts, yardRetools } from '../utilities/refits'
import { loadFormulaVersion } from '../utilities/transport'

const INPUT_LABELS = {
  refitData: 'the ship classes and their components',
  shipCounts: 'the ships',
  yards: 'the shipyards',
  refitTasks: 'the running refits',
  retoolTasks: 'the running retools',
  populationProductionModifiers: 'the colonies\' production rates',
  formulaVersion: 'the save\'s schema',
}
const VIEW_OPTIONS = [{ value: 'refits', label: 'Refits' }]
// The most cells the matrix prices and draws at once: a page of thousands of priced cells is slow to read and to scroll.
const MATRIX_PAIR_LIMIT = 4000

const YARD_TYPES = { [SHIPYARD_TYPE.NAVAL]: 'Naval', [SHIPYARD_TYPE.COMMERCIAL]: 'Commercial', [SHIPYARD_TYPE.REPAIR]: 'Repair' }

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

export default {
  name: 'ShipyardsPage',
  components: { LoadState, PageLink, ProvenanceMark, StatTiles },
  mixins: [
    countFormat,
    deepLink,
    loadState(INPUT_LABELS),
    productionModifiers,
    persistedView({
      view: { key: 'shipyardsView', default: 'refits', valid: oneOf(VIEW_OPTIONS.map((option) => option.value)) },
      sizeWindow: { key: 'shipyardsSizeWindow', default: true },
      shipsOnly: { key: 'shipyardsShipsOnly', default: true },
      hideObsolete: { key: 'shipyardsHideObsolete', default: true },
      search: { key: 'shipyardsSearch', default: '', scope: 'race' },
      yardsTable: tableView('shipyardsYardsTable', { sortBy: ['name'], sortDesc: false }),
      runningTable: tableView('shipyardsRunningTable', { sortBy: ['daysSort'], sortDesc: false }),
    }),
  ],
  data() {
    return {
      fromId: null,
      toId: null,
      viewOptions: VIEW_OPTIONS,
      matrixLimit: MATRIX_PAIR_LIMIT,
      linkTo,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    classes() {
      return this.refitData.classes
    },

    components() {
      return this.refitData.components
    },

    classById() {
      return Object.fromEntries(this.classes.map((shipClass) => [shipClass.id, shipClass]))
    },

    classOptions() {
      return this.classes.map((shipClass) => ({ id: shipClass.id, name: shipClass.name }))
    },

    pair() {
      const from = this.classById[this.fromId]
      const to = this.classById[this.toId]

      return from && to && from.id !== to.id ? { from, to } : null
    },

    pairHint() {
      if (this.fromId && this.toId && this.fromId === this.toId) {
        return 'Pick two different classes: a refit of a class into itself changes nothing.'
      } else if ((this.fromId && !this.classById[this.fromId]) || (this.toId && !this.classById[this.toId])) {
        return 'A class named by the link is not one of the race\'s classes.'
      }

      return 'Select a cell of the matrix, or pick the two classes, to see the refit in full.'
    },

    modifiersOf() {
      return this.populationProductionModifiers
    },

    // For each class as a refit's target: the yards that take it (a build or a refit), the yards not yet known to, the yards that can be retooled for it, and the quickest yard's rate for a refit. `none` is that no yard takes it, which is a fact. `gap` says what leaves the quickest yard unknown: a yard that might take the class with an input missing, or a rate that is missing. While a gap stands there is no `best`, as the quickest of the yards known would not be the quickest of them all. Read once per class, as a cell's time only divides by it.
    targetInfo() {
      const { classes, yards, modifiersOf } = this
      const info = {}

      classes.forEach((target) => {
        let refitYards = 0
        let unknownYards = 0
        let retoolYards = 0
        let unknownRetools = 0
        let best = null
        const missing = []

        yards.forEach((yard) => {
          const accepts = yardAccepts(yard, target)

          if (accepts.status === 'ok') {
            refitYards++

            const rate = refitRate(modifiersOf[yard.populationId], target)

            if (!isAvailable(rate)) {
              missing.push(...rate.inputs.missing.map((input) => `${input} (${yard.name})`))
            } else if (!best || rate.value > best.rate.value) {
              best = { rate, yard }
            }
          } else if (accepts.status === 'unknown') {
            unknownYards++
            missing.push(...accepts.missing.map((input) => `${input} (${yard.name})`))
          }

          const retools = yardRetools(yard, target)

          if (retools.status === 'ok') {
            retoolYards++
          } else if (retools.status === 'unknown') {
            unknownRetools++
          }
        })

        const gap = missing.length ? unavailable({ rule: 'refit.time', missing: [...new Set(missing)], units: 'days' }) : null

        info[target.id] = { refitYards, unknownYards, retoolYards, unknownRetools, best: gap ? null : best, gap, none: refitYards === 0 && unknownYards === 0 }
      })

      return info
    },

    searchText() {
      return (this.search || '').toLowerCase()
    },

    // Which filters would narrow a matrix that is too big to draw.
    narrowHint() {
      const off = [!this.sizeWindow ? 'turn on "Within 20% of the size"' : '', !this.shipsOnly ? 'turn on "Classes with ships"' : '', !this.hideObsolete ? 'turn on "Hide obsolete"' : ''].filter(Boolean)

      return off.length ? `Narrow them: ${off.join(', ')} or search for a class.` : 'Narrow them: search for a class.'
    },

    // The matrix: the rows are the classes ships can be refitted from, the columns the classes they can become, each cell priced once. `rows[].cells[]` are { target, state ('same'; 'outside' the size window, both sizes known; 'priced'; or 'unpriced' when a figure is missing), refit, days, time, shareSource, shareTarget, noRetool, info }. With the size window on, a row or column with no pair in the window is left out, which keeps a save with many classes to the pairs worth reading. `tooLarge` is set, with `pairs` the cells to price, when the matrix would be too big to draw.
    matrix() {
      const { classes, components, formulaVersion, shipCounts, targetInfo, sizeWindow, shipsOnly, hideObsolete, searchText, fromId, toId } = this
      const matches = (shipClass) => !searchText || shipClass.name.toLowerCase().includes(searchText)
      const priceable = (source, target) => source.id !== target.id && !(sizeWindow && inBand(source, target) === false)
      const candidateRows = classes.filter((shipClass) => shipClass.id === fromId || (matches(shipClass) && (!shipsOnly || shipCounts[shipClass.id] > 0) && (!hideObsolete || shipClass.obsolete !== true || shipCounts[shipClass.id] > 0)))
      const candidateColumns = classes.filter((shipClass) => shipClass.id === toId || (matches(shipClass) && (!hideObsolete || shipClass.obsolete !== true)))
      const columns = sizeWindow ? candidateColumns.filter((target) => target.id === toId || candidateRows.some((source) => priceable(source, target))) : candidateColumns
      const rowClasses = sizeWindow ? candidateRows.filter((source) => source.id === fromId || columns.some((target) => priceable(source, target))) : candidateRows
      const pairs = rowClasses.reduce((total, source) => total + columns.filter((target) => priceable(source, target)).length, 0)

      if (pairs > MATRIX_PAIR_LIMIT) {
        return { rows: [], columns: [], pairs, tooLarge: true, priced: 0, unpriced: 0 }
      }

      const rows = []
      let priced = 0
      let unpriced = 0

      rowClasses.forEach((source) => {
        const cells = columns.map((target) => {
          const info = targetInfo[target.id]

          if (target.id === source.id) {
            return { target, state: 'same' }
          } else if (!priceable(source, target)) {
            return { target, state: 'outside' }
          }

          const refit = refitTotal(source, target, components, formulaVersion)

          if (!isAvailable(refit.total)) {
            unpriced++

            return { target, state: 'unpriced', refit }
          }

          priced++

          const time = info.none ? null : refitTime(refit.total, info.gap || info.best.rate)

          return { target, state: 'priced', refit, time, days: valueOrNull(time), shareSource: costShare(refit.total, { name: source.name, cost: source.cost }), shareTarget: costShare(refit.total, { name: target.name, cost: target.cost }), noRetool: noRetoolCheck(source, target, refit.total, formulaVersion), info }
        })

        rows.push({ source, cells })
      })

      return { rows, columns, pairs, priced, unpriced }
    },

    detail() {
      const { pair } = this

      if (!pair) {
        return null
      }

      const { components, formulaVersion, targetInfo } = this
      const refit = refitCost(pair.from, pair.to, components, formulaVersion)
      const info = targetInfo[pair.to.id]
      const time = info.none ? null : refitTime(refit.total, info.gap || info.best.rate)

      return {
        ...refit,
        lines: [
          { label: 'Added components', result: refit.added },
          { label: 'Yard overhead (20% of the added cost)', result: refit.overhead },
          { label: 'Size change (share of the added cost)', result: refit.surcharge },
          { label: 'Refit cost', result: refit.total, strong: true },
        ],
        shareSource: costShare(refit.total, { name: pair.from.name, cost: pair.from.cost }),
        shareTarget: costShare(refit.total, { name: pair.to.name, cost: pair.to.cost }),
        reverse: refitTotal(pair.to, pair.from, components, formulaVersion),
        info,
        yard: info.best ? info.best.yard : null,
        time,
        days: valueOrNull(time),
      }
    },

    mineralChips() {
      const amounts = this.detail ? valueOrNull(this.detail.minerals) : null

      return amounts ? MINERALS.filter(({ name }) => amounts[name] > 0).map(({ name }) => ({ name, amount: amounts[name] })) : []
    },

    runningOfPair() {
      const { pair } = this

      return pair ? this.refitTasks.filter((task) => task.SourceClassID === pair.from.id && task.TargetClassID === pair.to.id).length : 0
    },

    // One row for each shipyard against the selected refit, with the retool costed from the yard's own tooled class.
    yardRows() {
      const { pair, detail, classById, components, formulaVersion, modifiersOf } = this

      if (!pair) {
        return []
      }

      return this.yards.map((yard) => {
        const modifiers = modifiersOf[yard.populationId]
        const takes = this.takesOf(yardAccepts(yard, pair.to))
        const rate = takes.status === 'ok' ? refitRate(modifiers, pair.to) : null
        const refitTimeResult = rate ? refitTime(detail.total, rate) : null
        const tooledClass = yard.tooledId ? classById[yard.tooledId] || null : null
        const tooled = yard.tooledId === undefined || (yard.tooledId && !tooledClass) ? undefined : tooledClass
        const base = { id: yard.id, name: yard.name, populationId: yard.populationId, colony: yard.colony, type: YARD_TYPES[yard.type] || UNKNOWN_TEXT, slipways: yard.slipways, capacity: yard.capacity, tooled, tooledName: tooled ? tooled.name : null, tooledGap: unavailable({ rule: 'refit.retool', missing: ['the class the yard is tooled for'], units: 'BP' }), takes, takesSort: takes.rank, refitDays: valueOrNull(refitTimeResult), refitTime: refitTimeResult }

        return { ...base, retool: this.retoolOf(yard, base.tooled, pair.to, modifiers, components, formulaVersion) }
      }).map((row) => ({ ...row, retoolCost: row.retool.state === 'priced' ? row.retool.cost : null }))
    },

    // The refit tasks and retool activities the yards are working on, each checked against the rules; the time left is the Production Recap's.
    runningRows() {
      const { classById, components, formulaVersion, modifiersOf } = this
      const name = (id) => (classById[id] ? classById[id].name : `class #${id}`)
      const refits = this.refitTasks.map((task) => {
        const check = checkRefitTask(task, classById, components, formulaVersion)
        const modifiers = modifiersOf[task.PopulationID]
        const paused = flagOf(task.Paused)
        const finish = finishDays({ rule: 'production.shipFinish', rate: shipRate(modifiers, task), remaining: task.RemainingProduction, remainingName: 'the task\'s remaining build points', paused })

        return this.runningRow({ key: `refit-${task.ID}`, kind: task.ShipyardTaskType === REFIT_TASK_TYPES[1] ? 'Automatic refit' : 'Refit', name: task.Name || `Refit #${task.ID}`, yardName: task.ShipyardName, sourceId: task.SourceClassID, targetId: task.TargetClassID, sourceName: name(task.SourceClassID), targetName: name(task.TargetClassID), stored: task.TotalBP, completed: task.CompletedBP, check, paused, finish: finish.result, idle: finish.idle })
      })
      const retools = this.retoolTasks.map((task) => {
        const check = checkRetoolTask(task, classById, components, modifiersOf[task.PopulationID] ? modifiersOf[task.PopulationID].ShipyardOperations : null, formulaVersion)
        const modifiers = modifiersOf[task.PopulationID]
        const shipyard = task
        const paused = flagOf(task.Paused)
        const finish = shipyardFinish(modifiers, shipyard, shipyardUpgradeRate(modifiers, shipyard))

        return this.runningRow({ key: `retool-${task.ID}`, kind: 'Retool', name: task.ShipyardName, yardName: '', sourceId: task.SourceClassID, targetId: task.TargetClassID, sourceName: task.SourceClassID ? name(task.SourceClassID) : 'No class', targetName: name(task.TargetClassID), stored: task.RequiredBP, completed: task.CompletedBP, check, paused, finish: finish.result, idle: finish.idle })
      })

      return [...refits, ...retools]
    },

    tiles() {
      const { matrix, yards, runningRows } = this
      const covered = yards.filter((yard) => yard.type === SHIPYARD_TYPE.NAVAL || yard.type === SHIPYARD_TYPE.COMMERCIAL)
      const typeless = yards.filter((yard) => !isNumber(yard.type))
      const others = yards.length - covered.length - typeless.length
      const refits = runningRows.filter((row) => row.kind !== 'Retool')
      const retools = runningRows.filter((row) => row.kind === 'Retool')
      const balance = (rows, rule, none) => {
        if (!rows.length) {
          return { note: none }
        }

        const unknown = rows.filter((row) => row.remaining === null)

        if (unknown.length) {
          return { note: `The balance is not known for ${unknown.length} of ${rows.length}`, result: unavailable({ rule, missing: [`the balance of ${unknown.length} of ${rows.length} tasks`], units: 'BP' }) }
        }

        return { note: `${this.count(rows.reduce((total, row) => total + row.remaining, 0), 0)} BP left` }
      }
      const refitBalance = balance(refits, 'refit.cost', 'No yard is refitting a ship')
      const retoolBalance = balance(retools, 'refit.retool', 'No yard is being retooled')
      const notCovered = [others ? `${this.count(others)} repair or other yards not covered` : '', typeless.length ? `${this.count(typeless.length)} with no type known` : ''].filter(Boolean).join('; ')

      return [
        { label: 'Refits priced', value: matrix.tooLarge ? UNKNOWN_TEXT : this.count(matrix.priced), rule: 'refit.cost', note: matrix.tooLarge ? this.narrowHint : `${this.count(matrix.rows.length)} source classes into ${this.count(matrix.columns.length)} target classes${matrix.unpriced ? `; ${this.count(matrix.unpriced)} with no price, a figure missing` : ''}` },
        { label: 'Yards that refit and retool', value: this.count(covered.length), rule: 'refit.yardAccepts', note: notCovered ? `Naval and commercial yards; ${notCovered}` : 'Naval and commercial yards' },
        { label: 'Refits running', value: this.count(refits.length), rule: 'refit.cost', result: refitBalance.result, note: refitBalance.note },
        { label: 'Retools running', value: this.count(retools.length), rule: 'refit.retool', result: retoolBalance.result, note: retoolBalance.note },
      ]
    },

    yardHeaders() {
      return [
        { text: 'Yard', value: 'name' },
        { text: 'Type', value: 'type' },
        { text: 'Slipways', value: 'slipways', align: 'end' },
        { text: 'Capacity (t)', value: 'capacity', align: 'end' },
        { text: 'Tooled for', value: 'tooledName' },
        { text: 'Takes the target class', value: 'takesSort' },
        { text: 'Refit time here', value: 'refitDays', align: 'end' },
        { text: 'Retool to the target class', value: 'retoolCost' },
      ]
    },

    runningHeaders() {
      return [
        { text: 'Work', value: 'name' },
        { text: 'From', value: 'sourceName' },
        { text: 'To', value: 'targetName' },
        { text: 'Stored cost (BP)', value: 'stored', align: 'end' },
        { text: 'Rule cost (BP)', value: 'expected', align: 'end' },
        { text: 'Rule', value: 'agree', sortable: false },
        { text: 'Done', value: 'done', align: 'end' },
        { text: 'Time left', value: 'daysSort', align: 'end' },
      ]
    },

    linkQuery() {
      return linkTo.shipyards({ from: this.fromId, to: this.toId }).query
    },

    linkLabel() {
      return this.pair ? `${this.pair.from.name} to ${this.pair.to.name}` : null
    },
  },
  watch: {
    // A pair picked belongs to the race that was showing.
    RaceID() {
      this.fromId = null
      this.toId = null
    },
  },
  methods: {
    sortNullLast,
    isAvailable,
    describeResult,

    applyLink(query) {
      this.fromId = queryId(query.from)
      this.toId = queryId(query.to)
    },

    selectPair(source, target) {
      this.fromId = source.id
      this.toId = target.id
    },

    selectPairById(fromId, toId) {
      this.fromId = fromId
      this.toId = toId
    },

    swapPair() {
      const { fromId } = this

      this.fromId = this.toId
      this.toId = fromId
    },

    figureOf(result) {
      return valueOrNull(result)
    },

    shipCountOf(classId) {
      return this.shipCounts[classId] || 0
    },

    shipsText(classId) {
      const ships = this.shipCountOf(classId)

      return `${this.count(ships)} ${ships === 1 ? 'ship' : 'ships'}`
    },

    percent(result) {
      const value = valueOrNull(result)

      return value === null ? UNKNOWN_TEXT : `${this.count(value, value < 10 ? 1 : 0)}%`
    },

    yardsText(known, unknown) {
      return unknown ? `≥${this.count(known)}` : this.count(known)
    },

    cellTitle(source, cell) {
      const total = valueOrNull(cell.refit.total)
      const { info } = cell
      const takes = info.unknownYards ? `at least ${info.refitYards} yards take the target class and ${info.unknownYards} more are not known to` : `${info.refitYards} yards take the target class`
      const retools = info.unknownRetools ? `at least ${info.retoolYards} can be retooled for it and ${info.unknownRetools} more are not known to` : `${info.retoolYards} can be retooled for it`

      return `${source.name} to ${cell.target.name}: ${this.count(total, 1)} BP, ${this.percent(cell.shareSource)} of ${source.name}'s cost, ${this.percent(cell.shareTarget)} of ${cell.target.name}'s cost; ${takes}, ${retools}${cell.noRetool.ok === true ? '; a yard tooled for the source needs no retool' : ''}`
    },

    // What a yard's acceptance of the target class reads as: a label, an icon and a colour, and `rank` for sorting (those that take it first).
    takesOf(accepts) {
      const note = accepts.reasons.join('; ')

      if (accepts.status === 'ok') {
        return { status: 'ok', label: 'Takes it', icon: 'mdi-check-circle', color: 'success', note: '', rank: 0 }
      } else if (accepts.status === 'blocked') {
        return { status: 'blocked', label: 'Cannot', icon: 'mdi-close-circle-outline', color: '', note, rank: 2 }
      } else if (accepts.status === 'unsupported') {
        return { status: 'unsupported', label: 'Not covered', icon: 'mdi-minus-circle-outline', color: '', note, rank: 3 }
      }

      return { status: 'unknown', label: 'Not known', icon: 'mdi-help-circle-outline', color: 'warning', note: `Needs ${note}`, rank: null }
    },

    // A yard's retool to `target`, costed from its own tooled class `tooled` (null for none, undefined when the save does not say): { state, label, note, cost, days, costResult, timeResult, gap }.
    retoolOf(yard, tooled, target, modifiers, components, version) {
      const retools = yardRetools(yard, target)
      const none = (state, label, note = '') => ({ state, label, note, cost: null, days: null, costResult: null, timeResult: null, gap: null })

      if (retools.status === 'unsupported') {
        return none('unsupported', 'Not covered', retools.reasons.join('; '))
      } else if (yard.tooledId === target.id) {
        return none('tooled', 'Tooled for the target class')
      } else if (retools.status === 'blocked') {
        return none('blocked', 'Cannot', retools.reasons.join('; '))
      } else if (retools.status === 'unknown') {
        return { ...none('unknown', ''), gap: unavailable({ rule: 'refit.retool', missing: retools.reasons, units: 'BP' }) }
      } else if (tooled === undefined) {
        return { ...none('unknown', ''), gap: unavailable({ rule: 'refit.retool', missing: ['the class the yard is tooled for'], units: 'BP' }) }
      } else if (tooled === null) {
        return none('immediate', 'At once', 'The yard has no tooled class')
      }

      const refit = refitTotal(tooled, target, components, version)
      const noRetool = noRetoolCheck(tooled, target, refit.total, version)

      if (noRetool.ok === true) {
        return none('noRetool', 'No retool needed', `Within 20% of ${tooled.name}'s size, refit at most a fifth of its cost`)
      }

      const operations = modifiers && isNumber(modifiers.ShipyardOperations) ? modifiers.ShipyardOperations : null
      const priced = retoolCost({ tooling: tooled, target, refit: refit.total, slipways: yard.slipways, operations, version })

      if (priced.kind === 'immediate') {
        return none('immediate', 'At once', 'The refit from the tooled class costs nothing')
      }

      const timeResult = retoolTime(modifiers, yard, priced.cost)

      return { state: 'priced', label: '', note: `From ${tooled.name}`, cost: valueOrNull(priced.cost), days: valueOrNull(timeResult), costResult: priced.cost, timeResult, gap: null }
    },

    // A running task as a table row: the stored cost against the rule's, the share done and the time left (null with `statusLabel` while paused or stalled).
    runningRow({ key, kind, name, yardName, sourceId, targetId, sourceName, targetName, stored, completed, check, paused, finish, idle = false }) {
      const days = valueOrNull(finish)
      const known = isNumber(stored) && isNumber(completed)

      return {
        key,
        kind,
        name,
        yardName,
        sourceId,
        targetId,
        sourceName,
        targetName,
        stored: isNumber(stored) ? stored : null,
        expected: check.expected,
        expectedResult: check.priced ? check.priced.cost : check.refit ? check.refit.total : unavailable({ rule: kind === 'Retool' ? 'refit.retool' : 'refit.cost', missing: ['a class that is one of the race\'s classes'], units: 'BP' }),
        matches: check.matches,
        done: known && stored > 0 ? (completed / stored) * 100 : null,
        remaining: known ? stored - completed : null,
        days,
        daysSort: days,
        finish,
        statusLabel: paused === true ? 'Paused' : idle ? 'No capacity' : '',
      }
    },
  },
  asyncComputed: {
    refitData: {
      get: tracked('refitData', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return { classes: [], components: {} }
        }

        return await loadRefitClasses(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: { classes: [], components: {} },
    },
    // The race's ships, not destroyed, by class: the own-ship count the other pages use.
    shipCounts: {
      get: tracked('shipCounts', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return {}
        }

        return await loadShipCounts(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: {},
    },
    yards: {
      get: tracked('yards', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadYards(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    refitTasks: {
      get: tracked('refitTasks', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadRefitTasks(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    retoolTasks: {
      get: tracked('retoolTasks', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await loadRetoolTasks(this.database, { GameID: this.GameID, RaceID: this.RaceID })
      }),
      default: [],
    },
    // The formula version the save's schema stands for (`loadFormulaVersion`): the stated one for a 2.7-shaped save, null for any other shape.
    formulaVersion: {
      get: tracked('formulaVersion', async function () {
        if (!this.database) {
          return null
        }

        return await loadFormulaVersion(this.database)
      }),
      default: null,
    },
  },
}
</script>

<style lang="scss">
.shipyards-page {
  .controls {
    gap: 12px;
  }

  .search-field {
    min-width: 180px;
    max-width: 240px;
  }

  .class-picker {
    min-width: 200px;
    max-width: 280px;
  }

  td,
  .breakdown td {
    font-variant-numeric: tabular-nums;
  }

  .pair-title {
    gap: 4px;
    margin-bottom: 12px;
  }

  .chips {
    gap: 6px;
    margin-top: 4px;
  }

  .matrix-scroll {
    max-height: 70vh;
    overflow: auto;
  }

  .refit-matrix {
    border-collapse: separate;
    border-spacing: 0;

    th,
    td {
      border-bottom: 1px solid var(--ae-border);
      border-right: 1px solid var(--ae-border);
    }

    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      min-width: 112px;
      max-width: 112px;
      padding: 6px 6px;
      background: var(--ae-card);
      text-align: center;
      font-weight: 500;
      font-size: 12px;
    }

    thead th.corner {
      left: 0;
      z-index: 4;
      min-width: 200px;
      max-width: 220px;
      text-align: left;
    }

    .row-head {
      position: sticky;
      left: 0;
      z-index: 1;
      min-width: 200px;
      max-width: 220px;
      padding: 4px 8px;
      background: var(--ae-card);
      text-align: left;
      font-weight: 500;
      font-size: 13px;
    }

    .class-name {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .is-selected {
      background: var(--ae-row-selected);
    }

    .matrix-cell {
      min-width: 112px;
      max-width: 112px;
      padding: 0;
      text-align: center;
      font-size: 12px;
      line-height: 1.3;
    }

    .matrix-cell.is-same {
      background: var(--ae-track-soft);
    }

    .cell-button {
      display: block;
      width: 100%;
      padding: 4px 6px;
      background: transparent;
      border: 0;
      color: inherit;
      font: inherit;
      cursor: pointer;

      &:hover {
        background: var(--ae-hover);
      }

      &:focus-visible {
        outline: 2px solid var(--ae-primary);
        outline-offset: -2px;
      }
    }

    .cell-unpriced {
      cursor: default;
    }

    .cell-time {
      display: block;
      font-weight: 500;
      white-space: nowrap;
    }

    .cell-share,
    .cell-yards {
      display: block;
      color: var(--ae-muted);
      font-size: 11px;
      white-space: nowrap;
    }
  }
}
</style>
