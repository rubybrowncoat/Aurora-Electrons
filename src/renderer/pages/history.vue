<template>
  <div>
    <div v-if="!RaceID">Select a race from the left-side menu.</div>

    <v-container v-else-if="!historyRecorded" fluid class="history-page">
      <v-alert type="info" outlined dense>
        The app doesn't keep Empire History for this race. It's one of Aurora's special factions (such as the Precursors, Invaders or Rakhas), which have no empire to chart. History is kept for player races and NPR empires.
      </v-alert>
    </v-container>

    <v-container v-else fluid class="history-page">
      <v-row dense align="center" class="mb-1">
        <v-col class="caption text--secondary">
          <template v-if="snapshots.length">{{ snapshots.length }} {{ snapshots.length === 1 ? 'snapshot' : 'snapshots' }}, {{ snapshots.length > 1 ? `${date(snapshots[0].t)} to ${date(snapshots[snapshots.length - 1].t)}` : date(snapshots[0].t) }}.</template>
          The app records one each time Aurora saves while it's open, for every player race and NPR empire in the save.
          <span v-if="filePath">Saved in <span class="file-path">{{ filePath }}</span>.</span>
        </v-col>
        <v-col cols="auto">
          <v-btn-toggle v-model="view" mandatory dense>
            <v-btn value="charts" small><v-icon small>mdi-chart-line</v-icon></v-btn>
            <v-btn value="table" small><v-icon small>mdi-table</v-icon></v-btn>
          </v-btn-toggle>
          <v-btn small text :disabled="!snapshots.length" class="ml-2" @click="downloadCsv"><v-icon small left>mdi-download</v-icon>CSV</v-btn>
          <v-btn small text color="error" :disabled="!snapshots.length" @click="confirmClear = true">Clear</v-btn>
        </v-col>
      </v-row>

      <v-alert v-if="!snapshots.length" type="info" outlined dense class="mt-3">
        No history for this race yet. A snapshot is taken as soon as the app reads the save, and another each time Aurora saves the game. For the past year of income and spending, see <nuxt-link to="/finances">Finances</nuxt-link>.
      </v-alert>

      <template v-else>
        <v-row class="mt-1">
          <v-col v-for="tile in tiles" :key="tile.label" cols="12" sm="6" lg="3">
            <v-card class="stat-tile" elevation="1">
              <div class="caption text--secondary">{{ tile.label }}</div>
              <div class="stat-value">{{ tile.value }}</div>
              <div class="caption text--secondary">{{ tile.note }}</div>
            </v-card>
          </v-col>
        </v-row>

        <v-alert v-if="snapshots.length === 1" type="info" outlined dense class="mt-4">
          History starts here. Charts fill in as Aurora saves: each save while the app is open adds a point.
        </v-alert>

        <v-card v-if="view === 'charts' && rivals" class="panel" elevation="1">
          <div class="panel-head">
            <span>Rivals <span class="caption text--secondary ml-2">Spy mode: every race recorded in this game</span></span>
            <span class="legend">
              <span v-for="series in rivals.data.datasets" :key="series.label" class="legend-item" :class="{ 'font-weight-bold': series.borderWidth === 3 }"><span class="swatch" :style="{ background: series.borderColor }" />{{ series.label }}</span>
            </span>
          </div>
          <div class="panel-body">
            <v-btn-toggle :value="rivalMetric" mandatory dense class="mb-2 flex-wrap" @change="setRivalMetric">
              <v-btn v-for="metric in rivalMetrics" :key="metric.value" :value="metric.value" small>{{ metric.text }}</v-btn>
            </v-btn-toggle>
            <chart-canvas type="line" :data="rivals.data" :options="rivals.options" :height="280" label="Rivals" />
          </div>
        </v-card>

        <v-row v-if="view === 'charts'">
          <v-col v-for="chart in charts" :key="chart.key" cols="12" lg="6">
            <v-card class="panel" elevation="1">
              <div class="panel-head">
                <span>{{ chart.title }}</span>
                <span class="legend">
                  <span v-for="series in chart.data.datasets" :key="series.label" class="legend-item"><span class="swatch" :style="{ background: series.borderColor }" />{{ series.label }}</span>
                </span>
              </div>
              <div class="panel-body">
                <div v-if="chart.picker" class="mb-2">
                  <v-chip-group :value="chart.picker.model" multiple column @change="chart.picker.change">
                    <v-chip v-for="option in chart.picker.options" :key="option.value" :value="option.value" small filter outlined>{{ option.text }}</v-chip>
                  </v-chip-group>
                </div>
                <chart-canvas type="line" :data="chart.data" :options="chart.options" :height="240" :label="chart.title" />
              </div>
            </v-card>
          </v-col>
        </v-row>

        <v-card v-else class="panel" elevation="1">
          <v-data-table :headers="tableHeaders" :items="tableRows" item-key="t" :items-per-page="25" :footer-props="{ itemsPerPageOptions: [25, 100, -1] }" dense />
        </v-card>
      </template>

      <v-dialog v-model="confirmClear" max-width="440">
        <v-card>
          <v-card-title>Clear this race's history?</v-card-title>
          <v-card-text>This deletes the {{ snapshots.length }} snapshots the app has recorded for this race. The save isn't touched, and recording starts again at the next save.</v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn text @click="confirmClear = false">Cancel</v-btn>
            <v-btn text color="error" @click="clearHistory">Clear</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-container>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import ChartCanvas from '../components/charts/ChartCanvas.vue'
