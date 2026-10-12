<template>
  <div>
    <v-container fluid class="outlook-page">
      <v-row dense align="center" class="mb-1">
        <v-col cols="auto" class="d-flex align-center mr-4">
          <span class="caption text--secondary mr-2">Horizon</span>
          <v-btn-toggle v-model="horizon" mandatory dense>
            <v-btn v-for="option in horizonOptions" :key="option" :value="option" small>{{ option }} y</v-btn>
          </v-btn-toggle>
        </v-col>
        <v-col cols="auto" class="mr-4">
          <v-switch v-model="attentionOnly" label="Only colonies that need attention" dense hide-details class="mt-0" />
        </v-col>
        <v-col cols="12" sm="auto" class="search-field">
          <v-text-field v-model="search" label="Search colonies" prepend-inner-icon="mdi-magnify" dense outlined hide-details clearable />
        </v-col>
      </v-row>

      <load-state :failed="failedInputsText" :error="loadErrors[failedInputs[0]]" :loading="!ready" class="mt-3" @retry="retryFailedInputs" />

      <template v-if="ready">
        <stat-tiles :tiles="tiles" class="mt-2" />

        <v-card class="panel" data-summary="Each colony with its population, growth, body capacity, infrastructure and workers, projected forward. Use it to see which will outgrow their bodies or lack workers." elevation="1">
          <div class="panel-head">
            <span class="d-flex align-center">
              <span>Colonies<provenance-mark rule="colonies.populationProjection" label /></span>
              <v-chip v-if="focusId" small close class="ml-3" close-label="Show every colony" @click:close="focusId = null">{{ focusName }}</v-chip>
            </span>
            <span class="legend">
              <span class="legend-item">Workers<provenance-mark rule="colonies.workers" /></span>
              <span class="legend-item"><span class="swatch" :style="{ background: workerColors.service }" />Services</span>
              <span class="legend-item"><span class="swatch" :style="{ background: workerColors.agriculture }" />Agriculture</span>
              <span class="legend-item"><span class="swatch" :style="{ background: workerColors.employed }" />Working</span>
              <span class="legend-item"><span class="swatch" :style="{ background: workerColors.free }" />Free</span>
              <span class="legend-item"><span class="swatch swatch-short" />Short</span>
            </span>
          </div>
          <v-data-table :headers="headers" :items="visibleRows" item-key="PopulationID" :expanded.sync="expanded" show-expand single-expand :custom-sort="sortRows" :sort-by.sync="colonyTable.sortBy" :sort-desc.sync="colonyTable.sortDesc" :items-per-page.sync="colonyTable.itemsPerPage" :footer-props="{ itemsPerPageOptions: colonyPageSizes }" :no-data-text="focusId ? 'This colony has no population, or does not belong to the race.' : undefined" class="colony-table" @click:row="(item, { expand, isExpanded }) => expand(!isExpanded)">
            <template #[`item.name`]="{ item }">
              <div class="py-2 d-flex align-center">
                <div>
                  <div class="font-weight-medium">
                    <v-icon v-if="item.Capital" small class="mr-1" title="Capital">mdi-star</v-icon>{{ item.name }}
                  </div>
                  <div class="caption text--secondary">{{ item.place }}<span v-if="multiSpecies"> · {{ item.SpeciesName }}</span></div>
                </div>
                <span class="ml-2 text-no-wrap">
                  <page-link :to="linkTo.production(item.PopulationID)" :name="item.name" />
                  <page-link :to="linkTo.planner({ bodies: [item] })" :name="item.place" />
                  <page-link :to="linkTo.commanders({ colony: item.PopulationID })" :name="item.name" />
                </span>
              </div>
            </template>
            <template #[`item.populationSort`]="{ item }">
              <div class="text-no-wrap">{{ people(item.Population) }}</div>
              <div class="caption text--secondary text-no-wrap">{{ people(item.final) }} in {{ horizon }} y<provenance-mark :result="item.r.projection" /></div>
            </template>
            <template #[`item.growthSort`]="{ item }">
              <span class="text-no-wrap" :class="{ 'text--secondary': !(item.growth > 0) }">{{ percent(item.growth, 2) }}</span><provenance-mark :result="item.r.growth" />
            </template>
            <template #[`item.fillSort`]="{ item }">
              <div class="fill-cell" :title="fillTitle(item)">
                <div class="meter">
                  <div v-if="item.fill !== null" class="meter-fill" :class="{ warning: item.fill > 1 / 3 }" :style="{ width: `${Math.min(100, item.fill * 100)}%` }" />
                  <div class="meter-tick" />
                </div>
                <span class="caption text-no-wrap">{{ fillCaption(item) }}<provenance-mark :result="item.r.fill" /></span>
              </div>
            </template>
            <template #[`item.infrastructureSort`]="{ item }">
              <span class="text-no-wrap" :class="{ 'text--secondary': item.infrastructureStatus.muted }">
                <v-icon v-if="item.infrastructureStatus.icon" small :color="item.infrastructureStatus.color">{{ item.infrastructureStatus.icon }}</v-icon>
                {{ item.infrastructureStatus.label }}
              </span><provenance-mark :result="item.infrastructureStatus.mark" />
              <div v-if="item.infrastructureStatus.note" class="caption text--secondary text-no-wrap">{{ item.infrastructureStatus.note }}</div>
            </template>
            <template #[`item.workersSort`]="{ item }">
              <div class="worker-cell">
                <div v-if="item.workersNow" class="worker-bar" :title="workerTitle(item.workersNow)">
                  <div v-for="segment in workerSegments(item.workersNow)" :key="segment.key" class="worker-segment" :class="segment.className" :style="{ width: `${segment.width}%`, background: segment.color }" />
                </div>
                <span class="caption text-no-wrap" :class="{ 'error--text': item.shortNow }">{{ freeLabel(item.freeNow) }}<provenance-mark :result="item.r.workersNow" /></span>
              </div>
            </template>
            <template #[`item.futureSort`]="{ item }">
              <span class="caption text-no-wrap" :class="{ 'error--text': item.shortLater }">{{ freeLabel(item.freeLater) }}</span><provenance-mark :result="item.r.workersLater" />
            </template>
            <template #[`item.inboundSort`]="{ item }">
              <span v-if="item.inbound" class="caption">{{ inboundLabel(item.inbound) }}</span>
              <span v-else class="text--secondary">—</span>
            </template>
            <template #expanded-item="{ headers: columns, item }">
              <td :colspan="columns.length" class="py-4">
                <div v-if="!focusId" class="mb-2">
                  <v-btn small text @click="focusId = item.PopulationID"><v-icon small left>mdi-filter-outline</v-icon>Only this colony</v-btn>
                </div>
                <v-row>
                  <v-col cols="12" md="7">
                    <div class="chart-title">Population over {{ horizon }} years<provenance-mark :result="item.r.projection" /></div>
                    <chart-canvas v-if="item.projection" type="line" :data="projectionChart(item)" :options="projectionOptions()" :height="220" :label="`Projected population of ${item.name}`" />
                    <div v-else class="caption text--secondary">No projection: {{ missingText(item.r.projection) }}.</div>
                    <div class="caption text--secondary mt-1"><span v-for="(part, index) in projectionNote(item)" :key="index" class="note-part">{{ part.text }}<provenance-mark v-for="(result, at) in part.results" :key="at" :result="result" /></span></div>
                  </v-col>
                  <v-col cols="12" md="5">
                    <div class="chart-title">Workers (millions)</div>
                    <v-simple-table dense class="worker-table">
                      <thead>
                        <tr>
                          <th />
                          <th class="text-right">Now<provenance-mark :result="item.r.workersNow" /></th>
                          <th class="text-right">In {{ horizon }} y<provenance-mark :result="item.r.workersLater" /></th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="line in workerLines" :key="line.key">
                          <td>{{ line.label }}</td>
                          <td class="text-right" :class="line.key === 'free' && item.shortNow ? 'error--text' : ''">{{ millions(workerValue(item.workersNow, line.key, item.Population)) }}</td>
                          <td class="text-right" :class="line.key === 'free' && item.shortLater ? 'error--text' : ''">{{ millions(workerValue(item.workersLater, line.key, item.final)) }}</td>
                        </tr>
                      </tbody>
                    </v-simple-table>
                    <div class="caption text--secondary mt-2">{{ workerNote(item) }}</div>
                  </v-col>
                </v-row>
              </td>
            </template>
          </v-data-table>
          <div class="panel-foot caption text--secondary">
            Growth is an estimate: 20% a year over the cube root of the population (at most 10%), times the species and governor modifiers, slowing past a third of the body's capacity and stopping at the infrastructure cap. Workers needed are today's installations and shipyards. Population in orbit (Ark modules) isn't counted. A dash is a figure the save cannot support, and the mark beside it names what is missing. Colonies short of workers today are also on the
            <router-link :to="linkTo.warnings({ check: 'low-efficiency-populations' })">Warnings</router-link> page.
          </div>
        </v-card>
      </template>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import { chartTheme, withAlpha } from '../components/charts/theme'
