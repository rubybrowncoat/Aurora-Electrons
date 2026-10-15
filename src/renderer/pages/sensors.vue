<template>
  <div>
    <v-container fluid class="sensors-page">
      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" @retry="retryFailedInputs" />

      <template v-if="ready">
        <div class="toolbar">
          <div class="tool tool--shares">
            <div class="tool__label caption text--secondary">Speed shares</div>
            <v-text-field v-model="shares" type="text" suffix="%" placeholder="50" aria-label="Shares of top speed in percent, separated by commas" dense outlined hide-details />
          </div>
          <div class="tool tool--figure">
            <div class="tool__label caption text--secondary">Enemy thermal sensitivity</div>
            <v-text-field v-model="enemyThermal" type="text" placeholder="Unknown" aria-label="Enemy thermal sensor sensitivity, blank when unknown" dense outlined hide-details />
          </div>
          <div class="tool tool--figure">
            <div class="tool__label caption text--secondary">Enemy EM sensitivity</div>
            <v-text-field v-model="enemyEm" type="text" placeholder="Unknown" aria-label="Enemy EM sensor sensitivity, blank when unknown" dense outlined hide-details />
          </div>
          <div class="tool tool--figure">
            <div class="tool__label caption text--secondary">Enemy active range</div>
            <v-text-field v-model="enemyRange" type="text" suffix="km" placeholder="Unknown" aria-label="Enemy active sensor range in km at its resolution, blank when unknown" dense outlined hide-details />
          </div>
          <div class="tool tool--figure">
            <div class="tool__label caption text--secondary">Enemy resolution</div>
            <v-text-field v-model="enemyResolution" type="text" suffix="HS" placeholder="Unknown" aria-label="Enemy active sensor resolution in HS, blank when unknown" dense outlined hide-details />
          </div>
          <div class="tool tool--class">
            <div class="tool__label caption text--secondary">Class for the speed and reduction panels</div>
            <v-autocomplete :value="selectedClass ? selectedClass.id : null" :items="classItems" item-text="text" item-value="value" placeholder="None" prepend-inner-icon="mdi-ferry" aria-label="Class for the speed and thermal reduction panels" dense outlined hide-details @change="pickClass" />
          </div>
          <div class="tool tool--switch">
            <v-switch v-model="hideObsolete" label="Hide obsolete" dense hide-details class="mt-0 pt-2" />
          </div>
        </div>

        <v-alert v-for="problem in inputProblems" :key="problem" type="warning" outlined dense class="mt-3" data-sensors="input-problem">{{ problem }}</v-alert>
        <v-alert v-if="!classes.length" type="info" outlined dense class="mt-3" data-sensors="no-classes">The race has no ship classes.</v-alert>

        <v-card class="panel" data-summary="The thermal and EM signatures of each class and its cross-section with the cloak working and damaged, then how far the typed enemy sensors reach each. A figure is marked confirmed, estimated, assumed or unavailable, and a stored figure the rules do not reproduce is flagged, so the classes can be compared on what a sensor sees." elevation="1">
          <div class="panel-head">
            <span>Signatures</span>
            <span class="d-flex align-center flex-wrap">
              <v-chip small outlined class="mr-2">{{ signatureRows.length }} of {{ classes.length }} classes</v-chip>
            </span>
          </div>
          <div class="panel-body">
            <div class="legend mb-2">
              <span v-for="status in statuses" :key="status" class="legend-item mr-4"><provenance-mark :status="status" label /><span class="caption text--secondary ml-1">{{ statusMeaning(status) }}</span></span>
            </div>
            <div class="subtitle-2">Signatures of the classes</div>
          </div>
          <v-data-table :headers="signatureHeaders" :items="signatureRows" item-key="id" :sort-by.sync="signaturesTable.sortBy" :sort-desc.sync="signaturesTable.sortDesc" :items-per-page.sync="signaturesTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" dense no-data-text="No class to show." data-sensors="signatures">
            <template #[`item.name`]="{ item }">
              <div class="py-1">
                <div class="font-weight-medium text-no-wrap">{{ item.name }}</div>
                <div v-if="item.obsolete" class="caption text--secondary">Obsolete</div>
              </div>
            </template>
            <template #[`item.sizeHS`]="{ item }"><div class="text-no-wrap">{{ shown(item.size, 2) }} HS<provenance-mark :result="item.size" /></div><div class="caption text--secondary text-no-wrap">{{ shown(item.tonsResult, 0) }} tons<provenance-mark :result="item.tonsResult" /></div></template>
            <template #[`item.cross`]="{ item }">
              <span class="text-no-wrap" data-sensors="cross-effective">{{ shown(item.sig.crossSection.effective, 2) }}</span><provenance-mark :result="item.sig.crossSection.effective" />
              <v-icon v-if="item.sig.crossSection.agrees === false" x-small color="warning" class="ml-1" :title="disagreement(item.sig.crossSection.stored, item.sig.crossSection.rebuilt, 'cross-section')">mdi-alert-circle-outline</v-icon>
              <div v-if="item.sig.crossSection.cloaked" class="caption text--secondary">Cloaked</div>
            </template>
            <template #[`item.uncloaked`]="{ item }"><span class="text-no-wrap" data-sensors="cross-uncloaked">{{ shown(item.sig.crossSection.uncloaked, 2) }}</span><provenance-mark :result="item.sig.crossSection.uncloaked" /></template>
            <template v-for="column in shareColumns" #[`item.${column.key}`]="{ item }">
              <span :key="column.key" class="text-no-wrap" :data-sensors="`thermal-${column.index}`">{{ shown(item.sig.thermal.byFraction[column.index].result, 1) }}</span><provenance-mark :key="`${column.key}-mark`" :result="item.sig.thermal.byFraction[column.index].result" />
              <v-icon v-if="column.full && item.sig.thermal.agrees === false" :key="`${column.key}-agree`" x-small color="warning" class="ml-1" :title="disagreement(item.sig.thermal.stored, item.sig.thermal.aggregate, 'thermal signature')">mdi-alert-circle-outline</v-icon>
            </template>
            <template #[`item.shields`]="{ item }"><span class="text-no-wrap" data-sensors="em-shields">{{ shown(item.sig.em.shields, 0) }}</span><provenance-mark :result="item.sig.em.shields" /></template>
            <template #[`item.active`]="{ item }">
              <span class="text-no-wrap" data-sensors="em-active" :title="activeEmText(item)">{{ shown(item.sig.em.strongestActive, 0) }}</span><provenance-mark :result="item.sig.em.strongestActive" />
              <div v-if="item.sig.em.activeSensors.length > 1" class="caption text--secondary text-no-wrap">{{ item.sig.em.activeSensors.length }} sensors, each alone</div>
            </template>
          </v-data-table>

          <div class="panel-body pt-4">
            <div class="subtitle-2">Reach of the enemy sensors (million km)</div>
          </div>
          <v-data-table :headers="reachHeaders" :items="signatureRows" item-key="id" :sort-by.sync="reachTable.sortBy" :sort-desc.sync="reachTable.sortDesc" :items-per-page.sync="reachTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: pageSizes }" dense no-data-text="No class to show." data-sensors="reach">
            <template #[`item.name`]="{ item }"><div class="font-weight-medium text-no-wrap py-1">{{ item.name }}</div></template>
            <template v-for="column in shareColumns" #[`item.reach${column.key}`]="{ item }">
              <span :key="column.key" class="text-no-wrap" :data-sensors="`reach-thermal-${column.index}`">{{ shown(item.reach.thermal[column.index], 2, MILLION) }}</span><provenance-mark :key="`${column.key}-mark`" :result="item.reach.thermal[column.index]" />
            </template>
            <template #[`item.reachShields`]="{ item }"><span class="text-no-wrap" data-sensors="reach-em-shields">{{ shown(item.reach.shields, 2, MILLION) }}</span><provenance-mark :result="item.reach.shields" /></template>
            <template #[`item.reachActiveEm`]="{ item }"><span class="text-no-wrap" data-sensors="reach-em-active">{{ shown(item.reach.activeEm, 2, MILLION) }}</span><provenance-mark :result="item.reach.activeEm" /></template>
            <template #[`item.reachCross`]="{ item }"><span class="text-no-wrap" data-sensors="reach-active-effective">{{ shown(item.reach.cross, 2, MILLION) }}</span><provenance-mark :result="item.reach.cross" /></template>
            <template #[`item.reachUncloaked`]="{ item }"><span class="text-no-wrap" data-sensors="reach-active-uncloaked">{{ shown(item.reach.uncloaked, 2, MILLION) }}</span><provenance-mark :result="item.reach.uncloaked" /></template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            At rest a class shows a twentieth of its size in HS as thermal signature. Moving, it shows the larger of that and the engines' summed power times thermal rating times the share of top speed. The sum is compared with the thermal signature the save stores for the class, and a warning icon names a stored figure the rule does not reproduce. The cross-section is the class size times the rating of the last cloak that fits the class, never under 0.3; an active sensor sees the size instead when the cloak is damaged. EM is the shield strength times 30 with shields up, and for each active sensor switched on its strength times its resolution, each seen alone and never summed; the saves store no emission, so EM figures are estimates. A passive sensor reaches 250,000 km times the square root of its sensitivity times the signature, and several sensors of one design do not add. An active sensor reaches its range times the square of the cross-section over its resolution when the cross-section is the smaller. The enemy figures are typed: they are assumed, a blank one is unknown and never 0, and nothing of another empire is read from the save. Shields may be below full strength, and damaged engines, overhaul, towing and nebulae change a fleet's speed and so its thermal signature; the figures are for the class and the chosen share. A hypothetical cloak is not sized here: only the cross-sections saved with the classes are shown.
            <div class="mt-2">The speed shares are percentages of top speed typed in the toolbar, separated by commas; idle and full speed are always shown beside them.</div>
          </div>
        </v-card>

        <v-card class="panel" data-summary="The thermal signature of the chosen class and the reach of the typed enemy thermal sensor against it from standing still to full speed, to see what speed costs in being seen." elevation="1">
          <div class="panel-head">
            <span>Speed and detection<v-chip v-if="selectedClass" x-small outlined class="ml-2">{{ selectedClass.name }}</v-chip></span>
            <v-btn-toggle v-model="speedView" mandatory dense>
              <v-btn value="chart" small aria-label="Chart"><v-icon small>mdi-chart-line</v-icon></v-btn>
              <v-btn value="table" small aria-label="Table"><v-icon small>mdi-table</v-icon></v-btn>
            </v-btn-toggle>
          </div>
          <div class="panel-body">
            <div v-if="!selectedClass" class="caption text--secondary" data-sensors="speed-none">No class to show.</div>
            <template v-else-if="speedView === 'chart'">
              <div class="legend">
                <span class="legend-item"><series-key :color="seriesColor(0)" kind="line" />Thermal signature</span>
                <span v-if="speedChart.hasReach" class="legend-item"><series-key :color="seriesColor(1)" kind="line" />Reach of the enemy thermal sensor (million km)</span>
              </div>
              <div v-if="!speedChart.hasReach" class="caption text--secondary mt-1" data-sensors="speed-reach-unknown">The reach of the enemy thermal sensor is unknown: type its sensitivity to chart it.</div>
              <chart-canvas type="line" :data="speedChart.data" :options="speedChart.options" :height="320" :label="`Thermal signature of ${selectedClass.name} and the reach of the enemy thermal sensor against the share of top speed`" />
            </template>
            <v-simple-table v-else dense data-sensors="speed-table">
              <thead>
                <tr>
                  <th class="text-right">Share of top speed</th>
                  <th class="text-right">Thermal signature</th>
                  <th class="text-right">Reach of the enemy thermal sensor (million km)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in speedRows" :key="row.fraction">
                  <td class="text-right text-no-wrap">{{ percent(row.fraction) }}<provenance-mark :result="typedShare(row.fraction)" /></td>
                  <td class="text-right text-no-wrap">{{ shown(row.thermal, 2) }}<provenance-mark :result="row.thermal" /></td>
                  <td class="text-right text-no-wrap">{{ shown(row.reach, 3, MILLION) }}<provenance-mark :result="row.reach" /></td>
                </tr>
              </tbody>
            </v-simple-table>
          </div>
          <div class="panel-foot caption text--secondary">The share is the part of top speed the fleet moves at. Idle, with no move orders, is the floor of a twentieth of the class size, and a share too low to rise above the floor shows the floor. A class with no engine shows the floor at rest and 0 when it moves. The reach is that of a passive thermal sensor of the typed sensitivity against each signature; with no sensitivity typed the reach is unknown, and the table says so. The chart and the table list the same points.</div>
        </v-card>

        <v-card class="panel" data-summary="How far passive thermal and EM sensors detect targets of typed signatures: every thermal and EM sensor the race has researched and the typed enemy sensor, on logarithmic axes, to see which sensor sees what a target gives off." elevation="1">
          <div class="panel-head">
            <span>Passive range</span>
            <v-btn-toggle v-model="passiveView" mandatory dense>
              <v-btn value="chart" small aria-label="Chart"><v-icon small>mdi-chart-line</v-icon></v-btn>
              <v-btn value="table" small aria-label="Table"><v-icon small>mdi-table</v-icon></v-btn>
            </v-btn-toggle>
          </div>
          <div class="panel-body">
            <v-row dense>
              <v-col cols="12" md="6"><v-text-field v-model="targetThermal" type="text" label="Target thermal signatures" suffix="thermal" :error-messages="targetThermalRead.error" aria-label="Thermal signatures of targets, separated by commas" dense outlined hide-details="auto" /></v-col>
              <v-col cols="12" md="6"><v-text-field v-model="targetEm" type="text" label="Target EM signatures" suffix="EM" :error-messages="targetEmRead.error" aria-label="EM signatures of targets, separated by commas" dense outlined hide-details="auto" /></v-col>
            </v-row>
            <div v-for="set in passiveSets" :key="set.kind" class="mt-4" :data-sensors="`passive-${set.kind}`">
              <div class="subtitle-2">{{ set.title }}</div>
              <div v-if="!set.sensitivities.length" class="caption text--secondary" :data-sensors="`passive-${set.kind}-none`">No {{ set.sensorName }} is researched by the race and no enemy sensitivity is typed.</div>
              <div v-else-if="!set.curve.rows.length" class="caption text--secondary">No target signature is typed.</div>
              <template v-else-if="passiveView === 'chart'">
                <div class="legend">
                  <span v-for="(series, index) in set.chartSeries" :key="series.key" class="legend-item"><series-key :color="seriesColor(index)" kind="line" />{{ series.name }}</span>
                </div>
                <div v-if="set.skipped" class="caption text--secondary mt-1">A signature of 0 is listed in the table only: a logarithmic axis has no 0.</div>
                <chart-canvas type="line" :data="set.chart.data" :options="set.chart.options" :height="300" :label="`Range of ${set.sensorName}s against target ${set.kind} signature`" />
              </template>
              <v-simple-table v-else dense :data-sensors="`passive-${set.kind}-table`">
                <thead>
                  <tr>
                    <th class="text-right">Signature</th>
                    <th v-for="series in set.curve.series" :key="series.key" class="text-right">{{ series.name }} (million km)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in set.curve.rows" :key="row.signature">
                    <td class="text-right text-no-wrap">{{ count(row.signature, 2) }}<provenance-mark :result="typedSignature(row.signature)" /></td>
                    <td v-for="range in row.ranges" :key="range.key" class="text-right text-no-wrap">{{ shown(range.result, 3, MILLION) }}<provenance-mark :result="range.result" /></td>
                  </tr>
                </tbody>
              </v-simple-table>
            </div>
          </div>
          <div class="panel-foot caption text--secondary">A passive sensor detects a target out to 250,000 km times the square root of its sensitivity times the target's signature, so four times the sensitivity doubles the range. The sensors listed are every thermal and EM sensor design the race has researched, each by its design's sensitivity, the strongest first; the chart draws the strongest eight of each kind and the typed enemy sensor, and the table holds the rest. The number fitted to a ship does not add, and a target's cloak and jammer do not change a passive range. The target signatures are typed and assumed, one number for each point, in the thermal or EM figure of the game; the enemy sensitivity is the one typed in the toolbar and is assumed too. The axes are logarithmic.</div>
        </v-card>

        <v-card class="panel" data-summary="The engines of the chosen class designed again at each thermal reduction level the race has researched: the multiplier, the engine cost factor and tech, the engine BP and the thermal signature at the speed shares, to weigh stealth against cost." elevation="1">
          <div class="panel-head">
            <span>Thermal reduction<v-chip v-if="selectedClass" x-small outlined class="ml-2">{{ selectedClass.name }}</v-chip></span>
          </div>
          <div class="panel-body">
            <div v-if="!selectedClass" class="caption text--secondary">No class to show.</div>
            <div v-else-if="!selectedClass.engines.length" class="caption text--secondary" data-sensors="reduction-no-engine">The class mounts no engine.</div>
            <div v-else-if="!reductionRows.length" class="caption text--secondary" data-sensors="reduction-none">The race has researched no thermal reduction level.</div>
            <v-simple-table v-else dense data-sensors="reduction-table">
              <thead>
                <tr>
                  <th>Level</th>
                  <th class="text-right">Multiplier</th>
                  <th class="text-right">Cost factor</th>
                  <th class="text-right">Engine BP</th>
                  <th class="text-right">Class engines BP</th>
                  <th v-for="column in shareColumns" :key="column.key" class="text-right">Thermal at {{ column.label }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in reductionRows" :key="row.level.id" :class="{ 'is-current-level': row.level.current }">
                  <td class="text-no-wrap">{{ row.level.name }}<v-chip v-if="row.level.current" x-small outlined class="ml-2">Current</v-chip><page-link :to="linkTo.techTree({ tech: row.level.id })" :name="row.level.name" class="ml-1" /></td>
                  <td class="text-right text-no-wrap">{{ shown(row.multiplierResult, 2) }}<provenance-mark :result="row.multiplierResult" /></td>
                  <td class="text-right text-no-wrap">{{ shown(row.costFactorResult, 2) }}<provenance-mark :result="row.costFactorResult" /><div v-if="!row.costApplied" class="caption text--secondary">not applied</div></td>
                  <td class="text-right text-no-wrap">{{ shown(row.engineCost, 2) }}<provenance-mark :result="row.engineCost" /></td>
                  <td class="text-right text-no-wrap">{{ shown(row.classEngineCost, 2) }}<provenance-mark :result="row.classEngineCost" /></td>
                  <td v-for="(entry, index) in row.byFraction" :key="shareColumns[index].key" class="text-right text-no-wrap">{{ shown(entry.result, 1) }}<provenance-mark :result="entry.result" /></td>
                </tr>
              </tbody>
            </v-simple-table>
          </div>
          <div class="panel-foot caption text--secondary">Each engine of the class is designed again from its own engine and fuel techs at the level's multiplier, which is the share of the engine's power that shows as heat. The cost factor is read from the level's tech and multiplies the engine's BP only when the multiplier is under 1. The thermal signature at a share is worked out as in the signatures panel from the engines at that level. The current level is the one every engine of the class was designed at. An engine whose tech rows are missing leaves the level unavailable, naming them.</div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import SeriesKey from '../components/charts/SeriesKey.vue'
import { chartTheme } from '../components/charts/theme'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import countFormat from '../mixins/count-format'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import { activeAppearance } from '../utilities/appearance'
import { linkTo } from '../utilities/deep-links'
import { NO_SIGNATURE_CLASSES, NO_THERMAL_REDUCTION, SENSOR_COMPONENT_TYPES, loadSignatureClasses, loadThermalReduction, ownedPassiveSensors } from '../utilities/design-data'
import { SENSOR_RULES, TONS_PER_HS } from '../utilities/design-rules'
import { tracked } from '../utilities/load-tracking'
import { roundToDecimal } from '../utilities/math'
import { entered } from '../utilities/missile-hit'
import { STATUSES, STATUS_MARKS, STATUS, envelope, isAvailable, ofRule, unavailable, valueOrNull } from '../utilities/provenance'
import { activeReach, classSignatures, passiveReach, rangeCurve, readSpeedShares, speedCurve, thermalReductionOptions } from '../utilities/signatures'

const INPUT_LABELS = {
  classRead: 'the ship classes with their engines, cloaks and sensors',
  ownedRows: 'the thermal and EM sensors the race has researched',
  reduction: 'the thermal reduction levels the race has researched',
}

const PAGE_SIZES = [15, 30, -1]
const VIEWS = ['chart', 'table']

// Ranges are listed in millions of km.
const MILLION = 1e6

// A tick of a logarithmic axis is labelled at 1, 2 and 5 times a power of 10 only, so the labels stay apart.
const logTick = (value) => (value > 0 && [1, 2, 5].includes(roundToDecimal(value / 10 ** Math.floor(Math.log10(value)), 6)) ? String(value) : '')

// The steps the speed curve is drawn in between standing still and full speed.
const SPEED_STEPS = 20

// The most own sensors of a kind drawn beside the enemy one: the chart has nine categorical colours. The table lists every researched sensor.
const MAX_SENSOR_SERIES = 8

const EMPTY_LIST = Object.freeze([])

const text = (value) => typeof value === 'string'

// The numbers of a text such as '10, 100 1000': each a finite number of 0 or more. `error` names the first token that is not one.
const numbersOf = (value) => {
  const tokens = String(value === null || value === undefined ? '' : value).split(/[\s,;]+/).filter(Boolean)
  const values = []

  for (const token of tokens) {
    const number = entered(token)

    if (number === null || number < 0) {
      return { values: EMPTY_LIST, error: `"${token}" is not a signature of 0 or more` }
    }

    values.push(number)
  }

  return { values, error: '' }
}

// A figure the enemy sensor is typed as: blank or not above 0 is null (unknown), anything else an assumed result that the reach rules lend their provenance from.
const typedFigure = (value, name, units) => {
  const number = entered(value)

  if (number === null || !(number > 0)) {
    return null
  }

  return envelope({ value: number, status: STATUS.ASSUMED, rule: SENSOR_RULES.detection, units, inputs: { present: [name] }, assumptions: [`${name} is typed, not read from the save`] })
}

// The rules a figure stored in the save or typed in the toolbar is marked under: the size of the class as the save stores it, the engine design rule that reads the level's multiplier and cost factor, and the thermal signature rule the shares of top speed feed.
const CLASS_SIZE_RULE = 'design.classSize'
const ENGINE_RULE = 'design.engineDesign'
const THERMAL_SIGNATURE_RULE = 'design.thermalSignature'

// A figure the save stores as a result: confirmed when it is a number, unavailable (never 0) when the save holds none.
const storedFigure = (value, name, rule, units) => (Number.isFinite(value) ? ofRule({ rule, value, units, inputs: { present: [name] } }) : unavailable({ rule, units, missing: [name] }))

// A page for what the classes of the race show to a passive sensor: their thermal and EM signatures and cross-sections, the reach of the typed enemy sensors against them, and the thermal reduction levels the race could build the engines at (utilities/signatures.js).
export default {
  name: 'SensorsPage',
  components: { ChartCanvas, LoadState, PageLink, ProvenanceMark, SeriesKey },
  mixins: [
    countFormat,
    loadState(INPUT_LABELS),
    persistedView({
      shares: { key: 'sensorsShares', default: '50', scope: 'race', valid: text },
      enemyThermal: { key: 'sensorsEnemyThermal', default: '', scope: 'race', valid: text },
      enemyEm: { key: 'sensorsEnemyEm', default: '', scope: 'race', valid: text },
      enemyRange: { key: 'sensorsEnemyRange', default: '', scope: 'race', valid: text },
      enemyResolution: { key: 'sensorsEnemyResolution', default: '', scope: 'race', valid: text },
      hideObsolete: { key: 'sensorsHideObsolete', default: false, valid: (value) => typeof value === 'boolean' },
      classId: { key: 'sensorsClass', default: null, scope: 'race', valid: (value) => value === null || Number.isInteger(value) },
      targetThermal: { key: 'sensorsTargetThermal', default: '10, 100, 1000, 10000', scope: 'race', valid: text },
      targetEm: { key: 'sensorsTargetEm', default: '10, 100, 1000, 10000', scope: 'race', valid: text },
      speedView: { key: 'sensorsSpeedView', default: 'chart', valid: oneOf(VIEWS) },
      passiveView: { key: 'sensorsPassiveView', default: 'chart', valid: oneOf(VIEWS) },
      signaturesTable: { ...tableView('sensorsSignaturesTable', { sortBy: ['name'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }), scope: 'race' },
      reachTable: { ...tableView('sensorsReachTable', { sortBy: ['name'], sortDesc: [false], itemsPerPage: 15, itemsPerPageOptions: PAGE_SIZES }), scope: 'race' },
    }),
  ],
  data() {
    return {
      linkTo,
      pageSizes: PAGE_SIZES,
      statuses: STATUSES,
      MILLION,
    }
  },
  computed: {
    ...mapGetters(['database', 'GameID', 'RaceID']),

    context() {
      return { GameID: this.GameID, RaceID: this.RaceID }
    },

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    // The speed shares as typed: idle and full speed always present.
    sharesRead() {
      return readSpeedShares(this.shares)
    },

    fractions() {
      return this.sharesRead.fractions
    },

    // One column of the tables for each share: its key, its label, its place in the shares and whether it is full speed.
    shareColumns() {
      return this.fractions.map((fraction, index) => ({ key: `share${index}`, index, fraction, label: fraction === 0 ? 'idle' : `${roundToDecimal(fraction * 100, 2)} %`, full: fraction === 1 }))
    },

    // The enemy sensors as typed, each an assumed result or null when blank or not above 0.
    enemy() {
      return {
        thermal: typedFigure(this.enemyThermal, 'the enemy thermal sensitivity', ''),
        em: typedFigure(this.enemyEm, 'the enemy EM sensitivity', ''),
        range: typedFigure(this.enemyRange, 'the enemy active sensor range', 'km'),
        resolution: typedFigure(this.enemyResolution, 'the enemy active sensor resolution', 'HS'),
      }
    },

    // What typed in the toolbar is not read: the field, and that a blank one is unknown.
    inputProblems() {
      const fields = [
        [this.enemyThermal, this.enemy.thermal, 'Enemy thermal sensitivity'],
        [this.enemyEm, this.enemy.em, 'Enemy EM sensitivity'],
        [this.enemyRange, this.enemy.range, 'Enemy active range'],
        [this.enemyResolution, this.enemy.resolution, 'Enemy resolution'],
      ]
      const problems = fields.filter(([typed, figure]) => String(typed).trim() !== '' && figure === null).map(([, , name]) => `${name}: enter a number above 0, or leave the field blank when it is unknown.`)

      return this.sharesRead.error ? [`Speed shares: ${this.sharesRead.error}; the defaults are shown.`, ...problems] : problems
    },

    classes() {
      return this.classRead || NO_SIGNATURE_CLASSES
    },

    classItems() {
      return this.classes.map((cls) => ({ text: cls.obsolete ? `${cls.name} (obsolete)` : cls.name, value: cls.id }))
    },

    // The chosen class, else the first with an engine, else the first.
    selectedClass() {
      return this.classes.find((cls) => cls.id === this.classId) || this.classes.find((cls) => cls.engines.length) || this.classes[0] || null
    },

    visibleClasses() {
      return this.hideObsolete ? this.classes.filter((cls) => !cls.obsolete) : this.classes
    },

    // One row for each class shown: what it shows to a sensor, and how far each typed enemy sensor reaches it.
    signatureRows() {
      return this.visibleClasses.map((cls) => {
        const sig = classSignatures(cls, { fractions: this.fractions })
        const { crossSection, em, thermal } = sig
        const reach = {
          thermal: thermal.byFraction.map(({ result }) => passiveReach({ sensitivity: this.enemy.thermal, signature: result })),
          shields: passiveReach({ sensitivity: this.enemy.em, signature: em.shields }),
          activeEm: passiveReach({ sensitivity: this.enemy.em, signature: em.strongestActive }),
          cross: activeReach({ rangeKm: this.enemy.range, resolution: this.enemy.resolution, crossSection: crossSection.effective }),
          uncloaked: activeReach({ rangeKm: this.enemy.range, resolution: this.enemy.resolution, crossSection: crossSection.uncloaked }),
        }
        const size = storedFigure(cls.sizeHS, 'the class size', CLASS_SIZE_RULE, 'HS')
        const tons = storedFigure(Number.isFinite(cls.sizeHS) ? cls.sizeHS * TONS_PER_HS : null, 'the class size', CLASS_SIZE_RULE, 't')
        const row = { id: cls.id, name: cls.name, obsolete: cls.obsolete === true, sizeHS: valueOrNull(size), tons: valueOrNull(tons), size, tonsResult: tons, sig, reach, cross: valueOrNull(crossSection.effective), uncloaked: valueOrNull(crossSection.uncloaked), shields: valueOrNull(em.shields), active: valueOrNull(em.strongestActive), reachShields: valueOrNull(reach.shields), reachActiveEm: valueOrNull(reach.activeEm), reachCross: valueOrNull(reach.cross), reachUncloaked: valueOrNull(reach.uncloaked) }

        thermal.byFraction.forEach(({ result }, index) => {
          row[`share${index}`] = valueOrNull(result)
          row[`reachshare${index}`] = valueOrNull(reach.thermal[index])
        })

        return row
      })
    },

    signatureHeaders() {
      return [
        { text: 'Class', value: 'name' },
        { text: 'Size', value: 'sizeHS', align: 'end' },
        { text: 'Cross-section (HS)', value: 'cross', align: 'end' },
        { text: 'Cloak damaged (HS)', value: 'uncloaked', align: 'end' },
        ...this.shareColumns.map((column) => ({ text: `Thermal ${column.label}`, value: column.key, align: 'end' })),
        { text: 'EM shields up', value: 'shields', align: 'end' },
        { text: 'EM active sensor', value: 'active', align: 'end' },
      ]
    },

    reachHeaders() {
      return [
        { text: 'Class', value: 'name' },
        ...this.shareColumns.map((column) => ({ text: `Thermal ${column.label}`, value: `reach${column.key}`, align: 'end' })),
        { text: 'EM shields up', value: 'reachShields', align: 'end' },
        { text: 'EM active sensor', value: 'reachActiveEm', align: 'end' },
        { text: 'Active, cloaked', value: 'reachCross', align: 'end' },
        { text: 'Active, cloak damaged', value: 'reachUncloaked', align: 'end' },
      ]
    },

    // The thermal signature and the reach of the enemy thermal sensor at 0 to 100 % of top speed, for the chosen class.
    speed() {
      return this.selectedClass ? speedCurve(this.selectedClass, { sensitivity: this.enemy.thermal, steps: SPEED_STEPS }) : { points: EMPTY_LIST, rows: EMPTY_LIST }
    },

    speedRows() {
      return this.speed.rows
    },

    speedChart() {
      const { points } = this.speed
      const thermal = points.filter((point) => point.thermal !== null).map((point) => ({ x: roundToDecimal(point.fraction * 100, 2), y: roundToDecimal(point.thermal, 2) }))
      const reach = points.filter((point) => point.reach !== null).map((point) => ({ x: roundToDecimal(point.fraction * 100, 2), y: roundToDecimal(point.reach / MILLION, 3) }))
      const line = (label, data, color, axis) => ({ label, data, yAxisID: axis, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0 })
      const datasets = [line('Thermal signature', thermal, this.seriesColor(0), 'y')]
      const { ink, inkMuted, border } = this.theme

      if (reach.length) {
        datasets.push(line('Reach of the enemy thermal sensor (million km)', reach, this.seriesColor(1), 'y1'))
      }

      return {
        hasReach: reach.length > 0,
        data: { labels: [], datasets },
        options: {
          scales: {
            x: { type: 'linear', min: 0, max: 100, title: { display: true, text: 'Share of top speed (%)' } },
            y: { type: 'linear', min: 0, title: { display: true, text: 'Thermal signature' } },
            y1: { type: 'linear', min: 0, position: 'right', display: reach.length > 0, grid: { drawOnChartArea: false }, border: { color: border }, ticks: { color: inkMuted, padding: 6 }, title: { display: true, text: 'Reach (million km)', color: ink } },
          },
        },
      }
    },

    targetThermalRead() {
      return numbersOf(this.targetThermal)
    },

    targetEmRead() {
      return numbersOf(this.targetEm)
    },

    // The thermal and EM sensor designs the race has researched, each by its sensitivity, strongest first.
    ownThermalSensors() {
      return this.sensorsOf(SENSOR_COMPONENT_TYPES.thermal, 'thermal')
    },

    ownEmSensors() {
      return this.sensorsOf(SENSOR_COMPONENT_TYPES.em, 'em')
    },

    // The two range curves of the passive panel: for each kind, the researched sensors and the typed enemy one, against the typed target signatures.
    passiveSets() {
      return [
        this.passiveSet({ kind: 'thermal', title: 'Thermal sensors against thermal signature', sensorName: 'thermal sensor', own: this.ownThermalSensors, enemy: this.enemy.thermal, signatures: this.targetThermalRead.values, axis: 'Thermal signature' }),
        this.passiveSet({ kind: 'em', title: 'EM sensors against EM signature', sensorName: 'EM sensor', own: this.ownEmSensors, enemy: this.enemy.em, signatures: this.targetEmRead.values, axis: 'EM signature' }),
      ]
    },

    // The chosen class's engines at each researched level: the page adds the plain facts of the level (whether its cost factor applies).
    reductionRows() {
      if (!this.selectedClass) {
        return EMPTY_LIST
      }

      return thermalReductionOptions(this.selectedClass, { levels: this.reduction.levels, techs: this.reduction.techs, fractions: this.fractions }).map((option) => ({ ...option, costApplied: option.multiplier < 1, multiplierResult: storedFigure(option.multiplier, 'the multiplier of the level', ENGINE_RULE, ''), costFactorResult: storedFigure(option.costFactor, 'the cost factor of the level', ENGINE_RULE, '') }))
    },
  },
  asyncComputed: {
    // The race's classes with the engines, cloaks and sensors their signatures are made of.
    classRead: {
      get: tracked('classRead', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_SIGNATURE_CLASSES
        }

        return await loadSignatureClasses(this.database, this.context)
      }),
      default: NO_SIGNATURE_CLASSES,
    },
    // The thermal and EM sensor designs the race has researched, as the rows of the save.
    ownedRows: {
      get: tracked('ownedRows', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return EMPTY_LIST
        }

        return await ownedPassiveSensors(this.database, this.GameID, this.RaceID)
      }),
      default: EMPTY_LIST,
    },
    // The thermal reduction levels the race has researched and the tech rows its engines name.
    reduction: {
      get: tracked('reduction', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return NO_THERMAL_REDUCTION
        }

        return await loadThermalReduction(this.database, this.context)
      }),
      default: NO_THERMAL_REDUCTION,
    },
  },
  methods: {
    pickClass(id) {
      this.classId = Number.isInteger(id) ? id : null
    },

    // The colour of the n-th series of a chart.
    seriesColor(index) {
      const colors = this.theme.categorical

      return colors[index % colors.length]
    },

    percent(fraction) {
      return `${roundToDecimal(fraction * 100, 2)} %`
    },

    // A figure typed in the toolbar and taken as given: the rule that uses it lends the provenance, and the status is assumed.
    typedResult(value, name, rule, units) {
      return envelope({ value, status: STATUS.ASSUMED, rule, units, inputs: { present: [name] }, assumptions: [`${name} is typed or defaulted here, not read from the save`] })
    },

    typedSignature(signature) {
      return this.typedResult(signature, 'the target signature', SENSOR_RULES.detection, '')
    },

    typedShare(fraction) {
      return this.typedResult(fraction, 'the share of top speed', THERMAL_SIGNATURE_RULE, '')
    },

    statusMeaning(status) {
      return STATUS_MARKS[status].meaning
    },

    // A figure of a result as text, divided by `divisor`: Unknown for a result with no value, never 0.
    shown(result, decimals = 0, divisor = 1) {
      return isAvailable(result) ? this.count(result.value / divisor, decimals) : 'Unknown'
    },

    // Where a figure the save stores is not the one the rules give.
    disagreement(stored, computed, name) {
      return `The save stores ${this.shown(stored, 2)} for the ${name} of this class and the rule gives ${this.shown(computed, 2)}.`
    },

    // The EM signature of each active sensor of a class, each seen on its own.
    activeEmText(row) {
      const sensors = row.sig.em.activeSensors

      return sensors.length ? sensors.map(({ sensor, result }) => `${sensor.name}: ${this.shown(result, 0)}`).join('; ') : 'The class has no active sensor.'
    },

    // The designs of one kind of passive sensor the race has researched, strongest first, as { key, name, sensitivity } (sensitivity null when the design stores none).
    sensorsOf(typeId, kind) {
      const strength = (sensor) => (Number.isFinite(sensor.sensitivity) ? sensor.sensitivity : -Infinity)

      return this.ownedRows
        .filter((row) => row.ComponentTypeID === typeId)
        .map((row) => ({ key: `${kind}-${row.SDComponentID}`, id: row.SDComponentID, name: row.Name, sensitivity: Number.isFinite(row.ComponentValue) ? row.ComponentValue : null }))
        .sort((a, b) => strength(b) - strength(a) || a.name.localeCompare(b.name) || a.id - b.id)
        .map((sensor) => ({ key: sensor.key, name: sensor.sensitivity === null ? sensor.name : `${sensor.name} (${this.count(sensor.sensitivity, 2)})`, sensitivity: sensor.sensitivity }))
    },

    // One kind's curve, its chart (the strongest own sensors and the typed enemy one, at the points of the curve's series a logarithmic axis can show) and the sensors it holds. The table lists every sensor.
    passiveSet({ kind, title, sensorName, own, enemy, signatures, axis }) {
      const sensitivities = [...own, ...(enemy ? [{ key: `${kind}-enemy`, name: 'Enemy sensor', sensitivity: enemy }] : [])]
      const curve = rangeCurve({ sensitivities, signatures })
      const charted = new Set([...own.slice(0, MAX_SENSOR_SERIES).map((sensor) => sensor.key), `${kind}-enemy`])
      const chartSeries = curve.series.filter((series) => charted.has(series.key))
      const shownPoints = (series) => series.points.filter((point) => point.x > 0 && point.y > 0)
      const datasets = chartSeries.map((series, index) => ({ label: series.name, data: shownPoints(series).map((point) => ({ x: point.x, y: point.y / MILLION })), borderColor: this.seriesColor(index), backgroundColor: this.seriesColor(index), borderWidth: 2, pointRadius: 3, pointHoverRadius: 6, tension: 0 }))
      const skipped = curve.series.some((series) => shownPoints(series).length !== series.points.length) || signatures.includes(0)

      return {
        kind,
        title,
        sensorName,
        sensitivities,
        curve,
        chartSeries,
        hidden: Math.max(0, own.length - MAX_SENSOR_SERIES),
        skipped,
        chart: {
          data: { labels: [], datasets },
          options: {
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            plugins: { tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${Number(context.parsed.y.toPrecision(4))} million km` } } },
            scales: {
              x: { type: 'logarithmic', ticks: { callback: logTick }, title: { display: true, text: `${axis} (log)` } },
              y: { type: 'logarithmic', ticks: { callback: logTick }, title: { display: true, text: 'Range (million km, log)' } },
            },
          },
        },
      }
    },
  },
}
</script>

<style lang="scss">
.sensors-page {
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 16px;
  }

  .tool {
    min-width: 0;
  }

  .tool__label {
    height: calc(18px * var(--ae-font-scale));
    line-height: calc(18px * var(--ae-font-scale));
    white-space: nowrap;
  }

  .tool--shares {
    flex: 0 0 200px;
  }

  .tool--figure {
    flex: 0 0 150px;
  }

  .tool--class {
    flex: 1 1 200px;
    max-width: 300px;
  }

  .tool--switch {
    align-self: flex-end;
  }

  tr.is-current-level {
    background: var(--ae-row-selected);
  }

  td {
    font-variant-numeric: tabular-nums;
  }
}
</style>