import { chartTheme, withAlpha } from '../components/charts/theme'
import { gameTime } from '../utilities/aurora'
import { historyConfig } from '../utilities/history'
import { roundToDecimal, separatedNumber } from '../utilities/math'
import { MINERALS } from '../utilities/minerals'

const SECONDS_PER_YEAR = 31536000
// Installation types charted when the player hasn't picked any: the largest by count.
const DEFAULT_INSTALLATIONS = 5

const compact = (value) => {
  const size = Math.abs(value)

  if (size >= 1e9) {
    return `${roundToDecimal(value / 1e9, 2)} bn`
  } else if (size >= 1e6) {
    return `${roundToDecimal(value / 1e6, 2)} M`
  } else if (size >= 1e3) {
    return `${roundToDecimal(value / 1e3, 1)} k`
  }

  return `${roundToDecimal(value, 1)}`
}

// Millions of people, in billions from 1,000 M (three decimals, so slow growth still shows).
const people = (millions) => (Math.abs(millions) >= 1000 ? `${roundToDecimal(millions / 1000, 3)} bn` : `${roundToDecimal(millions, 1)} M`)

// What the Rivals chart can compare.
const RIVAL_METRICS = [
  { value: 'population', text: 'Population', pick: (snapshot) => snapshot.population, format: people },
  { value: 'colonies', text: 'Colonies', pick: (snapshot) => snapshot.colonies, format: (value) => `${roundToDecimal(value, 0)}` },
  { value: 'fleet', text: 'Fleet tonnage', pick: (snapshot) => (snapshot.militaryTons || 0) + (snapshot.commercialTons || 0), format: (value) => `${compact(value)} t` },
  { value: 'military', text: 'Military tonnage', pick: (snapshot) => snapshot.militaryTons, format: (value) => `${compact(value)} t` },
  { value: 'research', text: 'Research', pick: (snapshot) => snapshot.research, format: (value) => `${compact(value)} RP` },
  { value: 'systems', text: 'Known systems', pick: (snapshot) => snapshot.systems, format: (value) => `${roundToDecimal(value, 0)}` },
  { value: 'wealth', text: 'Treasury', pick: (snapshot) => snapshot.wealth, format: compact },
]