import LoadState from '../components/page/LoadState.vue'
import PageLink from '../components/page/PageLink.vue'
import ProvenanceMark from '../components/page/ProvenanceMark.vue'
import StatTiles from '../components/page/StatTiles.vue'
import deepLink from '../mixins/deep-link'
import loadState from '../mixins/load-state'
import persistedView, { oneOf, tableView } from '../mixins/persisted-view'
import productionModifiers from '../mixins/production-modifiers'
import { activeAppearance } from '../utilities/appearance'
import { populationName } from '../utilities/aurora'
import { WORKER_TOLERANCE, outlookColonies, people as peopleOf, totalResult } from '../utilities/colonies'
import { linkTo, queryId } from '../utilities/deep-links'
import { tracked } from '../utilities/load-tracking'
import { roundToDecimal, separatedNumber } from '../utilities/math'
import { describeResult, valueOrNull } from '../utilities/provenance'

const INPUT_LABELS = {
  colonies: 'the colonies',
  inbound: 'cargo on its way',
  populationProductionModifiers: 'production modifiers',
}

const stripHtml = (text) => text.replace(/&mdash;/g, '—')

const HORIZONS = [5, 10, 25, 50]
const COLONY_PAGE_SIZES = [25, 50, -1]

export default {
  name: 'ColonyOutlookPage',
  components: { ChartCanvas, LoadState, PageLink, ProvenanceMark, StatTiles },
  mixins: [
    deepLink,
    loadState(INPUT_LABELS),
    productionModifiers,
    persistedView({
      horizon: { key: 'colonyOutlookHorizon', default: 10, valid: oneOf(HORIZONS) },
      attentionOnly: { key: 'colonyOutlookAttentionOnly', default: false },
      search: { key: 'colonyOutlookSearch', default: '', scope: 'race' },
      colonyTable: tableView('colonyOutlookTable', { sortBy: ['populationSort'], sortDesc: [true], itemsPerPage: 25, itemsPerPageOptions: COLONY_PAGE_SIZES }),
    }),
  ],
  data() {
    return {
      horizonOptions: HORIZONS,
      colonyPageSizes: COLONY_PAGE_SIZES,
      focusId: null,
      linkTo,
      expanded: [],
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID']),

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    appearance() {
      return activeAppearance()
    },

    theme() {
      return chartTheme(this.appearance)
    },

    workerColors() {
      const [blue, , green, , pink] = this.theme.categorical

      return { service: withAlpha(blue, 0.45), agriculture: withAlpha(pink, 0.6), employed: blue, free: green }
    },

    multiSpecies() {
      return new Set(this.colonies.map((colony) => colony.SpeciesID)).size > 1
    },

    rows() {
      return outlookColonies(this.colonies, this.inbound, this.horizon).map(({ colony, arriving, otherSeries, results }) => {
        const r = { ...results, construction: this.populationCapacityResult(colony.PopulationID, 'construction') }
        const projection = valueOrNull(r.projection)
        const workersNow = valueOrNull(r.workersNow)
        const workersLater = valueOrNull(r.workersLater)
        const perMillion = valueOrNull(r.rate)
        const growth = valueOrNull(r.growth)
        const fill = valueOrNull(r.fill)
        const freeNow = workersNow ? workersNow.free : null
        const freeLater = workersLater ? workersLater.free : null
        const row = {
          ...colony,
          name: colony.PopName,
          place: stripHtml(populationName(colony)).replace(` — ${colony.PopName}`, ''),
          r,
          capacity: valueOrNull(r.capacity),
          otherSeries,
          fill,
          growth,
          projection,
          final: projection ? projection.final : null,
          perMillion,
          infrastructureCap: valueOrNull(r.cap),
          infrastructureNeeded: valueOrNull(r.needed),
          infrastructureBP: valueOrNull(r.neededCost),
          constructionBP: valueOrNull(r.construction),
          workersNow,
          workersLater,
          freeNow,
          freeLater,
          shortNow: freeNow === null ? null : freeNow < -WORKER_TOLERANCE,
          shortLater: freeLater === null ? null : freeLater < -WORKER_TOLERANCE,
          attention: valueOrNull(r.attention),
          inbound: arriving && (arriving.Colonists || arriving.Infrastructure || arriving.Installations) ? arriving : null,
        }

        row.infrastructureStatus = this.infrastructureStatus(row)

        return {
          ...row,
          populationSort: colony.Population,
          growthSort: growth,
          fillSort: fill,
          infrastructureSort: perMillion === null ? null : perMillion === 0 ? 2e6 : projection ? (projection.infrastructureAt === null ? 1e6 : projection.infrastructureAt) : null,
          workersSort: freeNow,
          futureSort: freeLater,
          inboundSort: arriving ? arriving.Colonists * 1e6 + arriving.Infrastructure + arriving.Installations : 0,
        }
      })
    },

    focusRow() {
      return this.focusId ? this.rows.find((row) => row.PopulationID === this.focusId) || null : null
    },

    focusName() {
      return this.focusRow ? this.focusRow.name : `Colony #${this.focusId}`
    },

    linkQuery() {
      return linkTo.colonyOutlook(this.focusId).query
    },

    linkLabel() {
      return this.focusRow ? this.focusRow.name : ''
    },

    visibleRows() {
      if (this.focusId) {
        return this.rows.filter((row) => row.PopulationID === this.focusId)
      }

      const search = (this.search || '').toLowerCase()

      return this.rows.filter((row) => (!this.attentionOnly || row.attention === true) && (!search || `${row.name} ${row.place}`.toLowerCase().includes(search)))
    },

    tiles() {
      const rows = this.rows
      const horizon = this.horizon
      const total = rows.length

      if (!total) {
        return ['Population', 'Colonies short of workers', `Growth capped within ${horizon} y`, `Infrastructure for ${horizon} years of growth`].map((label) => ({ label, value: '—', note: 'No colonies with a population' }))
      }

      const results = (name) => rows.map((row) => row.r[name])
      const countOf = (name, test) => totalResult({ results: results(name), pick: (value) => (test(value) ? 1 : 0), partial: true })
      const sumOf = (name, units) => totalResult({ results: results(name), pick: (value) => value, partial: true, units })
      const now = rows.reduce((sum, row) => sum + row.Population, 0)
      const later = totalResult({ results: results('projection'), pick: (projection) => projection.final, units: 'M people' })
      const laterValue = valueOrNull(later.result)
      const annual = laterValue !== null && now > 0 ? (laterValue / now) ** (1 / horizon) - 1 : null
      const isShort = (workers) => workers.free < -WORKER_TOLERANCE
      const shortNow = countOf('workersNow', isShort)
      const shortLater = countOf('workersLater', isShort)
      const free = totalResult({ results: results('workersNow'), pick: (workers) => Math.max(0, workers.free), partial: true, units: 'M workers' })
      const capped = countOf('projection', (projection) => projection.infrastructureAt !== null)
      const crowded = countOf('fill', (fill) => fill > 1 / 3)
      const needed = sumOf('needed', 'infrastructure')
      const cost = sumOf('neededCost', 'BP')
      const shortNowValue = valueOrNull(shortNow.result)
      const shortLaterValue = valueOrNull(shortLater.result)
      const freeValue = valueOrNull(free.result)
      const cappedValue = valueOrNull(capped.result)
      const crowdedValue = valueOrNull(crowded.result)
      const neededValue = valueOrNull(needed.result)
      const costValue = valueOrNull(cost.result)
      const unknownWorkers = rows.filter((row) => !row.workersNow || !row.workersLater).length
      const unknownGrowth = Math.max(capped.unknown, crowded.unknown)
      const unknownInfrastructure = Math.max(needed.unknown, cost.unknown)
      const tile = (value, parts, fields) => ({ ...fields, value, title: `${value}. ${parts.map(describeResult).join('. ')}` })
      let neededNote = 'Infrastructure needed is unavailable'
      let neededText = '—'

      if (neededValue > 0) {
        neededText = this.count(neededValue)
        neededNote = `${costValue === null ? 'Cost unavailable' : `${this.count(costValue)} BP`}, beyond what's built or on its way`
      } else if (neededValue === 0 && !needed.unknown) {
        neededText = 'None needed'
        neededNote = 'Every colony with a colony cost has enough'
      } else if (neededValue === 0) {
        neededNote = 'None needed by the colonies that can be read'
      }

      return [
        tile(`${this.people(now)} → ${this.people(laterValue)}`, [later.result], {
          label: 'Population',
          note: later.unknown ? `${later.unknown} of ${total} colonies have no projection` : `In ${horizon} years, about ${percent(annual, 2)} a year`,
        }),
        tile(shortNowValue === null && shortLaterValue === null ? '—' : `${shortNowValue === null ? '—' : shortNowValue} now, ${shortLaterValue === null ? '—' : shortLaterValue} in ${horizon} y`, [shortNow.result, shortLater.result], {
          label: 'Colonies short of workers',
          note: `${freeValue === null ? 'Free workers elsewhere unavailable' : `${this.millions(freeValue)} M free workers elsewhere`}${leftOut(unknownWorkers, total)}`,
          icon: shortNowValue > 0 ? 'mdi-account-alert' : shortNowValue === 0 && !unknownWorkers ? 'mdi-check-circle' : null,
          iconColor: shortNowValue > 0 ? 'warning' : 'success',
        }),
        tile(cappedValue === null ? '—' : `${cappedValue}`, [capped.result, crowded.result], {
          label: `Growth capped within ${horizon} y`,
          note: `${cappedValue > 0 ? 'By infrastructure. ' : ''}${crowdedValue === null ? 'Crowding unavailable' : `${crowdedValue} past a third of their body's capacity`}${leftOut(unknownGrowth, total)}`,
          icon: cappedValue > 0 ? 'mdi-alert' : null,
          iconColor: 'warning',
        }),
        tile(neededText, [needed.result, cost.result], {
          label: `Infrastructure for ${horizon} years of growth`,
          note: `${neededNote}${leftOut(unknownInfrastructure, total)}`,
        }),
      ]
    },

    // Nothing is on its way to most colonies most of the time, and an all-empty column is the first thing to give up when the window is narrow.
    headers() {
      return [
        { text: 'Colony', value: 'name' },
        { text: 'Population', value: 'populationSort', align: 'end' },
        { text: 'Growth / yr', value: 'growthSort', align: 'end' },
        { text: 'Body capacity', value: 'fillSort' },
        { text: 'Infrastructure', value: 'infrastructureSort' },
        { text: 'Workers now', value: 'workersSort' },
        { text: `In ${this.horizon} y`, value: 'futureSort', align: 'end' },
        ...(this.rows.some((row) => row.inbound) ? [{ text: 'On its way', value: 'inboundSort' }] : []),
        { text: '', value: 'data-table-expand' },
      ]
    },

    workerLines() {
      return [
        { key: 'population', label: 'Population' },
        { key: 'service', label: 'Services' },
        { key: 'agriculture', label: 'Agriculture and environment' },
        { key: 'available', label: 'Available to work' },
        { key: 'required', label: 'Needed by installations and yards' },
        { key: 'free', label: 'Free (short when negative)' },
      ]
    },
  },
  watch: {
    // A colony picked by a link opens expanded.
    focusRow(row, previous) {
      if (row && (!previous || previous.PopulationID !== row.PopulationID)) {
        this.expanded = [row]
      }
    },
    RaceID() {
      this.focusId = null
    },
  },
  methods: {
    applyLink(query) {
      this.focusId = queryId(query.colony)
    },

    count(value) {
      return Number.isFinite(value) ? separatedNumber(roundToDecimal(value, 0), this.separator) : '—'
    },
    millions(value) {
      return Number.isFinite(value) ? separatedNumber(roundToDecimal(value, Math.abs(value) < 10 ? 2 : 1), this.separator) : '—'
    },
    people(millions) {
      return Number.isFinite(millions) ? peopleOf(millions) : '—'
    },
    percent,
    years(months) {
      return months < 12 ? `${Math.max(1, months)} mo` : `${roundToDecimal(months / 12, 1)} y`
    },
    freeLabel(free) {
      if (!Number.isFinite(free)) {
        return '—'
      } else if (Math.abs(free) < WORKER_TOLERANCE) {
        return 'Balanced'
      }

      return free < 0 ? `${this.people(-free)} short` : `${this.people(free)} free`
    },
    inboundLabel(inbound) {
      return [inbound.Colonists ? `${this.people(inbound.Colonists)} colonists` : null, inbound.Infrastructure ? `${this.count(inbound.Infrastructure)} infrastructure` : null, inbound.Installations ? `${this.count(inbound.Installations)} installations` : null].filter(Boolean).join(', ')
    },
    missingText(result) {
      return result.inputs.missing.length ? `missing ${result.inputs.missing.join(', ')}` : 'an input is missing'
    },
    fillTitle(row) {
      return row.capacity === null ? 'Body capacity is unavailable' : `Body holds ${this.people(row.capacity)}; growth slows past a third`
    },
    fillCaption(row) {
      return row.capacity === null ? '—' : `${percent(row.fill, 0)} of ${this.people(row.capacity)}`
    },
    // A column of null-last values: an unavailable figure sorts after every number, in either direction, never as 0.
    sortRows(items, sortBy, sortDesc) {
      const [by] = sortBy

      if (!by) {
        return items
      }

      const direction = sortDesc[0] ? -1 : 1
      const missing = (value) => value === null || value === undefined

      return [...items].sort((a, b) => {
        const x = a[by]
        const y = b[by]

        if (missing(x) || missing(y)) {
          return missing(x) === missing(y) ? 0 : missing(x) ? 1 : -1
        }

        return (typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y) * direction
      })
    },

    infrastructureStatus(row) {
      if (row.perMillion === null) {
        return { label: '—', note: '', icon: null, muted: true, mark: row.r.rate }
      } else if (row.perMillion === 0) {
        return { label: 'Not needed', note: 'No colony cost', icon: null, muted: true, mark: row.r.rate }
      } else if (row.infrastructureCap === null) {
        return { label: '—', note: '', icon: null, muted: true, mark: row.r.cap }
      }

      const supports = `Supports ${this.people(row.infrastructureCap)}`

      if (!row.projection) {
        return { label: supports, note: `${this.count(row.perMillion)} per million, no projection`, icon: null, mark: row.r.projection }
      } else if (row.projection.infrastructureAt === 0) {
        return { label: 'At its cap', note: supports, icon: 'mdi-alert-octagon', color: 'error', mark: row.r.projection }
      } else if (row.projection.infrastructureAt !== null) {
        return { label: `Cap in ${this.years(row.projection.infrastructureAt)}`, note: supports, icon: 'mdi-alert', color: 'warning', mark: row.r.projection }
      }

      return { label: supports, note: `${this.count(row.perMillion)} per million`, icon: null, mark: row.r.projection }
    },

    workerSegments(workers) {
      const total = Math.max(workers.population, workers.service + workers.agriculture + workers.required)

      if (!(total > 0)) {
        return []
      }

      const employed = Math.min(workers.available, workers.required)
      const segments = [
        { key: 'service', value: workers.service, color: this.workerColors.service },
        { key: 'agriculture', value: workers.agriculture, color: this.workerColors.agriculture },
        { key: 'employed', value: employed, color: this.workerColors.employed },
        { key: 'free', value: Math.max(0, workers.free), color: this.workerColors.free },
        { key: 'short', value: Math.max(0, -workers.free), className: 'segment-short' },
      ]

      return segments.filter((segment) => segment.value > 0).map((segment) => ({ ...segment, width: (segment.value / total) * 100 }))
    },
    workerTitle(workers) {
      return `${this.millions(workers.available)} M can work, ${this.millions(workers.required)} M needed`
    },
    workerValue(workers, key, population) {
      return workers ? workers[key] : key === 'population' ? population : null
    },
    workerNote(row) {
      if (row.freeNow === null) {
        return 'The worker split is unavailable for this colony.'
      } else if (row.freeLater === null) {
        return `${row.shortNow ? `Short of ${this.people(-row.freeNow)} now. ` : ''}The worker split in ${this.horizon} years is unavailable.`
      } else if (row.shortLater) {
        return `Short of ${this.people(-row.freeLater)} in ${this.horizon} years at today's installations: hold off on new ones, or bring colonists.`
      } else if (row.shortNow) {
        return `Growth closes the gap within ${this.horizon} years.`
      }

      return `Room for about ${this.count(Math.floor(Math.max(0, row.freeLater) / 0.05))} more factories, mines or similar (50,000 workers each) by then.`
    },

    projectionChart(row) {
      const color = this.theme.primary
      const points = row.projection.series.map((value, month) => ({ x: month / 12, y: value }))
      const peak = Math.max(...row.projection.series)
      // `values` are monthly, like the projection; a limit at or below zero isn't drawn.
      const ceiling = (label, values, dash) => ({
        label,
        data: values.map((value, month) => ({ x: month / 12, y: value > 0 ? value : null })),
        borderColor: this.theme.inkMuted,
        borderDash: dash,
        borderWidth: 1,
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
      })
      const datasets = [{ label: 'Population', data: points, borderColor: color, backgroundColor: withAlpha(color, 0.1), fill: 'origin', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0 }]

      // Only limits near the curve: one far above it would flatten it (the note names it instead). Other populations on the body grow too, so the body's limits for this colony move with them.
      const near = (values) => values.some((value) => value > 0 && value !== Infinity && value <= peak * 2)
      const limits = [
        ['Growth slows', row.otherSeries.map((other) => row.capacity / 3 - other), [2, 3]],
        ['Infrastructure cap', row.otherSeries.map(() => row.infrastructureCap), [6, 4]],
        ['Body capacity', row.otherSeries.map((other) => row.capacity - other), [10, 4]],
      ]

      limits.filter(([, values]) => near(values)).forEach(([label, values, dash]) => datasets.push(ceiling(label, values, dash)))

      return { datasets }
    },
    projectionOptions() {
      return {
        scales: {
          x: { type: 'linear', min: 0, max: this.horizon, title: { display: true, text: 'Years from now' } },
          y: { grace: '5%', ticks: { callback: (value) => peopleOf(value) } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => `Year ${roundToDecimal(items[0].parsed.x, 1)}`,
              label: (item) => `${item.dataset.label}: ${peopleOf(item.parsed.y)}`,
            },
          },
        },
      }
    },
    // The note under the chart as parts, each with the results whose marks follow it.
    projectionNote(row) {
      const notes = []
      const r = row.r

      if (row.infrastructureCap !== null && row.infrastructureCap !== Infinity) {
        notes.push({ text: row.projection && row.projection.infrastructureAt !== null ? `Infrastructure stops growth at ${this.people(row.infrastructureCap)}.` : `Infrastructure supports ${this.people(row.infrastructureCap)}.`, results: [row.projection ? r.projection : r.cap] })
      }

      if (row.infrastructureNeeded === null) {
        notes.push({ text: 'The infrastructure to keep it growing is unavailable.', results: [r.needed] })
      } else if (row.infrastructureNeeded > 0) {
        const bp = row.infrastructureBP
        const share = bp !== null && row.constructionBP > 0 ? ` (${this.years(Math.max(1, Math.ceil((bp / row.constructionBP) * 12)))} of this colony's construction)` : ''

        notes.push({ text: `${this.count(row.infrastructureNeeded)} more infrastructure, ${bp === null ? 'cost unavailable' : `${this.count(bp)} BP${share}`}, keeps it growing for ${this.horizon} years.`, results: [r.needed, ...(bp === null ? [r.neededCost] : share ? [r.construction] : [])] })
      }

      if (row.capacity === null) {
        notes.push({ text: 'Body capacity is unavailable, so crowding is unknown.', results: [r.capacity] })
      } else {
        notes.push({ text: row.fill !== null && row.fill > 1 / 3 ? 'Past a third of the body\'s capacity, so growth is slowing.' : `Growth starts slowing at ${this.people(row.capacity / 3)} on this body.`, results: [row.fill === null ? r.capacity : r.fill] })
      }

      if (row.inbound && row.inbound.Colonists) {
        notes.push({ text: `Includes ${this.people(row.inbound.Colonists)} colonists on their way.`, results: [] })
      }

      return notes
    },
  },
  asyncComputed: {
    colonies: {
      get: tracked('colonies', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.Population, FCT_Population.Efficiency, FCT_Population.ReqInf, FCT_Population.Capital, FCT_Population.SpeciesID, FCT_Species.SpeciesName, FCT_Species.PopulationGrowthModifier, FCT_Species.PopulationDensityModifier, FCT_RaceSysSurvey.Name as SystemName, FCT_Star.Component, FCT_SystemBody.SystemBodyID, FCT_SystemBody.PlanetNumber, FCT_SystemBody.OrbitNumber, FCT_SystemBody.BodyClass, FCT_SystemBodyName.Name as SystemBodyName, FCT_SystemBody.Radius, FCT_SystemBody.HydroExt, FCT_SystemBody.TidalLock, FCT_SystemBody.RadiationLevel, case when FCT_SystemBody.Gravity < FCT_Species.Gravity - FCT_Species.GravDev then 1 else 0 end as LowGravity, case when VIR_Legacy.Types > 0 and FCT_SystemBody.Gravity < FCT_Species.Gravity - FCT_Species.GravDev then 1 else 0 end as LegacyLowGravity, coalesce(VIR_Installations.Infrastructure, 0) as Infrastructure, coalesce(VIR_Installations.LGInfrastructure, 0) as LGInfrastructure, coalesce(VIR_Installations.Workers, 0) as InstallationWorkers, coalesce(VIR_Yards.Workers, 0) as YardWorkers, coalesce(VIR_Governor.BonusValue, 1) * (1 + (coalesce(VIR_Sector.BonusValue, 1) - 1) * 0.25) as PopulationGrowthBonus, VIR_Body.Population as BodyPopulation, VIR_Legacy.InfrastructureCost from FCT_Population inner join FCT_Species on FCT_Species.SpeciesID = FCT_Population.SpeciesID inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID cross join (select sum(case when DIM_PlanetaryInstallation.LGInfrastructureValue > 0 then 1 else 0 end) as Types, min(case when DIM_PlanetaryInstallation.InfrastructureValue > 0 then DIM_PlanetaryInstallation.Cost end) as InfrastructureCost from DIM_PlanetaryInstallation) as VIR_Legacy left join FCT_SystemBodyName on FCT_SystemBodyName.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodyName.RaceID = FCT_Population.RaceID left join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_Population.SystemID and FCT_RaceSysSurvey.RaceID = FCT_Population.RaceID left join FCT_Star on FCT_Star.StarID = FCT_SystemBody.StarID left join (select FCT_PopulationInstallations.PopID, sum(DIM_PlanetaryInstallation.InfrastructureValue * FCT_PopulationInstallations.Amount) as Infrastructure, sum(DIM_PlanetaryInstallation.LGInfrastructureValue * FCT_PopulationInstallations.Amount) as LGInfrastructure, sum(DIM_PlanetaryInstallation.Workers * FCT_PopulationInstallations.Amount) as Workers from FCT_PopulationInstallations inner join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${this.GameID} group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID left join (select FCT_Shipyard.PopulationID, sum(FCT_Shipyard.Capacity * FCT_Shipyard.Slipways * case FCT_Shipyard.SYType when 1 then 1.0 else 0.1 end) / 4000.0 as Workers from FCT_Shipyard where FCT_Shipyard.GameID = ${this.GameID} and FCT_Shipyard.RaceID = ${this.RaceID} group by FCT_Shipyard.PopulationID) as VIR_Yards on VIR_Yards.PopulationID = FCT_Population.PopulationID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 8 where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 3 and FCT_Commander.CommandID <> 0) as VIR_Governor on VIR_Governor.CommandID = FCT_Population.PopulationID left join (select FCT_Commander.CommandID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = 8 where FCT_Commander.GameID = ${this.GameID} and FCT_Commander.RaceID = ${this.RaceID} and FCT_Commander.CommandType = 4 and FCT_Commander.CommandID <> 0) as VIR_Sector on VIR_Sector.CommandID = FCT_RaceSysSurvey.SectorID and FCT_RaceSysSurvey.SectorID <> 0 left join (select FCT_Population.SystemBodyID, sum(FCT_Population.Population) as Population from FCT_Population where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} group by FCT_Population.SystemBodyID) as VIR_Body on VIR_Body.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${this.GameID} and FCT_Population.RaceID = ${this.RaceID} and FCT_Population.Population > 0 order by FCT_Population.Population desc`).then(([items]) => items)
      }),
      default: [],
    },
    // Colonists (millions) and installations in cargo, by the colony an unload order sends them to.
    inbound: {
      get: tracked('inbound', async function () {
        if (!this.database || !this.GameID || !this.RaceID) {
          return []
        }

        return await this.database.query(`select FCT_MoveOrders.PopulationID, sum(case when FCT_MoveOrders.MoveActionID = 6 and FCT_ShipCargo.CargoTypeID = 1 then FCT_ShipCargo.Amount else 0 end) / 1000000.0 as Colonists, sum(case when FCT_MoveOrders.MoveActionID in (96, 177) and FCT_ShipCargo.CargoTypeID = 2 then FCT_ShipCargo.Amount * (coalesce(DIM_PlanetaryInstallation.InfrastructureValue, 0) + coalesce(DIM_PlanetaryInstallation.LGInfrastructureValue, 0)) else 0 end) as Infrastructure, sum(case when FCT_MoveOrders.MoveActionID in (96, 177) and FCT_ShipCargo.CargoTypeID = 2 and coalesce(DIM_PlanetaryInstallation.InfrastructureValue, 0) + coalesce(DIM_PlanetaryInstallation.LGInfrastructureValue, 0) = 0 then FCT_ShipCargo.Amount else 0 end) as Installations from FCT_MoveOrders inner join FCT_Ship on FCT_Ship.FleetID = FCT_MoveOrders.FleetID inner join FCT_ShipCargo on FCT_ShipCargo.ShipID = FCT_Ship.ShipID left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_ShipCargo.CargoID and FCT_ShipCargo.CargoTypeID = 2 where FCT_MoveOrders.GameID = ${this.GameID} and FCT_MoveOrders.RaceID = ${this.RaceID} and FCT_MoveOrders.MoveActionID in (6, 96, 177) and FCT_MoveOrders.PopulationID <> 0 group by FCT_MoveOrders.PopulationID`).then(([items]) => items)
      }),
      default: [],
    },
  },
}

function leftOut(unknown, total) {
  return unknown ? ` · ${unknown} of ${total} colonies not counted` : ''
}

function percent(fraction, decimals) {
  return Number.isFinite(fraction) ? `${roundToDecimal(fraction * 100, decimals).toFixed(decimals)}%` : '—'
}
</script>

<style lang="scss">
.outlook-page {
  .search-field {
    min-width: 240px;
  }

  .chart-title {
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 8px;
  }

  .note-part:not(:last-child) {
    margin-right: 6px;
  }

  .swatch {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 2px;
    margin-right: 6px;
  }

  td {
    font-variant-numeric: tabular-nums;
  }

  .colony-table {
    td:first-child,
    th:first-child {
      min-width: 180px;
    }
  }

  .meter {
    position: relative;
    flex: 1 1 72px;
    min-width: 48px;
    max-width: 240px;
    height: 6px;
    border-radius: 3px;
    background: var(--ae-track);
  }

  .meter-fill {
    height: 100%;
    border-radius: 3px;
    background-color: var(--ae-muted);
  }

  .meter-tick {
    position: absolute;
    top: -2px;
    left: 33.3%;
    width: 1px;
    height: 10px;
    background: currentColor;
    opacity: 0.5;
  }

  .fill-cell,
  .worker-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .worker-bar {
    display: flex;
    flex: 1 1 120px;
    min-width: 64px;
    max-width: 360px;
    height: 10px;
    border-radius: 2px;
    overflow: hidden;
    background: var(--ae-track-soft);
  }

  .worker-segment {
    height: 100%;
  }

  .segment-short,
  .swatch-short {
    background-image: repeating-linear-gradient(-45deg, var(--ae-shortfall) 0, var(--ae-shortfall) 3px, transparent 3px, transparent 6px) !important;
  }

  .worker-table td,
  .worker-table th {
    font-variant-numeric: tabular-nums;
  }
}
</style>