export default {
  name: 'HistoryPage',
  components: { ChartCanvas },
  data() {
    return {
      view: 'charts',
      confirmClear: false,
      mineralIds: [1, 2, 11],
      installationIds: null,
      rivalMetric: 'population',
      rivalMetrics: RIVAL_METRICS,
      // Spy mode shows the other races' history (Rivals). Read on creation: it's set on Settings.
      spyNPR: false,
      // Bumped when this page clears the history, so `gameHistory` re-reads it.
      cleared: 0,
    }
  },
  computed: {
    ...mapGetters(['config', 'database', 'GameID', 'RaceID', 'StartYear', 'historyRecorded']),

    separator() {
      const selectedSeparator = this.config.get('selectedSeparator', 'Tick')

      return selectedSeparator === 'Tick' ? "'" : selectedSeparator === 'Comma' ? ',' : selectedSeparator === 'Dash' ? '-' : selectedSeparator === 'Space' ? ' ' : ''
    },

    theme() {
      return chartTheme(this.$vuetify.theme.dark)
    },

    // The game's history file, re-read whenever the recorder writes (store revision) or this page clears it.
    gameHistory() {
      // eslint-disable-next-line no-unused-expressions
      this.$store.state.history.revision + this.cleared

      if (!this.GameID || !this.RaceID || !this.historyRecorded) {
        return null
      }

      return historyConfig(this.GameID).store
    },

    record() {
      return this.gameHistory && this.gameHistory.races ? this.gameHistory.races[this.RaceID] || null : null
    },

    filePath() {
      return this.GameID ? historyConfig(this.GameID).path : ''
    },

    snapshots() {
      return this.record && Array.isArray(this.record.snapshots) ? this.record.snapshots : []
    },

    latest() {
      return this.snapshots[this.snapshots.length - 1]
    },

    tiles() {
      const first = this.snapshots[0]
      const last = this.latest
      const change = (key, format) => (this.snapshots.length > 1 ? `${last[key] - first[key] >= 0 ? '+' : '−'}${format(Math.abs(last[key] - first[key]))} since ${this.date(first.t)}` : 'First snapshot')

      return [
        { label: 'Population', value: people(last.population), note: change('population', people) },
        { label: 'Treasury', value: compact(last.wealth), note: change('wealth', compact) },
        { label: 'Fleet tonnage', value: `${compact(last.militaryTons + last.commercialTons)} t`, note: `${compact(last.militaryTons)} t military, ${compact(last.commercialTons)} t commercial` },
        { label: 'Research', value: `${compact(last.research)} RP`, note: change('research', (value) => `${compact(value)} RP`) },
      ]
    },

    installationOptions() {
      const ids = new Set()

      this.snapshots.forEach((snapshot) => Object.keys(snapshot.installations || {}).forEach((id) => ids.add(Number(id))))

      return [...ids].map((id) => ({ value: id, text: this.installationNames[id] || `Installation ${id}` })).sort((a, b) => a.text.localeCompare(b.text))
    },

    chosenInstallations() {
      if (this.installationIds) {
        return this.installationIds
      }

      const latest = (this.latest && this.latest.installations) || {}

      return Object.entries(latest).sort((a, b) => b[1] - a[1]).slice(0, DEFAULT_INSTALLATIONS).map(([id]) => Number(id))
    },

    charts() {
      const palette = this.theme.categorical
      const line = (label, values, index, axis = 'y') => ({
        label,
        data: this.snapshots.map((snapshot, position) => ({ x: this.year(snapshot.t), y: values[position] })),
        borderColor: palette[index % palette.length],
        backgroundColor: withAlpha(palette[index % palette.length], 0.1),
        borderWidth: 2,
        pointRadius: this.snapshots.length > 40 ? 0 : 3,
        pointHoverRadius: 4,
        tension: 0,
        yAxisID: axis,
      })
      const pick = (key) => this.snapshots.map((snapshot) => snapshot[key] || 0)

      return [
        {
          key: 'population',
          title: 'Population',
          data: { datasets: [line('Population', pick('population'), 0), line('Colonies', pick('colonies'), 1, 'y1')] },
          options: this.options({ y: people, y1: (value) => `${value}` }),
        },
        {
          key: 'wealth',
          title: 'Wealth',
          data: { datasets: [line('Treasury', pick('wealth'), 0), line('Annual income', pick('income'), 1, 'y1')] },
          options: this.options({ y: compact, y1: compact }),
        },
        {
          key: 'fleet',
          title: 'Fleet tonnage',
          data: { datasets: [line('Military', pick('militaryTons'), 0), line('Commercial', pick('commercialTons'), 1)] },
          options: this.options({ y: (value) => `${compact(value)} t` }),
        },
        {
          key: 'research',
          title: 'Research and exploration',
          data: { datasets: [line('Research (RP)', pick('research'), 0), line('Known systems', pick('systems'), 1, 'y1')] },
          options: this.options({ y: compact, y1: (value) => `${value}` }),
        },
        {
          key: 'minerals',
          title: 'Mineral stockpiles',
          picker: { model: this.mineralIds, options: MINERALS.map((mineral) => ({ value: mineral.id, text: mineral.name })), change: this.setMinerals },
          data: { datasets: this.mineralIds.map((id, index) => line(MINERALS.find((mineral) => mineral.id === id).name, this.snapshots.map((snapshot) => (snapshot.minerals || [])[id - 1] || 0), index)) },
          options: this.options({ y: (value) => `${compact(value)} t` }),
        },
        {
          key: 'installations',
          title: 'Installations',
          picker: { model: this.chosenInstallations, options: this.installationOptions, change: this.setInstallations },
          data: { datasets: this.chosenInstallations.map((id, index) => line(this.installationNames[id] || `Installation ${id}`, this.snapshots.map((snapshot) => (snapshot.installations || {})[id] || 0), index)) },
          options: this.options({ y: compact }),
        },
        {
          key: 'logistics',
          title: 'Fuel and maintenance supplies',
          data: { datasets: [line('Fuel (L)', pick('fuel'), 0), line('MSP', pick('msp'), 1, 'y1')] },
          options: this.options({ y: (value) => `${compact(value)} L`, y1: compact }),
        },
      ]
    },

    // Every recorded race in the game on one metric, players first; only in spy mode.
    rivals() {
      const races = this.spyNPR && this.gameHistory && this.gameHistory.races ? Object.entries(this.gameHistory.races).filter(([, record]) => record.snapshots && record.snapshots.length).sort(([a, first], [b, second]) => Number(!!first.npr) - Number(!!second.npr) || Number(a) - Number(b)) : []

      if (races.length < 2) {
        return null
      }

      const metric = RIVAL_METRICS.find((option) => option.value === this.rivalMetric) || RIVAL_METRICS[0]
      const palette = this.theme.categorical
      const datasets = races.map(([RaceID, record], index) => {
        const selected = Number(RaceID) === Number(this.RaceID)
        const color = palette[index % palette.length]

        return {
          label: record.raceName || `Race ${RaceID}`,
          data: record.snapshots.map((snapshot) => ({ x: this.year(snapshot.t), y: metric.pick(snapshot) || 0 })),
          borderColor: color,
          backgroundColor: withAlpha(color, 0.1),
          borderWidth: selected ? 3 : 1.5,
          borderDash: index >= palette.length ? [6, 4] : [],
          pointRadius: record.snapshots.length > 40 ? 0 : 2,
          pointHoverRadius: 4,
          tension: 0,
        }
      })

      return { data: { datasets }, options: this.options({ y: metric.format }, metric.format) }
    },

    tableHeaders() {
      return [
        { text: 'Date', value: 'date' },
        { text: 'Population (M)', value: 'population', align: 'end' },
        { text: 'Colonies', value: 'colonies', align: 'end' },
        { text: 'Treasury', value: 'wealth', align: 'end' },
        { text: 'Military (t)', value: 'militaryTons', align: 'end' },
        { text: 'Commercial (t)', value: 'commercialTons', align: 'end' },
        { text: 'Research (RP)', value: 'research', align: 'end' },
        { text: 'Systems', value: 'systems', align: 'end' },
      ]
    },

    tableRows() {
      return this.snapshots.slice().reverse().map((snapshot) => ({
        t: snapshot.t,
        date: this.date(snapshot.t),
        population: this.count(snapshot.population, 1),
        colonies: snapshot.colonies,
        wealth: this.count(snapshot.wealth),
        militaryTons: this.count(snapshot.militaryTons),
        commercialTons: this.count(snapshot.commercialTons),
        research: this.count(snapshot.research),
        systems: snapshot.systems,
      }))
    },
  },
  watch: {
    RaceID: {
      immediate: true,
      handler() {
        this.mineralIds = this.config.get('historyMinerals', [1, 2, 11])
        this.rivalMetric = this.config.get('historyRivalsMetric', 'population')
        this.installationIds = this.config.get(`game.${this.GameID}.race.${this.RaceID}.historyInstallations`, null)
      },
    },
  },
  created() {
    this.spyNPR = this.config.get('spyNPR', false)
  },
  methods: {
    count(value, decimals = 0) {
      return separatedNumber(roundToDecimal(value || 0, decimals), this.separator)
    },
    year(seconds) {
      return (this.StartYear || 0) + seconds / SECONDS_PER_YEAR
    },
    date(seconds) {
      return gameTime(this.StartYear, seconds).format('YYYY-MM-DD')
    },
    options(axes, labelFormat = null) {
      const scales = {
        x: { type: 'linear', title: { display: true, text: 'Year' }, ticks: { callback: (value) => `${roundToDecimal(value, 2)}` } },
        y: { ticks: { callback: axes.y } },
      }

      if (axes.y1) {
        scales.y1 = { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: axes.y1 } }
      }

      return {
        scales,
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => this.date((items[0].parsed.x - (this.StartYear || 0)) * SECONDS_PER_YEAR),
              label: (item) => `${item.dataset.label}: ${labelFormat ? labelFormat(item.parsed.y) : this.count(item.parsed.y, item.parsed.y < 100 ? 1 : 0)}`,
            },
          },
        },
      }
    },
    setMinerals(ids) {
      this.mineralIds = ids
      this.config.set('historyMinerals', ids)
    },
    setInstallations(ids) {
      this.installationIds = ids
      this.config.set(`game.${this.GameID}.race.${this.RaceID}.historyInstallations`, ids)
    },
    setRivalMetric(value) {
      this.rivalMetric = value
      this.config.set('historyRivalsMetric', value)
    },
    // Remove this race from the game's history file; other races keep theirs.
    clearHistory() {
      const store = historyConfig(this.GameID)
      const history = store.store

      if (history.races && history.races[this.RaceID]) {
        delete history.races[this.RaceID]
        store.store = history
      }

      this.cleared++
      this.confirmClear = false
    },
    downloadCsv() {
      const names = Object.fromEntries(this.installationOptions.map((option) => [option.value, option.text]))
      const installationIds = Object.keys(names).map(Number)
      const header = ['GameTime', 'Date', 'Population (M)', 'Colonies', 'Treasury', 'Annual income', 'Fuel (L)', 'MSP', ...MINERALS.map((mineral) => `${mineral.name} (t)`), 'Military ships', 'Military tons', 'Commercial ships', 'Commercial tons', 'Research (RP)', 'Known systems', 'Commanders', ...installationIds.map((id) => names[id])]
      const quote = (value) => (typeof value === 'string' && /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
      const rows = this.snapshots.map((snapshot) => [snapshot.t, this.date(snapshot.t), snapshot.population, snapshot.colonies, snapshot.wealth, snapshot.income, snapshot.fuel, snapshot.msp, ...MINERALS.map((mineral) => (snapshot.minerals || [])[mineral.id - 1] || 0), snapshot.militaryShips, snapshot.militaryTons, snapshot.commercialShips, snapshot.commercialTons, snapshot.research, snapshot.systems, snapshot.commanders, ...installationIds.map((id) => (snapshot.installations || {})[id] || 0)])
      const csv = [header, ...rows].map((row) => row.map(quote).join(',')).join('\n')
      const link = document.createElement('a')

      link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
      link.download = `${(this.record.raceName || 'race').replace(/[^\w-]+/g, '_')}-history.csv`
      link.click()
      URL.revokeObjectURL(link.href)
    },
  },
  asyncComputed: {
    installationNames: {
      async get() {
        if (!this.database) {
          return {}
        }

        const rows = await this.database.query('select DIM_PlanetaryInstallation.PlanetaryInstallationID, DIM_PlanetaryInstallation.Name from DIM_PlanetaryInstallation').then(([items]) => items)

        return Object.fromEntries(rows.map((row) => [row.PlanetaryInstallationID, row.Name]))
      },
      default: {},
    },
  },
}
</script>

<style lang="scss">
.history-page {
  .stat-tile {
    padding: 16px;
    height: 100%;
  }

  .stat-value {
    font-size: 24px;
    line-height: 32px;
    font-weight: 400;
    margin: 4px 0;
  }

  .panel {
    margin-top: 20px;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 24px;
    font-size: 16px;
    line-height: 28px;
  }

  .panel-body {
    padding: 0 24px 16px;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    font-size: 12px;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
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

  .file-path {
    font-family: monospace;
    overflow-wrap: anywhere;
  }
}
</style>
